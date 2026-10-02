/**
 * Ctrl-C (and SIGTERM / SIGHUP) handling for the `xanosdk` bin.
 *
 * Lives here rather than inline in `bin.ts` because `bin.ts` runs the CLI at
 * module scope and so can never be imported by a test — and an interrupt path
 * that is never exercised is an interrupt path that is broken on stage.
 *
 * What the terminal must show: no half-drawn spinner frame (the animation is
 * mid-`\r` when the signal lands), one `✗ Cancelled.` in the same vocabulary as
 * every other ending, and exit 130 — the shell convention for "terminated by
 * SIGINT" (128 + signal 2), which is how a wrapper tells an interrupted run from
 * a failed one.
 *
 * Except once a write has been sent. A request on the wire keeps running on the
 * server after we exit, so "Cancelled." would claim an outcome nobody knows.
 * Then the handler asks the registered operation (`operation-outcome.ts`) for
 * its result, writes it as the run's one JSON document under machine output,
 * names the read that settles it, and exits 9 — the same code as any other
 * `unknown`, because what the caller must do next is the same: read, then
 * decide.
 *
 * A command with no registered operation is covered too: every write request
 * on the wire is tracked at the transport (`sent-writes.ts`), and one still
 * waiting on its answer ends the run the same way, worded by the description
 * its caller gave it.
 *
 * And never once the run is over. A signal queued while the command ran
 * synchronous work (a child process, a file rewrite) is delivered after its
 * outcome was written; the run's own exit code stands, and nothing more is
 * printed. Likewise a run that wrote its one `--json` document with nothing
 * left on the wire: the document already told the caller what happened.
 */
import { writeSync } from "node:fs";
import { activeOperation, EXIT_OUTCOME_UNKNOWN } from "./operation-registry.js";
import { clearProgress, detail, error, success } from "./ui.js";
import { landedStep, pendingWrite, type LandedStep, type SentWrite } from "../util/sent-writes.js";
import { redactSecrets } from "../util/secrets.js";
import { failureWritesDocument } from "./errors.js";
import {
  interruptDocumentText,
  interruptedRunDocumentExitCode,
  interruptedRunFinished,
  interruptedRunWroteDocument,
} from "./output.js";

/** 128 + SIGINT(2), the conventional exit status for an interrupted process. */
export const EXIT_SIGINT = 130;

/**
 * 128 + the signal's number for each signal the bin ends on. A CI cancel or
 * `docker stop` sends SIGTERM, closing the terminal SIGHUP.
 */
const SIGNAL_EXIT = { SIGINT: EXIT_SIGINT, SIGTERM: 143, SIGHUP: 129 } as const;

/** The signals the bin answers with {@link handleInterrupt}. */
export type InterruptSignal = keyof typeof SIGNAL_EXIT;

/**
 * Write to stdout synchronously. `process.stdout.write` to a pipe can be
 * asynchronous, and the handler calls `process.exit` on the next line — a JSON
 * document cut off mid-object is worse than none. Falls back to the stream when
 * the descriptor refuses a blocking write.
 */
function writeStdoutSync(text: string): void {
  try {
    writeSync(1, text);
  } catch {
    process.stdout.write(text);
  }
}

/**
 * End the run the way Ctrl-C should end it. `exit` and `writeStdout` are
 * parameters only so a test can observe them instead of taking the test runner
 * down with it.
 *
 * Every JSON document written here is rendered as `writeJson` renders one —
 * commands spelled as the reader runs the CLI, the run's warnings — and
 * scrubbed of registered secrets, since the synchronous write bypasses the
 * stream every other document goes through.
 */
export function handleInterrupt(
  exit: (code: number) => void = process.exit,
  writeStdout: (text: string) => void = writeStdoutSync,
  signal: InterruptSignal = "SIGINT",
  argv: readonly string[] = process.argv.slice(2),
): void {
  let code: number = SIGNAL_EXIT[signal];
  try {
    // Order matters: erase the spinner's line FIRST, or the outcome prints into
    // the middle of a frame and the frame's tail survives to the right of it.
    clearProgress();
    const write = (doc: unknown): void => writeStdout(redactSecrets(interruptDocumentText(doc)));
    const landed = landedStep();
    const op = activeOperation();
    if (op === undefined || !op.writeSent) {
      const sent = pendingWrite();
      if (sent === undefined && op === undefined && interruptedRunFinished()) {
        code = runExitCode();
        return;
      }
      const reported = interruptedRunDocumentExitCode();
      if (sent === undefined && landed === undefined && reported !== undefined) {
        code = reported;
        return;
      }
      if (sent === undefined) {
        reportCancelled(signal, code, landed, argv, write);
        return;
      }
      code = EXIT_OUTCOME_UNKNOWN;
      reportSentWrite(sent, landed, argv, write);
      return;
    }
    code = EXIT_OUTCOME_UNKNOWN;
    if (op.machine) {
      // A builder that throws must not turn Ctrl-C into a crash: the stderr
      // lines and the exit code still say what matters.
      let doc: unknown;
      try {
        doc = withLanded(op.snapshot({ interrupted: true }), landed);
      } catch {
        doc = undefined;
      }
      if (doc !== undefined) write(doc);
    }
    if (landed !== undefined) success(landed.said);
    error(`Interrupted: ${op.what ?? "the write"} was already sent and may have completed.`);
    detail(`Check with \`${op.resolveWith}\` before retrying.`);
  } catch {
    // A hung-up terminal can refuse the lines; the exit code still says it.
  } finally {
    exit(code);
  }
}

/** The exit code the run set for itself, 0 when it set none. */
function runExitCode(): number {
  const set = process.exitCode;
  const n = typeof set === "number" ? set : typeof set === "string" ? Number(set) : 0;
  return Number.isInteger(n) ? n : 0;
}

/** `doc` with what already landed beside it, when it is an object document. */
function withLanded(doc: unknown, landed: LandedStep | undefined): unknown {
  if (landed === undefined || typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  return { ...landed.fields, ...doc, landed: landed.said };
}

/**
 * The ending for an interrupt with nothing on the wire. What already landed is
 * said with its way on; a run that asked for `--json` gets its one document —
 * any machine-output run does once something landed, as for a sent write.
 */
function reportCancelled(
  signal: InterruptSignal,
  code: number,
  landed: LandedStep | undefined,
  argv: readonly string[],
  write: (doc: unknown) => void,
): void {
  const head = signal === "SIGINT" ? "Cancelled." : `Stopped by ${signal}.`;
  const after = landed === undefined ? undefined : (landed.ifCancelled ?? landed.said);
  const wantsDocument = landed === undefined ? argv.includes("--json") : failureWritesDocument(argv);
  if (wantsDocument && !interruptedRunWroteDocument()) {
    write({
      ...landed?.fields,
      ok: false,
      outcome: "cancelled",
      interrupted: true,
      ...(landed === undefined ? {} : { landed: landed.said }),
      error: { code: "SDK_ERROR", message: after === undefined ? head : `${head}\n${after}`, exitCode: code },
    });
  }
  error(head);
  if (after !== undefined) detail(after);
}

/**
 * The ending for a write the transport saw go out and no registered operation
 * accounts for: the run's one JSON document under machine output, then what
 * already landed, the line naming the write and the read that settles it.
 */
function reportSentWrite(
  sent: SentWrite,
  landed: LandedStep | undefined,
  argv: readonly string[],
  write: (doc: unknown) => void,
): void {
  const what = sent.what ?? `a write to ${sent.host}`;
  const head = `Interrupted: ${what} was already ${sent.local === true ? "running" : "sent"} and may have completed.`;
  const check =
    sent.check ??
    (sent.resolveWith !== undefined
      ? `Check with \`${sent.resolveWith}\` before retrying.`
      : `Check what ${sent.host} now holds before retrying.`);
  if (failureWritesDocument(argv) && !interruptedRunWroteDocument()) {
    write({
      ...landed?.fields,
      ok: false,
      outcome: "unknown",
      interrupted: true,
      ...(landed === undefined ? {} : { landed: landed.said }),
      ...(sent.resolveWith === undefined ? {} : { resolveWith: sent.resolveWith }),
      error: {
        code: "SDK_ERROR",
        message: [...(landed === undefined ? [] : [landed.said]), head, check].join("\n"),
        exitCode: EXIT_OUTCOME_UNKNOWN,
      },
    });
  }
  if (landed !== undefined) success(landed.said);
  error(head);
  detail(check);
}

/**
 * Install {@link handleInterrupt} for SIGINT, SIGTERM and SIGHUP. Each ends
 * the process, so the `exit` handlers (lock release among them) always run.
 */
export function installInterruptHandler(): void {
  for (const signal of Object.keys(SIGNAL_EXIT) as InterruptSignal[]) {
    process.on(signal, () => handleInterrupt(process.exit, writeStdoutSync, signal));
  }
}
