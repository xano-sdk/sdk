/**
 * This run's own command line, reprinted for a remedy to paste back: a retry
 * after a failure, or the same run with `--yes` for a needs-confirmation
 * refusal. Light on purpose — every command's refusal imports it — so it
 * never pulls a command module in.
 */
import type { ParsedArgs } from "./cli.js";
import { contextFlags, isCredentialStoreCommand } from "./context-flags.js";
import { shellQuote } from "../util/shell-quote.js";
import { andList } from "../util/and-list.js";

/** Credential-selecting flags that take a value: re-said by {@link contextFlags}, never copied. */
const CREDENTIAL_VALUE_FLAGS = new Set(["--config", "--profile", "-p"]);

/**
 * Flags whose value may be a secret, and so is never reprinted: a backend env
 * value, a documentation token, and a sign-in origin (it can carry a
 * `user:password@`). The retry names what it withheld — `--env-var GREETING`,
 * never its value — for the reader to supply again. `--static-env` is not
 * here: its values are public by contract (baked into the served page), and a
 * retry without them publishes a different frontend.
 */
const SECRET_VALUE_FLAGS: ReadonlyMap<string, "key" | "whole"> = new Map([
  ["--env-var", "key"],
  ["--doc-token", "key"],
  ["--origin", "whole"],
]);

/**
 * Positional arguments that are a secret, by command: `env set NAME VALUE`'s
 * value. Never reprinted — the retry pipes it back in on stdin instead
 * (`printf %s "$VALUE" | xanosdk env set NAME …`), the form the command
 * documents for a secret. `name` is the positional the value belongs to.
 */
export const SECRET_POSITIONALS: ReadonlyMap<string, { readonly value: number; readonly name: number }> = new Map([
  ["env set", { value: 1, name: 0 }],
]);

/** The stand-in a retry pipes in for a secret positional, named in {@link withheldNote}. */
export const STDIN_VALUE = "$VALUE";

/** `NAME=value` typed where the name goes: the value half is the secret. */
const ASSIGNED = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Where in this run's argv a secret positional sits, and what (if anything)
 * the retry keeps of that word: the name half of a `NAME=value`.
 */
function secretPositional(args: ParsedArgs): { at: number; keep?: string } | undefined {
  const spec = SECRET_POSITIONALS.get(`${args.command}${args.subcommand === undefined ? "" : ` ${args.subcommand}`}`);
  const argv = args.argv;
  if (spec === undefined || argv === undefined) return undefined;
  // The argv index the parser recorded, trusted only while it still holds the
  // word; without one (a programmatic call), the word's last occurrence.
  const locate = (index: number): number | undefined => {
    const word = args.positionals[index];
    if (word === undefined) return undefined;
    if (args.positionalArgv !== undefined) {
      const at = args.positionalArgv[index];
      return at !== undefined && argv[at] === word ? at : undefined;
    }
    const found = argv.lastIndexOf(word);
    return found === -1 ? undefined : found;
  };
  const value = locate(spec.value);
  if (value !== undefined) return { at: value };
  const name = locate(spec.name);
  const assigned = name === undefined ? null : ASSIGNED.exec(argv[name]!);
  return name !== undefined && assigned !== null ? { at: name, keep: assigned[1]! } : undefined;
}

/**
 * Flags that only shape a CREATE. Every retry printed here goes onto an
 * ephemeral that already exists, where they are refused as not applied — so
 * they are dropped rather than handed back to warn.
 */
const CREATE_ONLY_FLAGS: ReadonlySet<string> = new Set(["--expires-hours"]);

/** A printed retry: the command to paste, and the secret-bearing flags it left out. */
export interface RetryCommand {
  command: string;
  /** `--env-var GREETING`, `--doc-token internal`, `--origin`: what to supply again. */
  withheld: string[];
}

/**
 * This run's own command line, to paste back: every flag it was typed with
 * (`--allow-empty-env`, `--static …` — a retry without them refuses, or
 * deploys something else), each token shell-quoted, the credential flags
 * re-said the way every other hint says them (an absolute `--config`, a
 * `--profile` only when one was typed) — and NO secret: a flag whose value may
 * be one ({@link SECRET_VALUE_FLAGS}) is left out and named in `withheld`, so
 * a retry hint never puts a token in a terminal scrollback, a CI log or the
 * `--json` error. Create-only flags are dropped (the retry goes onto an
 * ephemeral that exists). `add` appends flags the retry needs (`--keep-data`);
 * `drop` removes flags that would contradict them (`--reset`).
 */
export function retryCommand(
  args: ParsedArgs,
  opts: {
    add?: readonly string[];
    drop?: readonly string[];
    creates?: boolean;
    /** The command words when the run's own argv is unknown (a programmatic call). */
    command?: string;
  } = {},
): RetryCommand {
  // A retry that CREATES again (a create whose answer was lost) keeps them.
  const createOnly = opts.creates === true ? new Set<string>() : CREATE_ONLY_FLAGS;
  const flags = contextFlags(args, {
    credentialStore: isCredentialStoreCommand({ command: args.command ?? opts.command?.split(" ")[0] }),
  });
  const add = (opts.add ?? []).filter((f) => !(args.argv ?? []).includes(f));
  if (args.argv === undefined) {
    return { command: `xanosdk ${opts.command ?? "deploy"}${add.map((f) => ` ${f}`).join("")}${flags}`, withheld: [] };
  }
  const drop = new Set(opts.drop ?? []);
  const kept: string[] = [];
  const withheld: string[] = [];
  const secretAt = secretPositional(args);
  for (let i = 0; i < args.argv.length; i++) {
    const token = args.argv[i]!;
    if (i === secretAt?.at) {
      if (secretAt.keep !== undefined) kept.push(shellQuote(secretAt.keep));
      withheld.push(STDIN_VALUE);
      continue;
    }
    const eq = token.indexOf("=");
    const spelling = token.startsWith("-") && eq !== -1 ? token.slice(0, eq) : token;
    const attached = spelling !== token;
    const secret = SECRET_VALUE_FLAGS.get(spelling);
    if (secret !== undefined) {
      const value = attached ? token.slice(eq + 1) : args.argv[i + 1];
      if (!attached) i += 1;
      const key = secret === "key" && value !== undefined && value.includes("=") ? value.slice(0, value.indexOf("=")) : undefined;
      withheld.push(key !== undefined && key !== "" ? `${spelling} ${key}` : spelling);
      continue;
    }
    if (CREDENTIAL_VALUE_FLAGS.has(spelling) || createOnly.has(spelling) || drop.has(spelling)) {
      // A separated value goes with its flag; an attached one is in the token.
      if (!attached && (CREDENTIAL_VALUE_FLAGS.has(spelling) || createOnly.has(spelling))) i += 1;
      continue;
    }
    if (token === "--local") continue;
    kept.push(shellQuote(token));
  }
  const stdin = secretAt === undefined ? "" : `printf %s "${STDIN_VALUE}" | `;
  return { command: `${stdin}xanosdk ${[...kept, ...add].join(" ")}${flags}`, withheld };
}

/**
 * This run with `--yes` added, for a needs-confirmation refusal's "Re-run as
 * `…`": the command as typed (so it runs as printed), and the note naming any
 * secret-bearing flag it did not reprint.
 */
export function yesRerun(args: ParsedArgs, command: string): { rerun: string; note: string } {
  const retry = retryCommand(args, { add: ["--yes"], creates: true, command });
  return { rerun: retry.command, note: withheldNote(retry.withheld) };
}

/**
 * The sentence after a retry that withheld secrets: which flags to supply
 * again, by name — or, for a value kept on disk, that the file still holds it.
 * Empty when nothing was withheld.
 */
/**
 * ` --yes` for a next step that asks before it writes, when the run printing it
 * was itself not asked — answered with `--yes`, or off a terminal, where the
 * step pasted as printed would refuse with needs-confirmation. Empty otherwise.
 */
export function pipedYes(args?: { yes?: boolean }): string {
  return args?.yes === true || process.stdin.isTTY !== true ? " --yes" : "";
}

export function withheldNote(withheld: readonly string[]): string {
  const stdin = withheld.includes(STDIN_VALUE)
    ? ` The value is not reprinted: set \`VALUE\` to it and the command pipes it in, or pass it as the second argument.`
    : "";
  const flags = withheld.filter((w) => w !== STDIN_VALUE);
  if (flags.length === 0) return stdin;
  const named = andList(flags.map((w) => `\`${w}\``));
  return (
    ` It leaves out ${named}: ${flags.length === 1 ? "its value is" : "their values are"} not reprinted, ` +
    `so pass ${flags.length === 1 ? "it" : "them"} again (or keep env values in the backend's \`.env\` and ` +
    `documentation tokens in its \`.secrets.json\`, which a deploy reads).` +
    stdin
  );
}
