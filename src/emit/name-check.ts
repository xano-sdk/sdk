/**
 * The check for every command-line value that NAMES a remote object — an
 * ephemeral, a tenant, a release, a branch, a backend selector — run before
 * any request is sent.
 *
 * A name is one line of printable text. A value holding a newline is most
 * often a list captured into one variable (`L=$(… list --json | jq …)`) and
 * passed quoted; sent, it reaches the server percent-encoded and the server
 * matches its FIRST line, so a delete would act on the first name of the list.
 * Any other control character (a tab, a carriage return from a CRLF file)
 * names nothing either. Both are refused here
 * as usage errors; a multi-line value is answered with a loop that runs the
 * same command once per name.
 */
import { UsageError, type HelpTarget } from "./errors.js";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const CONTROL_NAMES: Readonly<Record<string, string>> = {
  "\t": "a tab",
  "\r": "a carriage return",
  "\n": "a line break",
  "\u2028": "a line break",
  "\u2029": "a line break",
};

export interface NameCheckOptions {
  readonly helpFor?: HelpTarget;
  /**
   * False when the value must never be echoed — an env var NAME that may be the
   * secret value typed in the wrong position.
   */
  readonly echo?: boolean;
  /** The command words (`xanosdk ephemeral delete`), when known. */
  readonly verb?: string;
  /** The command once per name, as a shell loop — `undefined` when it cannot be built. */
  readonly loop?: (value: string, prefix: string, names: readonly string[]) => string | undefined;
}

/**
 * The run in progress's command words and loop builder, for a name checked
 * where the parsed arguments are not in reach (a backend selector parsed deep
 * inside a command). Set by the CLI for each run; empty outside one.
 */
let runContext: Pick<NameCheckOptions, "verb" | "loop"> = {};
export function setRunNameContext(ctx: Pick<NameCheckOptions, "verb" | "loop"> | undefined): void {
  runContext = ctx ?? {};
}
export function runNameContext(): Pick<NameCheckOptions, "verb" | "loop"> {
  return runContext;
}

/**
 * Refuse `value` when it holds a control character, before anything is sent.
 * `what` names the argument as the reader typed it: "the ephemeral name",
 * "the `--to` value".
 */
export function checkOneName(value: string, what: string, opts: NameCheckOptions = {}): void {
  const trimmed = value.trim();
  const bad = CONTROL.exec(trimmed);
  if (bad === null) return;
  const hint = opts.helpFor === undefined ? {} : { hintFor: opts.helpFor };
  if (opts.echo === false) {
    throw new UsageError(
      `${capital(what)} holds ${describe(bad[0])}, and a name cannot (it is not repeated here). Nothing was sent.`,
      hint,
    );
  }
  const lines = trimmed.split(/\r?\n|[\u2028\u2029]/u).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length > 1 && lines.every((l) => !CONTROL.test(l))) {
    const prefix = /^[a-z][a-z-]*:/.exec(lines[0]!)?.[0] ?? "";
    const names = lines.map((l) => (prefix !== "" && l.startsWith(prefix) ? l.slice(prefix.length) : l));
    const shown = names.slice(0, 3).map((n) => `"${n}"`).join(", ") + (names.length > 3 ? ", …" : "");
    const loop = opts.loop?.(value, prefix, names);
    throw new UsageError(
      `${opts.verb === undefined ? "A command" : `\`${opts.verb}\``} takes one name per command, and ${what} holds ${names.length}, ` +
        `one per line (${shown}). Nothing was sent.` +
        (loop === undefined ? " Run the command once for each name." : `\nRun it once for each name:\n  ${loop}`),
      hint,
    );
  }
  throw new UsageError(
    `${capital(what)} ${JSON.stringify(trimmed)} holds ${describe(bad[0])}, which no name carries. Nothing was sent.`,
    hint,
  );
}

function describe(ch: string): string {
  return `a control character (${CONTROL_NAMES[ch] ?? `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`})`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
