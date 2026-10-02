/**
 * Shared bundle-input resolution for the commands that accept an entry `<file>`
 * OR a pre-exported `--bundle <path>` (`deploy`, `preflight`). Compiling an
 * entry runs the full `exportBundleJson`
 * pipeline (lock seed → export → lock write); `--bundle` reads the file verbatim.
 * The two are mutually exclusive.
 *
 * Callers differ only in WHICH command is missing its input, so that is the one
 * knob this helper takes: the target is handed to `missingArgument`, which
 * builds the same `UsageError` the dispatcher raises, so a bare `xanosdk deploy`
 * gets the `✗` headline and the command's own help block instead of a plain
 * sentence. It always returns the bundle text plus a `source` label (the
 * file/bundle path) for progress output — callers that don't need `source` just
 * ignore it.
 *
 * Node-only (reads the filesystem); imported by the Node-only command modules.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { assertEntryExists, compileBundle, envNameRule, type ParsedArgs } from "./cli.js";
import { LocalFileNotFoundError, missingArgument, UsageError } from "./errors.js";
import { contextFlags } from "./context-flags.js";
import { shellQuote } from "../util/shell-quote.js";
import { isRepresentableName, safeNames } from "../util/env-name.js";
import { HOSTED_FILE_SCHEME, HOSTED_ICON_KINDS } from "../fields/hosted-file.js";
import type { NonPublicSeedValue, SeedContentFile } from "../workspace/seed.js";
import type { ArchiveEntry } from "../validate/archive.js";
import { knowledgeBodiesAllEmpty, type Bundle } from "../workspace/export.js";
import type { LockFile } from "../lock/lock.js";

/** The resolved bundle text plus the input it came from (an entry file or a `--bundle` path). */
export interface LoadedBundle {
  bundle: string;
  /**
   * The same bundle as an object, when this load already had one.
   *
   * The compile path does — `compileBundle` builds the object and serializes
   * it — so a consumer that wants the payload (a toolchain module's `onBundle`)
   * can take it instead of parsing the whole workspace back out of the string
   * it was just printed from. Absent on the `--bundle <path>` branch, where the
   * input really is text and there is nothing to hand over for free.
   */
  bundleObject?: Bundle;
  source: string;
  /**
   * Seed `content/` archive entries — populated only when `opts.withSeed` is set
   * AND the input is an entry `<file>` (a pre-exported `--bundle` carries schema
   * only; there is no live registry to resolve seed rows from).
   */
  content: SeedContentFile[];
  /**
   * Hosted-file bytes the bundle's file library names, as `vault/` archive
   * members. Empty for a `--bundle` path: a serialized bundle carries none.
   */
  files: ArchiveEntry[];
  /**
   * Seed values from columns the schema declares non-public, for the `--static`
   * publication guard. Same population rule as {@link content}.
   */
  nonPublicSeedValues: NonPublicSeedValue[];
  /**
   * With `opts.deferLockWrite`, the compile's pending `xano.lock` write — run
   * it once the caller's pre-write refusals pass. Absent when there is nothing
   * to write (or the load did not defer).
   */
  commitLock?: (opts?: import("./cli.js").CommitLockOptions) => void;
  /** The compile's deferred orphan warning (`deferOrphanWarning`), said once with the keys a planned prune deletes left out. */
  warnLockOrphans?: (pruned?: ReadonlySet<string>) => void;
  /** With `opts.deferLockWrite`, the orphan warning for a run refused before {@link commitLock} (see `CompiledBundle.warnOrphansUncommitted`). */
  warnOrphansUncommitted?: () => void;
  /**
   * The lock the compile classified public URL slugs against, written or not —
   * see `CompiledBundle.classifiedLock`. Absent for `--bundle` and `--no-lock`.
   */
  classifiedLock?: LockFile;
}

/**
 * Refuse a run that named no input at all, as the `UsageError` the CLI renders
 * with the `✗` headline and the command's own help block.
 *
 * Separate from {@link loadBundleText} so a command can raise it BEFORE it does
 * anything expensive — `deploy` and `release` resolve a credential first, and
 * answering a bare `xanosdk deploy` with "not signed in" would be answering the
 * wrong question. {@link loadBundleText} still calls it, so a caller that skips
 * this cannot end up silently accepting no input.
 */
export function assertBundleInput(args: ParsedArgs, target: { command: string; subcommand?: string }): void {
  if (args.bundle === undefined && args.file === undefined) throw missingArgument("file", target);
  if (args.bundle === undefined) return;
  // Both are mistakes in the command line, so both are usage errors (exit 1,
  // `SDK_USAGE`) — the code `release create --bundle` already gives a missing
  // file — with a one-line pointer to help: the sentence says what to change.
  if (args.file !== undefined) {
    throw new UsageError(`Pass either an entry <file> or --bundle <path>, not both.`, { hintFor: target });
  }
}

// Defined beside UsageError, so the file readers that must not load this module
// (`--secrets-file`, `--backend-env-file`) throw the same class.
export { LocalFileNotFoundError };

/**
 * Refuse a `--bundle` path that is not a bundle, as a usage error: missing, a
 * directory, a file that is not JSON, or JSON that is not a bundle's envelope.
 *
 * Separate from {@link assertBundleInput} so a command can answer its own
 * flag refusals first (they say more about what was typed than a missing
 * file does), yet still before any credential is read — a typo in a path must
 * not be answered with "not signed in", and a file that cannot be parsed must
 * not surface later as a raw `JSON.parse` message naming no file (or, on
 * `release create`, as a comparison that "could not run" beside a release that
 * was cut anyway). {@link loadBundleText} runs it too. `consequence` ends the
 * sentence with what the refusal spared (`Nothing was cut.`).
 */
/**
 * A named entry file that is not there, refused before any credential is read —
 * a typo in a path must not be answered with "Not signed in". Exit 8, as every
 * missing local input. A `--bundle` run names no entry and is left alone.
 */
export function assertEntryFile(args: ParsedArgs): void {
  if (args.bundle === undefined && args.file !== undefined) assertEntryExists(args.file);
}

export function assertBundleFile(
  args: ParsedArgs,
  target: { command: string; subcommand?: string },
  consequence?: string,
): void {
  if (args.bundle === undefined) return;
  const tail = `${consequence === undefined ? "" : ` ${consequence}`} Pass the path of a bundle \`xanosdk export <entry> --out <path>\` wrote.`;
  // Named as it was typed: a `.json` positional is read as the bundle, and
  // "`--bundle x` does not exist" described a flag nobody passed.
  const typed = args.bundlePositional === true ? `"${args.bundle}"` : `\`--bundle ${args.bundle}\``;
  if (!existsSync(args.bundle) || !statSync(args.bundle).isFile()) {
    const Refusal = existsSync(args.bundle) ? UsageError : LocalFileNotFoundError;
    throw new Refusal(`${typed} ${existsSync(args.bundle) ? "is not a file" : "does not exist"}.${tail}`, {
      hintFor: target,
    });
  }
  const text = readFileSync(args.bundle, "utf8");
  const why = bundleTextProblem(text);
  if (why !== undefined) throw new UsageError(`${typed} is not a bundle: ${why}.${tail}`, { hintFor: target });
  // The env names a compile refuses, refused in a bundle too: the import took
  // `bad-name` and landed it, and `env pull` then could not write it back.
  // Not for `workspace diff`: a comparison writes nothing, so it lands no name.
  const bad = target.command === "workspace" ? [] : bundleEnvNames(text).filter((n) => !isRepresentableName(n));
  if (bad.length > 0) {
    const one = bad.length === 1;
    throw new UsageError(
      `${typed} sets ${bad.map((n) => `"${safeNames([n])}"`).join(", ")} in its env, which ` +
        `${one ? "is not a usable env var name" : "are not usable env var names"}. ${envNameRule()} ` +
        `${consequence === undefined ? "" : `${consequence} `}` +
        `Rename ${one ? "it" : "them"} in the source's \`workspaceConfig({ env })\` and \`xano/.env\`, and export the bundle again.`,
      { hintFor: target },
    );
  }
  const unread = target.command === "workspace" ? undefined : uncompiledBundleProblem(text);
  if (unread !== undefined) {
    throw new UsageError(
      `${typed} ${unread}, so it would land them empty. It was built in code without the Node compile ` +
        `(\`export()\` / \`emitBundle()\`). ${consequence === undefined ? "" : `${consequence} `}` +
        `Write it with \`xanosdk export <entry> --out <path>\` or \`writeBundle(app, path)\` from \`@xano/sdk/node\`, ` +
        `or deploy the entry itself.`,
      { hintFor: target },
    );
  }
}

/**
 * What a bundle built without the Node compile is missing, or `undefined`.
 * Two marks only that compile removes: an icon still holding the encoder's
 * `xanosdk-file://pending/` placeholder, and knowledge items that ALL have an
 * empty body with no reference files beside them — unless the bundle says
 * (`knowledge_read`) that the compile read those bodies and found them empty.
 */
function uncompiledBundleProblem(text: string): string | undefined {
  let payload: Record<string, unknown>;
  let knowledgeRead: boolean;
  try {
    const parsed = JSON.parse(text) as { payload?: unknown; knowledge_read?: unknown };
    payload = (parsed.payload ?? {}) as Record<string, unknown>;
    knowledgeRead = parsed.knowledge_read === true;
  } catch {
    return undefined;
  }
  const pending = HOSTED_ICON_KINDS.flatMap((kind) =>
    (Array.isArray(payload[kind]) ? (payload[kind] as Array<{ name?: unknown; icons?: unknown }>) : [])
      .filter((row) => Array.isArray(row?.icons) && row.icons.some((icon: { src?: unknown } | null) => String(icon?.src).startsWith(`${HOSTED_FILE_SCHEME}pending/`)))
      .map((row) => `${kind} "${String(row.name ?? "")}"`),
  );
  if (pending.length > 0) return `has unresolved hostedFile() icons (${pending.join(", ")})`;
  if (!knowledgeRead && knowledgeBodiesAllEmpty(payload)) {
    const knowledge = payload.knowledge as Array<Record<string, unknown>>;
    const names = knowledge.map((k) => `"${String(k?.name ?? "")}"`).join(", ");
    return `carries no markdown body for its knowledge (${names})`;
  }
  return undefined;
}

/** The env names a bundle carries (`payload.env[].name`), read defensively — a shape it lacks yields none. */
function bundleEnvNames(text: string): string[] {
  try {
    const env = (JSON.parse(text) as { payload?: { env?: unknown } }).payload?.env;
    if (!Array.isArray(env)) return [];
    return env.flatMap((e) => (e !== null && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? [(e as { name: string }).name] : []));
  } catch {
    return [];
  }
}

/**
 * The envelope keys a bundle cannot be read without — what `xanosdk export`
 * writes and an export from a live backend returns both carry them — with the
 * type each must hold. `version`, `type` and `sig` are left to the server,
 * which names its own objection to them; these two decide whether the file is
 * a bundle at all.
 */
const BUNDLE_ENVELOPE: readonly (readonly [string, "string" | "object"])[] = [
  ["app", "string"],
  ["payload", "object"],
];

/**
 * Why `text` cannot be a bundle, or `undefined` when it parses to a bundle's
 * envelope.
 *
 * The envelope is checked, not just "a JSON object": any other object reached
 * the server, which cut a release from it, compared zero objects, or answered
 * a 500 naming nothing the reader typed.
 */
export function bundleTextProblem(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return `it is not valid JSON (${(err as Error).message})`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "it is JSON, but not an object";
  const record = parsed as Record<string, unknown>;
  const missing = BUNDLE_ENVELOPE.filter(([key, type]) => {
    const value = record[key];
    return type === "object"
      ? value === null || typeof value !== "object" || Array.isArray(value)
      : typeof value !== "string";
  }).map(([key]) => `\`${key}\``);
  if (missing.length === 0) return undefined;
  const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)!}`;
  return `it is a JSON object with no ${list} (every bundle carries \`app\`, \`version\`, \`type\`, \`payload\` and \`sig\`)`;
}

/**
 * Refuse a `--backend-env-file` or `--secrets-file` path that is not a readable
 * file, as a usage error — the class `--bundle` gets for the same mistake.
 *
 * Both were read only inside the compile, after a credential, and failed there
 * as an SDK error: one typo, two exit codes depending on which flag held it.
 */
export function assertValueFiles(args: ParsedArgs, target: { command: string; subcommand?: string }): void {
  for (const [flag, path] of [
    ["--backend-env-file", args.envFile],
    ["--secrets-file", args.secretsFile],
  ] as const) {
    if (path === undefined) continue;
    if (existsSync(path) && statSync(path).isFile()) continue;
    // Not there at all: a missing local input (LocalFileNotFoundError).
    throw new (existsSync(path) ? UsageError : LocalFileNotFoundError)(
      `\`${flag} ${path}\` ${existsSync(path) ? "is not a file" : "does not exist"}. Check the path, and ` +
        `make sure the file is present wherever this runs (a CI secret mounted at deploy time, not a ` +
        `file committed to the repo).`,
      { hintFor: target },
    );
  }
}

/**
 * Refuse the env and documentation-token flags beside `--bundle` on a command
 * whose INPUT the bundle is (`deploy`, `preflight`).
 *
 * Not part of {@link assertBundleInput}, which {@link loadBundleText} runs for
 * every caller: `release create` loads a bundle only for its comparison, where
 * a refusal would read as "could not compare" rather than as a usage error.
 */
export function refuseValueFlagsBesideBundle(
  args: ParsedArgs,
  target: { command: string; subcommand?: string },
): void {
  if (args.bundle === undefined) return;
  refuseCompileValueFlags(
    args,
    args.bundle,
    "it is already compiled, and its env values and documentation tokens are the ones the " +
      "`xanosdk export` that wrote it resolved. Pass them to that export" +
      // `preflight` tears its environment down, so there is no afterwards.
      (target.command === "deploy" && compileValueFlagKinds(args).env
        ? `, or change an env var on the target afterwards with \`xanosdk env set NAME${args.to === undefined ? "" : ` --to ${shellQuote(args.to)}`}${contextFlags()}\`.`
        : "."),
    target,
  );
}

/**
 * Which of the two families of compile value flags this run passed: backend env
 * values, or documentation tokens. The remedies differ — an env var can be set
 * on a backend afterwards, a documentation token only arrives compiled into a
 * bundle — so a refusal names the one that fits what was typed.
 */
export function compileValueFlagKinds(args: ParsedArgs): { env: boolean; docs: boolean } {
  return {
    env: Object.keys(args.envVars).length > 0 || args.envFile !== undefined || args.allowEmptyEnv.length > 0,
    docs:
      Object.keys(args.docTokens).length > 0 || args.secretsFile !== undefined || args.allowEmptyDocToken.length > 0,
  };
}

/**
 * The remedy for a documentation-token flag on an input nothing compiles: the
 * token is compiled in, from the flag or `xano/.secrets.json`, so the entry file
 * is the only way to send one.
 */
export const DOC_TOKEN_REMEDY =
  "A documentation token is compiled into the bundle — deploy the project's entry file with `--doc-token` " +
  "(or its value in `xano/.secrets.json`) to set one.";

/**
 * The value flags a compile resolves from outside the source, by the spelling
 * this run passed — the order help lists them in.
 */
function compileValueFlagsPassed(args: ParsedArgs): string[] {
  return [
    Object.keys(args.envVars).length > 0 ? "--env-var" : undefined,
    args.envFile !== undefined ? "--backend-env-file" : undefined,
    args.allowEmptyEnv.length > 0 ? "--allow-empty-env" : undefined,
    args.allowEmptyDocToken.length > 0 ? "--allow-empty-doc-token" : undefined,
    args.secretsFile !== undefined ? "--secrets-file" : undefined,
    Object.keys(args.docTokens).length > 0 ? "--doc-token" : undefined,
  ].filter((f): f is string => f !== undefined);
}

/**
 * Refuse the env and documentation-token flags on an input nothing compiles.
 *
 * They fill values into a compile of an entry file. A bundle on disk or a
 * fetched backend is past that step, so each flag was accepted and dropped —
 * `--backend-env-file` without even checking the file existed. `input` is how
 * the input names itself (`b.json`, `release:main`); `why` finishes the
 * sentence with what that input carries instead, and what to do.
 *
 * A one-line pointer to help rather than the block: every flag named here
 * parsed fine, and the sentence already says what to drop.
 */
export function refuseCompileValueFlags(
  args: ParsedArgs,
  input: string,
  why: string,
  target: { command: string; subcommand?: string },
): void {
  const passed = compileValueFlagsPassed(args);
  if (passed.length === 0) return;
  const list = passed.length === 1 ? passed[0]! : `${passed.slice(0, -1).join(", ")} and ${passed.at(-1)!}`;
  throw new UsageError(
    `${list} ${passed.length === 1 ? "applies" : "apply"} only when an entry file is compiled, and ` +
      `${input} is not: ${why}`,
    { hintFor: target },
  );
}

/**
 * Resolve the bundle text from `--bundle <path>` or an entry `<file>`.
 * Throws a `UsageError` naming `target` (via {@link assertBundleInput}) on: both
 * supplied, a missing `--bundle` file, or neither supplied, so the CLI answers it with the
 * usage block rather than a bare sentence.
 *
 * `target` is the command (and subcommand, where there is one) whose `<file>`
 * is missing; `<file>` matches the arg name every one of these commands
 * declares in the registry, so the error and the help block agree.
 *
 * With `opts.withSeed`, an entry-file compile also resolves the tables' seed rows
 * into signed `content/` entries (the deploy path asks for this). A `--bundle`
 * path cannot — it's already-serialized text with no registry — so `content` is
 * empty there.
 */
export async function loadBundleText(
  args: ParsedArgs,
  target: { command: string; subcommand?: string },
  opts: { withSeed?: boolean; deferLockWrite?: boolean; deferOrphanWarning?: boolean } = {},
): Promise<LoadedBundle> {
  assertBundleInput(args, target);
  assertBundleFile(args, target);
  assertValueFiles(args, target);
  if (args.bundle !== undefined) {
    return { bundle: readFileSync(args.bundle, "utf8"), source: args.bundle, content: [], files: [], nonPublicSeedValues: [] };
  }
  if (args.file !== undefined) {
    const { bundle, bundleObject, content, files, nonPublicSeedValues, commitLock, classifiedLock, warnLockOrphans, warnOrphansUncommitted } = await compileBundle(args, {
      seed: opts.withSeed,
      deferLockWrite: opts.deferLockWrite,
      deferOrphanWarning: opts.deferOrphanWarning,
    });
    return {
      bundle,
      bundleObject,
      source: args.file,
      content,
      files,
      nonPublicSeedValues,
      ...(commitLock !== undefined ? { commitLock } : {}),
      ...(classifiedLock !== undefined ? { classifiedLock } : {}),
      ...(warnLockOrphans !== undefined ? { warnLockOrphans } : {}),
      ...(warnOrphansUncommitted !== undefined ? { warnOrphansUncommitted } : {}),
    };
  }
  // Unreachable — `assertBundleInput` above has already refused this — but it is
  // what makes the two branches exhaustive to the type checker and to a reader.
  throw missingArgument("file", target);
}
