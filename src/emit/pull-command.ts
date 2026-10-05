/**
 * `xanosdk pull [source]` — bring a live backend down into the project you are
 * already in.
 *
 * `init --from` writes a whole project around a decoded workspace. That is the
 * right shape once, at the start. It is the wrong shape for the middle of the
 * loop — take a release, stand it up,
 * change it — which needs the backend refreshed inside a project that already
 * has a frontend, a lockfile, and a git history.
 *
 * ## It replaces what a decode wrote, and says so first
 *
 * The decoded files are rewritten, and a file the previous decode wrote that
 * this one does not is deleted. A file no decode wrote — a hand-added def,
 * notes — is kept and named: the same planner `init --from`'s re-run uses
 * (`planDecodeReplace`), so the two never disagree about which files are yours.
 *
 * So the changes are listed and confirmed BEFORE the first write, and a dirty
 * working tree is refused outright — the honest answer to "can I get that
 * back?" is "from git", which is only true if git had it.
 *
 * ## The lock is reconciled, not preserved
 *
 * `xano.lock` survives a regenerable write, which is right when the tree is
 * being refreshed from the same backend and wrong when it is being pointed at a
 * different one: its entries pin the identities a later promote uses to claim
 * public URLs and to scope a prune. A lock carried across from an unrelated
 * backend arms a wrong prune later.
 *
 * An entry survives only when the pulled source carries an object with the same
 * key AND the same identity. Zero overlap against a non-empty lock is the
 * signature of a project pointed somewhere else entirely, and is refused.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { CliError, UsageError } from "./errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { contextFlags } from "./context-flags.js";
import { confirm } from "./prompt.js";
import { step, success, warn, detail, info, terminalText } from "./ui.js";
import { pastePath } from "./typed-cwd.js";
import { keptDuplicates, replacedRegistrations, reportSuperseded, type KeptDuplicate } from "./pull-superseded.js";
import { isMachineOutput, writeJson } from "./output.js";
import { decodeWorkspaceArchive, encodeWorkspaceArchive } from "../validate/archive.js";
import { decodeBundle } from "../codegen/index.js";
import { ROUTES_MANIFEST_BASENAME } from "./routes-manifest.js";
import {
  carriedSeedRows,
  fetchWorkspaceBundle,
  placeGeneratedFiles,
  refuseDuplicateSourceGuids,
  verifyPulledTree,
  reportSeedRows,
  seedRowsLanding,
  withSourceIdentities,
  writeDocumentationTokens,
  type SeedRowsReport,
} from "./codegen-command.js";
import { rerenderEnvExample } from "./env-example-refresh.js";
import { readVersion, refreshAgentGuidance } from "./cli.js";
import { CODEGEN_MARKER, PRESERVED_ON_REFRESH, SHELL_FILES_IN_BACKEND, XANO_DIR, type ScaffoldFile } from "./scaffold.js";
import { backendDirIn, resolveBackendDir } from "./backend-dir.js";
import { WORKSPACE_SECRETS_BASENAME } from "../workspace/documentation-token.js";
import { ensureSecretPathGitignored } from "./gitignore.js";
import {
  namesInEnvExample,
  readWorkspaceEnvFile,
  WORKSPACE_ENV_BASENAME,
  WORKSPACE_ENV_EXAMPLE_BASENAME,
} from "./workspace-env.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { identityNamesByGuid, lockKey, lockNameForObject, WORKSPACE_KEY, withObjects, type LockFile } from "../lock/lock.js";
import { fetchSourceArchive } from "./deploy-source.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, refuseProfileForLocal, selectBackend } from "./tracked-backend.js";
import { recordSync, syncBranchLabel, type SyncReport } from "./sync-record.js";
import { syncDigests } from "../deploy/sync-baseline.js";
import {
  containedWrites,
  DECODE_MARKER,
  decodeMarkerHead,
  decodeMarkerWith,
  describeDecodeReplace,
  filesUnder,
  planDecodeReplace,
  planTouchesExisting,
  readDecodeRecord,
  removeEmptiedDirs,
  removeFiles,
  type DecodeReplacePlan,
} from "./backend-tree.js";

/**
 * Files a refresh keeps because they are the project's, not the decode's.
 *
 * Read from `scaffold.ts` rather than restated: `init --from` clears `xano/`
 * through `scaffoldProject`, this command walks the directory itself, and two
 * lists is how a file ends up preserved on one path and deleted by the other —
 * which for `xano/.env` means destroying values that exist nowhere else.
 *
 * Plus the codegen record `init --from` and `generate` leave, which is pull's
 * alone to keep. It is what marks the tree as machine-written — `generate`
 * refreshes a directory only when it finds one — and a pull is a decode too,
 * so deleting it turned a generated tree into a hand-authored one. The shared
 * list cannot carry it: `init --force` over a project must drop it, or the
 * marker would outlive the tree it describes.
 */
const PRESERVED = new Set([...PRESERVED_ON_REFRESH, ...SHELL_FILES_IN_BACKEND, basename(CODEGEN_MARKER)]);

/**
 * Whether git can vouch that the backend directory has nothing uncommitted in it.
 *
 * Three answers, not two. "Cannot say" is NOT "clean": outside a repository, or
 * without git, nothing holds the old version, so a replace is less recoverable
 * there rather than more. Reporting clean in that case would skip the refusal
 * exactly where it matters most.
 */
export function backendDirCleanliness(cwd: string, backendDir: string): "clean" | "dirty" | "unknown" {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", backendDir], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "" ? "clean" : "dirty";
  } catch {
    return "unknown";
  }
}

/**
 * The files under `backendDir` git reports changed against HEAD, relative to
 * `backendDir` — or an empty set when git cannot say (no repository, no commit).
 */
export function gitChangedUnder(cwd: string, backendDir: string): ReadonlySet<string> {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--relative", "HEAD", "--", backendDir], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prefix = `${backendDir.replace(/\/+$/, "")}/`;
    return new Set(
      out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * `plan` with every "rewritten, nothing recorded" file git reports changed
 * moved to `edited`: git holds the committed version, so an uncommitted change
 * there is an edit the rewrite loses, whatever the decode record lacks.
 */
export function withGitEdits(plan: DecodeReplacePlan, changed: ReadonlySet<string>): DecodeReplacePlan {
  if (changed.size === 0) return plan;
  const moved = plan.rewrittenUnknown.filter((p) => changed.has(p));
  if (moved.length === 0) return plan;
  return {
    ...plan,
    edited: [...plan.edited, ...moved],
    rewrittenUnknown: plan.rewrittenUnknown.filter((p) => !changed.has(p)),
  };
}

/**
 * The lock entries a refresh gives up, split by what happens to them: `dropped`
 * the source has no object for; `repinned` the source holds under the same key
 * and another guid, which the refreshed lock records instead ({@link pulledLock}).
 */
export function lockReportOf(reconciliation: Reconciliation | undefined): {
  dropped: string[];
  repinned: Reconciliation["repinned"];
  renamed: NonNullable<Reconciliation["renamed"]>;
} {
  if (reconciliation === undefined) return { dropped: [], repinned: [], renamed: [] };
  const renamed = reconciliation.renamed ?? [];
  const moved = new Set([...reconciliation.repinned.map((r) => r.key), ...renamed.map((r) => r.from)]);
  return { dropped: reconciliation.dropped.filter((k) => !moved.has(k)), repinned: reconciliation.repinned, renamed };
}

/** Which objects the pulled bundle carries, as lock keys mapped to identities. */
export function pulledIdentities(payload: Record<string, unknown>): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const appNames = identityNamesByGuid(payload);
  for (const [payloadKey, value] of Object.entries(payload)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (row === null || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      if (typeof rec.name !== "string") continue;
      // Compose the key the way the lock WRITER does. Keying by the bare name
      // matches every kind except `query`, whose lock name is
      // `<group>|<verb>|<name>` — so a bare-name key never matched a real
      // lock's query entries, and a query-heavy project read as an unrelated
      // backend on every pull.
      const name = lockNameForObject(payloadKey, rec as { name: string }, appNames);
      out.set(lockKey(payloadKey, name), typeof rec.guid === "string" ? rec.guid : undefined);
    }
  }
  return out;
}

/** "None of the 3 identities in <lock> appear in" — or, for one, "The one identity in <lock> does not appear in". */
export function noneOfTheIdentities(count: number, lock: string): string {
  return count === 1
    ? `The one identity in ${lock} does not appear in`
    : `None of the ${count} identities in ${lock} appear in`;
}

export interface Reconciliation {
  kept: string[];
  dropped: string[];
  /**
   * The {@link dropped} keys the source DOES carry, under another guid: a
   * refresh that records the source's identities (`pull`, `generate`) re-pins
   * them to it rather than losing them. Each with the guid it moves from and to.
   */
  repinned: Array<{ key: string; from: string; to: string }>;
  /**
   * The {@link dropped} keys whose guid the source carries under ANOTHER name
   * of the same kind: the object was renamed there, and its identity carries
   * over to the new key ({@link pulledLock} records it). Never said as lost.
   */
  renamed?: Array<{ from: string; to: string; guid: string }>;
  /** True when the lock had entries and none of them survived. */
  disjoint: boolean;
}

/**
 * Which lock entries the pulled source still accounts for.
 *
 * Key AND identity, not key alone: a name collision between two backends is
 * exactly the case that would otherwise carry a wrong guid forward, and a wrong
 * guid is a reference that resolves to the wrong object rather than failing.
 */
export function reconcileLock(
  lock: LockFile,
  pulled: Map<string, string | undefined>,
): Reconciliation {
  const kept: string[] = [];
  const dropped: string[] = [];
  const repinned: Reconciliation["repinned"] = [];
  const renamed: NonNullable<Reconciliation["renamed"]> = [];
  const keyByGuid = new Map<string, string>();
  for (const [key, guid] of pulled) if (guid !== undefined) keyByGuid.set(guid, key);
  for (const [key, entry] of Object.entries(lock.objects)) {
    // The workspace's own canonical is not an object the source lists, so it
    // is never reconciled here — {@link reconciledLock} carries it across.
    if (key === WORKSPACE_KEY) continue;
    const identity = pulled.get(key);
    const present = pulled.has(key);
    // An entry with no guid pins nothing that can disagree, so presence is
    // enough; one that pins a guid must match the object that came back.
    if (present && (entry.guid === undefined || identity === undefined || entry.guid === identity)) {
      kept.push(key);
    } else {
      dropped.push(key);
      if (present && identity !== undefined && entry.guid !== undefined) {
        repinned.push({ key, from: entry.guid, to: identity });
      } else if (!present && entry.guid !== undefined) {
        // Its guid under another name of its kind: renamed there (E2E pass 28:
        // `create_note` said "will be dropped" while `add_note` kept its guid).
        const to = keyByGuid.get(entry.guid);
        if (to !== undefined && to !== key && to.slice(0, to.indexOf(":")) === key.slice(0, key.indexOf(":")) && !(to in lock.objects)) {
          renamed.push({ from: key, to, guid: entry.guid });
        }
      }
    }
  }
  return {
    kept,
    dropped,
    repinned,
    ...(renamed.length > 0 ? { renamed } : {}),
    disjoint: kept.length === 0 && renamed.length === 0 && dropped.length > 0,
  };
}

/**
 * The lock a regenerated tree keeps: the reconciled entries, plus the
 * workspace's own canonical under its fixed key.
 *
 * The workspace entry is the one `init --from`, `export` and `lock import` all
 * write, and the regenerated tree exports it again — so dropping it here left
 * `export --check` failing on the very next run. The pulled source's value
 * wins: the engine provisions a workspace canonical per environment, and the
 * tree just written carries that one. A source that carries none leaves the
 * recorded entry as it was, which is what an export of that tree fills back in.
 */
export function reconciledLock(
  lock: LockFile,
  reconciliation: Reconciliation,
  payload: Record<string, unknown>,
): LockFile {
  // The landing record is about destinations, not the tree: a pull keeps it.
  const next: LockFile = withObjects(lock, {});
  for (const key of reconciliation.kept) next.objects[key] = lock.objects[key]!;
  const ws = payload[WORKSPACE_KEY] as { canonical?: unknown } | undefined;
  const pulled = ws !== null && typeof ws === "object" && typeof ws.canonical === "string" ? ws.canonical : "";
  const recorded = lock.objects[WORKSPACE_KEY];
  if (pulled !== "") next.objects[WORKSPACE_KEY] = { ...recorded, canonical: pulled };
  else if (recorded !== undefined) next.objects[WORKSPACE_KEY] = recorded;
  return next;
}

/**
 * The lock a refresh leaves: the reconciled entries ({@link reconciledLock}),
 * then every identity the source carries recorded into them — so an entry for
 * an object the project did not have before the pull is added, and the next
 * `export --check` passes. Shared with `generate --force`.
 */
export function pulledLock(lock: LockFile, reconciliation: Reconciliation, payload: Record<string, unknown>): LockFile {
  const reconciled = reconciledLock(lock, reconciliation, payload);
  try {
    return withSourceIdentities(reconciled, payload);
  } catch (err) {
    // A source the lock cannot adopt (two objects composing one identity) is
    // named by the adoption; the reconciled lock is still correct, only short.
    warn(
      `Could not record the source's identities in xano.lock (${err instanceof Error ? err.message : String(err)}). ` +
        `The first \`xanosdk export\` records them.`,
      "lock.write-failed",
    );
    return reconciled;
  }
}

/**
 * The backend directory of the project `cwd` sits inside, relative to `cwd` —
 * `../xano` from `frontend/`. Walks up from the cwd's parent to the first
 * directory whose backend (found the way every command finds one) has an
 * `index.ts`; `undefined` when no ancestor is a project.
 */
function projectBackendAbove(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    // The scaffolded `xano/` is checked anywhere; the scan for a renamed backend
    // only at a project root, or every ancestor's listing is read — the OS temp
    // dir, a home full of checkouts.
    const backend = existsSync(join(dir, "package.json")) ? backendDirIn(dir) : join(dir, XANO_DIR);
    if (existsSync(join(backend, "index.ts"))) return relative(cwd, backend).split(sep).join("/");
  }
}

/**
 * Where a bundle FILE can be decoded, as a command that runs as printed.
 *
 * Only a backend a decode wrote (it carries the decode marker) can be replaced
 * by `generate --force`; a hand-written one — an `init` scaffold — is refused
 * by generate's ownership check, so pointing at it printed a remedy that
 * failed. Such a backend gets what generate's own refusal says: a new
 * directory, named here so the command needs no editing.
 */
function decodeHint(cwd: string, file: string, out: string): string {
  const backend = resolve(cwd, out);
  if (existsSync(join(backend, basename(CODEGEN_MARKER)))) {
    return `To decode a bundle file into this project's backend use \`${generateHint(cwd, file, out)}\`.`;
  }
  const base = basename(backend);
  let fresh = join(dirname(backend), `${base}-decoded`);
  for (let n = 2; existsSync(fresh); n++) fresh = join(dirname(backend), `${base}-decoded-${n}`);
  const shown = relative(cwd, backend).split(sep).join("/") || ".";
  const target = relative(cwd, fresh).split(sep).join("/");
  return (
    `${shown}/ was not written by a decode (it holds no ${basename(CODEGEN_MARKER)}), so a decode will not ` +
    `replace it. To decode the bundle into a new directory beside it use ` +
    `\`xanosdk generate ${shellQuote(file)} --out ${shellQuote(target)}\`.`
  );
}

/**
 * The `generate` that decodes `file` into the backend at `out` (cwd-relative),
 * runnable as printed from `cwd`.
 *
 * From inside the backend (`xano/`, `xano/query/`) the `--out` would be `''` or
 * `..` — the working directory or above it, which `generate` refuses to
 * replace. So the command steps out to the project root first, and names the
 * file and the backend from there. `--yes` rides along when stdin is not a
 * terminal, where `generate` cannot ask before replacing edited files.
 */
function generateHint(cwd: string, file: string, out: string): string {
  const yes = process.stdin.isTTY === true ? "" : " --yes";
  const backend = resolve(cwd, out);
  const here = resolve(cwd);
  if (here !== backend && !here.startsWith(`${backend}${sep}`)) {
    return `xanosdk generate ${shellQuote(file)} --out ${shellQuote(out)} --force${yes}`;
  }
  const root = dirname(backend);
  const fromRoot = (p: string) => relative(root, p).split(sep).join("/") || ".";
  const target = isAbsolute(file) ? file : fromRoot(resolve(cwd, file));
  return (
    `cd ${shellQuote(relative(here, root).split(sep).join("/"))} && ` +
    `xanosdk generate ${shellQuote(target)} --out ${shellQuote(fromRoot(backend))} --force${yes}`
  );
}

export async function runPullCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  // Resolved ONCE, and passed to everything below — nothing downstream
  // re-derives it. A pull DELETES, so the cost of two resolvers disagreeing is
  // not a wrong report, it is the wrong directory cleared: the walk that lists
  // deletions, the git check that vouches for them, the containment check, the
  // confirmation the user reads, and the clear itself all have to name one
  // directory, or the confirmation is about a different place than the write.
  const backendDir = resolveBackendDir(cwd, args.backendDir, (m) => new UsageError(
    `${m} A pull replaces the directory it is given.`,
    { hintFor: { command: "pull" } },
  ));

  // A bundle FILE is not something pull reads — it refreshes from a live
  // backend. Refused here, in pull's own words, rather than by the shared
  // selector, whose "a path has never run" is `release create`'s sentence, and
  // pointed at the command that does decode a file into this tree.
  const first = args.positionals[0];
  if (first !== undefined && !/^[a-z][a-z-]+:/i.test(first) && (/\.json$/i.test(first) || /[\\/]/.test(first))) {
    // The --out the hint prints is the PROJECT's backend, resolved from the
    // project root rather than the cwd: run from `frontend/`, the cwd-relative
    // `xano` would create `frontend/xano/`. Relative to the cwd, because that
    // is where the printed command runs.
    const out =
      args.backendDir !== undefined || existsSync(join(cwd, backendDir, "index.ts"))
        ? backendDir
        : projectBackendAbove(cwd);
    throw new UsageError(
      `\`xanosdk pull\` refreshes from a live backend, and "${first}" names a file. ` +
        (out !== undefined
          ? decodeHint(cwd, first, out)
          : `There is no project here to decode it into: \`xanosdk init <dir> --from ${shellQuote(first)}\` ` +
            `writes a whole project around it.`),
      { hintFor: { command: "pull" } },
    );
  }

  // Outside a project this is the wrong command, and the right one writes the
  // shell that `pull` assumes. Say which rather than creating half a project.
  if (!existsSync(join(cwd, backendDir, "index.ts"))) {
    throw new UsageError(
      `\`xanosdk pull\` refreshes the backend of a project that already exists, and there is no ` +
        `${backendDir}/index.ts here. \`xanosdk init <dir> --from <source>\` writes a whole project ` +
        `around a decoded backend` +
        (args.backendDir === undefined
          ? `, and \`--backend-dir <path>\` names the directory when this project keeps its ` +
            `backend somewhere discovery cannot find it.`
          : `.`),
    );
  }

  // Bare `pull` means the backend this project last deployed to — an ephemeral
  // or a Xano Engine — decided by the one tracked-backend resolver every bare
  // command shares. The credential is a memoized provider: read only when the
  // kind is hosted, so pulling from a Xano Engine signs in nowhere.
  const slot = requireBackendSlot("pull", undefined, "subject");
  const credential = memoCredential(() => getAccessToken(args));
  const source = await selectBackend(slot, args.positionals[0], { credential, deps: { cwd } });
  // A Xano Engine selects no credential: `--profile` beside one is refused,
  // not dropped (R9). After the default is decided, so a bare pull that lands
  // on the Xano Engine refuses the same way `pull local` does.
  refuseProfileForLocal(args.profile, [source.kind], slot);
  // Bare resolved to a kind is that kind's bare keyword, which the fetch then
  // resolves to the tracked one — the same record the decision just read.
  const raw = args.positionals[0] ?? source.kind;
  if (args.branch !== undefined && source.kind !== "workspace") {
    throw new UsageError(
      `\`--branch\` applies to \`workspace\` only. ${args.positionals[0] === undefined ? `This project's ${source.kind}` : `"${raw}"`} ` +
        `carries the logic it was built from, not a branch to choose between.`,
      { hintFor: { command: "pull" } },
    );
  }

  step(`Reading ${raw}`);
  // A branch of the workspace through the branch-checked export `init --from
  // workspace --branch` reads, so the refresh reads what the project was made from.
  const fetched =
    args.branch !== undefined
      ? { archive: encodeWorkspaceArchive(JSON.stringify(await fetchWorkspaceBundle(await credential(), args.branch))), provenance: "workspace", label: `workspace branch "${args.branch.trim()}"` }
      : await fetchSourceArchive(credential, raw, cwd);
  const bundle = decodeWorkspaceArchive(fetched.archive) as { payload: Record<string, unknown> };
  // A tenant's (or an ephemeral's) workspace is named by the platform — its
  // handle — and a release carries no workspace at all: neither is the name this
  // project gave itself, so the project's own `workspace("…")` is kept.
  const keptName = source.kind === "workspace" || source.kind === "local" ? undefined : projectWorkspaceName(join(cwd, backendDir, "index.ts"));
  const project = decodeBundle(bundle, {
    secretsFile: `${backendDir}/${WORKSPACE_SECRETS_BASENAME}`,
    ...(keptName !== undefined ? { workspaceName: keptName } : {}),
  });
  refuseDuplicateSourceGuids(project);
  const seedRows = carriedSeedRows(fetched.archive, bundle.payload);
  // The project's toolchain modules, for their sections of the route manifest
  // placed below — discovered before the pulled tree's entry is ever loaded.
  const { discoverManifestModules } = await import("./routes-manifest-file.js");
  const modules = await discoverManifestModules(cwd, join(cwd, backendDir, ROUTES_MANIFEST_BASENAME), readVersion());
  const placed = placeGeneratedFiles(project, backendDir, undefined, undefined, modules);
  const settings =
    source.kind === "release"
      ? keepProjectSettings(placed, backendDir, join(cwd, backendDir))
      : { files: placed, kept: false, lost: [], from: WORKSPACE_SETTINGS_FILE };
  const files = settings.files;

  // The same planner `init --from`'s re-run uses: only what the previous decode
  // recorded writing is removed, and a file no decode wrote is the author's.
  const dirAbs = join(cwd, backendDir);
  const prefix = `${backendDir}/`;
  const decoded = files.map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
  const incoming = new Map(decoded.map((f) => [f.path, f.content] as const));
  const existing = filesUnder(dirAbs).filter((p) => !PRESERVED.has(p));
  let plan = planDecodeReplace(dirAbs, incoming, existing, readDecodeRecord(dirAbs, existing));
  const deletions = plan.removals;

  // Beside the entry, matching `export`/`compile`/`deploy` (cf. resolveLockPath
  // in cli.ts) and matching this file's own PRESERVED check, which keeps
  // `xano/xano.lock`. Reading the project root instead left the reconciliation
  // silently skipped for every scaffolded project — and rewrote a lock the
  // build never reads.
  const lockPath = join(cwd, backendDir, "xano.lock");
  const lock = existsSync(lockPath) ? readLockFile(lockPath) : undefined;
  const reconciliation =
    lock === undefined ? undefined : reconcileLock(lock, pulledIdentities(bundle.payload));

  // The sync baseline this pull records once the tree is written (see
  // `deploy/sync-baseline.ts`): a decode reads the whole branch, so it is
  // complete. Only for a workspace, the one source `workspace diff` compares,
  // and only beside a lock, where a landing record lives too. The branch label
  // is read now so the record itself stays synchronous after the lock write.
  const syncTarget =
    source.kind === "workspace" && lock !== undefined
      ? await (async () => {
          const auth = await credential();
          const branch = await syncBranchLabel(auth, args.branch);
          return branch === undefined ? undefined : { instance: auth.instance, workspaceId: auth.workspaceId, branch };
        })()
      : undefined;
  /** Record it. AFTER the lock write: that write rebuilds the lock from the copy read above. */
  const recordPullSync = (): SyncReport | null =>
    syncTarget === undefined ? null : recordSync({ lockPath, target: syncTarget, digests: syncDigests({ held: [bundle] }), by: "pull", complete: true });

  if (reconciliation?.disjoint === true && args.yes !== true) {
    throw await needsYes(
      args,
      `${noneOfTheIdentities(reconciliation.dropped.length, "xano.lock")} ` +
        `${fetched.label}. That is what pointing a project at an unrelated backend looks like, ` +
        `and carrying the lock across would arm a wrong prune later.`,
      "if you meant to repoint this project",
      { refused: "unrelated-lock" },
    );
  }

  // Nothing to replace: every decoded file is already on disk byte for byte,
  // none is dropped, none is new, and the lock gives nothing up. The dirty-tree
  // refusal and the confirmation guard a REPLACE, so asking for `--yes` over an
  // empty listing guarded nothing — and rewriting the tree would only churn it.
  const existingSet = new Set(existing);
  const upToDate =
    !planTouchesExisting(plan) &&
    [...incoming.keys()].every((p) => existingSet.has(p)) &&
    (reconciliation?.dropped.length ?? 0) === 0;
  // Kept files that define an object the pulled tree declares too: the entry
  // registers the pulled copy, so the kept one is dead.
  const duplicates = keptDuplicates(dirAbs, incoming, plan.kept, backendDir);
  if (upToDate) {
    await refreshAgentGuidance({ ...args, file: join(cwd, backendDir, "index.ts") });
    finishUpToDate(cwd, backendDir, project, args, fetched, lock, lockPath, reconciliation, bundle.payload, files.length, plan.kept, settingsReport(settings, backendDir), seedRows, duplicates, recordPullSync);
    return;
  }

  const cleanliness = backendDirCleanliness(cwd, backendDir);
  if (cleanliness === "dirty" && args.yes !== true) {
    throw await needsYes(
      args,
      `${backendDir}/ has uncommitted changes, and a pull rewrites the files it decodes. Commit or stash ` +
        `them first.`,
      "to go ahead — it overwrites your edits to decoded files and keeps files you added",
      { refused: "uncommitted-changes" },
    );
  }
  if (cleanliness === "unknown") {
    warn(`Not a git repository — nothing here holds the version of ${backendDir}/ about to be replaced.`, "pull.no-git");
  }

  // A file nothing recorded a digest for is "rewritten, edits unknown" — but
  // git can say. One it reports changed IS edited, and is reported as such on
  // stderr and in `rewrittenEdited` alike (E2E pass 17: the warning said edits
  // were lost while the JSON said none were).
  if (cleanliness === "dirty") plan = withGitEdits(plan, gitChangedUnder(cwd, backendDir));
  describeDecodeReplace(plan, backendDir, fetched.label, (line, files) => warn(line, "pull.replace", files));
  // What the listing above does not say (E2E pass 25): the files this pull
  // adds, and the `seed:` rows a rewritten hand-written table loses — a live
  // backend's export carries no rows, so the decode writes none back.
  const newFiles = [...incoming.keys()].filter((p) => !existingSet.has(p)).sort();
  if (newFiles.length > 0) {
    info(`${newFiles.length} new file${newFiles.length === 1 ? "" : "s"} will be written:`);
    for (const p of newFiles.slice(0, 20)) detail(`${backendDir}/${p}`);
    if (newFiles.length > 20) detail(`… and ${newFiles.length - 20} more`);
  }
  const droppedSeeds = codeSeedsDropped(dirAbs, incoming, plan, backendDir);
  // One message per table (E2E pass 27: "holds no seed rows to write back"
  // beside "carries seed rows for table …" for the same table): a table whose
  // code seed is dropped says the release's rows there, and the rest here.
  const rowsOnly = seedRows.filter((s) => !droppedSeeds.some((d) => d.table === s.table));
  reportDroppedSeeds(
    droppedSeeds,
    seedRows,
    fetched,
    contextFlags(args),
    cleanliness !== "unknown",
    rowsOnly.length === 0,
    source.kind === "release",
  );
  // Module registrations the rewritten entry replaces with decoded copies, and
  // the kept duplicates above (E2E pass 48: both were silent).
  const modulesReplaced = replacedRegistrations(
    dirAbs,
    incoming,
    existing.filter((p) => !plan.kept.includes(p)),
    backendDir,
  );
  reportSuperseded(duplicates, modulesReplaced, backendDir, cleanliness === "clean");
  if (keptName !== undefined) {
    detail(`Kept this project's workspace name "${keptName}" — ${fetched.label} does not carry it.`);
  }
  reportSeedRows(rowsOnly, fetched.label, fetched.provenance, backendDir, contextFlags(args));
  if (settings.kept) {
    detail(
      `Kept this project's ${backendDir}/${WORKSPACE_SETTINGS_FILE} — ${fetched.label} carries no workspace settings.`,
    );
  } else if (settings.lost.length > 0) {
    warn(
      `${fetched.label} carries no workspace settings, so the workspaceConfig in ${backendDir}/${settings.from} is ` +
        `rewritten without its ${settings.lost.join(", ")}. ` +
        // Not a git repository: nothing holds the old file to restore from.
        `${cleanliness === "unknown" ? "Add them back by hand" : "Restore them from git"} to keep them` +
        (settings.from === WORKSPACE_SETTINGS_FILE
          ? ` (a release pull keeps ${backendDir}/${WORKSPACE_SETTINGS_FILE} when ${backendDir}/index.ts imports its ` +
            `export and passes it to \`.registerWorkspace()\`)`
          : ` (declared in ${backendDir}/${WORKSPACE_SETTINGS_FILE} as \`export const workspaceSettings\`, a release pull keeps them)`) +
        `, or pull from the workspace that holds them.`,
      "pull.settings-lost",
    );
  }
  if (plan.removals.includes(WORKSPACE_SETTINGS_FILE)) {
    warn(
      `${fetched.label} carries no workspace settings, so ${backendDir}/${WORKSPACE_SETTINGS_FILE} (the previous ` +
        `decode's) is removed and index.ts registers none. Restore it from git to keep them, or pull from ` +
        `the workspace that holds them.`,
      "pull.settings-lost",
    );
  }
  const lockReport = lockReportOf(reconciliation);
  if (lockReport.dropped.length > 0) {
    const dropped = lockReport.dropped;
    warn(
      `${dropped.length} ${backendDir}/xano.lock entr${dropped.length === 1 ? "y has" : "ies have"} ` +
        `no counterpart in ${fetched.label} and will be dropped:`,
      "pull.lock-dropped",
      // The lock's own key spelling (`dbo:users`), so it can be found in the file.
      capped(dropped),
    );
  }
  if (lockReport.renamed.length > 0) {
    const renamed = lockReport.renamed;
    info(
      `${renamed.length} ${backendDir}/xano.lock entr${renamed.length === 1 ? "y keeps its" : "ies keep their"} identity ` +
        `under the name ${fetched.label} carries ${renamed.length === 1 ? "it" : "them"} by (renamed there):`,
    );
    for (const line of capped(renamed.map((r) => `${r.from} → ${r.to} (guid ${r.guid})`))) detail(line);
  }
  if (lockReport.repinned.length > 0) {
    const repinned = lockReport.repinned;
    warn(
      `${repinned.length} ${backendDir}/xano.lock entr${repinned.length === 1 ? "y" : "ies"} will be re-pinned to ` +
        `the object ${fetched.label} holds under the same name:`,
      "pull.lock-repinned",
      capped(repinned.map((r) => `${r.key}: ${r.from} → ${r.to}`)),
    );
  }

  // Unconditional: `pull` REPLACES the directory, so every file in it is
  // rewritten whether or not the decode happens to drop one. Gating the prompt
  // on the deletion list meant a same-shape pull overwrote hand edits — the
  // case the dirty-tree check is meant to catch and cannot when git is absent.
  if (args.yes !== true) {
    const { yesRerun } = await import("./retry-command.js");
    const { rerun, note } = yesRerun(args, "pull");
    const ok = await confirm(`Replace ${backendDir}/ from ${fetched.label}?`, {
      flag: "--yes",
      refusal: { details: { written: false }, rerun, note },
    });
    if (!ok) {
      info("Pull cancelled. Nothing was written.");
      return;
    }
  }

  // Containment, BEFORE anything is deleted. A decoded path is derived from
  // the source's own stored strings, and a source is a remote backend — so a
  // path that climbs out of `xano/` is an arbitrary file write on the machine
  // running the pull. Checked up front so a refusal costs the user nothing:
  // the tree is still intact when this throws.
  const planned = containedWrites(
    join(cwd, backendDir),
    files,
    (path) =>
      new UsageError(
        `${fetched.label} carries a file that would be written outside ${backendDir}/ ` +
          `("${path}"). Nothing was written. A source cannot place files anywhere ` +
          `else in this project, so this one is refused rather than trusted.`,
        ),
    cwd,
  );

  // BEFORE the clear: the old `.env.example` is about to be rewritten, and it is
  // the only record of what this project declared a moment ago.
  // The config declares them too: a project with no `.env.example` of its own
  // had every declared name reported "added" (E2E pass 23).
  const previousNames = [
    ...new Set([
      ...namesInEnvExample(join(cwd, backendDir, WORKSPACE_ENV_EXAMPLE_BASENAME)),
      ...declaredEnvNames(dirAbs),
    ]),
  ];

  step(`Writing ${backendDir}/ from ${fetched.label}`);
  // Remove then write, in that order and only after the confirmation above:
  // a file the previous decode wrote and this one does not would leave the
  // project exporting something the source does not have. A file no decode
  // wrote is not the decode's to remove.
  removeFiles(dirAbs, plan.removals);
  removeEmptiedDirs(dirAbs, plan.removals);
  for (const file of planned) {
    mkdirSync(dirname(file.full), { recursive: true });
    writeFileSync(file.full, file.content, "utf8");
  }
  // The record the next pull or `init --from` re-run removes by, and tells an
  // edited file from one only the source changed by.
  // The head names THIS source and this command, over whatever an earlier
  // decode recorded (see `decodeMarkerHead`).
  const head = decodeMarkerHead(previousMarker(dirAbs), "pull", fetched.provenance, readVersion(), project.report.toJson());
  writeFileSync(join(dirAbs, DECODE_MARKER), `${JSON.stringify(decodeMarkerWith(head, decoded), null, 2)}\n`, "utf8");
  reportKept(backendDir, plan.kept);
  reportFindings(project, backendDir);

  // The pulled source may declare env names this project has no values for, and
  // a repo whose `.gitignore` predates this feature may not cover the file they
  // go in. File-level, never `xano/` — that directory is the review surface.
  ensureSecretPathGitignored(join(cwd, backendDir, WORKSPACE_ENV_BASENAME));

  // The documentation tokens this pull carried, into the gitignored sidecar.
  // This is the half of the round trip that makes the feature usable: without
  // it the tree declares its gates and the values exist only in the workspace,
  // so the next deploy refuses and the user has to go copy each one by hand.
  // Shared with `init --from` rather than spelled twice — a pull that wrote
  // them and a scaffold that did not would be the same defect in one of the two
  // commands, and nothing would say which.
  writeDocumentationTokens(
    cwd,
    project.documentationTokens,
    args,
    fetched.label,
    join(cwd, backendDir, WORKSPACE_SECRETS_BASENAME),
  );

  if (lock !== undefined && reconciliation !== undefined) {
    writeLockFile(lockPath, pulledLock(lock, reconciliation, bundle.payload));
  }

  // AFTER the lock is written. `xano/.env` is user-owned and hand-edited, and
  // `parseEnvFile` throws on a line that is not KEY=VALUE — a pasted multi-line
  // secret is exactly that. Reporting before the lock write would let a
  // malformed file abort the command between the two writes, leaving `xano/`
  // refreshed from the new source and `xano.lock` still holding the old entry
  // set, with a non-zero exit that reads as "the pull failed". A report is not
  // worth that.
  try {
    // A kept workspace.ts keeps its env declarations: the project's names stand.
    // Its names, when they can be read off it, are the declared set either side.
    const keptNames = settings.kept ? (settings.envNames ?? previousNames) : undefined;
    reportEnvNameChanges(
      cwd,
      backendDir,
      keptNames ?? previousNames,
      keptNames ?? Object.keys(project.env),
      (one: boolean) => envFillRemedy(source.kind, args, one),
    );
  } catch (err) {
    warn(
      `Could not check ${backendDir}/${WORKSPACE_ENV_BASENAME} for missing values ` +
        `(${err instanceof Error ? err.message : String(err)}). The pull itself is complete.`,
      "pull.env-check-failed",
    );
  }

  warnTsxNeeded(join(cwd, backendDir, "index.ts"), planned.map((f) => f.full), backendDir);
  // The tree is a decoded one now, which changes what AGENTS.md's managed
  // block tells an agent: refreshed here as `export` would, so the next build
  // is not the one that rewrites it.
  await refreshAgentGuidance({ ...args, file: join(cwd, backendDir, "index.ts") });

  // The round trip `init --from` runs, over the tree this pull just wrote (E2E
  // pass 26: a pull never checked it). A failure fails the command as it fails
  // `init --from` — the files stay, to be inspected.
  let verified: boolean | null = null;
  if (args.skipRoundtrip !== true) {
    step(`Verifying ${backendDir}/ round-trips`);
    verified = await verifyPulledTree(cwd, backendDir, project, source.kind, settings.kept);
    if (verified === false) {
      process.stderr.write(`${terminalText(project.report.renderCli({ fileBase: `${backendDir}/` }))}\n`);
      warn(
        `${backendDir}/ is NOT verified — the objects listed above do not re-export as ${fetched.label} holds them. ` +
          `Do not deploy it; reconcile the objects the report names, or re-run the pull once the source is fixed.`,
        "pull.unverified",
      );
    }
  }

  // A tree that does not round-trip does not match the branch, so it is no
  // baseline. One that was not checked (`--skip-roundtrip`) is taken as
  // decoded, as the rest of the pull takes it.
  const syncBaseline = verified === false ? null : recordPullSync();

  if (isMachineOutput(args)) {
    writeJson({
      source: fetched.provenance,
      upToDate: false,
      files: files.length,
      deleted: deletions.length,
      removedEdited: plan.removedEdited.map((p) => `${backendDir}/${p}`),
      rewrittenEdited: plan.edited.map((p) => `${backendDir}/${p}`),
      kept: plan.kept.map((p) => `${backendDir}/${p}`),
      lockKept: reconciliation?.kept.length ?? 0,
      lockDropped: lockReport.dropped.length,
      lockRepinned: lockReport.repinned.length,
      lockRenamed: lockReport.renamed.length,
      workspaceSettings: settingsReport(settings, backendDir),
      seedRows,
      newFiles: newFiles.map((p) => `${backendDir}/${p}`),
      droppedSeeds,
      keptDuplicates: duplicates,
      modulesReplaced,
      verified,
      syncBaseline,
    });
    if (verified === false) throw pullVerifyFailed(cwd, backendDir);
    // On stderr, so a piped run says it too: the document carries the rest.
    success(`Pulled ${fetched.label}`);
    detail(`${files.length} files written, ${deletions.length} removed`);
    return;
  }
  if (verified === false) throw pullVerifyFailed(cwd, backendDir);
  success(`Pulled ${fetched.label}`);
  detail(`${files.length} files written, ${deletions.length} removed`);
  if (reconciliation !== undefined) {
    detail(
      // Every count `--json` carries, renamed included (E2E pass 29: it was not said).
      `lock: ${reconciliation.kept.length} kept, ${lockReport.repinned.length} re-pinned, ` +
        `${lockReport.renamed.length} renamed, ${lockReport.dropped.length} dropped`,
    );
  }
}

/**
 * Whether `tsx` resolves for `entry` the way the entry loader looks for it:
 * from the entry, else beside this CLI.
 */
export function tsxResolvable(entry: string): boolean {
  for (const from of [pathToFileURL(resolve(entry)).href, import.meta.url]) {
    try {
      createRequire(from).resolve("tsx/esm/api");
      return true;
    } catch {
      // Not here; the next place, or none.
    }
  }
  return false;
}

/**
 * A pull that leaves the backend more than one TypeScript file, in a project
 * without `tsx`: said NOW, with the remedy. A single-file entry loads on
 * Node's own type stripping, but a decoded tree's `./tables/user.js` imports
 * resolve only under tsx — so the next deploy failed "requires tsx", reading
 * as the pull having broken the project (E2E pass 23). Exported for tests.
 */
export function warnTsxNeeded(
  entry: string,
  written: readonly string[],
  backendDir: string,
  resolvable: (entry: string) => boolean = tsxResolvable,
): void {
  const modules = written.filter((f) => /\.[cm]?ts$/.test(f) && !/\.d\.[cm]?ts$/.test(f));
  if (modules.length < 2 || resolvable(entry)) return;
  warn(
    `${backendDir}/ is now ${modules.length} TypeScript files, and an entry that imports its own modules loads only ` +
      `under tsx, which this project does not have — the next deploy fails until it does. Install it: \`npm i -D tsx\`.`,
    "pull.tsx-needed",
  );
}

/**
 * The end of a pull that has nothing to replace: no prompt, no tree write, and
 * the marker left alone. What is not the tree still runs — the documentation
 * tokens the source carries, and the lock (whose writer skips identical bytes).
 */
function finishUpToDate(
  cwd: string,
  backendDir: string,
  project: ReturnType<typeof decodeBundle>,
  args: ParsedArgs,
  fetched: Awaited<ReturnType<typeof fetchSourceArchive>>,
  lock: LockFile | undefined,
  lockPath: string,
  reconciliation: Reconciliation | undefined,
  payload: Record<string, unknown>,
  fileCount: number,
  kept: readonly string[],
  workspaceSettings: WorkspaceSettingsReport,
  seedRows: readonly SeedRowsReport[],
  duplicates: readonly KeptDuplicate[],
  /** Records the branch's sync baseline; run after the lock write. */
  recordPullSync: () => SyncReport | null,
): void {
  reportSeedRows(seedRows, fetched.label, fetched.provenance, backendDir, contextFlags(args));
  ensureSecretPathGitignored(join(cwd, backendDir, WORKSPACE_ENV_BASENAME));
  writeDocumentationTokens(cwd, project.documentationTokens, args, fetched.label, join(cwd, backendDir, WORKSPACE_SECRETS_BASENAME));
  if (lock !== undefined && reconciliation !== undefined) writeLockFile(lockPath, pulledLock(lock, reconciliation, payload));
  // The tree already matches the branch, so this is a moment the two agree.
  const syncBaseline = recordPullSync();
  if (isMachineOutput(args)) {
    writeJson({
      source: fetched.provenance,
      upToDate: true,
      files: fileCount,
      deleted: 0,
      removedEdited: [],
      rewrittenEdited: [],
      // The files no decode wrote are still there, and still the author's — the
      // same list a replacing pull reports, so the field means one thing.
      kept: kept.map((p) => `${backendDir}/${p}`),
      lockKept: reconciliation?.kept.length ?? 0,
      lockDropped: 0,
      lockRepinned: 0,
      lockRenamed: 0,
      workspaceSettings,
      seedRows,
      newFiles: [],
      droppedSeeds: [],
      keptDuplicates: duplicates,
      modulesReplaced: [],
      // Nothing was written, so there is nothing new to check.
      verified: null,
      syncBaseline,
    });
  }
  // On stderr, so a piped run says it too.
  success(`${backendDir}/ is already up to date with ${fetched.label} — nothing to replace.`);
  if (!isMachineOutput(args)) {
    reportKept(backendDir, kept);
    reportSuperseded(duplicates, [], backendDir, false);
  }
}

/** A table whose `seed:` rows in code a pull's rewrite drops, as `--json` reports it. */
export interface DroppedSeedReport {
  /** The table's name as its file declares it, or `null` when it could not be read off the file. */
  table: string | null;
  file: string;
  /**
   * `file` stays on disk (no decode wrote it) but the pulled tree declares the
   * table elsewhere, so it is no longer part of the project; `false` when the
   * pull rewrites or removes `file` itself.
   */
  kept: boolean;
  /** The pulled file that declares the table — where its `seed:` goes to keep it — or `null` when none does. */
  into: string | null;
}

/**
 * The code-authored seed rows a replace loses, table by table: a table whose
 * `seed:` a file declares today, where the pulled tree no longer carries one.
 *
 * Two ways to lose one. A file this pull rewrites or removes takes its seeds
 * with it. And a file it KEEPS (no decode wrote it — a table filed under
 * another name, `table/items.ts` declaring "stock") loses them too when the
 * pulled tree declares the same table in a file of its own: the rewritten
 * `index.ts` imports that file, so the kept one is no longer part of the
 * project (E2E pass 26: only the rewritten owners were named).
 *
 * Read off the text — the tree is about to be replaced, so there is no compile
 * to ask — which is enough to name the table and the file. Exported for tests.
 */
export function codeSeedsDropped(
  dirAbs: string,
  incoming: ReadonlyMap<string, string>,
  plan: DecodeReplacePlan,
  backendDir: string,
): DroppedSeedReport[] {
  // Every table the pulled tree declares, and whether any file seeds it.
  const pulled = new Map<string, boolean>();
  for (const text of incoming.values()) {
    for (const t of declaredTables(text)) {
      if (t.name !== null) pulled.set(t.name, (pulled.get(t.name) ?? false) || t.seeded);
    }
  }
  const out: DroppedSeedReport[] = [];
  const into = (table: string | null, own: string): string | null => {
    if (table === null) return incoming.has(own) ? `${backendDir}/${own}` : null;
    for (const [p, text] of incoming) if (declaredTables(text).some((t) => t.name === table)) return `${backendDir}/${p}`;
    return null;
  };
  const read = (p: string): string | undefined => {
    try {
      return readFileSync(join(dirAbs, p), "utf8");
    } catch {
      return undefined;
    }
  };
  for (const p of [...plan.edited, ...plan.rewrittenUnknown, ...plan.changedBySource, ...plan.removals]) {
    const current = read(p);
    if (current === undefined) continue;
    for (const t of declaredTables(current)) {
      if (!t.seeded) continue;
      // A name the text does not give is judged by its own file's replacement.
      const kept = t.name === null ? SEED.test(incoming.get(p) ?? "") : pulled.get(t.name) === true;
      if (!kept) out.push({ table: t.name, file: `${backendDir}/${p}`, kept: false, into: into(t.name, p) });
    }
  }
  for (const p of plan.kept) {
    const current = read(p);
    if (current === undefined) continue;
    for (const t of declaredTables(current)) {
      if (t.seeded && t.name !== null && pulled.get(t.name) === false) {
        out.push({ table: t.name, file: `${backendDir}/${p}`, kept: true, into: into(t.name, p) });
      }
    }
  }
  return out;
}

/** A `seed:` key — an inline array or rows imported from a file. */
const SEED = /\bseed\s*:/;

/**
 * The tables a file declares, each with whether its own `table({ … })` call
 * carries `seed:` — the text from one `table(` to the next is that call.
 */
function declaredTables(text: string): { name: string | null; seeded: boolean }[] {
  const starts = [...text.matchAll(/\btable\s*\(\s*\{/g)].map((m) => m.index);
  return starts.map((start, i) => {
    const chunk = text.slice(start, starts[i + 1] ?? text.length);
    const name = /\bname\s*:\s*(["'`])([^"'`]+)\1/.exec(chunk)?.[2];
    return { name: name ?? null, seeded: SEED.test(chunk) };
  });
}

/**
 * Say which code-authored seed rows the rewrite drops, before the confirmation
 * — one line per table, with the rows the source carries for it (a release cut
 * with `--seed`), and how to keep the code seed. A kept file's seed is still
 * on disk, so "restore it from git" did nothing for it (E2E pass 27): its
 * `seed:` is copied into the file the pulled tree declares the table in.
 */
function reportDroppedSeeds(
  dropped: readonly DroppedSeedReport[],
  seedRows: readonly SeedRowsReport[],
  fetched: { label: string; provenance: string },
  flags: string,
  inGit: boolean,
  /** No other table's rows are said after this, so this names where the rows it mentions stay. */
  saysLanding: boolean,
  /** The source is a release, the one source that can carry seed rows. */
  fromRelease: boolean,
): void {
  if (dropped.length === 0) return;
  const { label } = fetched;
  const one = dropped.length === 1;
  const rowsFor = (table: string | null): number | undefined => seedRows.find((s) => s.table === table)?.rows;
  const lines = dropped.map((d) => {
    const rows = rowsFor(d.table);
    // Not "carries no seed rows" of a live backend (E2E pass 28: said of a
    // tenant that holds rows): a pull never carries a backend's live rows.
    const carried =
      rows !== undefined
        ? `${label} carries ${rows} seed ${rows === 1 ? "row" : "rows"} for it, which a decoded tree does not hold either`
        : fromRelease
          ? `${label} carries no seed rows for it`
          : `a pull doesn't carry live rows, so none come from ${label}`;
    // Spelled from where the command was typed (E2E pass 28: from `frontend/`,
    // the `HEAD:./xano/…` path named `frontend/xano/…`). In that path, `./`
    // and `../` are relative to the working directory.
    const file = pastePath(d.file);
    const target = pastePath(d.into ?? d.file);
    const gitPath = file.startsWith("../") || file.startsWith("/") ? file : `./${file}`;
    const keep = d.kept
      ? `${file} stays on disk but is no longer part of the project — copy its \`seed:\` array into ${target} after the pull`
      : inGit
        ? `after the pull, copy its \`seed:\` array from \`git show HEAD:${gitPath}\` into ${target}`
        : `nothing here holds the current version — copy its \`seed:\` array out of ${file} before pulling, then into ${target}`;
    // A `seedFile(…)`/`hostedFile(…)` path resolves against the file that
    // declares it, so moving the array to another directory breaks it (E2E
    // pass 33: "no file at xano/table/seed/categories.json").
    const from = dirname(d.file);
    const to = dirname(d.into ?? d.file);
    const rebase =
      from === to
        ? ""
        : ` — its \`seedFile(…)\`/\`hostedFile(…)\` paths are relative to ${file}, so in ${target} prefix each ` +
          `relative one with \`${relative(to, from).split(sep).join("/")}/\` (\`./seed/x.json\` → ` +
          `\`${relative(to, join(from, "seed", "x.json")).split(sep).join("/").replace(/^(?!\.)/, "./")}\`)`;
    return `${d.table === null ? file : `${d.table} (${file})`}: ${carried}. To keep the code seed, ${keep}${rebase}.`;
  });
  warn(
    `${dropped.length} table${one ? " is" : "s are"} seeded in code, and the pulled tree drops ${one ? "that" : "each"} \`seed:\`:`,
    "pull.seeds-dropped",
    saysLanding && dropped.some((d) => rowsFor(d.table) !== undefined) ? [...lines, seedRowsLanding(fetched.provenance, flags)] : lines,
  );
}

/**
 * `--json`'s account of the project's workspace settings, as stderr gives it:
 * whether the project's `workspace.ts` was kept over the source's (a release
 * carries none), and which `workspaceConfig` keys the rewrite dropped from
 * `file`. A pull from a live backend takes its settings: `kept: false`, nothing
 * dropped.
 */
interface WorkspaceSettingsReport {
  kept: boolean;
  dropped: string[];
  file: string;
}

function settingsReport(settings: { kept: boolean; lost: string[]; from: string }, backendDir: string): WorkspaceSettingsReport {
  return { kept: settings.kept, dropped: settings.lost, file: `${backendDir}/${settings.from}` };
}

/** The decoded tree's workspace-settings file, as the decode places it. */
const WORKSPACE_SETTINGS_FILE = "workspace.ts";

/** The binding the decoded `index.ts` imports from it and registers. */
const WORKSPACE_SETTINGS_BINDING = "workspaceSettings";

/**
 * The export of `workspace.ts` that the project's `index.ts` registers as its
 * workspace config: `.registerWorkspace(<local>)`, with `<local>` imported from
 * `./workspace` — by name (`{ config }`, `{ config as cfg }`) or as its default.
 * `undefined` when the entry registers nothing imported from there, or when
 * `workspace.ts` does not export what it imports.
 */
export function registeredSettingsExport(index: string, settings: string): { name: string } | "default" | undefined {
  const local = /\.registerWorkspace\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(index)?.[1];
  if (local === undefined) return undefined;
  const imports = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']\.\/workspace(?:\.js|\.ts)?["']/g;
  for (const m of index.matchAll(imports)) {
    if (m[1] === local) return /\bexport\s+default\b/.test(settings) ? "default" : undefined;
    for (const spec of (m[2] ?? "").split(",")) {
      const [imported = "", as] = spec.trim().split(/\s+as\s+/);
      const name = imported.trim();
      if (name === "" || (as?.trim() ?? name) !== local) continue;
      const word = name.replace(/\$/g, "\\$");
      const exported = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${word}\\b|\\bexport\\s*\\{[^}]*\\b${word}\\b[^}]*\\}`);
      return exported.test(settings) ? { name } : undefined;
    }
  }
  return undefined;
}

/**
 * The decoded `index.ts` importing `binding` from the kept `workspace.ts` under
 * the name the decode registers — so the project's file, whatever it calls its
 * export, is what the entry registers.
 */
function importingKeptSettings(index: string, binding: { name: string } | "default"): string {
  if (binding !== "default" && binding.name === WORKSPACE_SETTINGS_BINDING) return index;
  const spec = binding === "default" ? WORKSPACE_SETTINGS_BINDING : `{ ${binding.name} as ${WORKSPACE_SETTINGS_BINDING} }`;
  return index.replace(
    /\bimport\s*\{\s*workspaceSettings\s*\}\s*from\s*(["']\.\/workspace\.js["'])/,
    (_m, from: string) => `import ${spec} from ${from}`,
  );
}

/**
 * The top-level entries of the object literal whose `{` is at `open`: each
 * key (`undefined` for a spread or a computed key, which name nothing
 * readable) and where its value starts.
 */
function literalEntries(text: string, open: number): Array<{ key: string | undefined; value: number }> {
  const entries: Array<{ key: string | undefined; value: number }> = [];
  let depth = 0;
  let key = true;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (depth === 1 && key) entries.push({ key: text.slice(i + 1, j), value: j + 1 });
      i = j;
      key = false;
    } else if (depth === 1 && key && text.startsWith("...", i)) {
      entries.push({ key: undefined, value: i + 3 });
      i += 2;
      key = false;
    } else if ("{[(".includes(c)) {
      if (depth === 1 && key && c === "[") entries.push({ key: undefined, value: i });
      key = ++depth === 1;
    } else if ("}])".includes(c)) {
      if (--depth === 0) break;
    } else if (depth === 1 && c === ",") {
      key = true;
    } else if (depth === 1 && key && /[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(text.slice(i))![0];
      entries.push({ key: word, value: i + word.length });
      i += word.length - 1;
      key = false;
    }
  }
  return entries;
}

/** Where the first `workspaceConfig({ … })` object literal in `text` opens, or -1. */
function settingsLiteral(text: string): number {
  const at = /\bworkspaceConfig\s*\(\s*\{/.exec(text);
  return at === null ? -1 : at.index + at[0].length - 1;
}

/**
 * The top-level keys of the first `workspaceConfig({ … })` object literal in
 * `text` — the decode's file, the project's, or an entry declaring it inline.
 */
function settingsKeys(text: string): string[] {
  const open = settingsLiteral(text);
  if (open < 0) return [];
  return literalEntries(text, open).flatMap((e) => (e.key === undefined ? [] : [e.key]));
}

/**
 * The env NAMES the first `workspaceConfig({ … })` in `text` declares — the
 * keys of its `env: { … }` literal — or `undefined` when they cannot be read
 * off the text: no literal, or an env that is a spread, a computed key or not
 * an object literal at all. `[]` for a config that declares no env.
 */
export function settingsEnvNames(text: string): string[] | undefined {
  const open = settingsLiteral(text);
  if (open < 0) return undefined;
  const entries = literalEntries(text, open);
  const env = entries.find((e) => e.key === "env");
  // No `env` key of its own: none declared — unless a spread may carry one.
  if (env === undefined) return entries.some((e) => e.key === undefined) ? undefined : [];
  const value = /^\s*:\s*\{/.exec(text.slice(env.value));
  if (value === null) return undefined;
  const names = literalEntries(text, env.value + value[0].length - 1);
  return names.some((e) => e.key === undefined) ? undefined : names.map((e) => e.key!);
}

/**
 * The env names the project's config declares before a pull — `workspace.ts`'s
 * `workspaceConfig({ env })` and one declared inline in `index.ts` — whichever
 * can be read off the text.
 */
/**
 * The env names the project's config declares, read off its text — or
 * `undefined` when no config literal is found, or one is found whose env cannot
 * be read off the text (a spread, a computed key). Unlike
 * {@link declaredEnvNames}, a readable config is the whole answer.
 */
export function readableDeclaredEnvNames(dirAbs: string): string[] | undefined {
  let found = false;
  const names: string[] = [];
  for (const name of [WORKSPACE_SETTINGS_FILE, "index.ts"]) {
    let text: string;
    try {
      text = readFileSync(join(dirAbs, name), "utf8");
    } catch {
      continue;
    }
    if (settingsLiteral(text) < 0) continue;
    const read = settingsEnvNames(text);
    if (read === undefined) return undefined;
    found = true;
    names.push(...read);
  }
  return found ? [...new Set(names)] : undefined;
}

export function declaredEnvNames(dirAbs: string): string[] {
  return [WORKSPACE_SETTINGS_FILE, "index.ts"].flatMap((name) => {
    try {
      return settingsEnvNames(readFileSync(join(dirAbs, name), "utf8")) ?? [];
    } catch {
      return [];
    }
  });
}

/**
 * The project's own `workspace.ts` — and the `.env.example` listing its env —
 * in place of what a release decodes.
 *
 * A release carries no workspace settings and no env: its decode is a name and
 * nothing else, so writing it replaced the project's canonical, documentation
 * gate, settings and env declarations with nothing (E2E passes 19, 20). Both
 * files are the project's: kept byte for byte, and recorded as this decode's.
 * Env names are never compared — the release has none to compare.
 *
 * A project with no `.env.example` of its own gets the template rendered from
 * the KEPT file's env names (names only), as `export` renders it — the decode's
 * said "declares no env vars" beside a `workspace.ts` declaring some, so the
 * next `export --check` failed (E2E pass 22). Names that cannot be read off the
 * text leave no template at all, which `export` leaves alone.
 *
 * Kept when the decode wrote a `workspace.ts` (so `index.ts` registers it) and
 * the project's `index.ts` registers an export of its own `workspace.ts`,
 * whatever that export is called (`registeredSettingsExport`); the decoded
 * `index.ts` then imports it under the decode's name. Otherwise the keys the
 * rewrite drops are returned to be named, with the file that held them — the
 * one `index.ts` REGISTERS: settings declared inline there are what the
 * project used, whatever an unregistered `workspace.ts` beside it says.
 */
function keepProjectSettings(
  files: ScaffoldFile[],
  backendDir: string,
  dirAbs: string,
): { files: ScaffoldFile[]; kept: boolean; lost: string[]; from: string; envNames?: string[] } {
  const incoming = files.find((f) => f.path === `${backendDir}/${WORKSPACE_SETTINGS_FILE}`);
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(dirAbs, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const ours = read(WORKSPACE_SETTINGS_FILE);
  const index = read("index.ts") ?? "";
  const binding = ours === undefined ? undefined : registeredSettingsExport(index, ours);
  if (incoming !== undefined && ours !== undefined && binding !== undefined) {
    const example = `${backendDir}/${WORKSPACE_ENV_EXAMPLE_BASENAME}`;
    const entry = `${backendDir}/index.ts`;
    const ourExample = read(WORKSPACE_ENV_EXAMPLE_BASENAME);
    const envNames = settingsEnvNames(ours);
    // The project's template, else one naming the kept file's env; else none.
    const exampleContent = (decoded: string): string | undefined =>
      ourExample ?? (envNames === undefined ? undefined : rerenderEnvExample(decoded, envNames));
    const out = files.flatMap((f): ScaffoldFile[] => {
      if (f === incoming) return [{ ...f, content: ours }];
      if (f.path === entry) return [{ ...f, content: importingKeptSettings(f.content, binding) }];
      if (f.path !== example) return [f];
      const content = exampleContent(f.content);
      return content === undefined ? [] : [{ ...f, content }];
    });
    return { files: out, kept: true, lost: [], from: WORKSPACE_SETTINGS_FILE, ...(envNames === undefined ? {} : { envNames }) };
  }
  // Nothing kept: what the project declared that the release's decode does not,
  // from the file whose config `index.ts` registers — inline there when it
  // declares one, else `workspace.ts`. A release has no env.
  const inline = binding === undefined && settingsLiteral(index) >= 0;
  const from = ours !== undefined && !inline ? WORKSPACE_SETTINGS_FILE : "index.ts";
  const theirs = new Set(incoming === undefined ? [] : settingsKeys(incoming.content));
  const lost = settingsKeys(from === "index.ts" ? index : (ours ?? "")).filter((k) => k === "env" || !theirs.has(k));
  return { files, kept: false, lost, from };
}

/**
 * The name the project's entry gives its workspace — `workspace("name")` — or
 * `undefined` when the entry is unreadable or names it some other way.
 */
export function projectWorkspaceName(entry: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(entry, "utf8");
  } catch {
    return undefined;
  }
  const m = /\bworkspace\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*[,)]/.exec(text);
  if (m === null) return undefined;
  const lit = m[1]!;
  try {
    const name = lit.startsWith('"') ? (JSON.parse(lit) as string) : lit.slice(1, -1);
    return name.trim() === "" ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * What did not come across, said as `init --from` says it: a warning or an
 * error is a loss (the headline counts it), notices alone are information.
 */
function reportFindings(project: ReturnType<typeof decodeBundle>, backendDir: string): void {
  const rendered = project.report.renderCli({ fileBase: `${backendDir}/` });
  if (rendered === "") return;
  const summary = project.report.summarize();
  if (summary.bySeverity.error + summary.bySeverity.warning > 0) {
    warn(`Not everything was carried into the tree — ${project.report.headline()} (listed below).`, "decode.findings");
  } else {
    info("Some values are deliberately not carried into the tree:");
  }
  process.stderr.write(`${terminalText(rendered)}\n`);
}

/** A pull whose written tree failed its round trip: exit 2, as `init --from`'s does. */
function pullVerifyFailed(cwd: string, backendDir: string): Error {
  return Object.assign(
    new Error(
      `Round-trip verification failed for ${join(cwd, backendDir)} — see the mismatches above. ` +
        `The files were written so you can inspect them; do not deploy them.`,
    ),
    { exitCode: 2 },
  );
}

/** The files in the backend no decode wrote: kept, and named, on every pull. */
function reportKept(backendDir: string, kept: readonly string[]): void {
  if (kept.length === 0) return;
  warn(
    `Kept ${kept.length} file${kept.length === 1 ? "" : "s"} in ${backendDir}/ no decode wrote — ` +
      `${kept.length === 1 ? "it is" : "they are"} yours, and not part of the decoded tree:`,
    "pull.kept-files",
    capped(kept.map((p) => `${backendDir}/${p}`)),
  );
}

/** A listing's detail lines: the first 20, then how many more. */
function capped(lines: readonly string[]): string[] {
  return [...lines.slice(0, 20), ...(lines.length > 20 ? [`… and ${lines.length - 20} more`] : [])];
}

/** The marker already in the tree, whose other fields a pull keeps; none is an empty record. */
function previousMarker(dir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, DECODE_MARKER), "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // None, or unreadable: a fresh record below.
  }
  return {};
}

/**
 * Say what the refresh did to the DECLARED env names, and what still has no
 * value.
 *
 * Without this a pull rewrites the source with a new name set while nothing
 * tells the user: `.env.example` changes silently, and — since a deploy replaces
 * the env set — a name the backend gained is declared nowhere they were told to
 * look. They would meet it as a refusal on their next deploy instead.
 *
 * `xano/.env` is READ here and never written or modified. The missing-value set
 * is not computable without reading it; no value is printed, and none is held
 * beyond this call.
 */
function reportEnvNameChanges(
  cwd: string,
  backendDir: string,
  before: readonly string[],
  after: readonly string[],
  remedy: (one: boolean) => string,
): void {
  const envFile = `${backendDir}/${WORKSPACE_ENV_BASENAME}`;
  const exampleFile = `${backendDir}/${WORKSPACE_ENV_EXAMPLE_BASENAME}`;
  const had = new Set(before);
  const has = new Set(after);
  const added = after.filter((n) => !had.has(n));
  const removed = before.filter((n) => !has.has(n));
  if (added.length > 0) {
    info(`Env vars added by this pull: ${added.join(", ")} (declared in ${exampleFile}).`);
  }
  if (removed.length > 0) {
    info(`Env vars no longer declared: ${removed.join(", ")}.`);
  }
  if (after.length === 0) return;

  const values = readWorkspaceEnvFile(join(cwd, envFile)) ?? {};
  const missing = after.filter((n) => !Object.hasOwn(values, n));
  if (missing.length === 0) return;
  warn(
    `${missing.length} declared env var${missing.length === 1 ? " has" : "s have"} no value in ${envFile}: ` +
      `${missing.join(", ")}. A deploy will refuse until ${missing.length === 1 ? "it does" : "they do"} — ${remedy(missing.length === 1)}`,
    "workspace-env.missing-values",
  );
}

/**
 * How to fill the missing values after THIS pull. A pull records no tracked
 * backend, so after `pull ephemeral:<n>` a bare `env pull` reads whatever the
 * project last deployed to — or nothing (E2E pass 22): a named source is named
 * again, with the run's credential flags. A release is a snapshot that carries
 * no env values, so there is no source to read them from.
 */
export function envFillRemedy(kind: string, args: ParsedArgs, one = false): string {
  const them = one ? "it" : "them";
  const raw = args.positionals[0];
  if (kind === "release") {
    return (
      `a release carries no env values, so fill ${them} in by hand, or read ${them} from a running ` +
      "backend with `xanosdk env pull --from <backend>`."
    );
  }
  const from = raw === undefined ? "" : ` --from ${shellQuote(raw)}`;
  // A Xano Engine is read with its own bearer: a credential flag there is refused.
  const flags = kind === "local" ? "" : contextFlags(args);
  return `fill ${them} in, or run \`xanosdk env pull${from}${flags}\`.`;
}

/**
 * A pull refusal `--yes` answers: the needs-confirmation failure every such
 * refusal carries (`details.reason`), naming this run with `--yes` as the
 * command to paste (E2E pass 30: "re-run with `--yes`").
 */
async function needsYes(
  args: ParsedArgs,
  head: string,
  why: string,
  details: Record<string, unknown>,
): Promise<CliError> {
  const { yesRerun } = await import("./retry-command.js");
  const { rerun, note } = yesRerun(args, "pull");
  return new CliError("SDK_USAGE", `${head} Re-run as \`${rerun}\` ${why}.${note}`, {
    exitCode: 1,
    details: { reason: "needs-confirmation", written: false, ...details },
  });
}
