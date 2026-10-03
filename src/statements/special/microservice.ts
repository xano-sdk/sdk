/**
 * `microservice.request` — call a container workload running alongside the
 * workspace (`mvp:microservice_request`).
 *
 * Its own module rather than a member of the external-HTTP-request family: a
 * microservice is a first-class workspace object with its own def factory and
 * its own deploy path, and this statement shares nothing with `api.request`
 * beyond the `{request, response}` result envelope — no TLS/cert fields, no
 * `output` envelope, and a different required-field contract (see
 * {@link MICROSERVICE_DEFAULTS}).
 *
 * The bulk of what lives here is host/port resolution: `host` and `port` are an
 * authoring convenience that folds into the single `"name:port"` string the
 * engine actually reads, and everything provably wrong about that pairing is
 * thrown on at build time rather than left to fail at request time.
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import type { Value } from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import type { StatementOptions } from "../statement.js";
import { declaredServicePorts, noteMicroserviceHandleHost, type MicroserviceDef } from "../../kinds/microservice.js";
import type { ApiRequestResult } from "./api-request.js";
import {
  type HttpRequestFields,
  isValue,
  coerceText,
  coerceObj,
  coerceHeaders,
  coerceInt,
  coerceBool,
} from "./coerce.js";
import { argsOrEmpty, assertArg } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

/** Host spellings `s.microservice.request` accepts. */
export type MicroserviceHost = MicroserviceDef | string | Value;

/**
 * Resolve `host` + `port` to the single `name:port` text field the engine reads.
 *
 * The engine splits `host` on the first `:`, resolves the name portion against
 * the microservice row, and passes the port through into the request URL — so
 * `port` is an authoring convenience that folds back into one string here, and
 * never reaches the encoder. Everything this function can prove wrong, it
 * throws on: an authored statement that names a port its own microservice does
 * not expose would deploy clean and fail only at request time.
 */
function resolveMicroserviceHost(
  host: MicroserviceHost,
  port: number | string | undefined,
): string | Value {
  // Order matters: a `Value` and a `MicroserviceDef` are both objects, so the
  // tagged-Value test has to run first and be the explicit discriminator.
  if (isValue(host)) {
    if (port !== undefined) {
      const v = host as { tag?: unknown; value?: unknown; filters?: unknown[] };
      const literal =
        typeof v.tag === "string" && v.tag.startsWith("const") && typeof v.value === "string" && !v.filters?.length;
      throw new Error(
        literal
          ? `Statement "s.microservice.request": \`port\` is not joined onto a \`c.text(...)\` \`host\`. ` +
              `Pass the name as a plain string (\`host: ${JSON.stringify(v.value)}, port: ${String(port)}\`), ` +
              `or spell the port in the text (\`c.text("${String(v.value)}:${String(port)}")\`).`
          : "Statement \"s.microservice.request\": `port` cannot be joined onto a dynamic `host` at build time. " +
              "Build the joined `\"name:port\"` string in the value itself instead.",
      );
    }
    return host;
  }

  if (typeof host === "string") {
    if (port !== undefined && host.includes(":")) {
      throw new Error(
        `Statement "s.microservice.request": \`host\` already carries a port ("${host}"), so \`port: ${String(port)}\` is ambiguous. ` +
          "Pass the port once — either joined into `host` or as `port`.",
      );
    }
    return port === undefined ? host : `${host}:${port}`;
  }

  return defHost(host, port);
}

/** `host` + `port` for a `microservice()` def, checked against the ports it declares. */
function defHost(host: MicroserviceDef, port: number | string | undefined): string {
  const declared = declaredServicePorts(host);

  if (port !== undefined) {
    // A microservice declaring no ports (helm, or a builtin exposing nothing)
    // has nothing to contradict, so any port is allowed through.
    if (declared.length > 0 && !declared.includes(String(port))) {
      throw new Error(
        `Statement "s.microservice.request": microservice "${host.name}" does not expose port ${String(port)}. ` +
          `It declares: ${declared.join(", ")}.`,
      );
    }
    return `${host.name}:${port}`;
  }

  // One declared port is unambiguous — it is the only entry the dashboard's own
  // host dropdown would offer for this microservice.
  if (declared.length === 1) return `${host.name}:${declared[0]}`;
  // No declared ports: the engine routes a bare name to `http://name/path`.
  if (declared.length === 0) return host.name;

  throw new Error(
    `Statement "s.microservice.request": microservice "${host.name}" declares ${declared.length} ports ` +
      `(${declared.join(", ")}), so \`port\` is required to pick one.`,
  );
}

/**
 * The literal `servicePort`s a def declares, at the type level — the type-side
 * mirror of {@link declaredServicePorts}.
 */
type PortsOf<D> = D extends { deployment: { containers: readonly (infer C)[] } }
  ? C extends { ports: readonly (infer P)[] }
    ? P extends { servicePort: infer S extends string }
      ? S
      : never
    : never
  : never;

/** `"8080"` → `8080`, so a port may be written as a number. */
type AsNumber<S extends string> = S extends `${infer N extends number}` ? N : never;

/**
 * What `port` accepts for a given `host`.
 *
 * Constrained to the declared ports ONLY when they are known as literals. Two
 * cases deliberately fall back to the open type rather than narrowing to
 * `never`, because a false type error on valid code is worse than a missing
 * one: a def whose ports widened to `string` (annotated `MicroserviceDef`,
 * built dynamically), and a def that declares no ports at all (helm).
 */
type PortArg<D> = string extends PortsOf<D>
  ? number | string
  : [PortsOf<D>] extends [never]
    ? number | string
    : PortsOf<D> | AsNumber<PortsOf<D>>;

/** True for a union of two or more members. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * `port` becomes REQUIRED when the def declares several literal ports — the
 * type-side mirror of the build-time "declares N ports, so `port` is required".
 */
type PortRequired<H> = H extends MicroserviceDef
  ? true extends IsUnion<PortsOf<H>>
    ? { port: PortArg<H> }
    : unknown
  : unknown;

/**
 * The five request fields this statement shares with the external-HTTP family,
 * taken FROM that family's field set rather than restated.
 *
 * Deriving them keeps the two in step: a widening on the HTTP side (the
 * `headers` record form, say) reaches here without a second hand-edit.
 * The per-field docs stay local because the DEFAULTS differ — this
 * statement's block schema requires all five, so it emits them (see
 * {@link MICROSERVICE_DEFAULTS}) where `api.request` may leave them out.
 */
type HttpFields = Pick<
  HttpRequestFields,
  "method" | "params" | "headers" | "timeout" | "follow_location"
>;

export interface MicroserviceArgs<H extends MicroserviceHost = MicroserviceHost>
  extends StatementOptions {
  /** Capture the response into this stack variable. */
  as?: string;
  /**
   * Target microservice — the `microservice()` def to call.
   *
   * A plain string is also accepted, and is the only way to reach an
   * instance-level microservice (those live in instance settings, not the
   * workspace, so there is no def to pass). It carries its own port:
   * `"legacy:80"`.
   */
  host: H;
  /**
   * Port to call, folded into `host` as `name:port`.
   *
   * Optional: a microservice declaring exactly one `servicePort` resolves to it.
   * One declaring several requires this field, and rejects a port it does not
   * expose — as a TYPE error when the def's ports are known as literals, and as
   * a build-time throw otherwise. Serialized as text, matching how
   * `servicePort` is stored.
   */
  port?: H extends MicroserviceDef ? PortArg<H> : number | string;
  /** Request path. */
  path: string | Value;
  /** HTTP verb — the 7 engine verbs are suggested; any string or dynamic `Value` is accepted. Defaults to `"GET"`. */
  method?: HttpFields["method"];
  /** Request params — a key/value object. Defaults to `{}`. */
  params?: HttpFields["params"];
  /** Headers — a `{ Name: value }` record (values may be tagged) or an array of full header-line strings. Defaults to `[]`. */
  headers?: HttpFields["headers"];
  /** Request timeout in seconds. Defaults to `10`. */
  timeout?: HttpFields["timeout"];
  /** Follow HTTP redirects. Defaults to `true`. */
  follow_location?: HttpFields["follow_location"];
}

/**
 * Defaults for the five request fields a caller may omit.
 *
 * These MIRROR the engine's own declared defaults for this statement rather
 * than inventing Xano SDK ones, so an omitted field produces exactly the bytes
 * a fully-specified statement produces — and exactly what the Xano editor
 * stores, since it saves the whole form.
 *
 * They are applied rather than omitted because this statement's block schema
 * declares all five REQUIRED (no `?`), unlike its `api.request` sibling, which
 * declares them optional-with-defaults and so may leave them out. Emitting a
 * microservice call without them is rejected as a missing required argument.
 *
 * Restating a third party's defaults means they can drift. Kept in one place so
 * a drift is a one-line fix.
 */
const MICROSERVICE_DEFAULTS = {
  method: "GET",
  params: {},
  headers: [] as readonly string[],
  timeout: 10,
  follow_location: true,
} as const;

const MICROSERVICE_KEYS = /* @__PURE__ */ Object.keys({ as: 1, host: 1, port: 1, path: 1, method: 1, params: 1, headers: 1, timeout: 1, follow_location: 1, asFilters: 1, uncheckedAs: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<MicroserviceArgs>, 1>);

/**
 * `microservice.request` — call an in-cluster microservice
 * (`mvp:microservice_request`). Typed over the generated factory; no TLS/cert
 * fields (the engine schema omits them).
 *
 * Only `host` and `path` are required. `method`, `params`, `headers`, `timeout`,
 * and `follow_location` default to the engine's own values
 * ({@link MICROSERVICE_DEFAULTS}) and are always EMITTED — this statement's
 * block schema requires them, so they cannot simply be left out:
 *
 * ```ts
 * s.microservice.request({ as: "result", host: echoService, path: "/health" })
 * ```
 *
 * Address it by passing the `microservice()` def itself — its declared ports are
 * then checked at the authoring site, and a rename fixes every call site at once:
 *
 * ```ts
 * s.microservice.request({ host: echoService, path: "/health", ... })
 * ```
 *
 * `host` binds by NAME, not by guid — deliberately, because the engine resolves
 * this field by name too (a workspace-scoped lookup on the microservice's name).
 * A guid here would not be merely unconventional; it would be wrong.
 */
export function microserviceRequest<
  const As extends string = string,
  const H extends MicroserviceHost = MicroserviceHost,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  a: MicroserviceArgs<H> & PortRequired<H> & { as?: As } & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.microservice.request"`, a, MICROSERVICE_KEYS);
  // Labelled by authoring path, not `mvp:microservice_request`: this wrapper
  // delegates to the generated factory, and a bare statement-name literal here
  // would read as a hand-written encoder to the `?=` coverage audit.
  assertArg("s.microservice.request", "host", a.host);
  assertArg("s.microservice.request", "path", a.path);
  const statement = generated.microservice.request({
    as: a.as,
    host: coerceText(resolveMicroserviceHost(a.host, a.port), `Statement "s.microservice.request": argument "host"`)!,
    path: coerceText(a.path, `Statement "s.microservice.request": argument "path"`)!,
    // `??` (not `||`) so an explicit `false`/`0`/`""` is honored, not defaulted.
    method: coerceText(a.method ?? MICROSERVICE_DEFAULTS.method, `Statement "s.microservice.request": argument "method"`)!,
    params: coerceObj(a.params ?? MICROSERVICE_DEFAULTS.params, `Statement "s.microservice.request": argument "params"`)!,
    headers: coerceHeaders(a.headers ?? MICROSERVICE_DEFAULTS.headers, `Statement "s.microservice.request": argument "headers"`)!,
    timeout: coerceInt(a.timeout ?? MICROSERVICE_DEFAULTS.timeout, `Statement "s.microservice.request": argument "timeout"`)!,
    follow_location: coerceBool(a.follow_location ?? MICROSERVICE_DEFAULTS.follow_location, `Statement "s.microservice.request": argument "follow_location"`)!,
    disabled: a.disabled,
    description: a.description,
    asFilters: a.asFilters as FilterXdo[] | undefined,
    // Read off the authored object at runtime; the generated arg type omits it.
    ...({ mock: a.mock } as object),
  }) as Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>>;
  // A def handle binds by name; the export checks that def is registered.
  const host: unknown = a.host;
  if (host !== null && typeof host === "object" && !isValue(host)) noteMicroserviceHandleHost(statement, (host as MicroserviceDef).name);
  return statement;
}
