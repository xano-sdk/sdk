/**
 * Call-family decoders — every statement that invokes another workspace object.
 *
 * The family is uniform in shape: a target guid somewhere in `context`, an
 * optional `as`, and a lean `input[]` of named bindings. The one place it is not
 * Every stored name maps to exactly one authoring surface — including
 * `mvp:function`, which briefly carried a second one (see
 * {@link functionRunDecoder} for why that went away).
 */
import type { TaggedValue } from "../../types/xdo.js";
import { call, lit, obj, type Expr } from "../print.js";
import { SDK_MODULE } from "../context.js";
import { ignored } from "../../values/ignored.js";
import { isBoundNumericId, isReferenceId, isUnboundId, microserviceHost, resolveReference } from "../ref-index.js";
import { s } from "../../statements/s.js";
import { encodeStatement } from "../../statements/statement.js";
import { deepEqual } from "../field.js";
import { decodeFromSpec } from "../spec-inverse.js";
import { decodeValue, describeStored, readValueOrBare } from "../value.js";
import {
  blankRefDetail,
  declineHere,
  getPath,
  prove,
  type SpecialArgs,
  type SpecialDecoder,
} from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** The `input[]` bindings a call carries, as a `{name: Value}` record. */
function callInput(a: SpecialArgs): { expr: Expr; runtime: Record<string, unknown> } | null {
  const entries = Array.isArray(a.stored.input) ? a.stored.input : [];
  const source: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  for (const entry of entries) {
    const name = (entry as { name?: unknown }).name;
    const value = toValue(entry);
    if (typeof name !== "string" || !value)
      return declineHere("call input[]: entry is not a named tagged value");
    // A stored `ignore: true` binding keeps its value and is skipped at
    // runtime; `ignored()` re-encodes the flag.
    if ((entry as { ignore?: unknown }).ignore === true) {
      a.ctx.use(SDK_MODULE, "ignored");
      source.push([name, call("ignored", decodeValue(a.ctx, value))]);
      runtime[name] = ignored(value);
      continue;
    }
    source.push([name, decodeValue(a.ctx, value)]);
    runtime[name] = value;
  }
  return { expr: obj(source), runtime };
}

/** How one call surface locates its target and names it in the authoring args. */
interface CallShape {
  /** The `s.` path to emit. */
  readonly path: string;
  /** The authoring argument holding the target reference. */
  readonly arg: string;
  /** Dotted path to the target guid inside `context`. */
  readonly idPath: string;
  /** Whether the surface accepts `input` bindings. */
  readonly takesInput?: boolean;
  /**
   * The surface's target argument accepts `null`, so a blank stored id decodes as
   * an unbound reference instead of declining.
   *
   * Opt-in per shape because `callDecoder` is shared: only the `mvp:function`
   * surfaces model the unbound state today (see `FnRef`), and offering `null` to a
   * factory that does not take it would just abort inside `prove`.
   */
  readonly unbindable?: boolean;
  /** Extra entries derived from the stored context (headers, auth, …). */
  readonly extra?: (a: SpecialArgs) => {
    entries: Array<[string, Expr]>;
    runtime: Record<string, unknown>;
  } | null;
}

/** Build a decoder for one uniform call surface. */
function callDecoder(shape: CallShape): SpecialDecoder {
  return (a) => {
    const stored = getPath(a.stored.context, shape.idPath);
    if (!isReferenceId(stored))
      return declineHere(`${shape.path}: context.${shape.idPath} is not a reference id`);
    // A blank id is an UNBOUND target, not a decode failure — the statement calls
    // a function that was deleted, or was never bound. Where the surface models
    // that state it is authored as `null`; elsewhere it stays a decline.
    const unbound = isUnboundId(stored);
    if (unbound && shape.unbindable !== true)
      return declineHere(`${shape.path}: context.${shape.idPath} is blank`);
    if (isBoundNumericId(stored))
      return declineHere(`${shape.path}: context.${shape.idPath} is a numeric object reference`);
    const guid = String(stored);

    if (unbound) {
      // Reported, not emitted quietly: presenting a lost binding as a
      // deliberate `null` would hide it. See {@link blankRefDetail}.
      a.ctx.problem(
        "blank-binding",
        blankRefDetail(`${shape.path} has a blank ${shape.arg} reference`, shape.arg),
        shape.path,
      );
    }
    const target = unbound
      ? lit(null)
      : resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" });
    // The runtime side references the target by guid directly: `resolveRef`
    // returns an explicit guid verbatim, so proving does not depend on whether a
    // symbol was available at this call site.
    const entries: Array<[string, Expr]> = [[shape.arg, target]];
    const runtime: Record<string, unknown> = {
      [shape.arg]: unbound ? null : { name: "", guid },
    };

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      entries.push(["as", lit(as)]);
      runtime.as = as;
    }

    if (shape.takesInput !== false) {
      const input = callInput(a);
      if (!input) return null;
      if (Object.keys(input.runtime).length > 0) {
        entries.push(["input", input.expr]);
        runtime.input = input.runtime;
      }
    }

    if (shape.extra) {
      const extra = shape.extra(a);
      if (!extra) return null;
      entries.push(...extra.entries);
      Object.assign(runtime, extra.runtime);
    }

    return prove(a.ctx, a.stored, shape.path, [runtime], [obj(entries)]);
  };
}

/** `api.call`'s optional header override and token auth. */
const apiCallExtra: CallShape["extra"] = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};

  const headers = toValue(context.headers);
  if (context.headers !== undefined) {
    if (!headers) return declineHere("api.call: context.headers is not a tagged value");
    entries.push(["headers", decodeValue(a.ctx, headers)]);
    runtime.headers = headers;
  }

  if (context.token !== undefined) {
    // Two stored generations of one slot: the tagged value a live capture holds,
    // and the bare string the engine's own schema declares (`token?="": text`).
    // Read either, carry back what was there.
    const token = readValueOrBare(a.ctx, context.token);
    if (!token)
      return declineHere(
        `api.call: context.token is neither a tagged value nor a scalar (${describeStored(context.token)})`,
      );
    const authEntries: Array<[string, Expr]> = [["token", token.expr]];
    const auth: Record<string, unknown> = { token: token.runtime };
    if (context.token_ignore_expiration === true) {
      authEntries.push(["ignoreExpiration", lit(true)]);
      auth.ignoreExpiration = true;
    }
    entries.push(["auth", obj(authEntries)]);
    runtime.auth = auth;
  }
  return { entries, runtime };
};

/**
 * The TOP-LEVEL `runtime` block that makes a call asynchronous.
 *
 * The engine switches on `runtime.mode` and recognizes exactly two values:
 * `async-shared` builds its runtime config from `mode` alone, and
 * `async-dedicated` additionally reads `cpu`/`memory`/`max_retry`/`timeout`.
 * Every other value — the absent block, `null`, and the editor's explicit
 * `"disabled"` — falls to the default arm, which is synchronous.
 *
 * So a non-async block carries nothing and is not authored back; anything else
 * would be noise on the 222 synchronous calls in the survey corpus that store
 * `null` or nothing at all.
 */
export function asyncRuntimeExtra(path: string): NonNullable<CallShape["extra"]> {
  return (a) => {
    const block = (a.stored as { runtime?: unknown }).runtime;
    if (block === null || block === undefined) return { entries: [], runtime: {} };
    if (typeof block !== "object" || Array.isArray(block))
      return declineHere(`${path}: \`runtime\` is present but not a block`);
    const mode = (block as { mode?: unknown }).mode;
    if (mode !== "async-shared" && mode !== "async-dedicated")
      return { entries: [], runtime: {} };

    const cells: Array<[string, Expr]> = [["mode", lit(mode)]];
    const runtime: Record<string, unknown> = { mode };
    // The dedicated resources, and ONLY at the mode that reads them. At
    // `async-shared` the editor writes all four blank and the engine never looks
    // at them, so carrying them across would author inert members.
    if (mode === "async-dedicated") {
      for (const [stored, arg] of [
        ["cpu", "cpu"],
        ["memory", "memory"],
        ["timeout", "timeout"],
        ["max_retry", "maxRetry"],
      ] as const) {
        const v = (block as Record<string, unknown>)[stored];
        if (typeof v !== "string" && typeof v !== "number")
          return declineHere(`${path}: \`runtime.${stored}\` is not a scalar`);
        if (v === "") continue;
        cells.push([arg, lit(String(v))]);
        runtime[arg] = String(v);
      }
    }
    return { entries: [["runtime", obj(cells)]], runtime: { runtime } };
  };
}

/**
 * `mvp:function` — one stored name, one authoring surface.
 *
 * There is no `service.function.run` surface to branch to. No workspace holds
 * a connected-service function, and `runtime_mode` is not a stored key at all —
 * it is the XanoScript SOURCE spelling of the top-level runtime block (see
 * {@link asyncRuntimeExtra}), which the engine's transform emits and re-parses.
 * The real discriminator would be `context.service.guid`.
 */
const functionRunDecoder: SpecialDecoder = callDecoder({
  path: "function.run",
  arg: "fn",
  idPath: "function.id",
  unbindable: true,
  extra: asyncRuntimeExtra("function.run"),
});

/**
 * `s.microservice.request` whose `host` text names a microservice in the bundle,
 * re-linked to that def's handle (`host: analytics, port: "8080"`) instead of
 * the stored `c.text("analytics:8080")` — so a rename follows and the def's
 * ports are checked. The rest is the spec inverse's proven decode; the host
 * swap is proven on its own, by re-encoding the def form against the stored text.
 */
const microserviceRequestDecoder: SpecialDecoder = (a) => {
  const link = microserviceHost(a.refs, a.stored);
  if (!link) return null;
  const hostText = link.port === undefined ? link.target.name : `${link.target.name}:${link.port}`;
  const def = {
    name: link.target.name,
    deployment: { containers: [{ ports: (link.target.ports ?? []).map((servicePort) => ({ servicePort })) }] },
  };
  const hostOf = (args: Record<string, unknown>): unknown =>
    (encodeStatement(s.microservice.request({ path: "/", ...args } as never)).input as Array<{ name?: unknown }>).find(
      (e) => e.name === "host",
    );
  try {
    const port = link.port === undefined ? {} : { port: link.port };
    if (!deepEqual(hostOf({ host: def, ...port }), hostOf({ host: hostText }))) return null;
  } catch {
    return null;
  }
  const symbol = resolveReference(a.ctx, a.refs, link.target.guid, a.resolve);
  if (symbol.kind !== "id") return null;
  const decoded = decodeFromSpec(a.ctx, a.stored);
  const call_ = decoded?.kind === "spread" ? decoded.base : decoded;
  const args = call_?.kind === "call" ? call_.args[0] : undefined;
  if (!decoded || call_?.kind !== "call" || args?.kind !== "object") return null;
  const entries = args.entries.flatMap(([key, value]): Array<readonly [string, Expr]> =>
    key !== "host" ? [[key, value]] : link.port === undefined ? [["host", symbol]] : [["host", symbol], ["port", lit(link.port)]],
  );
  const relinked = { ...call_, args: [obj(entries), ...call_.args.slice(1)] };
  return decoded.kind === "spread" ? { ...decoded, base: relinked } : relinked;
};

/** Call-family decoders by stored name. */
export const CALL_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  ["mvp:microservice_request", microserviceRequestDecoder],
  ["mvp:function", functionRunDecoder],
  ["mvp:workspace_run_function", callDecoder({ path: "function.call", arg: "fn", idPath: "id" })],
  [
    "mvp:workspace_run_endpoint",
    callDecoder({ path: "api.call", arg: "api", idPath: "id", extra: apiCallExtra }),
  ],
  [
    "mvp:workspace_run_task",
    callDecoder({ path: "task.call", arg: "task", idPath: "id", takesInput: false }),
  ],
  ["mvp:workspace_run_tool", callDecoder({ path: "tool.call", arg: "tool", idPath: "id" })],
  [
    "mvp:workspace_run_trigger",
    callDecoder({ path: "trigger.call", arg: "trigger", idPath: "id" }),
  ],
  [
    "mvp:workspace_run_middleware",
    callDecoder({ path: "middleware.call", arg: "middleware", idPath: "id" }),
  ],
  ["mvp:workspace_run_addon", callDecoder({ path: "addon.call", arg: "addon", idPath: "id" })],
]);
