/**
 * How a BACKEND is named on the command line, in one place.
 *
 * One grammar for every command that reads from or writes to a backend:
 *
 *   workspace              the real workspace the credential is bound to
 *   ephemeral              the ephemeral this project last deployed to
 *   ephemeral:<name>       a named ephemeral environment
 *   local-engine           the local engine recorded for this project directory
 *   local-engine:<name>    a local engine on this machine, by its enumerated name
 *   release:<name>         a release stored on the instance
 *   tenant:<name>          a tenant
 *   <path>                 a bundle already on disk
 *
 * **This parser fails closed, and that is the whole reason it exists.** The
 * layer below returns `undefined` for anything it does not recognise so that
 * `init --from` can fall through to a path — which meant `--from relase:main`
 * landed in the path arm and reported a missing file, naming neither the
 * mistake nor the fix. That was survivable while the only destination was a
 * throwaway environment. It is not survivable now that a mis-parse can address
 * a workspace, so anything shaped like `kind:` is resolved as a kind or
 * refused, and never reinterpreted as a filename.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 * - **Reject, do not normalize.** `Workspace` is an error carrying the correct
 *   spelling, not a silent lowercase. Accepting both keeps two spellings alive
 *   and hides the mistake instead of fixing it.
 * - **A bare word is a path only when it looks like one** — it carries a
 *   separator or a bundle extension. Reading every unprefixed argument as a
 *   path would turn a typo into a missing-file report about a file nobody
 *   meant to name.
 *
 * `accepted` is required rather than optional because every caller takes a
 * different subset: `promote` only a release, `release create --from` only
 * the kinds a release can be cut from, `pull` every running backend. A parser that knew only the global set could
 * offer spellings the caller rejects, and every command would re-implement the
 * subset check — which is the duplication one vocabulary exists to remove.
 *
 * Pure: no filesystem, no network. Resolving `ephemeral` to a tracked name,
 * and deciding whether any of these is still alive, belongs to the resolver.
 */
import { checkOneName, runNameContext } from "./name-check.js";
import { withArticle } from "../util/article.js";
import { UsageError, type HelpTarget } from "./errors.js";
import { suggest } from "../util/suggest.js";
import { shellQuote } from "../util/shell-quote.js";

/** The kinds an argument can name. The local project entry is absence, not a spelling. */
export type SourceKind = "workspace" | "ephemeral" | "local-engine" | "release" | "tenant" | "file";

/** A backend as the command line names it, before any lookup. */
export type Source =
  | { kind: "workspace" }
  /** `name` absent means "whichever one this project last deployed to". */
  | { kind: "ephemeral"; readonly name?: string }
  /** `name` absent means "the engine recorded for this project directory". */
  | { kind: "local-engine"; readonly name?: string }
  | { kind: "release"; readonly name: string }
  | { kind: "tenant"; readonly name: string }
  | { kind: "file"; readonly path: string };

/**
 * The kinds a release may be cut from.
 *
 * A release is a claim that its contents came up and answered, so it can only
 * be cut from something running. A bundle on disk has never run, which is why
 * `file` is absent here and not merely discouraged.
 *
 * `tenant` is present: the server reads a tenant's state directly and writes
 * nothing to it, so cutting from one is not a write to someone else's
 * deployment.
 *
 * LIVE deployments are still refused: only a throwaway tenant (`ephemeral`,
 * `sandbox`) may be a source, and `release create` enforces that once the
 * tenant's type is known. A `standard` or `run` tenant is a customer's running
 * deployment, and its schema — with table selection, its records — is not ours
 * to copy out.
 */
export const CUT_KINDS = ["workspace", "ephemeral", "tenant"] as const satisfies readonly SourceKind[];

/**
 * Every running backend: the cut kinds plus a local engine.
 *
 * A local engine is absent from {@link CUT_KINDS} only because the cut runs on
 * the instance, which cannot reach an engine on this machine. Every other
 * operation against a running backend takes it.
 */
export const BACKEND_KINDS = [
  "workspace",
  "ephemeral",
  "local-engine",
  "tenant",
] as const satisfies readonly SourceKind[];

/**
 * Exit code for a source that could not be resolved, or resolved to something
 * not alive.
 *
 * One code shared by every command that takes a source, so a CI wrapper can
 * retry this case — an environment swept between two steps is the common
 * cause — and investigate the rest.
 *
 * The allocation, in one place so a new code does not collide with an old one:
 * 2 through 7 are taken (verify/validation/import-conflict, static,
 * microservice, tests-failed, tests-unreachable, upgrade-available), 8 is this
 * one, 9 is a write whose outcome is unknown (`EXIT_OUTCOME_UNKNOWN` in
 * `operation-outcome.ts`, Ctrl-C during a write included), and 130 is SIGINT
 * outside a write.
 */
export const EXIT_SOURCE_UNRESOLVABLE = 8;

/** Kinds written `kind:<name>`, mapped to whether the name is required. */
const PREFIXED: Partial<Record<SourceKind, "required" | "optional">> = {
  release: "required",
  tenant: "required",
  ephemeral: "optional",
  "local-engine": "optional",
};

/** Kinds that stand alone as a bare word. */
export const BARE: readonly SourceKind[] = ["workspace", "ephemeral", "local-engine"];

/**
 * True when `raw` is shaped like `kind:` — letters and hyphens before a colon.
 *
 * The one test for "this names a kind, not a path". Hyphens are in the class
 * because `local-engine` is a kind: a narrower test let `local-engine:x` fall
 * through to the path arm, the silent reinterpretation this module exists to
 * close. Anything that matches is resolved as a kind or refused.
 */
export function isKindShaped(raw: string): boolean {
  return /^[a-z][a-z-]*:/.test(raw);
}

/** How each kind is spelled, for an error that lists what WOULD have worked. */
function spellingsOf(kind: SourceKind): readonly string[] {
  switch (kind) {
    case "workspace":
      return ["workspace"];
    case "ephemeral":
      return ["ephemeral", "ephemeral:<name>"];
    case "local-engine":
      return ["local-engine", "local-engine:<name>"];
    case "release":
      return ["release:<name>"];
    case "tenant":
      return ["tenant:<name>"];
    case "file":
      return ["a path to a bundle .json"];
  }
}

/**
 * The spellings a given caller accepts, rendered for an error message.
 *
 * Only the caller's kinds: offering `tenant:<name>` to a command that refuses
 * a tenant sends the user down a second wrong path from inside the message
 * that was supposed to end the first one.
 */
export function sourceSpellings(accepted: readonly SourceKind[]): string {
  const parts = accepted.flatMap(spellingsOf);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

/**
 * The failure for an argument that names nothing the caller takes.
 *
 * A one-line pointer to the help page, not the block: the message already
 * lists every spelling the command takes, which is all the block would add.
 */
function refuse(
  raw: string,
  accepted: readonly SourceKind[],
  helpFor: HelpTarget,
  because: string,
  noun: SelectorNoun = SOURCE_NOUN,
  suggestion?: string,
): UsageError {
  return new UsageError(
    `"${raw}" ${because}. ${noun.plural} are ${sourceSpellings(accepted)}.`,
    { hintFor: helpFor, ...(suggestion === undefined ? {} : { suggestion }) },
  );
}

/**
 * The corrected ARGUMENT for a mistyped keyword, spelled whole — `ephemerl:foo`
 * → `ephemeral:foo`, `locl-engine` → `local-engine` — drawn only from what this
 * caller takes, so the did-you-mean never offers a spelling it then refuses.
 * `undefined` when nothing is close.
 */
function keywordSuggestion(raw: string, accepted: readonly SourceKind[]): string | undefined {
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const kinds = accepted.filter((k) => (Object.hasOwn(PREFIXED, k) ? PREFIXED[k] : undefined) !== undefined);
    const kind = suggest(raw.slice(0, colon), kinds);
    return kind === undefined ? undefined : `${kind}${raw.slice(colon)}`;
  }
  return suggest(raw, accepted.filter((k) => BARE.includes(k)));
}

/**
 * What the argument being parsed IS, for the refusal's words: a source for
 * `--from`, a destination for `--to`, a backend for a positional or `--on`.
 * "Sources are workspace, or tenant:<name>" under `deploy --to` described the
 * one flag that writes as the one that reads.
 */
export interface SelectorNoun {
  readonly singular: string;
  readonly plural: string;
}

const SOURCE_NOUN: SelectorNoun = { singular: "source", plural: "Sources" };

/**
 * Parse one source, or throw a {@link UsageError} naming the caller's kinds.
 *
 * Throws rather than returning undefined: this is the outermost layer, so
 * there is nothing left to fall through to, and a source that quietly resolved
 * to a default would be a write against something nobody named.
 */
export function parseSource<K extends SourceKind>(
  raw: string,
  accepted: readonly K[],
  helpFor: HelpTarget,
  noun: SelectorNoun = SOURCE_NOUN,
): Extract<Source, { kind: K }> {
  checkOneName(raw, `the ${noun.singular}`, { helpFor, ...runNameContext() });
  // Anything shaped like a prefix is resolved as one or refused. It never
  // falls through to the path arm — that fall-through is the bug this module
  // was written to close.
  if (isKindShaped(raw)) {
    // Only the FIRST colon separates. A name carrying its own colon is a name,
    // and splitting on every colon would address something other than what was
    // typed.
    const colon = raw.indexOf(":");
    const kind = raw.slice(0, colon) as SourceKind;
    // Trimmed, as a branch label is: `tenant: eu` is a name typed with a space
    // after the colon, and no backend is named with one.
    const name = raw.slice(colon + 1).trim();

    if ((Object.hasOwn(PREFIXED, kind) ? PREFIXED[kind] : undefined) === undefined) {
      // A kind that exists but takes no name is a different mistake from a kind
      // that does not exist, and the fixes are not the same one.
      throw BARE.includes(kind)
        ? refuse(raw, accepted, helpFor, `takes no name — ${kind} names one thing`, noun)
        : refuse(raw, accepted, helpFor, `names no ${noun.singular} kind "${kind}"`, noun, keywordSuggestion(raw, accepted));
    }
    if (!(accepted as readonly SourceKind[]).includes(kind)) {
      throw refuse(raw, accepted, helpFor, `names ${withArticle(kind.replace("-", " "))}, which this command does not take`, noun);
    }
    // Empty is refused for both arities: `ephemeral:` is a name the user began
    // and did not finish, which is not the same as the bare `ephemeral` that
    // means the tracked one.
    if (name === "") throw refuse(raw, accepted, helpFor, `names no ${kind}`, noun);
    return { kind, name } as Extract<Source, { kind: K }>;
  }

  // A bare word that is one of the standalone keywords.
  if (BARE.includes(raw as SourceKind)) {
    const kind = raw as SourceKind;
    if (!(accepted as readonly SourceKind[]).includes(kind)) {
      throw refuse(raw, accepted, helpFor, `names the ${kind}, which this command does not take`, noun);
    }
    return { kind } as Extract<Source, { kind: K }>;
  }

  // A path, but only when it looks like one — the shape test `init --from` has
  // always applied. Widening it to "anything unprefixed" would read a typo as a
  // filename.
  if ((accepted as readonly SourceKind[]).includes("file") && (/\.json$/i.test(raw) || /[\\/]/.test(raw))) {
    return { kind: "file", path: raw } as Extract<Source, { kind: K }>;
  }

  // Path-SHAPED input, where a path is not on offer. Refused before the bare
  // name reading below, which would otherwise take `./ws.json` as the name of
  // an environment and report "no ephemeral named ./ws.json" — a sentence about
  // neither the input nor the fix. A file has never run, so for a caller that
  // takes only live sources this is a category error, not a typo.
  if (/\.json$/i.test(raw) || /[\\/]/.test(raw)) {
    throw refuse(raw, accepted, helpFor, "names a path, and a path has never run", noun);
  }

  // A caller that takes exactly one kind with a name can read a bare word as
  // that name: `promote main` cannot mean anything else. Where several kinds
  // are on offer the same word is ambiguous, and ambiguity resolves toward the
  // reading that cannot write anywhere — a refusal. So is a bare keyword on
  // offer beside the one named kind: `deploy --to bogus` takes `workspace` or
  // `tenant:<name>`, and reading the typo as a tenant name answered "no tenant
  // named bogus" for a word nobody meant as one.
  const named = (accepted as readonly SourceKind[]).filter((k) => (Object.hasOwn(PREFIXED, k) ? PREFIXED[k] : undefined) !== undefined);
  const others = (accepted as readonly SourceKind[]).filter((k) => k !== "file" && (Object.hasOwn(PREFIXED, k) ? PREFIXED[k] : undefined) === undefined);
  if (named.length === 1 && others.length === 0) {
    return { kind: named[0], name: raw } as Extract<Source, { kind: K }>;
  }

  throw refuse(raw, accepted, helpFor, `names no ${noun.singular}`, noun, keywordSuggestion(raw, accepted));
}

/**
 * The NAME a verb that already names its kind (`ephemeral get`, `tenant
 * delete`) takes, read from either spelling: the bare name, or the full
 * selector a `--json` document's `selector` carries (`ephemeral:e4f2-9ab1`),
 * which is stripped to its name. A selector of another kind is refused: it
 * names a backend this verb does not act on, and reading it as a name looked
 * up a backend called `tenant:acme` that no one has.
 */
export function verbBackendName(
  raw: string,
  kind: "ephemeral" | "tenant",
  helpFor: HelpTarget & { subcommand: string },
  /** This run's credential flags, for the printed command (see `contextFlags`). */
  flags = "",
): string {
  const value = raw.trim();
  if (!isKindShaped(value)) return value;
  const colon = value.indexOf(":");
  const typed = value.slice(0, colon);
  const name = value.slice(colon + 1).trim();
  const verb = `xanosdk ${kind} ${helpFor.subcommand}`;
  if (typed === kind) {
    if (name === "") throw new UsageError(`"${raw}" names no ${kind}. \`${verb}\` takes ${withArticle(kind)} name.`, { hintFor: helpFor });
    return name;
  }
  // The same verb on the kind it does name, where both have it: `get` and `delete`.
  const shared = helpFor.subcommand === "get" || helpFor.subcommand === "delete";
  const other = shared && (typed === "tenant" || typed === "ephemeral") ? `xanosdk ${typed} ${helpFor.subcommand}` : undefined;
  const known = Object.hasOwn(PREFIXED, typed) || BARE.includes(typed as SourceKind);
  throw new UsageError(
    `"${raw}" ${known ? `names ${withArticle(typed.replace("-", " "))}` : `names no backend kind "${typed}"`}, and \`${verb}\` takes ${withArticle(kind)} ` +
      `name (\`${kind}:<name>\` or the bare name).` +
      (other !== undefined && name !== "" ? ` For ${withArticle(typed)}, run \`${other} ${shellQuote(name)}${flags}\`.` : ""),
    { hintFor: helpFor },
  );
}

/**
 * True when `name` has the shape of a backend's handle: the platform assigns
 * every tenant and ephemeral one as three groups of four lowercase letters and
 * digits (`t5jl-kp7h-ec68`). A miss on one is an idempotent delete's "already
 * gone"; a miss on anything else — a display name, a typo of one, a sentence —
 * names no backend that ever existed.
 */
export function isBackendHandle(name: string): boolean {
  return /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(name);
}
