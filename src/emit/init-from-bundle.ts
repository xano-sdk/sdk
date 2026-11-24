/**
 * `xanosdk init [dir] --from <bundle.tar.gz>` — a project that runs on a hosted
 * workspace's exported data.
 *
 * At the end of a hosted trial a workspace downloads as a Xano Engine export
 * bundle (`engine-bundle.ts`): its records, its stored files and its instance's
 * secrets. This turns one into a project whose `deploy --local` runs the engine
 * ON those records (`src/deploy/local-data.ts`):
 *
 * 1. The bundle is recognized by its manifest, before anything is written. A
 *    `.tar.gz` that is not one is refused in words.
 * 2. An engine is acquired the way a deploy acquires one, and its own `import`
 *    verb unpacks the bundle into a data directory STAGED under the engine
 *    home — not yet the project's `xano/data`, because `init --from` writes a
 *    project only into a new or empty directory, and the data would make the
 *    target neither.
 * 3. A persistent engine starts on the staged data, and the backend code is
 *    pulled from it exactly as `init --from local:<name>` pulls one, under the
 *    engine name the project's deploys will use.
 * 4. The engine is stopped (cleanly, so its database is whole) and the data is
 *    moved into `<project>/xano/data`, which is then gitignored. If no project
 *    was written (a refusal, a cancelled prompt), the staged data is removed:
 *    the bundle is still where it was.
 *
 * The workspace the engine signs in to must be the one the export carries.
 * Engines released so far sign in to workspace 1 of any data directory, and an
 * export keeps its hosted id (7, say): pulling or deploying into a workspace
 * the data does not hold would read nothing or create one beside it, so that
 * is refused clearly instead ({@link refuseMissingDataWorkspace}, which
 * `deploy --local` runs too).
 *
 * Node-only; lazily imported by `init`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { LocalFileNotFoundError, UsageError } from "./errors.js";
import { detail, info, step, success, warn } from "./ui.js";
import { shellQuote } from "../util/shell-quote.js";
import { isGzipFile, NotAnEngineBundle, readEngineBundleManifest, type EngineBundleManifest } from "../deploy/engine-bundle.js";
import { PROJECT_DATA_DIR, projectDataDir } from "../deploy/local-data.js";
import type { LocalEngine } from "../deploy/local-engine-handshake.js";
import type { EngineFetch } from "../deploy/local-engine-release.js";
import type { EngineRun, EngineSpawn } from "../deploy/local-engine-process.js";
import type { ReachableWorkspace } from "./workspace-binding.js";
import type { ResolvedAuth } from "../auth/token.js";
import type { InitFromHooks } from "./codegen-command.js";
import type { CodegenSource } from "./codegen-command.js";

/** An export bundle `--from` named: where it is, and its manifest. */
export interface FoundEngineBundle {
  /** The bundle as typed, for messages. */
  raw: string;
  /** The bundle's absolute path. */
  path: string;
  manifest: EngineBundleManifest;
}

/** A path named like a `.tar.gz`. */
const TAR_GZ = /\.(?:tar\.gz|tgz)$/i;

/**
 * The export bundle `raw` names, or `undefined` when `raw` is not a gzip file
 * (a running backend, a bundle `.json`: the ordinary `--from` sources).
 *
 * A path named like a `.tar.gz` that is missing is refused as the missing file
 * it is. A gzip file that is not a bundle is refused too, saying why — read as
 * anything else, it would only fail later as a bundle `.json` that does not
 * parse.
 */
export async function engineBundleAt(raw: string): Promise<FoundEngineBundle | undefined> {
  const path = resolve(raw);
  // Node 20 throws ENOTDIR here when a parent is a file (`throwIfNoEntry` covers ENOENT only)
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    if (TAR_GZ.test(raw)) {
      throw new LocalFileNotFoundError(`--from ${raw}: no file there.`, { helpFor: { command: "init" } });
    }
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (!isGzipFile(path)) {
    if (!TAR_GZ.test(raw)) return undefined;
    throw notABundle(raw, "it is not gzip-compressed");
  }
  try {
    return { raw, path, manifest: await readEngineBundleManifest(path) };
  } catch (err) {
    if (err instanceof NotAnEngineBundle) throw notABundle(raw, err.message);
    throw err;
  }
}

function notABundle(raw: string, why: string): UsageError {
  return new UsageError(
    `--from ${raw} is not a Xano Engine export bundle: ${why}.\n` +
      "`init --from` takes the workspace download a hosted trial ends with (a .tar.gz), a bundle .json, " +
      "or a running backend (`workspace`, `ephemeral`, `local`, `tenant:<name>`, `release:<name>`).",
    { helpFor: { command: "init" } },
  );
}

/** The seams {@link runInitFromBundle} is driven through. Every one defaults to the real thing. */
export interface InitFromBundleDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: EngineFetch;
  spawn?: EngineSpawn;
  run?: EngineRun;
  /** Read the workspaces an engine's bearer sees; undefined when the list cannot be read. */
  readWorkspaces?: WorkspaceReader;
  /** Write the project from the running engine — `init --from local:<name>`. */
  initFrom?: (args: ParsedArgs, source: CodegenSource, hooks: InitFromHooks) => Promise<void>;
}

/** What {@link refuseMissingDataWorkspace} reads the workspace list with. */
export type WorkspaceReader = (auth: { instance: string; access_token: string }) => Promise<ReachableWorkspace[] | undefined>;

/**
 * Write a project around an export bundle's workspace and move its data into
 * the project's `xano/data`. See the module note for the steps and why they
 * are in this order.
 */
export async function runInitFromBundle(args: ParsedArgs, bundle: FoundEngineBundle, deps: InitFromBundleDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const { manifest } = bundle;
  refuseBundleFlags(args);

  // The directory: the one named, else one named after the workspace — never
  // the current directory by default, where the data would land beside
  // whatever is already there.
  const { sanitizeAppName } = await import("./init-command.js");
  const workspaceName = manifest.workspace?.name.trim() ?? "";
  const targetArg = args.positionals[0] ?? sanitizeAppName(workspaceName !== "" ? workspaceName : basename(bundle.path).replace(TAR_GZ, ""));
  const target = resolve(targetArg);
  const dataDir = projectDataDir(target);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    throw new UsageError(
      `${displayDir(dataDir)} already holds engine data, and \`init --from\` a bundle never writes over a project's data. ` +
        `Move it out of the project first, or name a new directory for this one.`,
      { helpFor: { command: "init" } },
    );
  }
  for (const note of manifest.notes) info(`From the export: ${note}`);

  // The engine a deploy would run: an override in the environment, else the latest release.
  const { resolveEngineSource } = await import("../deploy/local-engine-config.js");
  const { acquireEngine, ENGINE_LICENSE_NOTICE } = await import("../deploy/local-engine-release.js");
  const rerun = `xanosdk init ${shellQuote(targetArg)} --from ${shellQuote(bundle.raw)}`;
  const { entry } = await acquireEngine({
    spec: resolveEngineSource(undefined, env),
    env,
    rerun,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    onDownloaded: () => info(ENGINE_LICENSE_NOTICE),
  });
  const seams = { entry, env, ...(deps.run === undefined ? {} : { run: deps.run }) };

  const { importEngineBundle, listEngines, startEngine, stopEngineNamed } = await import("../deploy/local-engine-process.js");
  const { engineNameForProject } = await import("../deploy/local-engine-state.js");
  const name = engineNameForProject(target);
  // The name this project's deploys will use, so the codegen record names the
  // engine they run. One already serving under it is this directory's engine
  // from before, and its data is not the bundle's.
  if (listEngines(seams).some((e) => e.name === name)) {
    throw new UsageError(
      `Xano Engine ${name} is already running for ${displayDir(target)}. Stop it with \`xanosdk local stop ${name}\`, ` +
        `then run this again.`,
      { helpFor: { command: "init" } },
    );
  }

  const { localEngineHome } = await import("../deploy/local-engine-config.js");
  const imports = join(localEngineHome(env), "imports");
  mkdirSync(imports, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(imports, "import-"));
  const staged = join(staging, "data");
  let keepStaged = false;
  try {
    step(`Importing ${basename(bundle.path)} into a Xano Engine data directory`);
    const imported = importEngineBundle(bundle.path, staged, seams);
    if (imported.remoteFiles > 0) {
      warn(
        `${imported.remoteFiles === 1 ? "1 stored file was" : `${imported.remoteFiles} stored files were`} not in the bundle, ` +
          "so the data still reads them from the hosted storage, which is deleted with the hosted instance.",
        "init.bundle-remote-files",
      );
    }

    const engine = await startEngine({ ...seams, name, dataDir: staged, ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }) });
    let written = false;
    let failure: { err: unknown } | undefined;
    try {
      await refuseMissingDataWorkspace(engine, {
        ...(manifest.workspace === undefined ? {} : { expected: manifest.workspace }),
        ...(deps.readWorkspaces === undefined ? {} : { read: deps.readWorkspaces }),
      });
      const initFrom = deps.initFrom ?? (await import("./codegen-command.js")).runInitFromCommand;
      await initFrom(
        {
          ...args,
          from: `local:${name}`,
          positionals: [targetArg, ...args.positionals.slice(1)],
          ...(args.name === undefined && workspaceName !== "" ? { name: workspaceName } : {}),
        },
        { kind: "local", name },
        { onWritten: () => (written = true) },
      );
    } catch (err) {
      failure = { err };
    }
    // Through the engine's own verb, which waits for the process to exit, so
    // the database moved below is one no process is writing.
    let stopped = false;
    try {
      stopped = stopEngineNamed(name, seams).stopped;
    } catch {
      /* reported below, as a stop that did not happen */
    }
    // An engine still running on the staged data keeps it: neither moved nor
    // removed from under a live process.
    if (!stopped) {
      keepStaged = true;
      throw new Error(
        (written
          ? `The project was written, but Xano Engine ${name} could not be stopped, so its data was not moved into it.\n` +
            `Stop it with \`xanosdk local stop ${name}\`, then move ${staged} to ${dataDir}.`
          : `Xano Engine ${name} could not be stopped, and nothing was written.\n` +
            `Stop it with \`xanosdk local stop ${name}\`, then remove ${staging}.`),
        ...(failure === undefined ? [] : [{ cause: failure.err }]),
      );
    }
    if (written) moveInto(staged, dataDir);
    // A failure after the project was written (its round trip, say) still
    // fails the command — with the data in place, as the project now needs it.
    if (failure !== undefined) throw failure.err;
    if (!written) return;
  } finally {
    if (!keepStaged) rmSync(staging, { recursive: true, force: true });
  }

  const { ensureLocalDataGitignored } = await import("./gitignore.js");
  ensureLocalDataGitignored(target);
  success(`Moved the workspace's data into ${displayDir(dataDir)} — it stays on this machine and out of git.`);
  const cd = target === process.cwd() ? "" : `cd ${shellQuote(relative(process.cwd(), target) || target)} && `;
  info(`Next: ${cd}npx @xano/sdk deploy --local — the Xano Engine runs on that data, and every deploy merges into it, keeping its rows.`);
  detail(`${PROJECT_DATA_DIR}/ holds the exported instance's secrets (xano.yaml): never commit, copy or share it.`);
}

/**
 * Flags that cannot apply to a bundle, refused before anything is read:
 * `--branch` and the sites (a bundle is one workspace's data, already of one
 * branch, with no sites to pull), and `--profile` (it is read with no Xano
 * credential at all).
 */
function refuseBundleFlags(args: ParsedArgs): void {
  const passed = [
    ...(args.branch !== undefined ? ["--branch"] : []),
    ...(args.withSites === true ? ["--with-sites"] : []),
    ...(args.profile !== undefined ? ["--profile"] : []),
  ];
  if (passed.length === 0) return;
  throw new UsageError(
    `${passed.map((f) => `\`${f}\``).join(" and ")} ${passed.length === 1 ? "does" : "do"} not apply to an export bundle: ` +
      "it is one workspace's data, read with no Xano credential. Drop " +
      `${passed.length === 1 ? "it" : "them"}.`,
    { helpFor: { command: "init" } },
  );
}

/**
 * Refuse to pull from, or deploy into, a workspace the engine's data does not
 * hold — the import would create it beside the data's own.
 *
 * Two checks. When the export names its workspace (`expected`), the engine must
 * have signed in to THAT one: an engine that signs in to workspace 1 of an
 * export of workspace 7 is one released before it opened an export's own
 * workspace, and pulling workspace 1 would read nothing. Then the engine's own
 * workspace list must hold the id it signed in to; a list that cannot be read
 * proves nothing either way, and the call that follows answers for itself.
 */
export async function refuseMissingDataWorkspace(
  engine: LocalEngine,
  opts: { expected?: { id: number; name: string }; read?: WorkspaceReader } = {},
): Promise<void> {
  const signedIn = engine.workspaceId;
  const newer =
    "Nothing was written. A newer Xano Engine release opens the data's own workspace; once one is out, " +
    "`xanosdk local update` (in a project) or `xanosdk local cache fetch` gets it, then run this again.";
  if (opts.expected !== undefined && opts.expected.id !== signedIn) {
    throw new Error(
      `This export holds workspace ${opts.expected.id}${opts.expected.name === "" ? "" : ` (${JSON.stringify(opts.expected.name)})`}, ` +
        `but the Xano Engine signed in to workspace ${signedIn} of it, which this engine release always does. ${newer}`,
    );
  }
  const read: WorkspaceReader =
    opts.read ??
    (async (auth) => (await import("./workspace-binding.js")).readReachableWorkspaces(auth as unknown as ResolvedAuth));
  const all = await read({ instance: engine.url, access_token: engine.token });
  if (all === undefined || all.some((w) => w.id === signedIn)) return;
  const { reachableInline } = await import("./workspace-binding.js");
  throw new Error(
    `The Xano Engine signed in to workspace ${signedIn}, but this project's data in ${PROJECT_DATA_DIR} ` +
      (all.length === 0 ? "holds no workspace" : `holds workspace ${reachableInline(all)}`) +
      `, and writing to one it does not hold would create it beside the data's own. ${newer}`,
  );
}

/** Move a stopped engine's data directory into place: a rename, or a copy across filesystems. */
function moveInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  // An empty `xano/data` (the scaffold leaves none, but a user may) is replaced;
  // one holding anything was refused before the import, and is never removed.
  if (existsSync(to)) rmdirSync(to);
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** A path as the reader typed it: relative to the working directory when under it. */
function displayDir(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === "" ? "." : rel.startsWith("..") ? path : rel;
}
