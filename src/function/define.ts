/**
 * `defineFunction` + the in-memory `FunctionDef` model.
 *
 * The authoring API is a flat declarative factory: data in → JSON out,
 * no hidden control-flow inference.
 */
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { InputDescriptor } from "../inputs/input.js";
import type { Statement } from "../statements/statement.js";
import type { ResponseDef } from "../responses/response.js";
import type { MiddlewareAttach } from "../kinds/middleware-attach.js";
import type { HistoryInput } from "../kinds/history.js";
import type { CacheXdo } from "../types/xdo.js";
import type { TestDef } from "../kinds/test.js";
import { brandDef } from "../kinds/def-brand.js";

export type { ResponseDef };

/**
 * Like {@link QueryDef}, `FunctionDef` is generic over its `input` map `I` so a
 * consumer can recover the exact, branded input types via
 * `InferInput<typeof myFunction>`, and over its declared response shape `Res` so
 * `InferResponse<typeof myFunction>` recovers the read shape (functions share
 * the response system with queries). Both default so every bare-`FunctionDef`
 * use works unchanged; `Res` defaults to `never` (undeclared → derivation).
 */
export interface FunctionDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "function";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /** Deploy-target workspace id. Defaults to 0 (binding deferred). */
  workspace?: number;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"function">;
  input?: I;
  /** The statement stack, captured as the literal tuple `S` — see
   * {@link QueryDef.stack}. Enables `InferResponse`'s single-variable trace. */
  stack?: S;
  /** The response assignment — see {@link QueryDef.response}. Captured as `Resp`
   * so `InferResponse` can auto-derive object-literal keys / trace a variable. */
  response?: Resp;
  /**
   * Type-only: declare the function's response shape so
   * `InferResponse<typeof fn>` recovers it exactly (the override, taking
   * precedence over automatic derivation). The runtime value is ignored by the
   * encoder; only its type is read. See {@link QueryDef.responseShape}.
   */
  responseShape?: Res;
  /**
   * Pre/post middleware attachment. Functions have no API-Group tier — an
   * un-customized phase inherits straight from the workspace. Providing a phase
   * sets its `_customize` flag; `pre: middleware.clear()` overrides with nothing.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit from the workspace (functions have
   * no container tier). A scalar: `false` off, `true` on at default depth, a
   * number = capture depth, `"all"` unlimited. Any value stops inheriting.
   * Functions default OFF. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /**
   * Saved UNIT TESTS — named input sets run against this object, with
   * assertions on the response. The same tests the Xano editor shows.
   *
   * Build assertions with the top-level `expect.*` helpers (NOT `s.expect.*`,
   * which builds workflow-test statements). A statement in this object's stack
   * can return a mock instead of running, per test, via its `mock` option.
   *
   * ⚠ A run uses an EMPTY datasource, so no `table({ seed })` row is visible to
   * it: every `db` read misses, and an assertion on the first row fails against
   * a deployment whose endpoint returns those rows over HTTP. Create what the
   * test needs inside the run — a `defineFunction` fixture the stack calls
   * first — or `mock` the read.
   */
  tests?: TestDef[];
  /**
   * Response caching, in the same block a query carries. Omit for no caching;
   * any setting turns it on unless `active: false`, and the fields left out take
   * `ttl: 3600, input: true, auth: true, datasource: true, ip: false`.
   *
   * A function's cache is shared by EVERY caller, like a global feed: `auth`
   * has no effect here, so a result built from `auth()` is served to whoever
   * calls next. The key is the function plus `input` (the arguments the call
   * binds), `datasource`, `ip`, `headers` and `env` when switched on. Cache
   * per caller on the endpoint instead ({@link QueryDef.cache}).
   *
   * Modelled because it was NOT authorable and the encoder hard-coded the
   * default: a pulled function with caching switched on re-exported with it OFF,
   * so a redeploy silently turned real caching off. See {@link QueryDef.cache}.
   */
  cache?: Partial<CacheXdo>;
}

/**
 * Validate and return a typed `FunctionDef`, preserving the exact branded `input`
 * map on the return type so `InferInput<typeof theFunction>` recovers the input
 * payload type (functions share the input system with queries).
 */
export function defineFunction<
  const I extends Record<string, InputDescriptor> = Record<never, never>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  // See `queryImpl` — an omitted stack defaults to the empty tuple so it is not
  // mistaken for a widened one.
  const S extends readonly Statement[] = readonly [],
>(def: FunctionDef<I, Res, Resp, S>): FunctionDef<I, Res, Resp, S> {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("defineFunction: `name` is required and must be a non-empty string.");
  }
  return brandDef(def, "function");
}
