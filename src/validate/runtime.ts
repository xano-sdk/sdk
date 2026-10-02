/**
 * Runtime execution: prove deployed logic actually runs, not just that it
 * imports and round-trips. `smokeRunFunctions` runs each deployed function via
 * the meta function-run route and reports whether the engine executed it, with
 * the result body (or the engine error + logs) surfaced for diagnosis.
 *
 * Node-only; reached through the command.
 */
import type { InvokeResult } from "./meta-client.js";

/** Client surface runtime needs (satisfied structurally by MetaClient). */
export interface RuntimeClient {
  runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult>;
}

/** Outcome of running one function through the engine. */
export interface RuntimeEntry {
  name: string;
  /** True when the engine executed it without error. */
  ran: boolean;
  status: number;
  /** Result body on success, or the engine error + logs on failure. */
  detail: unknown;
  /**
   * Present (and `ran` false) when the run was refused only for its INPUT: the
   * function declares inputs, the smoke run sends none, and the engine answered
   * with an input error. That is the input's verdict, not the function's, so a
   * caller reports it as not run rather than as failed.
   */
  needsInputs?: true;
}

/**
 * Execute each named function on the engine with the given input (default `{}`)
 * and report the outcome. Runs sequentially: these are live executions against a
 * shared tenant and may have side effects, so ordering/isolation matters more
 * than shaving wall-clock.
 *
 * A function with required inputs errors on the empty input. When it is one of
 * `withInputs` (it declares inputs) and the engine's refusal is an input error,
 * the entry is marked `needsInputs` — the run said nothing about its logic.
 * Any other failure, a throw from its body included, stays a plain `ran:false`.
 */
export async function smokeRunFunctions(
  client: RuntimeClient,
  workspaceId: number,
  names: string[],
  inputs: Record<string, unknown> = {},
  withInputs: ReadonlySet<string> = new Set(),
): Promise<RuntimeEntry[]> {
  const out: RuntimeEntry[] = [];
  for (const name of names) {
    const res = await client.runFunction(workspaceId, name, inputs[name] ?? {});
    const ran = res.ok && !threw(res.body);
    const needsInputs = !ran && withInputs.has(name) && isInputError(res.body);
    out.push({ name, ran, status: res.status, detail: res.body, ...(needsInputs ? { needsInputs: true as const } : {}) });
  }
  return out;
}

/**
 * The names of the bundle's functions that declare at least one input — the
 * only ones whose empty-input run can be refused for its input alone.
 */
export function functionsWithInputs(bundle: unknown): Set<string> {
  const fns = field(field(bundle, "payload"), "function");
  const out = new Set<string>();
  if (!Array.isArray(fns)) return out;
  for (const fn of fns) {
    const name = field(fn, "name");
    const input = field(fn, "input");
    if (typeof name === "string" && Array.isArray(input) && input.length > 0) out.add(name);
  }
  return out;
}

/** The engine's code for a request refused over its input (a missing or invalid param). */
const INPUT_ERROR_CODE = "ERROR_CODE_INPUT_ERROR";

/**
 * Whether a failed run was refused for its input: the engine's input-error
 * code, wherever the body carries it, or its "Missing param" message.
 *
 * Measured live, a run with a required input missing answers HTTP 200 with
 * `{result: {status: "exception", exception: {message: "Param: n - Missing
 * param: n", error_type: "ERROR_CODE_INPUT_ERROR"}}}`. A request-level refusal
 * carries the same code as a top-level `code`.
 */
function isInputError(body: unknown): boolean {
  const exception = field(field(body, "result"), "exception");
  const codes = [field(body, "code"), field(exception, "error_type"), field(exception, "code")];
  if (codes.includes(INPUT_ERROR_CODE)) return true;
  return /\bMissing param\b/.test(runtimeErrorMessage(body) ?? "");
}

/**
 * Whether the engine reports the run itself as failed. A function that throws
 * (a failed precondition, say) still answers HTTP 200 — the throw is in the
 * body as `{result: {status: "exception", exception: {message}}}` — so the HTTP
 * status alone passes it. Any result status other than `"ok"` is a failure; a
 * body without one falls back to the HTTP status.
 */
function threw(body: unknown): boolean {
  const result = (body as { result?: unknown } | null | undefined)?.result;
  const status = (result as { status?: unknown } | null | undefined)?.status;
  return typeof status === "string" && status !== "ok";
}

/**
 * The engine's message for a run that threw, when the body carries one.
 *
 * Two shapes. An engine exception carries `result.exception.message`. A user
 * `throw` reports status `"throwerror"` with NO exception: the thrown value is
 * `result.result.payload`, and the run body stores values by reference — the
 * payload is a key into `value_store`, which holds the value itself. Read
 * without that lookup, the message a caller most needs ("boom") was absent and
 * the failure printed as a bare status.
 */
export function runtimeErrorMessage(detail: unknown): string | undefined {
  const result = field(detail, "result");
  const message = field(field(result, "exception"), "message") ?? field(detail, "message");
  if (typeof message === "string" && message !== "") return message;
  const thrown = field(field(result, "result"), "payload");
  if (thrown === undefined) return undefined;
  const store = field(result, "value_store") ?? field(detail, "value_store");
  const value =
    typeof thrown === "string" && store !== null && typeof store === "object" && Object.hasOwn(store, thrown)
      ? (store as Record<string, unknown>)[thrown]
      : thrown;
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Why a run that did not pass failed, in one phrase for the `✗` line.
 *
 * A throw answers HTTP 200 with the failure in the body, so an HTTP status
 * beside it only contradicts it (`status 200: Bad Request`): it is named only
 * when the request itself failed. The message is the body's own. For a
 * `badrequest` or `unauthorized` throw the engine answers with the error
 * TYPE's name ("Bad Request", "Unauthorized") in place of the thrown text —
 * measured on a precondition whose text never appears anywhere in the run
 * body — so the line says the text is not returned rather than implying the
 * author wrote "Bad Request".
 */
export function describeRuntimeFailure(entry: Pick<RuntimeEntry, "status" | "detail">): string {
  const why = runtimeErrorMessage(entry.detail);
  const requestFailed = entry.status < 200 || entry.status >= 300;
  if (requestFailed) return `HTTP ${entry.status}${why !== undefined ? `: ${why}` : ""}`;
  if (why === undefined) return "threw";
  const type = field(field(field(entry.detail, "result"), "exception"), "error_type");
  const masked =
    (type === "ERROR_CODE_BAD_REQUEST" && why === "Bad Request") ||
    (type === "ERROR_CODE_UNAUTHORIZED" && why === "Unauthorized");
  return masked ? `threw ${why} — the run does not return the text of this error type` : `threw: ${why}`;
}

function field(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}
