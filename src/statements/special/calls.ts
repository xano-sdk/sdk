/**
 * Hand-authored call-family block statements — invoking another workspace
 * object from a stack. These carry `!class` transforms in the engine
 * (FunctionRun, FunctionCall, ApiCall, …) so they're authored by hand.
 *
 * Each stores a **cross-object reference** to its target. In a packageExport
 * bundle that reference is the target's guid (the engine's exportTypeId maps a
 * local id → guid on export); xanosdk resolves the authored target → its
 * deterministic guid via `resolveRef` (see refs/guid.ts), so the emitted call
 * and the target object's payload `guid` agree and the import remaps both.
 *
 * Stored shapes (from the Xano engine's persisted context shapes):
 *   function.run     → mvp:function                 ctx { function: { id:<guid> } }   [+input]
 *   function.call    → mvp:workspace_run_function    ctx { id:<guid> }                 [+input]
 *   api.call         → mvp:workspace_run_endpoint     ctx { id:<guid> }                 [+input]
 *   task.call        → mvp:workspace_run_task         ctx { id:<guid> }
 *   tool.call        → mvp:workspace_run_tool         ctx { id:<guid> }                 [+input]
 *   trigger.call     → mvp:workspace_run_trigger      ctx { id:<guid> }                 [+input]
 *   middleware.call  → mvp:workspace_run_middleware   ctx { id:<guid> }                 [+input]
 *   addon.call       → mvp:workspace_run_addon        ctx { id:<guid> }                 [+input]
 *
 * The target object's id resolves to a guid keyed by the engine's migrate
 * *type*: function.run/call → "function", api.call → "query" (an API endpoint
 * is a `query` object), and the rest map name-for-name.
 *
 * Scope: connected-service functions are OUT, permanently — they were never
 * released in Xano, so no engine produces the shape and no workspace can hold
 * one. `mvp:function` therefore has exactly one authoring surface, storing the
 * default payload. Async execution IS modelled (see {@link AsyncRuntime});
 * api.call emits the `headers`/`auth` blocks (verb/name/api_group are
 * engine-derived, not stored).
 *
 * `action.call` / `action.package.call` are the exception to the paragraph
 * above: their target is NOT a workspace object, so no id is derived for them
 * and the author supplies one. See {@link ActionCallArgs} for why.
 */
// Evidence, 2026-09-02. `function.run` (mvp:function), `api.call` (context.token
//   confirmed tagged) and `function.call` (mvp:workspace_run_function) are
//   golden-verified. The other six members — task/tool/trigger/middleware/addon
//   and workflow_test — were deployed to a throwaway ephemeral and read back,
//   and all six persisted exactly what is emitted here, twice. That settled two
//   defaults that had been read out of the engine's format rather than measured:
//   `workflow_test`'s `context.datasource` is stored at its empty default rather
//   than dropped, and `task.call`'s fixed empty `input[]` survives the round
//   trip.
// Evidence, 2026-09-05. The two action members are settled, by two different
//   routes because they are reachable in two different ways.
//
//   `action.call` came from a REAL WORKSPACE: one that has "Get Hypotenuse"
//   installed stores an `mvp:action`, vendored as
//   test/fixtures/statements/action_call.json and wired into the conformance
//   corpus. The same bundle's `run_install` record carries the install-assigned
//   `run_.version.id`, and it is the value the statement points at — so the
//   claim that `context.run_version.id` is assigned at install and cannot be
//   derived from a name is demonstrated by the bytes rather than argued.
//
//   `action.package.call` had no such workspace, so it was deployed to a
//   throwaway ephemeral and read back (scripts/probe-action-package.ts). All
//   three identity members persisted verbatim at their declared paths, a
//   POPULATED `settings_registry` survived unchanged, and the engine did not
//   resolve the package at import — it stores the ids unexamined. The already
//   captured `action.call` rode along as the control.
//
//   What neither route proves, and what no encoder test could: that an id
//   addresses a real installed package. The SDK never inspects it, which is the
//   whole design — see {@link ActionCallArgs}.
//
//   One asymmetry the corpus row cannot see: `id` is a global strip key in
//   normalize.ts, so the deep-equal there is blind to `run_version.id` and to
//   `package_version.id`. The verbatim carriage is asserted directly in
//   test/statements/calls.test.ts and in the probe's recorded raw bytes.
import type { Statement, AsShapeBrand } from "../statement.js";
import type { StatementOptions } from "../statement.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import type { InferResponse } from "../../responses/infer.js";
import { registerStatement, annotate } from "../statement.js";
import type { Value } from "../../values/value.js";
import { isTaggedValue } from "../../values/value.js";
import { isIgnored } from "../../values/ignored.js";
import { resolveQueryRef, resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { coerceScalar, coerceHeaders } from "./coerce.js";
import type { HeaderMap } from "./coerce.js";
import { encodeAsyncRuntime } from "./async-runtime.js";
import type { AsyncRuntime } from "./async-runtime.js";
import type { InputValue } from "./coerce.js";
import type { XanoDbLink } from "../../fields/value-types.js";
import { argsOrEmpty, assertArg, describeEntry, isRecordArg, isTaggedArg } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

/** A call/agent `{name: value}` input map — raw scalar literals coerce to constants. */
export type CallInput = Record<string, InputValue>;

/** Whether an input map holds an `input.dbLink`, whose COLUMNS are the inputs a call binds. */
type HasDbLink<I> = true extends {
  [K in keyof I]: I[K] extends { readonly __value?: infer V }
    ? [V] extends [XanoDbLink] ? ([XanoDbLink] extends [V] ? true : false) : false
    : false;
}[keyof I]
  ? true
  : false;

/**
 * The input names a call target's type declares: `string` when its type does
 * not say (a name, a `{ name, guid }`, a widened def, a dbLink input), `never`
 * when it declares none.
 */
type TargetInputKeys<T> = T extends { readonly input?: infer I }
  ? I extends Record<string, unknown>
    ? string extends keyof I
      ? string
      : HasDbLink<I> extends true
        ? string
        : keyof I & string
    : string
  : string;

/**
 * A call's `input`, keyed by the target's declared inputs, so a misspelt key is
 * a compile error. A target whose inputs its type does not show takes any key.
 * `RawWhenEmpty`: the target's bag is the raw request when it declares no inputs
 * (an endpoint, a tool), so any key reaches it.
 */
export type CallInputFor<T, RawWhenEmpty extends boolean = false> =
  string extends TargetInputKeys<T>
    ? CallInput
    : [TargetInputKeys<T>] extends [never]
      ? RawWhenEmpty extends true
        ? CallInput
        : NoInputs
      : { [K in TargetInputKeys<T>]?: InputValue };

/**
 * The `input` of a target that declares none: an object literal naming any key
 * is an excess-property error, while a `Record<string, Value>` built elsewhere
 * still assigns — which is what lets a helper generic over the def
 * (`<T extends AnyFunctionDef>(fn: T, input: Record<string, Value>)`) pass its
 * `input` through, since every branch of {@link CallInputFor} accepts it.
 */
type NoInputs = { readonly "(this target declares no inputs)"?: undefined };

/** A stored tagged-value triple `{value, tag, filters}`. */
function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/**
 * Encode a call's `{name: value}` input map into the stored `input[]` entries.
 * Each value is coerced via {@link coerceScalar}, so a raw literal (`{ n: 3 }`)
 * works alongside a tagged {@link Value} (`{ n: inp("n") }`).
 *
 * An `ignored()` value is stored with `ignore: true`: the engine keeps the
 * value on record and does not bind it, so the target falls back to its own
 * default.
 */
function encodeCallInput(input: CallInput | undefined, statement: string, field = "input"): unknown[] {
  // `null` is the absent map it means.
  if (input === undefined || input === null) return [];
  if (typeof input !== "object" || Array.isArray(input) || isTaggedValue(input)) {
    throw new Error(
      `Statement "${statement}": argument "${field}" must be a { name: value } record — got ${describeEntry(input)}.`,
    );
  }
  // An entry set to `undefined` is left out, as JavaScript leaves it out of
  // JSON; `null` is a literal the target receives (see `coerceScalar`).
  return Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([name, v]) => ({ name, ...vf(coerceScalar(v)), ...(isIgnored(v) ? { ignore: true } : {}) }));
}

/**
 * A call's target function — a def handle or name, or `null` for the engine's own
 * empty binding (`context.function.id: ""`).
 *
 * ⚠ **Do not author `null`.** It is a BROKEN state in Xano, not a neutral one:
 * the statement calls nothing. It exists so `codegen` can represent a broken
 * statement faithfully rather than degrade it to `raw()` — a pulled `fn: null` is
 * a defect to fix in the pulled workspace, not a shape to copy. Same contract as
 * a db statement's `table` and an addon's, which is where the pattern comes from.
 */
type FnRef = ObjectRef | null;

/** A target function's stored id — `""` for an unbound one (see {@link FnRef}). */
function fnId(fn: FnRef): string {
  return fn === null ? "" : resolveRef("function", fn, `Statement "s.function.run": argument "fn"`);
}

export interface FunctionRunArgs<
  Fn extends FnRef = FnRef,
  As extends string = string,
  R extends AsyncRuntime | undefined = AsyncRuntime | undefined,
> extends StatementOptions {
  /** The target function (def handle or name), or `null` when unbound. */
  fn: Fn;
  /** Capture the result into this stack variable. */
  as?: As;
  /** Input bindings, keyed by the target's input names. */
  input?: CallInputFor<Fn>;
  /**
   * Run the function in the background instead of inline. Omit for a normal
   * synchronous call. See {@link AsyncRuntime} — an async call does NOT return
   * the function's result: `as` binds the run's job id (a UUID string) for
   * `s.await({ ids })`.
   */
  runtime?: R;
}

const FUNCTION_RUN_KEYS = /* @__PURE__ */ Object.keys({ fn: 1, as: 1, input: 1, runtime: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<FunctionRunArgs>, 1>);

/**
 * `function.run <fn>` — run another function inline.
 *
 * Branded `AsShapeBrand<As, InferResponse<Fn>>`: the bound variable
 * carries the TARGET's response type, so `ref("<as>.field")` in the caller's
 * response types to that field instead of `unknown`. See {@link functionCall}
 * for what the propagation can and cannot see.
 *
 * An ASYNC run (`runtime` given) is rewritten by the engine to its async form,
 * which dispatches and binds the run's JOB ID — a UUID string — not the result.
 * So its `as` is branded `string`: that id is what `s.await({ ids })` takes.
 */
export function functionRun<
  const Fn extends FnRef = FnRef,
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
  const R extends AsyncRuntime | undefined = undefined,
>(
  args: FunctionRunArgs<Fn, As, R> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<RunBinding<Fn, R>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.function.run"`, args, FUNCTION_RUN_KEYS);
  // `fn: null` is the unbound call a pulled workspace stores when the target
  // function was deleted — an authored answer, so only absence is refused.
  assertArg("s.function.run", "fn", args.fn, { nullable: true });
  return annotate({
    name: "mvp:function",
    context: { function: { id: fnId(args.fn) } },
    as: args.as,
    input: encodeCallInput(args.input as CallInput | undefined, "s.function.run"),
    runtime: encodeAsyncRuntime(args.runtime),
  }, args) as Statement & AsShapeBrand<As, ApplyFilters<RunBinding<Fn, R>, Fs>>;
}

/**
 * What `s.function.run`'s `as` binds: the target's response inline, the job id
 * (a string) when a `runtime` makes it async. Non-distributive, so an explicit
 * `R` of `AsyncRuntime | undefined` yields the union rather than a guess.
 */
export type RunBinding<Fn, R> = [R] extends [undefined]
  ? InferResponse<Fn>
  : [R] extends [AsyncRuntime]
    ? string
    : string | InferResponse<Fn>;

export interface FunctionCallArgs<Fn extends ObjectRef = ObjectRef, As extends string = string>
  extends StatementOptions {
  fn: Fn;
  as?: As;
  input?: CallInputFor<Fn>;
}

const FUNCTION_CALL_KEYS = /* @__PURE__ */ Object.keys({ fn: 1, as: 1, input: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<FunctionCallArgs>, 1>);

/**
 * `function.call <fn>` — invoke a function as a workspace run.
 *
 * Branded `AsShapeBrand<As, InferResponse<Fn>>`. `InferResponse` of
 * the TARGET is exactly what a client would get back from it, so drilling into
 * the binding now types:
 *
 * ```ts
 * stack: [s.function.call({ fn: calculateDiscount, input: {…}, as: "discount" })],
 * response: { cents: ref("discount.discount_cents") },   // number, was unknown
 * ```
 *
 * What it can see is what `InferResponse` can see on the target: a declared
 * `responseShape` always, and otherwise the target's own auto-derivation (object
 * literal keys, a variable traced to a typed `db.*`). A target whose response
 * bottoms out at `unknown` — or one named by STRING rather than by def handle,
 * where there is no def to read — propagates that `unknown` unchanged. Declaring
 * `responseShape` on the TARGET fixes every caller at once, which is why that
 * remains the recommendation for a response the walk cannot resolve.
 */
export function functionCall<
  const Fn extends ObjectRef = ObjectRef,
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: FunctionCallArgs<Fn, As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Fn>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.function.call"`, args, FUNCTION_CALL_KEYS);
  assertArg("s.function.call", "fn", args.fn);
  return annotate({
    name: "mvp:workspace_run_function",
    context: { id: resolveRef("function", args.fn, `Statement "s.function.call": argument "fn"`) },
    as: args.as,
    input: encodeCallInput(args.input as CallInput | undefined, "s.function.call"),
  }, args) as Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Fn>, Fs>>;
}

/** The type of `s.api.call`'s non-argument `query`, whose one member names the fix. */
export type EndpointGoesInApi = { readonly "s.api.call takes the endpoint as `api`, not `query`": never };

export interface ApiCallArgs<Api extends ObjectRef = ObjectRef, As extends string = string>
  extends StatementOptions {
  /** The target API endpoint (a `query` object). */
  api: Api;
  /**
   * Not an argument: the endpoint to call goes in `api` — `s.api.call({ api: myQuery })`.
   * Declared so the misspelling is reported HERE, rather than as a baffling
   * `"list"` is not assignable to `""` on `as`.
   */
  query?: EndpointGoesInApi;
  as?: As;
  input?: CallInputFor<Api, true>;
  /**
   * Replace the request headers the called endpoint sees. Same shape as
   * `s.api.request`'s: a `{ "Name": value }` record (values may be tagged), a
   * `string[]` of full `"Name: value"` lines, or one whole `Value`.
   *
   * ⚠ This is the ONLY slot that authenticates a call with a token computed
   * during the run — an `Authorization` header is read and applied as the
   * caller's token, while `auth.token` is a static string (see {@link ApiCallArgs.auth}):
   *
   * ```ts
   * s.api.call({ api: signup, input: {…}, as: "signup" }),
   * s.api.call({ api: checkout, headers: { Authorization: ref("signup.authToken") } }),
   * ```
   *
   * Send `Authorization` only to an endpoint that declares `auth` — the engine
   * enforces that the token's table matches the target's, and a target with no
   * `auth` rejects any token as belonging to a different object type.
   */
  headers?: readonly string[] | HeaderMap | Value;
  /**
   * Authenticate the call with a STATIC token, and optionally ignore its expiry.
   *
   * ⚠ `token` is stored in a slot the engine declares as plain text and does NOT
   * evaluate, so a tagged `Value` — `ref("signup.authToken")`, `env("TOKEN")` —
   * is rejected at runtime with `Param: token - Text filter requires an integer,
   * float, string or boolean value`, even though it deploys clean. Only a bare
   * **string** runs. For a token minted during the run, use an `Authorization`
   * entry in {@link ApiCallArgs.headers} instead.
   *
   * The `Value` spelling stays accepted so a pulled workspace holding one
   * round-trips as itself — it is a shape to carry, not to author.
   */
  auth?: { token: Value | string; ignoreExpiration?: boolean };
}

/**
 * A header name as a real request delivers it to an endpoint: each `-` segment
 * lowercased with its first letter raised (`x-api-key` → `X-Api-Key`).
 */
function deliveredName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

/**
 * Respell `api.call`'s header names the way production delivers them.
 *
 * A real request's names reach the endpoint Title-Cased, but a workflow test's
 * call hands them over exactly as written — so an endpoint reading
 * `X-Sync-Secret` passed a test that sent `x-sync-secret` and then rejected the
 * same client in production. Measured on an ephemeral. A whole `Value` passes
 * through: its names are only known at run time.
 */
function asDelivered(headers: ApiCallArgs["headers"]): ApiCallArgs["headers"] {
  // `null` is absent; a wrong-typed field or line passes through untouched so
  // `coerceHeaders` refuses it with the argument named.
  if (headers === undefined || headers === null) return undefined;
  if (isTaggedValue(headers) || typeof headers !== "object") return headers;
  if (Array.isArray(headers)) {
    return (headers as readonly unknown[]).map((line): unknown => {
      if (typeof line !== "string") return line;
      const colon = line.indexOf(":");
      return colon === -1 ? line : deliveredName(line.slice(0, colon)) + line.slice(colon);
    }) as readonly string[];
  }
  const delivered: Record<string, HeaderMap[string]> = {};
  for (const [name, value] of Object.entries(headers as HeaderMap)) {
    const as = deliveredName(name);
    if (Object.hasOwn(delivered, as)) {
      throw new Error(
        `Statement "s.api.call": headers name "${as}" twice (as ${JSON.stringify(name)} and another spelling) — ` +
          "a real request delivers both under that one name, so only one can reach the endpoint.",
      );
    }
    delivered[as] = value;
  }
  return delivered;
}

const API_CALL_KEYS = /* @__PURE__ */ Object.keys({ api: 1, query: 1, as: 1, input: 1, headers: 1, auth: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ApiCallArgs>, 1>);

/**
 * `api.call <endpoint>` — invoke an API endpoint as a workspace run. The stored
 * `context` is `{ id, headers?, token?, token_ignore_expiration? }` (the engine
 * derives name/verb/api_group from the referenced query at encode time, so they
 * are intentionally NOT stored). Shape modeled on the engine's stored api-call format.
 *
 * `context.headers` is a tagged value the engine EVALUATES, so it carries a
 * runtime-computed `Authorization`. `context.token` is not: the engine declares
 * that slot as plain text, so a tagged token round-trips byte-for-byte (the
 * golden pins that) and is then rejected the moment the statement runs. See
 * {@link ApiCallArgs.auth}.
 */
export function apiCall<
  const Api extends ObjectRef = ObjectRef,
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: ApiCallArgs<Api, As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Api>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.api.call"`, args, API_CALL_KEYS);
  if ((args as { query?: unknown }).query !== undefined && args.api === undefined) {
    throw new Error(`Statement "s.api.call": the endpoint goes in \`api\`, not \`query\` — s.api.call({ api: myQuery, … }).`);
  }
  assertArg("s.api.call", "api", args.api);
  // Query identity is composed from (apiGroup, verb, name), so this target
  // resolves through the query-aware sibling of `resolveRef`: a def handle
  // carries all three components, a `{ name, guid }` pair addresses by explicit
  // identity, and a bare name is refused with the fix.
  const context: Record<string, unknown> = { id: resolveQueryRef(args.api, `Statement "s.api.call": argument "api"`) };
  const headers = coerceHeaders(asDelivered(args.headers), `Statement "s.api.call": argument "headers"`);
  if (headers) context.headers = vf(headers);
  if (args.auth !== undefined && args.auth !== null) {
    const auth = args.auth as unknown;
    const token = isRecordArg(auth) ? auth.token : undefined;
    if (!isRecordArg(auth) || (typeof token !== "string" && !isTaggedArg(token))) {
      throw new Error(
        `Statement "s.api.call": argument "auth" must be { token, ignoreExpiration? } with token a string or a tagged value — got ` +
          `${isRecordArg(auth) ? `token ${describeEntry(token)}` : describeEntry(auth)}.`,
      );
    }
    // Written in the spelling it was authored in. Promoting a bare token to the
    // tagged form would rewrite bytes the workspace holds for no gain — the
    // engine reads either.
    context.token =
      typeof args.auth.token === "string" ? args.auth.token : vf(args.auth.token);
    if (args.auth.ignoreExpiration) context.token_ignore_expiration = true;
  }
  return annotate({
    name: "mvp:workspace_run_endpoint",
    context,
    as: args.as,
    input: encodeCallInput(args.input as CallInput | undefined, "s.api.call"),
  }, args) as Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Api>, Fs>>;
}

export interface TaskCallArgs extends StatementOptions {
  /** The target background task. */
  task: ObjectRef;
  as?: string;
}

const TASK_CALL_KEYS = /* @__PURE__ */ Object.keys({ task: 1, as: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<TaskCallArgs>, 1>);

/** `task.call <task>` — invoke a task as a workspace run (no input). */
export function taskCall(args: TaskCallArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.task.call"`, args, TASK_CALL_KEYS);
  assertArg("s.task.call", "task", args.task);
  return annotate({
    name: "mvp:workspace_run_task",
    context: { id: resolveRef("task", args.task, `Statement "s.task.call": argument "task"`) },
    as: args.as,
    input: [],
  }, args);
}

export interface ToolCallArgs<Tool extends ObjectRef = ObjectRef, As extends string = string>
  extends StatementOptions {
  tool: Tool;
  as?: As;
  input?: CallInputFor<Tool, true>;
}

const TOOL_CALL_KEYS = /* @__PURE__ */ Object.keys({ tool: 1, as: 1, input: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ToolCallArgs>, 1>);

/**
 * `tool.call <tool>` — invoke a tool as a workspace run. Branded with the
 * TARGET's `InferResponse`, like {@link functionCall}.
 */
export function toolCall<
  const Tool extends ObjectRef = ObjectRef,
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: ToolCallArgs<Tool, As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Tool>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.tool.call"`, args, TOOL_CALL_KEYS);
  assertArg("s.tool.call", "tool", args.tool);
  return annotate({
    name: "mvp:workspace_run_tool",
    context: { id: resolveRef("tool", args.tool, `Statement "s.tool.call": argument "tool"`) },
    as: args.as,
    input: encodeCallInput(args.input as CallInput | undefined, "s.tool.call"),
  }, args) as Statement & AsShapeBrand<As, ApplyFilters<InferResponse<Tool>, Fs>>;
}

export interface TriggerCallArgs extends StatementOptions {
  trigger: ObjectRef;
  as?: string;
  input?: CallInput;
}

const TRIGGER_CALL_KEYS = /* @__PURE__ */ Object.keys({ trigger: 1, as: 1, input: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<TriggerCallArgs>, 1>);

/** `trigger.call <trigger>` — invoke a trigger as a workspace run. */
export function triggerCall(args: TriggerCallArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.trigger.call"`, args, TRIGGER_CALL_KEYS);
  assertArg("s.trigger.call", "trigger", args.trigger);
  return annotate({
    name: "mvp:workspace_run_trigger",
    context: { id: resolveRef("trigger", args.trigger, `Statement "s.trigger.call": argument "trigger"`) },
    as: args.as,
    input: encodeCallInput(args.input, "s.trigger.call"),
  }, args);
}

export interface MiddlewareCallArgs extends StatementOptions {
  middleware: ObjectRef;
  as?: string;
  input?: CallInput;
}

const MIDDLEWARE_CALL_KEYS = /* @__PURE__ */ Object.keys({ middleware: 1, as: 1, input: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<MiddlewareCallArgs>, 1>);

/** `middleware.call <middleware>` — invoke middleware as a workspace run. */
export function middlewareCall(args: MiddlewareCallArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.middleware.call"`, args, MIDDLEWARE_CALL_KEYS);
  assertArg("s.middleware.call", "middleware", args.middleware);
  return annotate({
    name: "mvp:workspace_run_middleware",
    context: { id: resolveRef("middleware", args.middleware, `Statement "s.middleware.call": argument "middleware"`) },
    as: args.as,
    input: encodeCallInput(args.input, "s.middleware.call"),
  }, args);
}

export interface AddonCallArgs extends StatementOptions {
  addon: ObjectRef;
  as?: string;
  input?: CallInput;
}

const ADDON_CALL_KEYS = /* @__PURE__ */ Object.keys({ addon: 1, as: 1, input: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<AddonCallArgs>, 1>);

/** `addon.call <addon>` — invoke an addon as a workspace run. */
export function addonCall(args: AddonCallArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.addon.call"`, args, ADDON_CALL_KEYS);
  assertArg("s.addon.call", "addon", args.addon);
  return annotate({
    name: "mvp:workspace_run_addon",
    context: { id: resolveRef("addon", args.addon, `Statement "s.addon.call": argument "addon"`) },
    as: args.as,
    input: encodeCallInput(args.input, "s.addon.call"),
  }, args);
}

// ---------------------------------------------------------------------------
// Call-family tail (structural — no persisted fixture yet).
//
// There is deliberately no `service.function.run` here. Connected-service
// functions were never released, so nothing produces that shape and nothing can
// call one — `mvp:function` has a single surface and the default payload above.
// ---------------------------------------------------------------------------

/**
 * Why an action is identified by a LITERAL id and not by a name or a handle.
 *
 * Every other call in this file targets a workspace object, so its id is
 * derivable: the name plus the object type is enough, because the SDK and the
 * engine agree on how a workspace object is keyed. An action is not a workspace
 * object. It is a third-party package INSTALLED onto the instance, and its
 * identity is assigned at install time by the instance that installed it.
 *
 * Nothing offline can compute that. There is no name-to-id rule to reimplement —
 * the mapping is a lookup over what happens to be installed, so the same action
 * name resolves differently on two instances and to nothing at all on a third.
 * That is also why an installed action never appears in the bundle's object
 * graph: it is not part of the workspace's source.
 *
 * So the author supplies the id, and the SDK stores it verbatim. Deriving one
 * from a name would produce a confident, well-formed value that addresses
 * nothing — the failure mode this shape exists to make impossible.
 *
 * Where to find the ids: read them off an existing call in a pulled workspace,
 * which round-trips them unchanged.
 */
export interface ActionCallArgs extends StatementOptions {
  /**
   * The installed action's id, stored verbatim as `context.run_version.id`.
   *
   * Assigned when the action was installed — not derivable from the action's
   * name, and not the same value on another instance.
   */
  actionId: string;
  as?: string;
  /** Arguments passed to the action. */
  input?: CallInput;
  /**
   * The action's own settings (`settings_registry`) — an installed action's
   * configured values, keyed by setting name. Separate from {@link input},
   * which carries the per-call arguments.
   */
  registry?: CallInput;
}

/** The old name-based spelling, kept only to name what replaced it. */
interface LegacyActionArgs {
  action?: unknown;
  package?: unknown;
}

/**
 * Refuse the pre-identity spelling by name rather than by a missing-argument
 * error three lines later.
 *
 * A name-derived id addresses nothing on any instance. A caller passing
 * `action:` needs to know the value it
 * held cannot be converted — it has to be looked up — so the error says that
 * instead of reporting an absent `actionId`.
 */
function refuseDerivedIdentity(statement: string, args: object): void {
  const legacy = args as LegacyActionArgs;
  if (legacy.action === undefined && legacy.package === undefined) return;
  throw new Error(
    `Statement "${statement}": \`action\`/\`package\` named an action and let the SDK derive ` +
      `its id. An action is a third-party package installed onto the instance, so its id is ` +
      `assigned at install and cannot be derived from a name — a derived one addresses ` +
      `nothing. Pass the installed id instead: \`actionId\` for action.call, or ` +
      `\`traceId\`/\`versionId\`/\`slug\` for action.package.call. Read them off an existing ` +
      `call in a pulled workspace.`,
  );
}

const ACTION_CALL_KEYS = /* @__PURE__ */ Object.keys({ actionId: 1, as: 1, input: 1, registry: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ActionCallArgs>, 1>);

/**
 * `action.call` — invoke an installed action (`mvp:action`).
 *
 * Stores `context.run_version.id` verbatim; see {@link ActionCallArgs} for why
 * the id is supplied rather than derived.
 */
export function actionCall(args: ActionCallArgs): Statement {
  args = argsOrEmpty(args);
  refuseDerivedIdentity("s.action.call", args);
  assertKnownKeys(`Statement "s.action.call"`, args, ACTION_CALL_KEYS);
  assertArg("s.action.call", "actionId", args.actionId);
  return annotate({
    name: "mvp:action",
    context: { run_version: { id: args.actionId } },
    as: args.as,
    input: encodeCallInput(args.input, "s.action.call"),
    settings_registry: encodeCallInput(args.registry, "s.action.call", "registry"),
  }, args);
}

export interface ActionPackageCallArgs extends StatementOptions {
  /** The installed package's trace id (`context.action.trace_id`). */
  traceId: string;
  /** The installed package VERSION's id (`context.package_version.id`). */
  versionId: string;
  /** The package's slug (`context.package.slug`). */
  slug: string;
  as?: string;
  /** Arguments passed to the action. */
  input?: CallInput;
  /** The action's own settings (`settings_registry`), keyed by setting name. */
  registry?: CallInput;
}

const ACTION_PACKAGE_CALL_KEYS = /* @__PURE__ */ Object.keys({ traceId: 1, versionId: 1, slug: 1, as: 1, input: 1, registry: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ActionPackageCallArgs>, 1>);

/**
 * `action.package.call` — invoke an action inside an installed package
 * (`mvp:action_package`).
 *
 * Stores `context.{action.trace_id, package.slug, package_version.id}`. The
 * three travel together: they are one composite identity the instance assigns at
 * install, so a call carrying two of them addresses nothing. Same sourcing as
 * {@link ActionCallArgs} — read them off an existing call in a pulled workspace.
 */
export function actionPackageCall(args: ActionPackageCallArgs): Statement {
  args = argsOrEmpty(args);
  refuseDerivedIdentity("s.action.package.call", args);
  assertKnownKeys(`Statement "s.action.package.call"`, args, ACTION_PACKAGE_CALL_KEYS);
  assertArg("s.action.package.call", "traceId", args.traceId);
  assertArg("s.action.package.call", "versionId", args.versionId);
  assertArg("s.action.package.call", "slug", args.slug);
  return annotate({
    name: "mvp:action_package",
    context: {
      action: { trace_id: args.traceId },
      package: { slug: args.slug },
      package_version: { id: args.versionId },
    },
    as: args.as,
    input: encodeCallInput(args.input, "s.action.package.call"),
    settings_registry: encodeCallInput(args.registry, "s.action.package.call", "registry"),
  }, args);
}

export interface WorkflowTestCallArgs extends StatementOptions {
  /** The target workflow test. */
  workflowTest: ObjectRef;
  as?: string;
  /** Data source to run against. */
  datasource?: string;
}

const WORKFLOW_TEST_CALL_KEYS = /* @__PURE__ */ Object.keys({ workflowTest: 1, as: 1, datasource: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<WorkflowTestCallArgs>, 1>);

/**
 * `workflow_test.call <test>` — run a workflow test
 * (`mvp:workspace_run_workflow_test`). Stored shape from the engine's workflow-test format:
 * `context.{datasource, id}` — `datasource` is ALWAYS present (default `""`).
 *
 * Round-trip verified against a live engine: authored with no datasource, the
 * key comes back stored at its empty default rather than dropped.
 */
export function workflowTestCall(args: WorkflowTestCallArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.workflow_test.call"`, args, WORKFLOW_TEST_CALL_KEYS);
  assertArg("s.workflow_test.call", "workflowTest", args.workflowTest);
  return annotate({
    name: "mvp:workspace_run_workflow_test",
    context: {
      datasource: args.datasource ?? "",
      id: resolveRef("workflow_test", args.workflowTest, `Statement "s.workflow_test.call": argument "workflowTest"`),
    },
    as: args.as,
    input: [],
  }, args);
}

registerStatement("mvp:function", functionRun);
registerStatement("mvp:action", actionCall);
registerStatement("mvp:action_package", actionPackageCall);
registerStatement("mvp:workspace_run_workflow_test", workflowTestCall);
registerStatement("mvp:workspace_run_function", functionCall);
registerStatement("mvp:workspace_run_endpoint", apiCall);
registerStatement("mvp:workspace_run_task", taskCall);
registerStatement("mvp:workspace_run_tool", toolCall);
registerStatement("mvp:workspace_run_trigger", triggerCall);
registerStatement("mvp:workspace_run_middleware", middlewareCall);
registerStatement("mvp:workspace_run_addon", addonCall);
