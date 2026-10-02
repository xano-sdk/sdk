/**
 * `UsageError` — a failure the user can fix by typing something different.
 *
 * The distinction that matters at the process boundary: a UsageError means the
 * CLI never got far enough to try, so printing the relevant help block is
 * useful. Every other error means the command ran and failed, where a wall of
 * usage text is noise. `bin.ts` renders the two differently on that basis.
 *
 * Thrown (not printed) so `run()` stays a library function — the exported entry
 * that tests drive directly — with rendering and exit codes owned by the bin.
 * The renderer lives here too ({@link reportFailure}) rather than in `bin.ts`,
 * which is unimportable from a test: it calls `run()` at module scope.
 */
import type { ErrorCode } from "../codes.js";
import { error, detail, stderrStyle, terminalText, warn } from "./ui.js";
import { EXIT_OUTCOME_UNKNOWN } from "./operation-registry.js";
import { setDiagnosticSink } from "../workspace/diagnostics.js";
import { isMachineOutput, jsonDocumentWritten, noteRunWarning, writeJson } from "./output.js";
import { renderHelpFor, indentBlock } from "./help.js";
import {
  FLAGS,
  flagKey,
  getCommand,
  GLOBAL_FLAGS,
  getSubcommand,
  liveCommandNames,
  renderArgs,
  liveSubcommandNames,
  selectorSpellings,
  suggest,
  tablesCommand,
  takesProfileFlag,
  visibleFlags,
  type CommandSpec,
  type SubcommandSpec,
} from "./commands.js";

/**
 * Whether a failure's message says a write's outcome is unknown — the answer
 * was lost after the request went out. Every transport phrases that through one
 * of a few fixed sentences (`SENT_AFTERMATH` in `util/http.ts`, the import's "may or
 * may not have landed", a create's or delete's "may or may not have been …"), so the
 * CLI can exit 9 over any of them without every call site tagging its error.
 */
export function statesOutcomeUnknown(message: string): boolean {
  return /\bmay or may not have (taken effect|landed|published|been \w+)/.test(message);
}

/**
 * Which help block belongs with this failure. An empty object means the global
 * command reference; omitting `helpFor` entirely means no block at all, for the
 * failures whose message already says everything useful.
 */
export interface HelpTarget {
  command?: string;
  subcommand?: string;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
  /** The help block to print under the message. */
  readonly helpFor: HelpTarget | undefined;
  /**
   * A one-line pointer to this help page, in place of the block. For a conflict
   * between flags that each parsed fine: the message already names which to
   * drop, and a full usage block under it buries that sentence. {@link helpFor}
   * is for a mistake in the command's SHAPE, where the block lists what works.
   */
  readonly hintFor: HelpTarget | undefined;
  /** A closest-match hint (`Did you mean: details`), when one is close enough. */
  readonly suggestion: string | undefined;

  constructor(
    message: string,
    opts: {
      helpFor?: HelpTarget;
      hintFor?: HelpTarget;
      suggestion?: string;
    } = {},
  ) {
    super(message);
    this.helpFor = opts.helpFor;
    this.hintFor = opts.hintFor;
    this.suggestion = opts.suggestion;
  }
}

/**
 * A named local input file that is not there — a bundle, a `--static` build,
 * a `--backend-env-file`, a `--secrets-file`, a `publish` directory. A path the
 * user typed is fixed by retyping it, so it is a usage failure like any other:
 * `SDK_USAGE`, exit 1. Exit 8 (`EXIT_SOURCE_UNRESOLVABLE`) is for a named
 * backend, release or module that is not there — a lookup, not a typo in the
 * command line. One class, so every command agrees.
 */
export class LocalFileNotFoundError extends UsageError {
  readonly exitCode = 1;
}

/**
 * A failure a caller may want to branch on without reading its prose.
 *
 * `code` is stable (`SDK_*`) and lands in the `--json` failure document beside
 * `details`, the failure's own data — the file and column pairs of a refused
 * static build, say. The message stays what a person reads on stderr.
 */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly details: unknown;
  readonly exitCode: number | undefined;

  constructor(
    readonly code: ErrorCode,
    message: string,
    opts: { details?: unknown; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.details = opts.details;
    this.exitCode = opts.exitCode;
  }
}

/**
 * Narrow an unknown catch binding — by shape as well as class. A project's
 * entry imports its OWN copy of the SDK, which can differ from the CLI's (a
 * global install, another project's bin); a usage error that copy throws while
 * the entry loads or exports (a `seedFile()` or `lambdaFile()` path that is not
 * there) must still read as `SDK_USAGE`, not an unclassified failure.
 */
export function isUsageError(err: unknown): err is UsageError {
  return err instanceof UsageError || (err instanceof Error && err.name === "UsageError");
}

// ── Constructors ────────────────────────────────────────────────────────────
//
// Every unknown-* failure is built here, from the registry. Nothing downstream
// hand-writes a list of valid commands or verbs, so a list can never go stale
// against the dispatch it describes.

/** `xanosdk <not-a-command>`. */
export function unknownCommand(
  name: string,
  opts: { help?: boolean } = {},
): UsageError {
  // A flag where the command goes (`xanosdk -P prof status`) is an unknown FLAG:
  // its name only, with the global flag it was likely meant as — and never the
  // value after its `=`.
  if (name.startsWith("-") && name !== "-") {
    const flag = flagName(name);
    const hint = suggestFlag(flag, undefined);
    return new UsageError(
      `Unknown flag ${flag} before the command. Global flags go after it: \`xanosdk <command> ${hint ?? "<flag>"}${hint === "-p" || hint === "--profile" ? " <profile>" : ""}\`.`,
      { helpFor: {}, suggestion: hint },
    );
  }
  const owned = verbOwnerHint(name, opts.help === true);
  if (owned !== undefined) {
    return new UsageError(`Unknown command "${name}". ${owned.hint}`, {
      helpFor: { command: owned.command },
    });
  }
  // Through the verb filter, so a command that does the opposite is never the
  // did-you-mean: `push` is not `pull`, `undeploy` not `deploy`.
  return new UsageError(`Unknown command "${name}".`, {
    helpFor: {},
    suggestion: suggestVerb(name, liveCommandNames()),
  });
}

/**
 * A word that is not a command but IS a verb of one — `cache`, typed without
 * the `local-engine` it lives under. A spelling suggestion cannot reach that
 * (the nearest command name is unrelated), so the owner is named instead,
 * with the full path to type.
 */
function verbOwnerHint(
  name: string,
  help: boolean,
): { command: string; hint: string } | undefined {
  const owners = liveCommandNames().filter((c) =>
    liveSubcommandNames(c).includes(name),
  );
  if (owners.length === 0) return undefined;
  const paths = owners
    .map((c) => `\`xanosdk ${help ? "help " : ""}${c} ${name}\``)
    .join(" or ");
  const nouns = owners.map((c) => `\`${c}\``).join(" and ");
  return {
    command: owners[0]!,
    hint: `\`${name}\` is a subcommand of ${nouns}: ${paths}.`,
  };
}

/**
 * `xanosdk help <not-a-command>` — a help request for a topic that doesn't exist.
 *
 * Printed the global command reference and exited 0, which is the one answer
 * that can't be right: the reader ASKED about a specific word, and a successful
 * dump of everything else reads as though the word was fine. Same shape as
 * {@link unknownCommand} — closest match, the reference underneath, non-zero —
 * because it is the same mistake, made one token later.
 */
export function unknownHelpTopic(name: string): UsageError {
  const owned = verbOwnerHint(name, true);
  if (owned !== undefined) {
    return new UsageError(
      `\`xanosdk help\`: no help topic "${name}". ${owned.hint}`,
      {
        helpFor: { command: owned.command },
      },
    );
  }
  return new UsageError(`\`xanosdk help\`: no help topic "${name}".`, {
    helpFor: {},
    suggestion: suggest(name, liveCommandNames()),
  });
}

/**
 * `xanosdk <noun> <not-a-verb>` — the family's help block lists the real ones.
 *
 * `positionals` lets a verb that moved to the top level be renamed with the
 * name that was typed (see {@link movedVerb}).
 */
export function unknownSubcommand(
  command: string,
  sub: string | undefined,
  positionals: readonly string[] = [],
): UsageError {
  const moved = movedVerb(command, sub, positionals);
  if (moved !== undefined) return moved;
  // A flag where the verb goes (`marketplace --json`) is a missing verb, not an
  // unknown one — the same answer `lock --json` gives.
  const missing = sub === undefined || sub === "" || sub.startsWith("-");
  const what = missing ? "no subcommand given" : `unknown subcommand "${sub}"`;
  const verbs = liveSubcommandNames(command);
  return new UsageError(`\`xanosdk ${command}\`: ${what}.`, {
    helpFor: { command },
    suggestion: !missing ? suggestVerb(sub, verbs) : undefined,
  });
}

/**
 * The did-you-mean for an unknown verb: a synonym the family has first — it is
 * what the reader MEANT (`uninstall` is `remove`, never the `install` one edit
 * away) — then the closest spelling.
 */
export function suggestVerb(typed: string, verbs: readonly string[]): string | undefined {
  const synonym = VERB_SYNONYMS[typed]?.find((v) => verbs.includes(v));
  if (synonym !== undefined) return synonym;
  const spelled = suggest(typed, verbs);
  if (spelled === undefined || negates(typed, spelled)) return undefined;
  // A spelling neighbour that does the OPPOSITE is no correction: `env get` is
  // a read and `set` a write, `env push` sends and `pull` fetches. The typed
  // word's intent is its own class, or that of the verb word it misspells.
  const meant = Object.hasOwn(VERB_INTENT, typed) ? typed : suggest(typed, Object.keys(VERB_INTENT));
  const want = meant === undefined ? undefined : VERB_INTENT[meant];
  const got = Object.hasOwn(VERB_INTENT, spelled) ? VERB_INTENT[spelled] : undefined;
  return want !== undefined && got !== undefined && want !== got ? undefined : spelled;
}

/**
 * True when one word is the other's undoing — `undeploy`/`deploy`,
 * `unset-live`/`set-live`, `deactivate`/`activate`: the same stem behind an
 * `un` or `de`, which is a spelling neighbour and the opposite act.
 */
function negates(a: string, b: string): boolean {
  const stem = (w: string, p: string): string | undefined => (w.startsWith(p) ? w.slice(p.length).replace(/^-/, "") : undefined);
  return ["un", "de"].some((p) => stem(a, p) === b || stem(b, p) === a);
}

/**
 * What a verb word does, for refusing a did-you-mean across kinds: `read`
 * looks, `fetch` brings a backend's state here, `send` changes a backend.
 */
const VERB_INTENT: Readonly<Record<string, "read" | "fetch" | "send">> = {
  list: "read",
  ls: "read",
  show: "read",
  get: "read",
  details: "read",
  view: "read",
  info: "read",
  describe: "read",
  search: "read",
  cat: "read",
  pull: "fetch",
  fetch: "fetch",
  download: "fetch",
  export: "fetch",
  push: "send",
  upload: "send",
  put: "send",
  set: "send",
  unset: "send",
  delete: "send",
  remove: "send",
  rm: "send",
  install: "send",
  reinstall: "send",
  create: "send",
  add: "send",
  prune: "send",
  rename: "send",
  deploy: "send",
  "set-live": "send",
  "set-default": "send",
  use: "send",
};

/**
 * The verb another CLI's habit reaches for, to the one a family here spells it
 * with — offered as the did-you-mean, never run in its place. The first one the
 * family has wins.
 */
const VERB_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  remove: ["delete", "unset", "prune"],
  rm: ["delete", "remove", "unset", "prune"],
  del: ["delete", "remove", "unset"],
  delete: ["remove", "unset"],
  destroy: ["delete", "remove"],
  uninstall: ["remove", "delete"],
  un: ["remove", "delete"],
  unset: ["delete", "remove"],
  mv: ["rename"],
  move: ["rename"],
  switch: ["use", "set-live"],
  promote: ["set-live"],
  activate: ["set-live", "use"],
  default: ["set-default"],
  select: ["use"],
  ls: ["list"],
  new: ["create", "add"],
  add: ["create", "install"],
  create: ["add"],
  info: ["show", "get", "details"],
  view: ["show", "get", "details"],
  describe: ["show", "get", "details"],
  get: ["show", "details"],
  show: ["get", "details"],
};

/**
 * A `--flag` the parser does not know.
 *
 * Every unrecognized flag used to be collected and then dropped in silence, so
 * the command ran with the flag's effect simply MISSING — `export --frozen-lok`
 * exited 0 with the CI guard off, `deploy --strcit` shipped the warnings it was
 * asked to promote. Unknown COMMANDS were always rejected; this closes the same
 * door on flags, with the suggestion drawn from the flag registry.
 */
export function unknownFlag(
  flags: readonly string[],
  target: HelpTarget | undefined,
  alsoKnown: readonly string[] = [],
): UsageError {
  // The flag's NAME only, never what followed its `=`: a mistyped secret-bearing
  // flag (`--doc-tokne=notes=<token>`, `--env-vra=KEY=<value>`) carried the
  // secret into the refusal, on stderr and in the JSON document both.
  const names = [...new Set(flags.map(flagName))];
  // `--json=x`: a flag this command knows, given a value it does not take.
  // "Unknown flag --json. Did you mean --json" contradicted itself — and with
  // a second, really unknown flag beside it, it still did (`whoami --json=x
  // --frob=y`). Each problem is reported as what it is.
  const known = (name: string): boolean =>
    suggestFlag(name, target, alsoKnown) === name ||
    scopedFlagNames(target).some((n) => shortSpellings(n).includes(name));
  const valued = names.filter((n) => known(n) && flags.some((f) => f !== n && flagName(f) === n));
  const unknown = names.filter((n) => !valued.includes(n));
  const noValue =
    valued.length === 0
      ? ""
      : `${valued.map((n) => `\`${n}\``).join(", ")} ${valued.length === 1 ? "takes" : "take"} no value — drop the \`=\` and what follows it.`;
  const [first, ...rest] = unknown;
  if (first === undefined) return new UsageError(noValue, { helpFor: target });
  // `profile add --token abc`: the one place a token is taken reads it from
  // stdin, never argv (shell history, `ps`). Said as the way to pass it — and
  // never with the value typed, which the name-only rule above already drops.
  const tokenNote =
    target?.command === "profile" && target.subcommand === "add" && unknown.includes("--token")
      ? ` The token is read from stdin: \`printf %s "$TOKEN" | xanosdk profile add <name>\`.`
      : "";
  return new UsageError(
    `Unknown flag ${first}${rest.length ? ` (also ${rest.join(", ")})` : ""}.${noValue === "" ? "" : ` ${noValue}`}${tokenNote}`,
    {
      helpFor: target,
      suggestion: suggestFlag(first, target, alsoKnown),
    },
  );
}

/** A registry flag's short spellings (`profile` → `-p`), read off its help spec. */
function shortSpellings(key: string): string[] {
  const spec = (FLAGS as Record<string, { spec: string } | undefined>)[key]?.spec ?? "";
  return spec.split(/[\s,=[]+/).filter((t) => /^-[A-Za-z]$/.test(t));
}

/** `--x=value` → `--x`: all a refusal may repeat of a flag token it did not recognise. */
export function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq < 0 ? token : token.slice(0, eq);
}

/**
 * The closest real flag to what was typed, rendered as it would be typed.
 *
 * Drawn from the flags THIS command (or verb) declares plus the global ones —
 * never the whole registry. The parser refuses any flag a command does not
 * declare, so a registry-wide match (`profile show --instnce` → `--instance`)
 * sent the reader straight into "takes no `--instance`". No close match here
 * means no suggestion.
 *
 * `alsoKnown` carries flags that exist for THIS run but are not in the static
 * registry — a toolchain module's derived question flags. Without them a
 * typo'd module flag got "Unknown flag" and no way forward, which is the worst
 * case for an agent: the name it needs is knowable and nothing tells it.
 */
function suggestFlag(
  flag: string,
  target: HelpTarget | undefined,
  alsoKnown: readonly string[] = [],
): string | undefined {
  const names = [...scopedFlagNames(target), ...alsoKnown];
  // A short flag in the wrong case (`-P`): the short it is, when one in scope
  // differs only by case. Edit distance cannot see it — `P` is far from `profile`.
  const short = /^-([A-Za-z])$/.exec(flagName(flag))?.[1];
  if (short !== undefined) {
    const shorts = names.flatMap((n) => shortSpellings(n));
    const other = short === short.toLowerCase() ? short.toUpperCase() : short.toLowerCase();
    if (shorts.includes(`-${other}`)) return `-${other}`;
  }
  const typed = flagName(flag).replace(/^-+/, "");
  const match = suggest(typed, names);
  return match === undefined ? undefined : `--${match}`;
}

/**
 * The flags a command line naming `target` can carry: the global ones (with
 * `--profile` only where it is honoured) and the command's or verb's own. A
 * noun whose verb is not known yet offers every verb's flags.
 */
function scopedFlagNames(target: HelpTarget | undefined): string[] {
  const command = target?.command;
  const spec = command === undefined ? undefined : getCommand(command);
  const own =
    spec === undefined
      ? []
      : target?.subcommand !== undefined
        ? [getSubcommand(command!, target.subcommand)]
        : spec.subcommands !== undefined
          ? Object.values(spec.subcommands)
          : [spec];
  const declared = own.flatMap((s) => (s === undefined ? [] : (visibleFlags(s) ?? []).map(flagKey)));
  const globals = GLOBAL_FLAGS.filter(
    (f) => f !== "profile" || command === undefined || takesProfileFlag(command, target?.subcommand),
  );
  return [...new Set([...globals, ...declared])];
}

/**
 * Positionals the command has nowhere to put.
 *
 * A parser that hands the command only `positionals[0]` never reads anything
 * past the arguments the command declares. `xanosdk deploy a.ts b.ts` would
 * deploy `a.ts` and say nothing about `b.ts`, and `--lock path` — the boolean
 * flag plus a path the reader believed was its value — would export with the
 * DEFAULT lock while the path sat in `positionals` unused. Both are the same
 * failure: the CLI acting on a different invocation than the one that was
 * typed, and reporting success.
 *
 * `attachedValueFlag` names the flag a stray positional immediately followed,
 * for the case worth diagnosing precisely rather than counting: the value was
 * written with a space where the flag only accepts it attached.
 */
export function extraArguments(
  extras: readonly string[],
  target: { command: string; subcommand?: string },
  max: number,
  attachedValueFlag?: string,
): UsageError {
  const where = target.subcommand
    ? `${target.command} ${target.subcommand}`
    : target.command;
  // `KEY=VALUE` is named by its KEY: a stray assignment is most often a
  // flag's value that lost its flag, and that value may be a secret.
  const named = extras.map((e) => `"${e.includes("=") ? `${flagName(e)}=…` : e}"`).join(", ");
  const noun = extras.length === 1 ? "argument" : "arguments";
  // A backend written as a positional where this command names one only with a
  // flag (E2E pass 28: `env pull ephemeral:x`): the rewrite, and the flag as
  // the did-you-mean.
  const selector = max === 0 && extras.length === 1 ? positionalSelectorHint(extras[0]!, target) : undefined;
  const why =
    selector !== undefined
      ? `\`xanosdk ${where}\` takes no positional arguments; it names its backend with \`${selector.flag}\`: ` +
        `\`${selector.flag} ${extras[0]}\`.`
      : attachedValueFlag !== undefined
      ? // `--lock` is the only flag with an attached-only value form, and its
        // value is a path — spelled out here rather than reconstructed from the
        // flag registry, whose `spec` strings are written for help, not reuse.
        `\`${attachedValueFlag}\` takes its value attached: \`${attachedValueFlag}=<path>\`.`
      : (specFor(target)?.extraArgHint ??
        (max === 0
          ? `\`xanosdk ${where}\` takes no positional arguments.`
          : `\`xanosdk ${where}\` takes at most ${max}: ${renderArgs(specFor(target)?.args)}.`));
  return new UsageError(
    `\`xanosdk ${where}\`: unexpected ${noun} ${named} — ${why}`,
    {
      helpFor: target,
      ...(selector === undefined ? {} : { suggestion: selector.flag }),
    },
  );
}

/** A backend handle (`ephemeral:x`, `local-engine`, …). */
const BACKEND_HANDLE = /^(?:workspace|ephemeral|local-engine|tenant)(?::[^\s=]+)?$/;

/** The selector flag a stray backend positional belongs on, when the command has exactly one. */
function positionalSelectorHint(
  extra: string,
  target: { command: string; subcommand?: string },
): { flag: string } | undefined {
  if (!BACKEND_HANDLE.test(extra)) return undefined;
  const own = selectorSpellings(target.command, target.subcommand);
  return own.length === 1 && /^`--/.test(own[0]!) ? { flag: own[0]!.slice(1, -1) } : undefined;
}

/**
 * The parse failures of `env set`, which name no token.
 *
 * {@link unknownFlag} and {@link extraArguments} quote what was typed, and on
 * this verb what was typed is a secret: a value that starts with `-` lands in
 * the unknown flags, and an unquoted value with a space is split into surplus
 * positionals. Neither can be told apart from a typo, so neither is echoed —
 * the way out is stdin, which carries any value intact.
 */
export function envSetArgumentsRefused(problem: "flag" | "extra", flags: readonly string[] = []): UsageError {
  // A `--`-spelled token close to one of the verb's flags (`--ot` → `--to`) is
  // suggested by the FLAG's name, which is all the suggestion ever prints — a
  // value that happens to look like a flag is still not repeated.
  const target = { command: "env", subcommand: "set" };
  const suggestion = flags
    .filter((f) => f.startsWith("--"))
    .map((f) => suggestFlag(f, target))
    .find((m) => m !== undefined);
  const what =
    problem === "flag"
      ? "an argument starting with `-` is not a flag it knows"
      : "it takes at most NAME and VALUE, and got more";
  return new UsageError(
    `\`xanosdk env set\`: ${what}. It is not repeated here in case it is the value. A value that ` +
      `starts with \`-\` or holds spaces is safest piped on stdin: \`printf %s "$VALUE" | xanosdk env set NAME\`.`,
    { helpFor: target, suggestion },
  );
}

/** The registry entry a help target names — the verb's when it has one, else the command's. */
function specFor(target: {
  command: string;
  subcommand?: string;
}): CommandSpec | SubcommandSpec | undefined {
  return target.subcommand !== undefined
    ? getSubcommand(target.command, target.subcommand)
    : getCommand(target.command);
}

/** A required positional the invocation didn't supply. */
export function missingArgument(
  arg: string,
  target: { command: string; subcommand?: string },
): UsageError {
  const where = target.subcommand
    ? `${target.command} ${target.subcommand}`
    : target.command;
  return new UsageError(`\`xanosdk ${where}\`: missing required <${arg}>.`, {
    helpFor: target,
  });
}

/**
 * Render any failure to STDERR in the CLI's own vocabulary: the `✗` headline,
 * a did-you-mean line when there is one, and — for a UsageError only — the help
 * block that lists what WOULD have worked (or, for a conflict between flags,
 * one line pointing at it — see {@link UsageError.hintFor}).
 *
 * Everything lands on stderr, including the help block, so a failed run never
 * writes to the data channel a caller may be piping. Requested help goes to
 * stdout; help shown because something broke does not.
 */
export function reportFailure(
  err: unknown,
  version = "",
  argv: readonly string[] = [],
): void {
  const s = stderrStyle();
  // A library message's own `xanosdk:` prefix is dropped once, here, for both
  // channels: the `✗` says the CLI reported it, and a JSON `message` starting
  // with the tool's name is the same word twice to a reader of the document.
  const message = (err instanceof Error ? err.message : String(err)).replace(
    /^xanosdk: /,
    "",
  );
  // A document on stdout, because a failure is an answer too: without one, the
  // caller sees exit 1 over an empty stdout and has only the prose below to go
  // on. The same rule as a success document — `--json`, or stdout not a
  // terminal — so a piped failure is not the one answer with nothing on stdout.
  // Skipped when the command already wrote its document (a release write emits
  // its operation result before it throws), so stdout stays ONE parseable
  // document; and without `--json`, for a command whose stdout is its DATA
  // (`export`, `llms`, `--path -`): a failure must not land in the file that
  // data was piped to.
  if (failureWritesDocument(argv, err) && !jsonDocumentWritten(err))
    writeJson(failureDocument(err, message));
  error(indentContinuation(message));
  if (!isUsageError(err)) return;
  // A message that already quotes the correction (`"./frontend/dist" is: ...`)
  // is not repeated under it: the suggestion stays in the document, the prose
  // says it once.
  // Every near name when one failure missed several (E2E pass 30: `--seed`
  // with two names printed only the first), each once.
  const many = (err as { suggestions?: unknown }).suggestions;
  const near = (
    Array.isArray(many) && many.length > 1 && many.every((n) => typeof n === "string")
      ? (many as string[])
      : err.suggestion === undefined
        ? []
        : [err.suggestion]
  ).filter((n) => !namesSuggestion(message, n));
  if (near.length > 0) {
    process.stderr.write("\n");
    detail(`Did you mean: ${near.map((n) => s.cyan(n)).join(" or ")}`);
  }
  if (err.hintFor?.command !== undefined) {
    const path = [err.hintFor.command, err.hintFor.subcommand]
      .filter((p) => p !== undefined)
      .join(" ");
    process.stderr.write("\n");
    detail(`Run \`xanosdk ${path} --help\` for its usage and flags.`);
  }
  if (err.helpFor === undefined) return;
  process.stderr.write(terminalText("\n" + indentBlock(renderHelpFor(err.helpFor, s, version))));
}

/**
 * Whether a failure of this command line writes a JSON document on stdout:
 * `--json`, or stdout not a terminal — unless stdout carries the command's data.
 */
export function failureWritesDocument(argv: readonly string[], err?: unknown): boolean {
  const json = argv.includes("--json");
  return json || (isMachineOutput({ json }) && !stdoutCarriesData(argv, err));
}

/** Whether a failure's message already quotes its suggestion, so a "Did you mean" line would repeat it. */
function namesSuggestion(message: string, suggestion: string): boolean {
  return message.includes(`"${suggestion}"`) || message.includes(`\`${suggestion}\``);
}

/** Commands whose stdout is data, not a document: a bundle, a guide, a completion script, text. */
const DATA_STDOUT_COMMANDS = new Set([
  "export",
  "llms",
  "completion",
  "version",
  "help",
]);

/** Global flags that take their value as the next word, so it is not read as the command. */
const VALUE_FLAGS = new Set(["--profile", "-p", "--config", "--origin"]);

/**
 * Whether this command line's stdout carries the command's data rather than a
 * JSON document — so a piped failure writes none there. The command is the
 * first word that is not a flag or a global flag's value; `--path -` sends any
 * export's data to stdout; `--help` is text — unless the failure is a usage
 * error, which printed no help to stdout (E2E pass 18: `<verb> <unknown> --help`
 * piped wrote no failure document).
 */
function stdoutCarriesData(argv: readonly string[], err?: unknown): boolean {
  if ((argv.includes("--help") || argv.includes("-h")) && !isUsageError(err)) return true;
  if (
    argv.includes("--path=-") ||
    argv.some((a, i) => a === "--path" && argv[i + 1] === "-")
  )
    return true;
  const command = argv.find(
    (a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(argv[i - 1] ?? ""),
  );
  // `export --out <file>` writes its bundle to the file, and `export --check`
  // writes no bundle at all; a piped stdout then carries the success document
  // — so the failure writes one too.
  if (command === "export")
    return !writesToFile(argv) && !argv.includes("--check");
  return command === undefined || DATA_STDOUT_COMMANDS.has(command);
}

/** Whether `--out`/`-o` names a file rather than `-` (stdout). */
function writesToFile(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value =
      a === "--out" || a === "-o"
        ? argv[i + 1]
        : a.startsWith("--out=")
          ? a.slice("--out=".length)
          : undefined;
    if (value !== undefined && value !== "" && value !== "-") return true;
  }
  return false;
}

/**
 * A multi-line failure message laid out under its `✗` headline: every
 * continuation line indented to the text after the glyph, so a remedy on the
 * second line reads as part of the failure rather than as a new, unmarked one
 * flush against the margin. Done once, here, for every error — the messages
 * themselves stay plain lines (the `--json` `message` carries them unindented).
 *
 * A message that already indents EVERY continuation line laid itself out for
 * this position and is left as written; blank lines stay blank.
 */
export function indentContinuation(message: string): string {
  const [head, ...rest] = message.split("\n");
  if (rest.length === 0) return message;
  const text = rest.filter((line) => line.trim() !== "");
  if (text.length > 0 && text.every((line) => /^\s/.test(line))) return message;
  return [
    head,
    ...rest.map((line) => (line.trim() === "" ? "" : `  ${line}`)),
  ].join("\n");
}

/**
 * The `--json` failure document:
 * `{ ok: false, error: { code, message, exitCode, details?, suggestion?, suggestions? } }` — `suggestions` only when one failure missed several names.
 *
 * Every failure gets a code — its own when it carries an `SDK_*` one (a
 * {@link CliError}, an export's failed checks), `SDK_USAGE` for a mistyped
 * invocation, `SDK_ERROR` for one not yet given its own — so a caller branches
 * on the code and never on the message text. `suggestion` is the did-you-mean
 * stderr shows under a usage failure.
 */
function failureDocument(err: unknown, message: string): Record<string, unknown> {
  // The code the PROCESS exits with, so the document never disagrees with it.
  return { ok: false, error: failureError(err, message, processExitCode(err)) };
}

/** A failure document's `error` member. */
export interface FailureError {
  /** `SDK_*` — the failure's own code, `SDK_USAGE`, or `SDK_ERROR`. */
  code: string;
  message: string;
  /** The exit code this run ends with. */
  exitCode: number;
  /** The failure's own data, when it carries some (`conflictsWith`, a refusal's lists). */
  details?: unknown;
  /** The did-you-mean — of a usage failure, or a not-found name's near one; the first when there are several. */
  suggestion?: string;
  /** Every near name, when one failure missed several (`marketplace install authh chatbt`). */
  suggestions?: string[];
}

/**
 * The `error` member of every failure document — the plain one above and an
 * operation result's alike, so one failure never reads two ways.
 */
export function failureError(err: unknown, message: string, exitCode: number): FailureError {
  const details = ownCode(err)?.details;
  // A usage error's did-you-mean, or a not-found one's near key (read by shape:
  // the lock layer does not import the CLI's error types).
  const own = (err as { suggestion?: unknown } | null | undefined)?.suggestion;
  const suggestion = isUsageError(err) ? err.suggestion : typeof own === "string" ? own : undefined;
  const many = (err as { suggestions?: unknown } | null | undefined)?.suggestions;
  const suggestions = Array.isArray(many) && many.length > 1 && many.every((s) => typeof s === "string") ? (many as string[]) : undefined;
  return {
    code: failureCode(err),
    message,
    exitCode,
    ...(details === undefined ? {} : { details }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(suggestion === undefined || suggestions === undefined ? {} : { suggestions }),
  };
}

/**
 * The code a failure is branched on: its own `SDK_*` one, `SDK_USAGE` for a
 * mistyped invocation, `SDK_ERROR` otherwise. Shared by the failure document
 * and the operation result's `error`, so one failure never carries two codes.
 */
export function failureCode(err: unknown): string {
  return ownCode(err)?.code ?? (isUsageError(err) ? "SDK_USAGE" : "SDK_ERROR");
}

/**
 * The stable code and data a failure carries, read by shape rather than class:
 * the export's checks throw from the workspace layer, which does not import the
 * CLI's error types. A Node system error's `code` (`ENOENT`) is not `SDK_*`, so
 * it falls through to `SDK_ERROR` with the rest.
 */
function ownCode(err: unknown): { code: string; details: unknown } | undefined {
  const { code, details } = (err ?? {}) as {
    code?: unknown;
    details?: unknown;
  };
  return typeof code === "string" && code.startsWith("SDK_")
    ? { code, details }
    : undefined;
}

/**
 * The process exit code a failure asks for, when it asks for one.
 *
 * A thrown error exits 1 by default, which says only "this did not work". Two
 * commands already distinguish their failure MODES by code — a validation that
 * ran and disagreed, a static build that broke — because a caller scripting
 * around them acts differently on each. An error carrying `exitCode` gets the
 * same treatment without every command having to reach for `process.exitCode`
 * and then find a second way to print its message.
 */
export function exitCodeOf(err: unknown): number {
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" &&
    Number.isInteger(code) &&
    code > 0 &&
    code < 256
    ? code
    : 1;
}

/**
 * The code the process exits with for a failure that reached the bin — and
 * that its `--json` document carries: {@link exitCodeOf}, except that a
 * failure with no code of its own whose message says a write's outcome is
 * unknown exits 9 ("read before retrying"). Every transport phrases a lost
 * answer through a few fixed sentences (see `statesOutcomeUnknown`), so a
 * deploy's import, an env write or a delete exit 9 without each tagging its
 * error. Kept out of {@link exitCodeOf}, which the operation-result wrapper
 * reads for a failure's OWN code.
 */
export function processExitCode(err: unknown): number {
  const own = exitCodeOf(err);
  if (own !== 1 || (err as { exitCode?: unknown } | null)?.exitCode === 1)
    return own;
  return err instanceof Error && statesOutcomeUnknown(err.message)
    ? EXIT_OUTCOME_UNKNOWN
    : 1;
}

/**
 * The verbs that once lived under a backend noun and are top-level now, each
 * taking the backend as its positional, mapped to the nouns whose rename lands
 * on a spelling the verb accepts. `workspace impersonate` is left out: pointing
 * it at `impersonate workspace` would name a spelling the verb refuses.
 */
const MOVED_TO_TOP_LEVEL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["tables", new Set(["workspace", "ephemeral", "tenant", "local-engine"])],
  ["impersonate", new Set(["ephemeral", "tenant", "local-engine"])],
]);

/**
 * The rename error for `xanosdk ephemeral tables pr-3` — "it is `xanosdk tables
 * ephemeral:pr-3` now" — or undefined when `sub` under `command` is not a moved
 * verb.
 *
 * Not an alias, deliberately: agents arrive with cached docs, and a spelling
 * that kept working would never be unlearned, while one that fails naming its
 * replacement is corrected on the first run. The replacement is built from what
 * was typed, so it is ready to paste — the noun becomes the kind and the name
 * its suffix, and a tenant typed with no name keeps the `<name>` it needs.
 */
export function movedVerb(
  command: string | undefined,
  sub: string | undefined,
  positionals: readonly string[],
): UsageError | undefined {
  if (
    command === undefined ||
    sub === undefined ||
    MOVED_TO_TOP_LEVEL.get(sub)?.has(command) !== true
  ) {
    return undefined;
  }
  const name = positionals[0];
  const backend =
    command === "workspace"
      ? "workspace"
      : name !== undefined && name !== ""
        ? `${command}:${name}`
        : command === "tenant"
          ? "tenant:<name>"
          : command;
  const replacement =
    sub === "tables" ? tablesCommand(backend) : `xanosdk ${sub} ${backend}`;
  return new UsageError(
    `\`xanosdk ${command} ${sub}\` is now \`${replacement}\`: \`${sub}\` is one top-level verb that takes ` +
      `the backend as its argument, and bare it follows what this project last deployed to.`,
    { helpFor: { command: sub } },
  );
}

/**
 * Route the SDK's build diagnostics through the CLI's warning line (`! …`),
 * the way every other warning prints — rather than `console.warn`'s
 * `xanosdk: …`, which read as a different tool's output beside them.
 */
export function installCliDiagnosticSink(): void {
  setDiagnosticSink((diagnostic) => {
    warn(diagnostic.message, diagnostic.code);
    // The def it is about, for every `--json` document this run writes.
    if (diagnostic.subject !== undefined) noteRunWarning(diagnostic.code, diagnostic.message, diagnostic.subject);
  });
}
