/**
 * The CLI's terminal prompts: one yes/no, one free-text line.
 *
 * Written once because it was written twice: `ephemeral delete` and `release`
 * each carried their own copy, and each copy hung forever without a terminal.
 * `readline` on a stdin that is a pipe, a closed descriptor, or a CI runner's
 * `/dev/null` simply never answers, so a scripted run that forgot `--yes` sat
 * there until something killed it — the worst failure a CLI can have, because it
 * looks like slowness rather than a mistake.
 *
 * The guard turns that into an immediate, fixable refusal that names the flag
 * for THIS command. Node-only (`node:readline`), so it is imported by the
 * command modules that are Node-only anyway.
 */
import { createInterface } from "node:readline";
import { CliError, UsageError } from "./errors.js";
import { style, terminalText } from "./ui.js";
import { landedStep } from "../util/sent-writes.js";

/** 128 + SIGINT(2): Ctrl-C at a prompt ends the run as Ctrl-C anywhere else does. */
const EXIT_PROMPT_CANCELLED = 130;

/** What a prompt's interface settles with when Ctrl-C is pressed at it. */
const CANCELLED = Symbol("cancelled");

/**
 * Ctrl-C at a prompt. The terminal is in raw mode while a prompt reads, so the
 * key reaches the prompt rather than the process's SIGINT handler: it is
 * answered here the way that handler answers it — `Cancelled.`, exit 130 —
 * never as end of input, and never as a decline that exits 0.
 */
export function promptCancelled(): CliError {
  const landed = landedStep();
  const after = landed === undefined ? "Nothing was changed." : (landed.ifCancelled ?? landed.said);
  return new CliError("SDK_ERROR", `Cancelled. ${after}`, { exitCode: EXIT_PROMPT_CANCELLED });
}

/**
 * `rl.question(text)` on a `node:readline/promises` interface, with Ctrl-C at
 * it rejected as {@link promptCancelled} rather than the interface's own
 * "Aborted with Ctrl+C" failure.
 */
export async function questionOrCancel(
  rl: { question(text: string): Promise<string>; once?(event: "SIGINT", fn: () => void): unknown; off?(event: "SIGINT", fn: () => void): unknown },
  text: string,
  output: Pick<NodeJS.WritableStream, "write"> = process.stderr,
): Promise<string> {
  // An interface with no events (a scripted stand-in) has no Ctrl-C to hear.
  if (typeof rl.once !== "function" || typeof rl.off !== "function") return rl.question(text);
  let onInterrupt!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onInterrupt = (): void => {
      output.write("\n");
      reject(promptCancelled());
    };
    rl.once!("SIGINT", onInterrupt);
  });
  try {
    return await Promise.race([rl.question(text), cancelled]);
  } finally {
    rl.off!("SIGINT", onInterrupt);
  }
}

export interface ConfirmOptions {
  /** The flag that answers this prompt non-interactively, e.g. `--yes`. */
  readonly flag: string;
  /**
   * The off-terminal refusal as a landing or delete document carries it:
   * `error.details` `{ reason: "needs-confirmation", ...details }` (what did
   * NOT happen — `deleted: false`, `landed: false`), and `rerun`, this command
   * with the flag, named as the way out so it runs as printed. Required: every
   * confirmation refuses the same way, with a literal command to paste.
   */
  readonly refusal: {
    readonly details: Readonly<Record<string, unknown>>;
    readonly rerun: string;
    /** Said after the rerun: what it leaves out (a secret-bearing flag not reprinted). */
    readonly note?: string;
  };
}

/**
 * Ask `message` on the terminal, resolving true only for `y`/`yes`.
 *
 * Refuses (rather than hangs) when stdin is not a terminal: there is no one to
 * answer, and the caller's own `--yes`-style flag is the answer. The refusal
 * carries no help block: it already names that flag, and a page of usage after
 * it is all a truncated log (`| tail`) would keep.
 */
export async function confirm(message: string, opts: ConfirmOptions): Promise<boolean> {
  if (process.stdin.isTTY !== true) throw needsConfirmation(message, opts.refusal);
  // Prompts write to STDERR like the rest of the progress UI, so stdout stays a
  // clean data channel even mid-question.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Race the answer against the interface closing. Ctrl-D (EOF) mid-question
    // never fires `question`'s callback — the process simply ran out of work and
    // exited 0 with nothing said and no `--json` document. EOF is a DECLINE: the
    // one answer that cannot destroy anything, and the one `N` is the default of.
    const onClose = (): void => settle(null);
    const onInterrupt = (): void => settle(CANCELLED);
    let settle!: (value: string | null | typeof CANCELLED) => void;
    const answer = await new Promise<string | null | typeof CANCELLED>((resolve) => {
      settle = resolve;
      rl.once("close", onClose);
      rl.once("SIGINT", onInterrupt);
      rl.question(terminalText(`${style.yellow("?")} ${message} (y/N) `), resolve);
    }).finally(() => {
      rl.off("close", onClose);
      rl.off("SIGINT", onInterrupt);
    });
    if (answer === CANCELLED) {
      process.stderr.write("\n");
      throw promptCancelled();
    }
    if (answer === null) {
      // The cursor is still on the prompt line; leave it before the caller speaks.
      process.stderr.write("\n");
      return false;
    }
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * The off-terminal refusal of a confirmation: SDK_USAGE exit 1, `details.reason:
 * "needs-confirmation"`, the question, and the literal rerun. {@link confirm}
 * throws it; a command that has to refuse EARLY — before a write it could not
 * take back, ahead of the prompt it would reach later — throws the same one, so
 * every confirmation refuses one way.
 */
export function needsConfirmation(
  message: string,
  refusal: ConfirmOptions["refusal"],
  /** What the refusal opens with. */
  lead = "Cannot ask for confirmation: stdin is not a terminal.",
): CliError {
  // The question rides along: it is what the flag answers yes to, and a
  // refusal without it hands a script `--yes` with no word of what it does.
  const text =
    `${lead} It would have asked: ${message.trim()}\n` +
    `Re-run as \`${refusal.rerun}\` to answer yes without being asked.${refusal.note ?? ""}`;
  return new CliError("SDK_USAGE", text, {
    exitCode: 1,
    details: { reason: "needs-confirmation", ...refusal.details },
  });
}

/** How many empty answers to absorb before giving up, so a stuck terminal can't loop forever. */
const MAX_EMPTY_ANSWERS = 3;

export interface PromptLineOptions {
  /**
   * What to do INSTEAD when there is no terminal. Unlike `confirm`, this prompt
   * has no flag that answers it — the value only exists in the user's browser —
   * so the refusal has to point somewhere else entirely.
   */
  readonly noTtyHint: string;
  /**
   * Suppress the echo while the answer is typed. For a SECRET: a token echoed
   * to the terminal is readable over a shoulder and stays in the scrollback of
   * every session that ran the command.
   */
  readonly mask?: boolean;
}

/**
 * Ask for one line of free text on the terminal, returning it trimmed.
 *
 * Refuses (rather than hangs) with no terminal, for the reason in this module's
 * header. An empty answer re-asks a bounded number of times: a bare Enter is a
 * slip, but a stream that only ever yields empty lines must not spin.
 */
export async function promptLine(message: string, opts: PromptLineOptions): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new UsageError(`Cannot prompt: stdin is not a terminal. ${opts.noTtyHint}`);
  }
  // Prompts write to STDERR like the rest of the progress UI, so stdout stays a
  // clean data channel even mid-question.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Masking writes the prompt itself and then swallows each echoed keystroke,
  // so the answer never reaches the terminal (or its scrollback).
  if (opts.mask === true) {
    const iface = rl as unknown as { _writeToOutput?: (chunk: string) => void };
    let atPrompt = false;
    iface._writeToOutput = (chunk: string): void => {
      if (!atPrompt) {
        process.stderr.write(chunk);
        atPrompt = true;
        return;
      }
      // Newlines still pass, so the cursor leaves the prompt line on submit.
      if (chunk.includes("\n")) {
        process.stderr.write("\n");
        atPrompt = false;
      }
    };
  }
  try {
    for (let attempt = 0; attempt < MAX_EMPTY_ANSWERS; attempt++) {
      // Race the answer against the interface closing: a stdin that reaches EOF
      // mid-question never fires `question`'s callback, which would hang here.
      const onClose = (): void => settle(null);
      const onInterrupt = (): void => settle(CANCELLED);
      let settle!: (value: string | null | typeof CANCELLED) => void;
      const answer = await new Promise<string | null | typeof CANCELLED>((resolve) => {
        settle = resolve;
        rl.once("close", onClose);
        rl.once("SIGINT", onInterrupt);
        rl.question(terminalText(`${style.yellow("?")} ${message} `), resolve);
      }).finally(() => {
        rl.off("close", onClose);
        rl.off("SIGINT", onInterrupt);
      });
      if (answer === CANCELLED) {
        process.stderr.write("\n");
        throw promptCancelled();
      }
      if (answer === null) throw new UsageError(`Input ended before an answer arrived. ${opts.noTtyHint}`);
      const trimmed = answer.trim();
      if (trimmed !== "") return trimmed;
      process.stderr.write(terminalText(`${style.yellow("!")} A value is required.\n`));
    }
    throw new UsageError(`No value entered. ${opts.noTtyHint}`);
  } finally {
    rl.close();
  }
}

/** How long a non-terminal stdin may go without a byte before {@link readStdin} gives up. */
export const STDIN_IDLE_MS = 30_000;

/**
 * Everything piped on stdin, or undefined when stdin is a terminal (nothing was piped).
 *
 * Bounded by {@link STDIN_IDLE_MS} of silence, reset by every chunk: a stdin
 * that is not a terminal but never closes — a CI step that leaves the pipe
 * open, an inherited descriptor — otherwise waits for an EOF that never comes.
 */
export async function readStdin(): Promise<string | undefined> {
  const stdin = process.stdin;
  if (stdin.isTTY === true) return undefined;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    const onIdle = (): void => {
      done();
      stdin.pause();
      reject(
        new UsageError(
          `stdin is not a terminal, and nothing arrived on it for ${STDIN_IDLE_MS / 1000}s. Pipe the ` +
            `value in (\`printf %s "$VALUE" | xanosdk …\`), or close stdin (\`</dev/null\`) when there is none.`,
        ),
      );
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, STDIN_IDLE_MS);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      arm();
    };
    const onEnd = (): void => {
      done();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err: Error): void => {
      done();
      reject(err);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    arm();
  });
}
