/**
 * Middleware kind → payload key `middleware`. Function-like
 * (input/run/result) plus `result_type` (merge|replace) and `exception`
 * (silent|rethrow|critical). Validated against the Xano engine's persisted shape.
 */
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeTests } from "./test.js";
import { resolveMockKeys } from "./test-mocks.js";
import type { TestDef, TestXdo } from "./test.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import { clear } from "./middleware-attach.js";
import { brandDef } from "./def-brand.js";

/**
 * How the middleware's `response` folds into the accumulator of the phase it is
 * **attached** to — and the two phases accumulate different things.
 *
 * - Attached **`post`**, the accumulator is the host's RESULT, so a returned
 *   object changes what the CALLER receives.
 * - Attached **`pre`**, it is the host's REQUEST INPUTS, so a returned object
 *   changes what the HOST receives.
 *
 * `"merge"` (the default) folds key by key; `"replace"` substitutes the whole
 * accumulator. Either way the next entry in the chain sees the updated value.
 *
 * So `pre` + `"replace"` REWRITES THE REQUEST: every caller input the middleware
 * does not re-emit is discarded, and reading a discarded input then fails the
 * request with a 500 even where it is declared `required: false` — input
 * defaulting has already happened by the time the override lands. `pre` is the
 * natural home for an auth or normalization guard, which is exactly where that
 * substitution is least visible.
 */
export type ResultStrategy = "merge" | "replace";
/**
 * What Xano does to the request when the middleware stack **throws** (e.g. a
 * tripped `s.redis.ratelimit`). Xano SDK passes the value through verbatim; the
 * Xano engine interprets it:
 *
 * - `"rethrow"` **(Xano SDK's default)** — the throw aborts the request and the
 *   authored `error`/status surfaces to the caller (a tripped `ratelimit` →
 *   HTTP 429). The `post` chain still runs. This is what a guard-style
 *   middleware wants, and guards are what middleware is mostly used for.
 * - `"silent"` — the throw is swallowed; the host continues as if the
 *   middleware succeeded. For a guard (rate limit, auth check) this means the
 *   guard is **not enforced** — the over-limit request goes through. Set this
 *   only for advisory middleware (logging, metrics) that must never block.
 * - `"critical"` — like `"rethrow"` (same aborted request, same HTTP status) but
 *   additionally **skips the entire `post` middleware chain**. Use it when a
 *   failed `pre` guard should suppress post-processing (audit shaping, response
 *   rewrites) that assumes the host ran.
 *
 * No status or logging difference between `rethrow` and `critical` — the only
 * distinction is whether `post` middleware runs.
 *
 * ## Why Xano SDK defaults to `rethrow` and the engine does not
 *
 * The engine falls back to `silent` when the field is absent. Xano SDK always
 * writes the field, and writes `rethrow`, so nothing here depends on the
 * engine's fallback — the value is explicit in the bundle either way.
 *
 * The default is different on purpose. Verified live: a middleware that throws
 * under `silent` returns the host's normal 200 and the guard is simply not
 * enforced; under `rethrow` the same middleware returns the authored error. An
 * author who writes a rate limiter and does not think about this field gets, by
 * default, a limiter that does nothing and says nothing. An inert guard is
 * worse than a loud one, so the safe reading is the default and the permissive
 * one is opt-in.
 */
export type ExceptionPolicy = "silent" | "rethrow" | "critical";

/**
 * Generic over its branded stack tuple `S`, literal response `Resp`, and
 * declared `Res`, so `InferResponse` can trace a response ref back to the
 * statement that bound it. All default, so a bare `MiddlewareDef`
 * is unchanged.
 *
 * No input generic, deliberately: a middleware's declared `input` is NEVER bound
 * by the host request (see the field below), so typing a payload that cannot be
 * read would be a claim the runtime does not honor.
 */
export interface MiddlewareDef<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "middleware";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /**
   * How this middleware's `response` folds into the phase it is attached to:
   * the host's RESULT in `post`, the host's REQUEST INPUTS in `pre`. Defaults to
   * `"merge"`; `"replace"` in `pre` discards every caller input the middleware
   * does not re-emit. See {@link ResultStrategy}.
   */
  resultStrategy?: ResultStrategy;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"middleware">;
  /**
   * How a throw in the stack affects the request. Defaults to `"rethrow"` — the
   * throw aborts the request and the authored error reaches the caller, which
   * is what a guard wants. Set `"silent"` for advisory middleware that must
   * never block. See {@link ExceptionPolicy}.
   */
  exceptionPolicy?: ExceptionPolicy;
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
   * Request-history capture. Omit to inherit from the workspace. A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. Any value stops inheriting. Middleware defaults OFF. See
   * {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * ⚠ **Never bound.** Declaring an input here is accepted and stored (the
   * engine persists the field, and real workspaces carry one), but the host
   * request does not populate it: `inp("x")` inside a middleware stack fails at
   * runtime with `Unable to locate input: x` — verified live. Read the request
   * body with `s.util.get_all_input` instead, which hands back a
   * `{ type, vars }` envelope — `vars` is the request inputs in `pre` but
   * `{ status, result }` (the host's outcome) in `post`, where the request is
   * read with `s.util.get_raw_input`. `export()` warns if this is set.
   */
  input?: Record<string, InputDescriptor>;
  /**
   * The middleware's statement stack. Captured as the literal tuple `S` (via
   * `middleware()`'s `const` inference) so `InferResponse` can trace a response
   * ref back to the statement that bound it; a dynamically-built `Statement[]`
   * widens it and the trace degrades — declare `responseShape` there.
   */
  stack?: S;
  /** What this middleware hands back (subject to {@link ResultStrategy}).
   * Captured as the literal `Resp` so `InferResponse` can derive its keys. */
  response?: Resp;
  /**
   * Type-only: declare the response shape so `InferResponse<typeof mw>` recovers
   * it exactly, overriding automatic derivation. The runtime value is ignored by
   * `encodeMiddleware`; only its type is read.
   */
  responseShape?: Res;
}

export interface MiddlewareXdo {
  name: string;
  description: string;
  docs: string;
  result_type: ResultStrategy;
  exception: ExceptionPolicy;
  history: { inherit: boolean; enabled: boolean; limit: number };
  tag: Array<{ tag: string }>;
  shared_workspace: { is_shared: boolean };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: TestXdo[];
}

/**
 * Any middleware def, whatever its stack/response — the parameter type every
 * consumer that only READS a def wants. `Res` is widened to `unknown` rather
 * than left at the `never` default, which would reject a def that declares
 * `responseShape`; the same widening `encodeQuery` uses.
 */
export type AnyMiddlewareDef = MiddlewareDef<unknown>;

export function encodeMiddleware(def: AnyMiddlewareDef): MiddlewareXdo {
  if (!def.name) throw new Error("middleware: `name` is required.");
  const xdo: MiddlewareXdo = {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    result_type: def.resultStrategy ?? "merge",
    exception: def.exceptionPolicy ?? "rethrow",
    history: encodeHistory("middleware", def.history),
    tag: encodeTags(def.tags),
    shared_workspace: { is_shared: false },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: encodeStack("middleware", def.name, def.stack),
    test: encodeTests(def.tests, "middleware", def.name),
  };
  // Mocks are authored keyed by TEST NAME and stored keyed by test id.
  // The rewrite needs both the stack and the test list, so it happens here
  // rather than inside any statement factory.
  resolveMockKeys(xdo.run, xdo.test, "middleware", def.name);
  return xdo;
}

export const middlewareKind: ObjectKind<AnyMiddlewareDef, MiddlewareXdo> = {
  name: "middleware",
  payloadKey: "middleware",
  encode: encodeMiddleware,
};
registerKind(middlewareKind);

function middlewareImpl<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(def: MiddlewareDef<Res, Resp, S>): MiddlewareDef<Res, Resp, S> {
  return brandDef(def, "middleware");
}

/**
 * Author a middleware object. Callable as `middleware({…})`; also carries
 * {@link clear} as `middleware.clear()` — the readable spelling of an explicit
 * empty pre/post override (`pre: middleware.clear()` ⇒ customize the phase, run
 * nothing, stop inheriting the parent tier).
 */
export const middleware = Object.assign(middlewareImpl, { clear });
