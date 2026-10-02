/**
 * Node-only artifact writers. Split from `emit.ts` (which stays pure/browser-
 * safe) so the `node:fs` dependency is reachable only through the
 * `@xano/sdk/node` entry and the CLI — never from a workspace def imported
 * into a frontend bundle.
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { emit, serializeBundle } from "./emit.js";
import { classifyEnv, declaredEnv, parseEnvFile } from "./workspace-env.js";
import { backendDirIn, projectRootFrom } from "./backend-dir.js";
import { authorFiles } from "./authoring-site.js";
import { secretsPhrase } from "./output-target.js";
import { secretsCarriedBy } from "../deploy/live-diff.js";
import { allLandings } from "../deploy/ephemeral-state.js";
import { createLockContext, emptyLock, mergeObserved, serializeLock, validateLockModel, type LockFile } from "../lock/lock.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { getLockedCanonical, getLockedGuid, isLockSeeded, seededLockSource } from "../lock/store.js";
import { isRepresentableName } from "../util/env-name.js";
import { hostedIconOwners } from "../fields/hosted-file.js";
import { hostedFileResolver } from "../workspace/hosted-file.js";
import { resolveKnowledge } from "../workspace/knowledge.js";
import { emitDiagnostic } from "../workspace/diagnostics.js";
import {
  documentationScopeFlagLabel,
  SCAFFOLD_SECRETS_REMEDY,
  type DocumentationTokenDeclaration,
  type SecretsRemedy,
} from "../workspace/documentation-token.js";
import type { FunctionDef } from "../function/define.js";
import { XANO_ORIGIN, type Xano } from "../workspace/xano.js";

/** Compile a function and write the JSON artifact to `path`. */
export function writeArtifact(fn: FunctionDef, path: string, opts: { indent?: number } = {}): void {
  writeFileSync(path, emit(fn, opts) + "\n", "utf8");
}

/** Options for {@link writeBundle}. */
export interface WriteBundleOptions {
  indent?: number;
  /** Fail the write on any build warning instead of printing it — `xanosdk export --strict`. */
  strict?: boolean;
  /** Backend env values, name→value — `--env-var`. Wins over {@link envFile}. */
  env?: Readonly<Record<string, string>>;
  /** A dotenv file of backend env values — `--backend-env-file` (the CLI's default is `xano/.env`). */
  envFile?: string;
  /**
   * Documentation-gate tokens, scope→value — `--doc-token`. A scope is
   * `workspace`, an API group's name, or the `xano/.secrets.json` key
   * (`apiGroup:<guid>`); one that names no declared gate is refused.
   */
  documentationTokens?: Readonly<Record<string, string>>;
  /** Scopes whose gate this bundle clears on purpose (sent empty) — `--allow-empty-doc-token`. */
  allowEmptyDocToken?: readonly string[];
  /**
   * The `xano.lock` to build against and update — `--lock=<path>`. Default: the
   * file the seeded lock was read from; else the cwd project's `xano/xano.lock`;
   * else (cwd outside a project) the lock beside `envFile` or in the output
   * path's project, or of the module that created the registry or called this.
   * When none is found the build is unlocked and says so. `false` builds without
   * one (`--no-lock`), refused when that lock exists.
   */
  lock?: string | false;
}

/**
 * Compile the workspace and write the bundle to `path` — the bytes
 * `xanosdk export` writes for the same source and values.
 *
 * Knowledge bodies and reference files are read, and `hostedFile()` references
 * resolved, as the CLI compile does. The project's `xano.lock` is built against
 * and updated as the CLI does — so it must be seeded (`seedLockOverrides`)
 * before the entry is imported, or the write is refused. A bundle carrying
 * secrets is written owner-only (0600). Env values come only from `env`/`envFile`
 * (this call has no entry path to find `xano/.env` from); a declared name
 * neither supplies is written empty and reported. Seed rows never ride in a
 * bundle file, and neither do hosted-file bytes: deploy from the entry to ship
 * those.
 */
export function writeBundle(xano: Xano, path: string, opts: WriteBundleOptions = {}): void {
  const declared = declaredEnv(xano.workspaceSettings());
  const fileValues = opts.envFile !== undefined ? parseEnvFile(opts.envFile, "writeBundle envFile") : {};
  const badNames = [...declared.map((e) => e.name), ...Object.keys(fileValues), ...Object.keys(opts.env ?? {})].filter(
    (n) => !isRepresentableName(n),
  );
  if (badNames.length > 0) {
    throw new Error(
      `writeBundle: ${[...new Set(badNames)].map((n) => JSON.stringify(n)).join(", ")} ${badNames.length === 1 ? "is not a usable env var name" : "are not usable env var names"}. ` +
        `A name is letters, digits and \`_\`, and does not start with a digit (e.g. STRIPE_KEY).`,
    );
  }
  const env = classifyEnv({
    fileValues,
    flagValues: { ...(opts.env ?? {}) },
    declaredNames: declared.map((e) => e.name),
    declaredValues: Object.fromEntries(declared.map((e) => [e.name, e.value])),
  });
  const docs = resolveDocumentationTokens(xano, opts);
  const registry = authorFiles(originOf(xano))[0];
  const lock = openLock(opts.lock, {
    out: path,
    ...(opts.envFile !== undefined ? { envFile: opts.envFile } : {}),
    authored: [authorFiles(new Error())[0], registry].filter((f): f is string => f !== undefined),
    ...(registry !== undefined ? { registry } : {}),
    strict: opts.strict === true,
  });
  const bundle = xano.export({
    ...(lock !== undefined ? { lock: lock.ctx } : {}),
    ...(opts.strict !== undefined ? { strict: opts.strict } : {}),
    knowledge: resolveKnowledge(xano.knowledge()),
    hostedFiles: hostedFileResolver(),
    ...(Object.keys(env.values).length > 0 ? { envOverrides: env.values } : {}),
    documentationTokens: docs.values,
    ...(docs.allowEmpty.size > 0 ? { allowEmptyDocToken: docs.allowEmpty } : {}),
    secretsRemedy: WRITE_BUNDLE_REMEDY,
  });
  if (env.clearing.length > 0) {
    const one = env.clearing.length === 1;
    const message =
      `writeBundle: ${one ? "declared env var" : "declared env vars"} ${env.clearing.join(", ")} ` +
      `${one ? "has" : "have"} no value, so this bundle clears ${one ? "it" : "them"} if it is imported. ` +
      `Pass \`env: { NAME: "value" }\` or \`envFile: ${JSON.stringify(shownPath(join(lock !== undefined ? dirname(lock.path) : backendDirIn(projectRootFrom(registry !== undefined ? dirname(registry) : process.cwd())), ".env")))}\`.`;
    if (opts.strict === true) throw new Error(message);
    emitDiagnostic({ severity: "warning", code: "workspace-env.unsupplied", message });
  }
  if (env.additions.length > 0) {
    const one = env.additions.length === 1;
    const message =
      `writeBundle: env ${env.additions.join(", ")} ${one ? "is" : "are"} not declared in \`workspaceConfig({ env })\` ` +
      `and will be ADDED if this bundle is imported. Declare ${one ? "it" : "them"} there with an empty value; ` +
      `if this is a typo, this is the only place you will see it.`;
    if (opts.strict === true) throw new Error(message);
    emitDiagnostic({ severity: "warning", code: "workspace-env.undeclared", message });
  }
  const owners = hostedIconOwners((bundle as { payload?: Record<string, unknown> }).payload ?? {});
  if (owners.length > 0) {
    emitDiagnostic({
      severity: "warning",
      code: "export.hosted-files-omitted",
      message:
        `writeBundle: the bundle names hostedFile() icons whose files it does not carry: ${owners.join(", ")}. ` +
        `Deploying the file is refused; \`xanosdk deploy <entry>\` ships the files.`,
    });
  }
  // Lock before bundle, as the CLI orders it: a bundle never carries an
  // identity the lock has not recorded. The bundle's directory is made and
  // proven writable first, so a bad path never leaves a lock behind.
  prepareBundlePath(path);
  if (lock !== undefined) lock.commit();
  writeBundleFile(path, serializeBundle(bundle, opts) + "\n", secretsCarriedBy(bundle));
}

/** The `Error` captured when the registry was created, or an empty one for a registry that has none. */
function originOf(xano: Xano): Error {
  const origin = (xano as unknown as Record<symbol, unknown>)[XANO_ORIGIN];
  return origin instanceof Error ? origin : new Error();
}

/**
 * Create the bundle's directory, as `xanosdk export --out` does, and refuse a
 * path that cannot be written before anything else is.
 */
function prepareBundlePath(path: string): void {
  const dir = dirname(resolve(path));
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(existsSync(path) ? path : dir, constants.W_OK);
  } catch (err) {
    throw new Error(
      `writeBundle: cannot write ${path} — ${(err as Error).message}. Pass a path in a directory you can write.`,
    );
  }
}

/** Remedies worded as `writeBundle` options rather than CLI flags. */
const WRITE_BUNDLE_REMEDY: SecretsRemedy = {
  ...SCAFFOLD_SECRETS_REMEDY,
  supply: (scope) => `documentationTokens: { ${JSON.stringify(scope)}: "<value>" }`,
  allowEmpty: (scope) => `allowEmptyDocToken: [${JSON.stringify(scope)}]`,
};

/**
 * `documentationTokens` / `allowEmptyDocToken` → the scope keys `export()`
 * reads, with the CLI's refusals and warnings: a scope that names no declared
 * gate is refused, an opt-out to empty and a gate left unsupplied are reported.
 */
function resolveDocumentationTokens(
  xano: Xano,
  opts: WriteBundleOptions,
): { values: Record<string, string>; allowEmpty: ReadonlySet<string> } {
  const declared = xano.documentationTokenNames();
  const labelOf = (d: DocumentationTokenDeclaration): string => documentationScopeFlagLabel(d.scope);
  const keyFor = (scope: string, option: string): string => {
    const byKey = declared.find((d) => d.key === scope);
    if (byKey !== undefined) return byKey.key;
    const ws = declared.find((d) => d.scope.kind === "workspace");
    if (scope === "workspace" && ws !== undefined) return ws.key;
    const groups = declared.filter((d) => d.scope.kind === "api_group" && labelOf(d) === scope);
    if (groups.length === 1) return groups[0]!.key;
    if (groups.length > 1) {
      throw new Error(
        `writeBundle: \`${option}\` scope ${JSON.stringify(scope)} names ${groups.length} API groups — ` +
          `use the key for the one you mean: ${groups.map((d) => JSON.stringify(d.key)).join(", ")}.`,
      );
    }
    const known = [...new Set(declared.map(labelOf))];
    throw new Error(
      `writeBundle: \`${option}\`: no documentation gate is declared for ${JSON.stringify(scope)}.` +
        (known.length === 0
          ? ` This workspace declares none — a gate is \`documentation: { require_token: true }\`.`
          : ` Declared: ${known.map((n) => JSON.stringify(n)).join(", ")}.`),
    );
  };
  const values = Object.create(null) as Record<string, string>;
  for (const [scope, value] of Object.entries(opts.documentationTokens ?? {}) as [string, unknown][]) {
    // `undefined` is "not supplied" — an unset `process.env` read — and takes the unsupplied path below.
    if (value === undefined) continue;
    const key = keyFor(scope, "documentationTokens");
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `writeBundle: \`documentationTokens\` ${JSON.stringify(scope)} is ${typeof value === "string" ? "empty" : `${value === null ? "null" : typeof value}, not a string`}. ` +
          `An empty value is refused: to clear a gate on purpose, say so with \`allowEmptyDocToken: [${JSON.stringify(scope)}]\`.`,
      );
    }
    values[key] = value;
  }
  const allowEmpty = new Set((opts.allowEmptyDocToken ?? []).map((scope) => keyFor(scope, "allowEmptyDocToken")));
  const cleared = declared.filter((d) => !Object.hasOwn(values, d.key) && allowEmpty.has(d.key));
  if (cleared.length > 0) {
    emitDiagnostic({
      severity: "warning",
      code: "doc-token.cleared",
      message:
        `writeBundle: documentation tokens for ${cleared.map((d) => JSON.stringify(labelOf(d))).join(", ")} are sent EMPTY ` +
        `(allowEmptyDocToken). Whatever gate the target holds for ${cleared.length === 1 ? "that doc site" : "those doc sites"} ` +
        `is cleared, and its docs become publicly readable.`,
    });
  }
  const unsupplied = declared.filter((d) => d.gated && !Object.hasOwn(values, d.key) && !allowEmpty.has(d.key));
  if (unsupplied.some((d) => d.scope.kind === "workspace")) {
    emitDiagnostic({
      severity: "warning",
      code: "doc-token.unsupplied",
      message:
        `writeBundle: the workspace declares a documentation gate and no token was supplied; no \`documentation\` key ` +
        `is emitted, so this bundle leaves the workspace's gate as it is rather than clearing it — and cannot restore it either.`,
    });
  }
  // A group that publishes its docs is refused by the export itself.
  const groups = unsupplied.filter((d) => d.scope.kind === "api_group" && !d.published);
  if (groups.length > 0) {
    const one = groups.length === 1;
    emitDiagnostic({
      severity: "warning",
      code: "doc-token.unsupplied",
      message:
        `writeBundle: ${groups.map((d) => JSON.stringify(labelOf(d))).join(", ")} ${one ? "declares" : "declare"} a documentation ` +
        `gate with no token. A group's \`documentation\` key is written as the engine default when it is absent, so these ` +
        `bytes CLEAR that gate on import. ${one ? "That group does" : "Those groups do"} not publish docs (\`swagger\` is off), ` +
        `so nothing is exposed. Pass \`documentationTokens: { ${JSON.stringify(labelOf(groups[0]!))}: "<value>" }\`.`,
    });
  }
  return { values, allowEmpty };
}

/**
 * Owner-only (0600) when the bundle carries secrets in cleartext, and said —
 * the mode and the `secrets.cleartext-export` warning `xanosdk export` gives.
 */
function writeBundleFile(path: string, content: string, secrets: readonly string[]): void {
  if (secrets.length === 0) {
    writeFileSync(path, content, "utf8");
    return;
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  // `mode` applies only to a file this write creates; a device is not a file anyone commits.
  if (!statSync(path).isFile()) return;
  chmodSync(path, 0o600);
  emitDiagnostic({
    severity: "warning",
    code: "secrets.cleartext-export",
    message: `${path} carries ${secretsPhrase(secrets)} in cleartext — written owner-only (0600); do not commit it.`,
  });
}

/** Where else a write with no `lock` option looks for one, and whether a build without one fails. */
interface LockHints {
  out: string;
  envFile?: string;
  /** The module that called `writeBundle` and the one that created the registry. */
  authored: readonly string[];
  /** The module that created the registry — the project whose lock these objects belong to. */
  registry?: string;
  strict: boolean;
}

/**
 * The lock a write builds against, as `xanosdk export` reads it, or `undefined`
 * for an unlocked build. `commit()` merges what the export observed and writes
 * the lock back — minted canonicals included — when anything changed.
 */
function openLock(
  option: string | false | undefined,
  hints: LockHints,
): { path: string; ctx: ReturnType<typeof createLockContext>; commit: () => void } | undefined {
  const discovered = join(backendDirIn(projectRootFrom(process.cwd())), "xano.lock");
  if (option === false) {
    if (existsSync(discovered) && parses(discovered)) {
      throw new Error(
        `writeBundle: \`lock: false\` refused — ${shownPath(discovered)} pins this project's identities, and building without it ` +
          `derives guids from names, so every object it pins under another guid is deleted and recreated wherever ` +
          `the bundle lands. Drop \`lock: false\`, or delete the lock if you mean to abandon those identities.`,
      );
    }
    return undefined;
  }
  if (option !== undefined && !existsSync(dirname(resolve(option)))) {
    const dir = relative(process.cwd(), dirname(resolve(option))) || dirname(resolve(option));
    throw new Error(
      `writeBundle: \`lock: ${JSON.stringify(option)}\`: ${dir}/ doesn't exist — create it, or pass a \`lock\` path in an existing directory.`,
    );
  }
  const lockPath = option !== undefined ? resolve(option) : defaultLockPath(discovered, hints);
  if (lockPath === undefined) return undefined;
  const exists = existsSync(lockPath);
  const model: LockFile = exists ? readLockFile(lockPath) : emptyLock();
  assertSeeded(model, lockPath);
  const original = exists ? serializeLock(model) : undefined;
  const ctx = createLockContext(model);
  // Ephemeral landings live in the project the lock belongs to.
  const landingsDir = lockPath === discovered ? process.cwd() : projectRootFrom(dirname(lockPath));
  return {
    path: lockPath,
    ctx,
    commit: () => {
      const landed = new Set(allLandings(landingsDir, model).flatMap(([, record]) => Object.values(record).map((e) => e.guid)));
      const { lock: merged } = mergeObserved(model, ctx.observed, { landedGuids: landed });
      validateLockModel(merged, lockPath, ctx.observed);
      if (!exists && Object.keys(merged.objects).length === 0) return;
      if (serializeLock(merged) !== original) writeLockFile(lockPath, merged);
    },
  };
}

/**
 * The lock a write with no `lock` option builds against, or `undefined` for an
 * unlocked build. The seeded lock's file wins — the references were baked from
 * it. Otherwise the cwd project's backend directory — unless the registry was
 * created in another project: then that project's lock, refused when both
 * projects hold one, and a lock is never created in the cwd's project. When the
 * cwd is not inside a project that has one (a monorepo root, a CI step), the lock beside
 * `envFile`, in the output path's project, or beside / in the project of the
 * module that called this or created the registry. A seeded lock with no file
 * found is refused rather than built without; an unseeded build with none is
 * unlocked, and warned (refused under `strict`).
 */
function defaultLockPath(discovered: string, hints: LockHints): string | undefined {
  const seeded = seededLockSource();
  if (seeded !== undefined) {
    if (existsSync(discovered) && !samePath(discovered, seeded)) {
      throw new Error(
        `writeBundle: the seeded lock is ${shownPath(seeded)}, but the cwd's project has ${shownPath(discovered)} — ` +
          `pass \`lock: ${JSON.stringify(shownPath(seeded))}\` to name the one this bundle builds against.`,
      );
    }
    return seeded;
  }
  const origin =
    hints.registry !== undefined
      ? [join(dirname(hints.registry), "xano.lock"), join(backendDirIn(projectRootFrom(dirname(hints.registry))), "xano.lock")]
      : [];
  const originLock = origin.find((p) => existsSync(p));
  if (existsSync(discovered)) {
    if (originLock !== undefined && !samePath(originLock, discovered)) {
      throw new Error(
        `writeBundle: the registry was created in the project of ${shownPath(originLock)}, but the cwd's project has ` +
          `${shownPath(discovered)} — pass \`lock: ${JSON.stringify(shownPath(originLock))}\` to name the one this bundle builds against.`,
      );
    }
    return discovered;
  }
  const elsewhere =
    hints.registry !== undefined && !samePath(projectRootFrom(dirname(hints.registry)), projectRootFrom(process.cwd()));
  if (existsSync(dirname(discovered)) && !elsewhere) return discovered;
  const nearby = [
    ...(hints.envFile !== undefined
      ? [join(dirname(resolve(hints.envFile)), "xano.lock"), join(backendDirIn(projectRootFrom(dirname(resolve(hints.envFile)))), "xano.lock")]
      : []),
    join(backendDirIn(projectRootFrom(dirname(resolve(hints.out)))), "xano.lock"),
    ...hints.authored.flatMap((file) => [join(dirname(file), "xano.lock"), join(backendDirIn(projectRootFrom(dirname(file))), "xano.lock")]),
  ].find((p) => existsSync(p));
  if (nearby !== undefined) return nearby;
  if (isLockSeeded()) {
    throw new Error(
      `writeBundle: a lock is seeded, but no \`xano.lock\` was found from the cwd (${process.cwd()}) — it is not inside ` +
        `a project with a backend directory. Pass \`lock: "<path>/xano.lock"\` (the file you seeded).`,
    );
  }
  const message =
    `writeBundle: built without a lock — no \`xano.lock\` was found from the cwd (${process.cwd()}), the output path, ` +
    `\`envFile\`, or the modules that built the registry and called this. Nothing pins identities: guids are ` +
    `derived from names, so a renamed object lands as a new one. Pass \`lock: "<path>/xano.lock"\` to build against one, ` +
    `or \`lock: false\` to build without one on purpose.`;
  if (hints.strict) throw new Error(message);
  emitDiagnostic({ severity: "warning", code: "lock.not-found", message });
  return undefined;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * References bake their guids when the workspace module is evaluated, so a lock
 * reaches them only when seeded BEFORE that import. A lock that was not is
 * refused here: building on would ship name-derived guids beside the lock's.
 */
function assertSeeded(lock: LockFile, lockPath: string): void {
  const unseeded = Object.entries(lock.objects).some(
    ([key, e]) =>
      !isLockSeeded() ||
      (e.guid !== undefined && getLockedGuid(key) !== e.guid) ||
      (e.canonical !== undefined && getLockedCanonical(key) !== e.canonical),
  );
  if (!unseeded) return;
  const shown = shownPath(lockPath);
  throw new Error(
    `writeBundle: ${shown} pins this project's identities, but it was not seeded before the workspace module ` +
      `loaded, so the bundle would carry name-derived guids. Seed it first — ` +
      `\`seedLockOverrides(readLockFile(${JSON.stringify(shown)}))\`, then import the entry — or run ` +
      `\`xanosdk export <entry> --out <path>\`.`,
  );
}

/** A path as the caller would type it from the cwd. */
function shownPath(path: string): string {
  for (const p of [path, realOrSelf(path)]) {
    const rel = relative(process.cwd(), p);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return path;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
    } catch {
      return path;
    }
  }
}

function parses(lockPath: string): boolean {
  try {
    readLockFile(lockPath);
    return true;
  } catch {
    return false;
  }
}
