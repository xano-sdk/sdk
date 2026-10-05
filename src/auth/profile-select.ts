/**
 * WHICH profile a command acts on, as a pure grammar.
 *
 * Two independent ladders compose to reach a credential: which FILE
 * (`--config`/`$XANO_CONFIG` → `--local-auth` → the shared global cache, in
 * `resolveAuthFilePath`), then which PROFILE inside it — this module.
 *
 * Nothing here touches the filesystem: the caller reads the pointer file and
 * the credential file's `default` key and hands both in, so the rungs can be
 * tested as a table. {@link findProfilePointer} is the filesystem half, and
 * lives next door in `profile-pointer.ts`.
 *
 * The `unset` state stays distinct from the literal name `default` through
 * every rung. Collapsing them early would make "the user asked for `default`"
 * indistinguishable from "the user asked for nothing" — a distinction the
 * pointer file, the error wording, and the ephemeral stamp all need, and the
 * exact shape of `docs/solutions/conventions/a-default-silently-defeats-a-
 * required-flag.md`.
 */
import { readEnvVar } from "../util/env.js";

/**
 * The profile name used when nothing selects one, and the home of a credential
 * file written before profiles existed.
 *
 * Defined HERE rather than in the store so the argument parser can reach the
 * selection grammar without pulling the credential store — and its lock
 * library, and its filesystem reads — into the startup path of every `compile`.
 */
export const DEFAULT_PROFILE = "default";

/** The environment variable that selects a profile without a flag. */
export const ENV_PROFILE = "XANO_PROFILE";

/**
 * Where a profile selection came from. Carried forward with the name because
 * every message that has to explain a selection needs to say where it came
 * from: a name a teammate never typed (`pointer`) reads very differently from
 * one they did (`flag`).
 */
export type ProfileSource = "flag" | "pointer" | "env" | "file-default" | "implicit";

/** One resolved selection: the winning name, and the rung that produced it. */
export interface ProfileSelection {
  name: string;
  source: ProfileSource;
  /**
   * The flag that typed this name, when it was not `--profile`. Set only on a
   * `"flag"` selection that names a SECOND credential beside the active one —
   * the destination of a cross-workspace command. It rides on the selection so
   * every message built from it (a binding refusal, a shadow warning) names the
   * flag the reader actually typed: advice to fix a destination with
   * `--profile` changes the source instead.
   */
  flag?: string;
  /**
   * On a `"file-default"` selection read from a credential file that is NOT
   * this machine's shared one (`--config`, `--local-auth`, `$XANO_CONFIG`): that
   * file's path. Its `default` key governs runs that read that file, so
   * "this machine's stored default" would misname it.
   */
  defaultIn?: string;
}

/** The inputs to the ladder. `undefined` means "this rung said nothing". */
export interface ProfileSelectionInputs {
  /** `--profile <name>` / `-p <name>` — an explicit, typed instruction. */
  flag?: string;
  /** The `profile` key of the nearest `xano.profile.json` — the project's pin. */
  pointer?: string;
  /** `$XANO_PROFILE` — commonly inherited from a shell rc. */
  env?: string;
  /** The credential file's own `default` key. */
  fileDefault?: string;
}

/**
 * Resolve the five rungs in order. Always returns a name: the last rung is the
 * literal `default`, reported as `implicit` so a caller can tell that nobody
 * chose it.
 *
 * The POINTER sits above the environment, and that order is the safety property:
 * a repository that pins itself is pinned on every machine that holds the
 * profile, and a `$XANO_PROFILE` inherited from a shell rc — set once, months
 * ago, for something else — cannot retarget it. `--profile` stays above both
 * because it is the only rung someone typed on this command line; it is the one
 * override, and it discloses itself rather than being refused.
 */
export function resolveProfileSelection(inputs: ProfileSelectionInputs): ProfileSelection {
  if (inputs.flag !== undefined) return { name: inputs.flag, source: "flag" };
  if (inputs.pointer !== undefined) return { name: inputs.pointer, source: "pointer" };
  if (inputs.env !== undefined) return { name: inputs.env, source: "env" };
  if (inputs.fileDefault !== undefined) return { name: inputs.fileDefault, source: "file-default" };
  return { name: DEFAULT_PROFILE, source: "implicit" };
}

/**
 * The whole ladder, including the two rungs that are not plain values: reading
 * `$XANO_PROFILE` out of the environment, and reading the project pointer file.
 *
 * ONE wrapper, because every command resolves the same ladder and four
 * hand-rolled copies had already drifted — only one of them validated the
 * environment's name, so a malformed `$XANO_PROFILE` was rejected on a deploy
 * and silently accepted by `login`. The pointer is a callback rather than a
 * value so the up-walk is paid for only when the ONE rung above it — the flag —
 * said nothing.
 *
 * `$XANO_PROFILE` is still read and still VALIDATED even when the pointer is
 * going to outrank it: an unusable name in the environment is a mistake worth
 * naming, and it would otherwise go quiet in exactly the projects that pinned
 * themselves.
 */
export function resolveActiveProfile(sources: {
  /** `--profile <name>`, already parsed. */
  flag?: string;
  /** The credential file's `default` key, when a file was read. */
  fileDefault?: string;
  /**
   * The path of that file when it is not the machine's shared one — carried
   * onto a `"file-default"` selection as `defaultIn`, so it is named as the
   * default IN that file.
   */
  defaultIn?: string;
  /**
   * Reads the project pointer. Called whenever `--profile` did NOT answer —
   * which is every rung below the flag, because the pointer outranks the
   * environment and cannot be skipped on the strength of a `$XANO_PROFILE` it
   * beats. Only a typed flag still makes the up-walk unnecessary.
   *
   * A callback rather than a default import: this module is pulled in by the
   * ARGUMENT PARSER on every command, and it stays filesystem-free so
   * `xanosdk compile` pays nothing for a credential concept it never reaches.
   * That is also why the four callers each pass the same one-liner.
   */
  readPointer: () => string | undefined;
}): ProfileSelection {
  const env = readEnvVar(ENV_PROFILE)?.trim();
  if (env !== undefined) assertValidProfileName(env, ENV_PROFILE);
  const selection = resolveProfileSelection({
    flag: sources.flag,
    pointer: sources.flag === undefined ? sources.readPointer() : undefined,
    env,
    fileDefault: sources.fileDefault,
  });
  return selection.source === "file-default" && sources.defaultIn !== undefined
    ? { ...selection, defaultIn: sources.defaultIn }
    : selection;
}

/** How a selection reads in a sentence — "profile "prod" (from --profile)". */
export function describeProfileSelection(selection: ProfileSelection): string {
  const label =
    selection.source === "flag" && selection.flag !== undefined
      ? `from ${selection.flag}`
      : profileSourceLabel(selection.source, selection.defaultIn);
  return `profile "${selection.name}" (${label})`;
}

/**
 * What each rung is CALLED to the person reading the message. One map, because
 * a binding refusal, `whoami`, `status` and `profile list` all have to name the
 * same rung the same way or the reader cannot match them up.
 */
export function profileSourceLabel(source: ProfileSource, defaultIn?: string): string {
  // A `--config`/`--local-auth` file's default is that file's, not the machine's —
  // the words `login` uses for it.
  if (source === "file-default" && defaultIn !== undefined) return `the default profile in ${defaultIn}`;
  return SOURCE_LABEL[source];
}

const SOURCE_LABEL: Record<ProfileSource, string> = {
  flag: "from --profile",
  pointer: "from this project's xano.profile.json",
  env: `from ${ENV_PROFILE}`,
  "file-default": "this machine's stored default",
  implicit: "the default",
};

/**
 * A profile name is a JSON object key in a file the CLI rewrites, so what it
 * may contain is a correctness question, not a style one.
 *
 * Names are CASE-SENSITIVE: they are stored verbatim as object keys, and
 * case-folding them would need a canonical form plus a collision rule for a file
 * a user may hand-edit — at which point `Prod` and `prod` in the same file have
 * no defined winner. The error says so, because "no such profile: Prod" next to
 * a visible `prod` is otherwise baffling.
 */
export function assertValidProfileName(name: string, context = "--profile"): void {
  if (name === "") {
    throw new Error(`\`${context}\` needs a profile name. Names are letters, digits, \`.\`, \`-\` and \`_\`.`);
  }
  if (name.startsWith("-")) {
    // "Parsed as two flags" is true only of a command line. From the
    // environment or a pointer file, name where it came from and why it is
    // refused there too: the same profile must be selectable by `--profile`.
    const onCommandLine = context.startsWith("-") || context.startsWith("xanosdk ");
    throw new Error(
      onCommandLine
        ? `Profile name "${name}" starts with \`-\`, which reads as a flag — \`${context} ${name}\` ` +
            `would be parsed as two flags. Names are letters, digits, \`.\`, \`-\` and \`_\`, ` +
            `and cannot start with \`-\`.`
        : `Profile name "${name}" in \`${context}\` starts with \`-\`, and no profile name can — it ` +
            `could never be selected with \`--profile\`. Set \`${context}\` to a name of letters, digits, ` +
            `\`.\`, \`-\` and \`_\` that starts with a letter or digit, or unset it.`,
    );
  }
  // A name that reaches `profiles[name]` on a plain object. `__proto__` and
  // `constructor` are not "unusual names" here, they are the prototype-pollution
  // keys, and this file is written back to disk by the CLI.
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Profile name "${name}" in \`${context}\` is reserved. Choose another name.`);
  }
  if (!VALID_NAME.test(name)) {
    // Names the CONTEXT: a bad name in `$XANO_PROFILE` or a committed pointer
    // is not on the command line, and "which one of these is wrong" is the
    // whole question when the value came from somewhere the reader forgot.
    throw new Error(
      `Profile name "${name}" in \`${context}\` is not valid. Names are letters, digits, \`.\`, ` +
        `\`-\` and \`_\`, start with a letter or digit, and are case-sensitive ` +
        `("Prod" and "prod" are two profiles).`,
    );
  }
}

/**
 * A selection as the `--json` documents of `whoami` and `status` carry it:
 * `defaultIn` always present — the file whose `default` chose it, or null for
 * the machine's shared file and for every other rung — so a script reads one
 * shape rather than a key that appears only under `--config`/`--local-auth`.
 */
export function selectionDocument(
  selection: ProfileSelection | null,
): (Omit<ProfileSelection, "defaultIn"> & { defaultIn: string | null }) | null {
  return selection === null ? null : { ...selection, defaultIn: selection.defaultIn ?? null };
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
