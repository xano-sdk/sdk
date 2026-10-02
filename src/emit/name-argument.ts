/**
 * {@link checkOneName} for a value typed on this run's command line: the
 * refusal names the command, and a multi-line value is answered with this run
 * once per name, as a shell loop that runs as printed.
 */
import type { ParsedArgs } from "./cli.js";
import type { HelpTarget } from "./errors.js";
import { checkOneName, setRunNameContext } from "./name-check.js";
import { retryCommand, withheldNote } from "./retry-command.js";
import { shellQuote } from "../util/shell-quote.js";

/** Placeholder for the name inside a reprinted command line: bare under {@link shellQuote}. */
const SLOT = "XANOSDKNAMESLOT";

export function assertOneName(
  value: string,
  what: string,
  opts: { readonly args?: ParsedArgs; readonly helpFor?: HelpTarget; readonly echo?: boolean } = {},
): void {
  const { args } = opts;
  checkOneName(value, what, {
    ...(opts.helpFor === undefined ? {} : { helpFor: opts.helpFor }),
    ...(opts.echo === undefined ? {} : { echo: opts.echo }),
    ...runContextOf(args),
  });
}

/** The command words and the per-name loop for `args`' run. */
function runContextOf(args: ParsedArgs | undefined): { verb?: string; loop: (raw: string, prefix: string, names: readonly string[]) => string | undefined } {
  return {
    ...(args?.command === undefined ? {} : { verb: `xanosdk ${args.command}${args.subcommand === undefined ? "" : ` ${args.subcommand}`}` }),
    loop: (raw, prefix, names) => loopOver(raw, prefix, names, args),
  };
}

/**
 * Hand the run in progress to every name check, including those made where
 * its arguments are not in reach (`undefined` when the run ends).
 */
export function noteRunArgs(args: ParsedArgs | undefined): void {
  setRunNameContext(args === undefined ? undefined : runContextOf(args));
}

/**
 * This run's own command line as a shell loop over `names`, the multi-line
 * token replaced by the loop variable. `undefined` when the run's argv is
 * unknown or the token cannot be found in it.
 */
function loopOver(value: string, prefix: string, names: readonly string[], args: ParsedArgs | undefined): string | undefined {
  if (args?.argv === undefined) return undefined;
  const argv = args.argv;
  const at = argv.findIndex((t) => t === value || (t.startsWith("--") && t.endsWith(`=${value}`)));
  if (at === -1) return undefined;
  const token = argv[at]!;
  const swapped = argv.map((t, i) => (i === at ? `${token.slice(0, token.length - value.length)}${prefix}${SLOT}` : t));
  const { command, withheld } = retryCommand({ ...args, argv: swapped });
  const note = withheldNote(withheld).trim();
  return `for n in ${names.map(shellQuote).join(" ")}; do ${command.replace(SLOT, '"$n"')}; done${note === "" ? "" : `\n  ${note}`}`;
}
