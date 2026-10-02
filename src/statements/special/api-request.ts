/**
 * Hand-authored typed wrappers for the HTTP-request statement family — the
 * "External API Request" (`api.request`) and its siblings `stream.from_request`
 * and `webflow.request`. Each has a generated bare-`Value`
 * factory because the codegen source YAML types every field as generic
 * `!kinds assign`; the engine's *runtime* schema is stricter (method enum, int
 * timeout, object params, string-array headers, booleans) and the frontend
 * enforces that shape. These wrappers surface ergonomic, literal-friendly types
 * (each still accepting a dynamic {@link Value}) and delegate encoding to the
 * generated factory, so the emitted statement stays byte-identical to the
 * generated path. Shared coercion + TLS validation live in {@link ./coerce.ts}.
 *
 * TLS/mTLS field interdependencies are validated at build time only when the
 * combination is statically provable-invalid (see `assertSslConsistency`); a
 * dynamic `Value` is never rejected. `description` (Settings tab) and `output`
 * (Output tab) ride the envelope where the statement carries one — today only
 * `api.request` does (its siblings are lean specs).
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import type { Value } from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import type { OutputAuthored } from "../schema-dsl/interpret.js";
import { annotate } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";
import {
  type HttpMethod,
  type HttpRequestFields,
  coerceText,
  coerceHttpFields,
  assertSslConsistency,
} from "./coerce.js";
import { argsOrEmpty } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

export type { HttpMethod };

/**
 * The `{request, response}` envelope every external-request statement binds to
 * its `as` variable (`api.request`, `webflow.request`, `microservice.request`). Shape
 * confirmed against the Xano engine and a live run: `headers` are
 * arrays of raw `"Name: value"` lines, `result` is the response body (JSON-decoded
 * when possible, else the raw string — hence `unknown`), `status` the HTTP code,
 * and `error` is present only on a transport-level (curl) failure.
 */
export interface ApiRequestResult {
  request: {
    url: string;
    method: string;
    headers: string[];
    params: unknown;
  };
  response: {
    headers: string[];
    result: unknown;
    status: number;
    error?: { code: number; message: string };
  };
}

// ── api.request ──────────────────────────────────────────────────────────────

export interface ApiRequestArgs extends HttpRequestFields, StatementAnnotations {
  /** Capture the response (`{request, response}`) into this stack variable. */
  as?: string;
  /** Request URL. Required: the engine declares it with no default, and no stored request omits it. */
  url: string | Value;
  /** Per-statement description (frontend "Settings" tab). */
  description?: string;
  /** Output-envelope shaping — result-variable filter chain / field mapping (frontend "Output" tab). */
  output?: OutputAuthored;
}

const API_REQUEST_KEYS = /* @__PURE__ */ Object.keys({ as: 1, url: 1, output: 1, method: 1, params: 1, headers: 1, timeout: 1, follow_location: 1, verify_host: 1, verify_peer: 1, ca_certificate: 1, certificate: 1, certificate_pass: 1, private_key: 1, private_key_pass: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ApiRequestArgs & { asFilters?: unknown }>, 1>);

/**
 * `api.request` — issue an external HTTP request. Ergonomic, literal-friendly
 * field types over the generated `mvp:api_request` factory; delegates encoding
 * to it for byte-parity. Any field also accepts a dynamic {@link Value}.
 *
 * `method` suggests the 7 verbs, `params` is a key/value object (→ query string
 * for GET/HEAD/OPTIONS, body otherwise), `headers` an array of full header-line
 * strings, `timeout` seconds (engine bounds 1–86400), and the verify/follow
 * flags booleans.
 *
 * A plain-object `params` may carry tagged values (`inp`/`ref`/`c.*`) at the TOP
 * LEVEL only — each is lifted onto a `const:obj` via a `set` filter. Nest one
 * inside an object or array and encoding throws, because `const:obj` embeds a
 * plain JSON constant. For a body with any structure, wrap the whole thing in
 * `obj({...})`, which encodes any depth as a single `const:expr2`.
 */
export function apiRequest<const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  a: ApiRequestArgs & { as?: As; asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.api.request"`, a, API_REQUEST_KEYS);
  assertSslConsistency('Statement "s.api.request"', a);
  return generated.api.request({
    as: a.as,
    url: coerceText(a.url, `Statement "s.api.request": argument "url"`),
    ...coerceHttpFields(a),
    disabled: a.disabled,
    description: a.description,
    output: a.output,
    asFilters: a.asFilters as FilterXdo[] | undefined,
    // Read off the authored object at runtime; the generated arg type omits it.
    ...({ mock: a.mock } as object),
  }) as Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>>;
}

// ── stream.from_request ──────────────────────────────────────────────────────

export interface StreamFromRequestArgs extends HttpRequestFields, StatementAnnotations {
  /** Capture the streaming response into this stack variable. */
  as?: string;
  /** Request URL. Required: shares `api.request`'s declaration, which has no default. */
  url: string | Value;
}

const STREAM_FROM_REQUEST_KEYS = /* @__PURE__ */ Object.keys({ as: 1, url: 1, method: 1, params: 1, headers: 1, timeout: 1, follow_location: 1, verify_host: 1, verify_peer: 1, ca_certificate: 1, certificate: 1, certificate_pass: 1, private_key: 1, private_key_pass: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<StreamFromRequestArgs>, 1>);

/**
 * `stream.from_request` — stream an external HTTP request (`mvp:streaming_api_request`).
 * Same typed field surface as {@link apiRequest}; delegates to the generated factory.
 */
export function streamFromRequest(a: StreamFromRequestArgs): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.stream.from_request"`, a, STREAM_FROM_REQUEST_KEYS);
  assertSslConsistency('Statement "s.stream.from_request"', a);
  return annotate(generated.stream.from_request({
    as: a.as,
    url: coerceText(a.url, `Statement "s.stream.from_request": argument "url"`),
    ...coerceHttpFields(a, "s.stream.from_request"),
  }), a);
}

// ── webflow.request ──────────────────────────────────────────────────────────

/**
 * `headers` is deliberately absent. The engine builds its own header list for
 * this statement — the API version and the connection's bearer token — and
 * never reads an authored one, so offering the field would let an author send
 * an auth header into a void that round-trips perfectly. See `UNREAD_INPUT`.
 */
export interface WebflowRequestArgs
  extends Omit<HttpRequestFields, "headers">,
    StatementAnnotations {
  /** Capture the response into this stack variable. */
  as?: string;
  /** Request path (relative to the Webflow API host). Required: the engine rejects an empty one. */
  path: string | Value;
}

// The declared keys, plus `headers`: not offered by the type (that is the
// refusal), but a stored request may carry one and must re-encode byte for byte.
const WEBFLOW_REQUEST_KEYS = [.../* @__PURE__ */ Object.keys({ as: 1, path: 1, method: 1, params: 1, timeout: 1, follow_location: 1, verify_host: 1, verify_peer: 1, ca_certificate: 1, certificate: 1, certificate_pass: 1, private_key: 1, private_key_pass: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<WebflowRequestArgs & { asFilters?: unknown }>, 1>), "headers"];

/**
 * `webflow.request` — call the Webflow API (`mvp:connect_webflow_api_request`).
 * Like {@link apiRequest} but addressed by `path` (the host is engine-supplied).
 */
export function webflowRequest<const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  a: WebflowRequestArgs & { as?: As; asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.webflow.request"`, a, WEBFLOW_REQUEST_KEYS);
  assertSslConsistency('Statement "s.webflow.request"', a);
  return generated.webflow.request({
    as: a.as,
    path: coerceText(a.path, `Statement "s.webflow.request": argument "path"`),
    ...coerceHttpFields(a, "s.webflow.request"),
    disabled: a.disabled,
    description: a.description,
    asFilters: a.asFilters as FilterXdo[] | undefined,
    // Read off the authored object at runtime; the generated arg type omits it.
    ...({ mock: a.mock } as object),
  }) as Statement & AsShapeBrand<As, ApplyFilters<ApiRequestResult, Fs>>;
}
