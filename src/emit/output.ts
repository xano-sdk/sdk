/**
 * Which shape a command's STDOUT takes: the machine-readable JSON, or nothing
 * (because the human progress lines on stderr already said it).
 *
 * One resolver for the whole CLI, rather than a bare `process.stdout.isTTY`
 * check at every call site. That inference is a good DEFAULT — a piped or
 * redirected run wants data — but as the only input, `xanosdk deploy | tee
 * deploy.log` would silently switch format, and someone sitting at a terminal
 * would have no way to ask for JSON at all. `--json` is that input; the
 * inference is the default when the flag is absent.
 *
 * Deliberately NOT about color. Color is stderr's concern and is resolved in
 * `ui.ts` from `NO_COLOR`/`FORCE_COLOR` plus stderr's own TTY — conflating the
 * two would make `--json` repaint the progress lines, and `NO_COLOR` change what
 * a pipeline parses.
 */
import type { AnyWarningCode } from "../codes.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { withBackendFields } from "./json-target.js";
import { withCliPrefixDeep } from "./invocation.js";
import { plainText } from "./ui.js";

/** The slice of `ParsedArgs` this reads — so any caller can be tested with a literal. */
export interface OutputArgs {
  /** `--json`: force the machine-readable output whatever stdout is attached to. */
  readonly json?: boolean;
}

/**
 * Whether this run's stdout should carry machine-readable JSON: asked for with
 * `--json`, or inferred because stdout is not a terminal.
 */
export function isMachineOutput(args: OutputArgs): boolean {
  return args.json === true || process.stdout.isTTY !== true;
}

/** The inverse, for the call sites that read better as "print the pretty view". */
export function isHumanOutput(args: OutputArgs): boolean {
  return !isMachineOutput(args);
}

/**
 * One element of every `--json` document's `warnings[]` — a success document's
 * top level and a failure's `error.details.warnings` alike. `code` is stable and
 * dotted: a build diagnostic keeps its own (`stack.env-undeclared`); a CLI notice
 * takes its family's (`secrets.cleartext-export`, `credential.readable-file`).
 * `message` is the line stderr printed. One shape everywhere, so a script reads
 * `warnings.map(w => w.code)` on any command.
 */
export interface JsonWarning {
  readonly code: AnyWarningCode;
  readonly message: string;
  /** The def a build diagnostic is about (`{ kind: "function", name: "fn" }`), when it is about one. */
  readonly subject?: { readonly kind: string; readonly name: string };
}

/** `w` in exactly the {@link JsonWarning} shape: an absent `subject` is left out, any other key dropped. */
export function jsonWarning(w: JsonWarning): JsonWarning {
  return { code: w.code, message: w.message, ...(w.subject === undefined ? {} : { subject: w.subject }) };
}

/** Whether `value` is a `warnings[]` in the one shape — see {@link JsonWarning}. */
export function isJsonWarnings(value: unknown): value is JsonWarning[] {
  return (
    Array.isArray(value) &&
    value.every(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        typeof (w as JsonWarning).code === "string" &&
        typeof (w as JsonWarning).message === "string",
    )
  );
}

/**
 * `own` followed by each of `extra` it does not already hold (same code and
 * message), or undefined when `own` is present but not a {@link JsonWarning} list.
 * Of two copies of one warning, the one naming its `subject` is kept.
 */
export function mergeJsonWarnings(own: unknown, extra: readonly JsonWarning[]): JsonWarning[] | undefined {
  if (own !== undefined && !isJsonWarnings(own)) return undefined;
  const merged: JsonWarning[] = [...(own ?? [])];
  for (const w of extra) {
    const at = merged.findIndex((m) => m.code === w.code && m.message === w.message);
    if (at === -1) merged.push(jsonWarning(w));
    else if (merged[at]!.subject === undefined && w.subject !== undefined) merged[at] = jsonWarning(w);
  }
  return merged;
}

/** Whether a run has written its JSON document — see {@link jsonDocumentWritten}. */
interface DocumentState {
  written: boolean;
  /** The exit code the written document reports: its `error.exitCode` when `ok` is false, else 0. */
  writtenExitCode?: number;
  /** Warnings this run printed that every document it writes carries — see {@link noteRunWarning}. */
  warnings?: JsonWarning[];
  /** Warnings a `diagnostics.allow` accepted in this run's build — see {@link noteRunAccepted}. */
  accepted?: JsonWarning[];
  /** What this run adds to a failure before a document carries it — see {@link explainRunFailure}. */
  explain?: (err: unknown) => Promise<unknown>;
}

/**
 * One record per `run()`, carried by async context rather than held in module
 * state: two runs in one process — a test driving `run()` concurrently, an
 * embedder — would otherwise see each other's writes, and one's failure would
 * lose its document because the OTHER run wrote one.
 */
const runScope = new AsyncLocalStorage<DocumentState>();

/** The record for writes made outside any run: a test calling {@link writeJson} directly. */
const unscoped: DocumentState = { written: false };

const currentState = (): DocumentState => runScope.getStore() ?? unscoped;

/**
 * Failures thrown out of a run that had already written its document. The
 * failure is rendered by the bin AFTER the run's async context has ended, so
 * the fact has to travel with the error itself.
 */
const thrownAfterDocument = new WeakSet<object>();

/**
 * The run in progress, for a signal handler: it runs outside every run's async
 * context, so {@link currentState} cannot find the run it interrupts.
 */
let liveRun: DocumentState | undefined;

const signalState = (): DocumentState => runScope.getStore() ?? liveRun ?? unscoped;

/**
 * Whether the bin's run has returned (or thrown) and nothing has started since:
 * the command is finished, and what is left is the process winding down.
 */
let runFinished = false;

/**
 * Whether the run a signal arrived during is already over — its outcome
 * written, its exit code decided. An interrupt then must not report anything.
 */
export function interruptedRunFinished(): boolean {
  return runFinished && liveRun === undefined;
}

/**
 * `value` as one JSON document in the CLI's one house format: printed commands
 * spelled as the reader runs the CLI (see `invocation.ts`), the run's warnings,
 * and `selector` / `workspaceId` on every document naming a backend.
 */
function documentText(value: unknown, state: DocumentState): string {
  const document = withCliPrefixDeep(withRunWarnings(withBackendFields(value), state.warnings ?? [], state.accepted ?? []));
  // The terminal palette's styling never reaches a document: a warning worded
  // for the terminal is recorded here as the reader would read it.
  return JSON.stringify(document, (_key, v: unknown) => (typeof v === "string" ? plainText(v) : v), 2) + "\n";
}

/** Write one JSON document to stdout, in the CLI's one house format. */
export function writeJson(value: unknown): void {
  const state = currentState();
  state.written = true;
  state.writtenExitCode = documentExitCode(value);
  process.stdout.write(documentText(value, state));
}

/**
 * The interrupted run's one JSON document, rendered as {@link writeJson} renders
 * it, for the signal handler to write synchronously before the process exits.
 */
export function interruptDocumentText(value: unknown): string {
  return documentText(value, signalState());
}

/** Whether the run a signal interrupted has already written its JSON document. */
export function interruptedRunWroteDocument(): boolean {
  return signalState().written;
}

/** The exit code the interrupted run's written document reports, when a run is live and wrote one. */
export function interruptedRunDocumentExitCode(): number | undefined {
  const state = signalState();
  return state !== unscoped && state.written ? state.writtenExitCode : undefined;
}

function documentExitCode(value: unknown): number {
  if (typeof value !== "object" || value === null || (value as { ok?: unknown }).ok !== false) return 0;
  const code = (value as { error?: { exitCode?: unknown } }).error?.exitCode;
  return typeof code === "number" && Number.isInteger(code) ? code : 1;
}

/**
 * Record a warning this run printed on stderr, so whatever `--json` document
 * the command writes — success or failure — carries it in `warnings[]` as
 * `{ code, message, subject? }`. The one collector every warning goes through: the build's
 * diagnostics, the export-time notices, a credential file other users can read,
 * a secrets file written. Said once per code and message. Outside a run (a test
 * calling a helper, a library `compileBundle`) it goes nowhere.
 */
export function noteRunWarning(code: AnyWarningCode, message: string, subject?: JsonWarning["subject"]): void {
  const state = runScope.getStore();
  if (state === undefined) return;
  state.warnings = mergeJsonWarnings(state.warnings, [{ code, message, subject }]);
}

/** This run's {@link noteRunWarning} warnings, for a failure rendered after the run. */
export function runWarnings(): readonly JsonWarning[] {
  return runScope.getStore()?.warnings ?? [];
}

/**
 * Record a build warning a def's `diagnostics.allow` accepted: never printed,
 * but every `--json` document this run writes carries it in `accepted[]`, in
 * the {@link JsonWarning} shape, so a fixture can assert the hazard is still
 * diagnosed. Absent from a document when nothing was accepted.
 */
export function noteRunAccepted(accepted: readonly JsonWarning[]): void {
  const state = runScope.getStore();
  if (state === undefined || accepted.length === 0) return;
  state.accepted = mergeJsonWarnings(state.accepted, accepted);
}

/** This run's {@link noteRunAccepted} warnings, for a failure rendered after the run. */
export function runAccepted(): readonly JsonWarning[] {
  return runScope.getStore()?.accepted ?? [];
}

/**
 * Set what this run adds to a failure before a document carries it: the CLI's
 * remedy and code for a credential the instance refused. A command that writes
 * its own result before throwing (`runOperation`) serializes the failure inside
 * the command, so the run's own catch is too late to reach that document.
 */
export function setRunFailureExplainer(explain: (err: unknown) => Promise<unknown>): void {
  const state = runScope.getStore();
  if (state !== undefined) state.explain = explain;
}

/** `err` with this run's {@link setRunFailureExplainer} additions — `err` itself outside a run. */
export async function explainRunFailure(err: unknown): Promise<unknown> {
  const explain = runScope.getStore()?.explain;
  return explain === undefined ? err : explain(err);
}

/**
 * `value` with `warnings` and `accepted` merged in, when it is an object
 * document. An array is left as it is, and so is a key whose value is not a
 * {@link JsonWarning} list.
 */
function withRunWarnings(value: unknown, warnings: readonly JsonWarning[], accepted: readonly JsonWarning[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  let out = value;
  for (const [key, extra] of [["warnings", warnings], ["accepted", accepted]] as const) {
    if (extra.length === 0) continue;
    const merged = mergeJsonWarnings((value as Record<string, unknown>)[key], extra);
    if (merged !== undefined) out = { ...out, [key]: merged };
  }
  return out;
}

/**
 * Run `fn` as one run with its own written-document record. `run()` wraps each
 * invocation in it. A failure that escapes after `fn` wrote its document is
 * remembered, so {@link jsonDocumentWritten} answers for it later.
 */
export async function inJsonDocumentScope<T>(fn: () => Promise<T>): Promise<T> {
  const state: DocumentState = { written: false };
  const outer = liveRun;
  liveRun = state;
  runFinished = false;
  try {
    return await runScope.run(state, fn);
  } catch (err) {
    if (state.written && typeof err === "object" && err !== null) thrownAfterDocument.add(err);
    throw err;
  } finally {
    liveRun = outer;
    if (outer === undefined) runFinished = true;
  }
}

/**
 * Whether the run that produced `failure` already wrote a JSON document. The
 * failure renderer reads it so a command that emitted its own result before
 * throwing does not get a second document appended — stdout carries one.
 *
 * Without a `failure` (or for one that escaped no scope), it answers for the
 * current context.
 */
export function jsonDocumentWritten(failure?: unknown): boolean {
  if (typeof failure === "object" && failure !== null && thrownAfterDocument.has(failure)) return true;
  return currentState().written;
}

/** Clear the record of writes made outside any run. For tests. */
export function resetJsonDocument(): void {
  unscoped.written = false;
  runFinished = false;
}

/**
 * A reader that closed stdout early (`xanosdk status --json | head -1`,
 * `| true`) is not a failure of the command: without a listener the pipe's
 * `EPIPE` was an unhandled `error` event and a stack trace. The write is
 * dropped, the run finishes, and it exits with its own code. Any other stream
 * error is still thrown.
 */
export function installStdoutPipeGuard(stream: NodeJS.WriteStream = process.stdout): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    throw err;
  });
}
