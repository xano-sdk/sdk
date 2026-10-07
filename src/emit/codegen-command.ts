/**
 * `xanosdk init [dir] --from <source>` — pull a backend and write it as a
 * ready-to-run Xano SDK project.
 *
 *   --from workspace              your real workspace (the one your OAuth token
 *                                   is scoped to), `--branch` to read a branch
 *   --from ephemeral[:<name>]     an ephemeral; bare is the one this project
 *                                   last deployed to
 *   --from local[:<name>]  a Xano Engine; bare is the one recorded for
 *                                   this directory (no Xano credential)
 *   --from tenant:<name>          a tenant
 *   --from release:<name>         a release
 *   --from ./bundle.json          a bundle file already on disk (offline, no auth)
 *
 * All of them share one core: get a bundle, `decodeBundle` it, write the
 * project, then verify. Only the first step differs, and every running backend
 * and release takes it through the one archive fetch `deploy` and `generate`
 * use — so a spelling reads the same bytes whichever command named it. It is a
 * FLAG rather than a family of commands because this is `init` with `xano/`
 * filled from somewhere, not a separate kind of thing. See `init-command.ts`,
 * which parses the flag against its declared slot and hands the source over.
 *
 * **The output is a project, not a loose tree.** It is the same scaffold a bare
 * `xanosdk init` writes — root `package.json`, `tsconfig.json`, `frontend/`,
 * the `build`/`xano:deploy` scripts — with the decoded workspace filling
 * `xano/` instead of a starter. So a pull is immediately runnable:
 *
 *   xanosdk init my-app --from workspace && cd my-app && npm run xano:deploy
 *
 * **A re-run refreshes `xano/`; the project around it is left alone.** It
 * overwrites the files it decodes and keeps the ones no decode wrote, listing
 * and confirming first, which is why it needs no `--force` (the provenance
 * marker proves the directory was decoded) while a directory holding anything
 * else still does. A plain deploy is a full replace of an ephemeral; the
 * generated READMEs and the summary here say so, and name `promote` for a real
 * workspace.
 *
 * Verification runs by default: the project that was just written is
 * loaded, exported, and diffed against the source bundle under `normalize()`.
 * `--skip-roundtrip` skips it. See `codegen/verify.ts` for why a proof-carrying
 * decoder still needs it.
 *
 * Node-only (fetch/fs + OAuth); lazily imported by the command layer so the
 * browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { shellWord } from "./command-line.js";
import { pastePath } from "./typed-cwd.js";
import type { ParsedArgs } from "./cli.js";
import { loadDefault, readVersion } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { decodeBundle, type GeneratedProject } from "../codegen/index.js";
import { decodedCounts } from "../codegen/labels.js";
import { reportMismatches, verifyBundles } from "../codegen/verify.js";
import type { DecodeReport, ReportEntry } from "../codegen/report.js";
import { UsageError } from "./errors.js";
import { LocalFileNotFoundError } from "./bundle-input.js";
import type { ExportedBundle } from "../deploy/workspace-export.js";
import { assertBranchReadSupported, exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { listBranches, requireBranch } from "../deploy/branch.js";
import { archiveSeedContent, fetchSourceArchive } from "./deploy-source.js";
import { shellQuote } from "../util/shell-quote.js";
import { seedRowsByTableGuid } from "../workspace/seed.js";
import { contextFlags } from "./context-flags.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, refuseProfileForLocal } from "./tracked-backend.js";
import { recordSync, syncBranchLabel, type SyncTarget } from "./sync-record.js";
import { syncDigests } from "../deploy/sync-baseline.js";
import type { Source } from "./source-selector.js";
import { getEngineRecord } from "../deploy/local-engine-state.js";
import { detail, info, step, success, warn, blank, style, stdoutStyle, terminalText } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import {
  backendShellFiles,
  type BackendShell,
  deployNextCommand,
  ephemeralNextStep,
  loginNextStep,
  planProfilePin,
  projectCli,
  projectShellFiles,
  refuseFrontendOnlyFlags,
  resolveInitFrontend,
  runFiles,
  sanitizeAppName,
  settleClashes,
  templateVarsFor,
  reportWorkflowPlacement,
} from "./init-command.js";
import {
  adoptFromBundle,
  CANONICAL_PAYLOAD_KEYS,
  displayLockKey,
  createLockContext,
  emptyLock,
  mergeObserved,
  withObjects,
  type LockExportContext,
  type LockFile,
} from "../lock/lock.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";
import { planRouteManifest, RouteManifestError, ROUTES_MANIFEST_BASENAME } from "./routes-manifest.js";
import { renderManifestFile, reportModuleFailures, type ManifestModules } from "./routes-manifest-file.js";
import { setDiagnosticSink, type Diagnostic } from "../workspace/diagnostics.js";
import { resolveKnowledge } from "../workspace/knowledge.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { describeDecodeReplace, filesUnder, planDecodeReplace, planTouchesExisting, readDecodeRecord } from "./backend-tree.js";
import { resolveFrameworkValue, resolveFrontendPreset } from "./frontend-resolve.js";
import { detectPackageManager, installCommandFor } from "./package-manager.js";
import { resolveThemeChoice } from "./theme-resolve.js";
import {
  valueProblem,
  isRepresentableName,
  renderWorkspaceEnvExample,
  renderWorkspaceEnvFile,
  WORKSPACE_ENV_BASENAME,
  WORKSPACE_ENV_EXAMPLE_BASENAME,
  type EnvExampleName,
} from "./workspace-env.js";
import { ensureWorkspaceEnvGitignored, requireSecretPathGitignored, type IgnorePlacement } from "./gitignore.js";
import { atomicWrite } from "../util/atomic-write.js";
import { safeNames } from "../util/env-name.js";
import { displayPath } from "../util/rel-path.js";
import { readInstalledManifest } from "./module-manifest.js";
import { detectInstallMode } from "./update-check.js";
import { SDK_MODULE } from "../codegen/context.js";
import {
  SECRETS_FILE_VERSION,
  workspaceSecretsPathIn,
  writeSecretsFile,
} from "./secrets-file.js";
import {
  changedOnDisk,
  CODEGEN_MARKER,
  decideOverwrite,
  isNonEmptyDir,
  MERGED_IN_EXISTING,
  plannedAgentsMd,
  PRESERVED_ON_REFRESH,
  SHELL_FILES_IN_BACKEND,
  scaffoldProject,
  XANO_DIR,
  type InstallOutcome,
  type ScaffoldFile,
} from "./scaffold.js";
import {
  BACKEND_TSCONFIG_PATH,
  describeOrigin,
  codegenLanding,
  renderCodegenMarker,
  renderCodegenReadme,
  type CodegenOrigin,
  type TemplateVars,
} from "./init-templates.js";

/**
 * Where to read the bundle from — `--from`, already parsed against its slot.
 *
 * Every kind of the selector grammar that `init --from` declares: the running
 * backends, a release, and a bundle file. The kinds that need an identifier
 * carry it, so nothing downstream reaches back into `positionals` for half of
 * its own source. `init` owns exactly one positional — the target directory —
 * whatever the source is.
 */
export type CodegenSource = Source;

/** Why each kind has no branch to choose, for the `--branch` refusal. */
const NO_BRANCH: Record<Exclude<CodegenSource["kind"], "workspace">, string> = {
  ephemeral:
    "an ephemeral environment holds the logic it was deployed with, not a branch you can " +
    "choose between afterwards — deploy from the branch you want, then read the ephemeral",
  "local":
    "a Xano Engine holds the logic it was deployed with, not a branch you can choose between " +
    "afterwards — deploy from the branch you want, then read the engine",
  tenant:
    "a tenant runs the release it was deployed with, not a branch you can choose between",
  release: "a release is one archive already cut from one branch — cut another from the branch you need",
  file:
    "a bundle file is one archive that was already exported from one branch — re-export it " +
    "with `--branch` if you need a different one",
};

/**
 * `--branch` against a source that has no branches.
 *
 * Rejected rather than ignored, because ignoring it is the exact defect this
 * flag was added to fix: a silently dropped `--branch` returns a complete,
 * plausible project tree for something other than what was asked for, and
 * reports success. Only the workspace holds branches; every other source is
 * built from ONE branch's logic and cannot be re-pointed after the fact.
 */
function assertBranchMatchesSource(args: ParsedArgs, source: CodegenSource): void {
  if (args.branch === undefined || source.kind === "workspace") return;
  throw new UsageError(
    `\`--branch\` does not apply to \`--from ${source.kind}\`: ${NO_BRANCH[source.kind]}.\n` +
      `Drop \`--branch\`, or use \`--from workspace\` to read a branch of your real workspace.`,
    { helpFor: { command: "init" } },
  );
}

/** A bundle plus what identifies where it came from, for the marker and README. */
interface SourcedBundle {
  readonly bundle: ExportedBundle;
  readonly origin: CodegenOrigin;
  /** Whether the read resolved a credential — a Xano Engine's and a file's do not. */
  readonly credentialRead?: boolean;
  /** The seed rows the archive carries (a release cut with `--seed`), which the tree does not. */
  readonly seed?: { rows: SeedRowsReport[]; label: string; provenance: string };
  /** The workspace branch read, for its sync baseline. Only for a workspace whose branch label is known. */
  readonly syncTarget?: SyncTarget;
}

/**
 * Read the bundle for a running backend or a release.
 *
 * Through the archive fetch `deploy` and `generate` share, so `--from
 * tenant:acme` reads exactly what `generate tenant:acme` would. The one arm of
 * its own is the workspace, whose `--branch` probe that fetch does not carry.
 *
 * The credential is a provider, read only for a hosted kind: a Xano Engine is
 * exported through its own bearer, so a signed-out developer can pull one.
 */
async function fetchBundle(
  args: ParsedArgs,
  source: Exclude<CodegenSource, { kind: "file" }>,
): Promise<SourcedBundle> {
  let credentialRead = false;
  const credential = memoCredential(() => ((credentialRead = true), getAccessToken(args)));
  if (source.kind === "workspace") {
    const auth = await credential();
    // The `step` lines belong to fetchWorkspaceBundle, which also owns the
    // branch probe that has to run before them.
    const bundle = await fetchWorkspaceBundle(auth, args.branch);
    const branch = await syncBranchLabel(auth, args.branch);
    return {
      bundle,
      origin: { source: "workspace", origin: String(auth.workspaceId), ...(args.branch === undefined ? {} : { branch: args.branch.trim() }) },
      credentialRead,
      ...(branch === undefined ? {} : { syncTarget: { instance: auth.instance, workspaceId: auth.workspaceId, branch } }),
    };
  }
  // A bare tracked source (`local`, `ephemeral`) is the one recorded for
  // the PROJECT this run stands in — its root, from a subdirectory of it. Only
  // the lookup moves; the target directory stays relative to where it was typed.
  const { projectDirFrom } = await import("./xanosdk-project.js");
  const cwd = projectDirFrom(process.cwd()) ?? process.cwd();
  // Spelled back from the parsed source, so the fetch parses exactly the value
  // this command already accepted.
  const raw = "name" in source && source.name !== undefined ? `${source.kind}:${source.name}` : source.kind;
  step(`Reading ${raw}`);
  const fetched = await fetchSourceArchive(credential, raw, cwd);
  const bundle = decodeWorkspaceArchive(fetched.archive) as ExportedBundle;
  return {
    bundle,
    origin: { source: source.kind, origin: originName(source, fetched.provenance, cwd) },
    credentialRead,
    seed: {
      rows: carriedSeedRows(fetched.archive, (bundle.payload ?? {}) as Record<string, unknown>),
      label: fetched.label,
      provenance: fetched.provenance,
    },
  };
}

/**
 * What names the source in the marker and README: the ephemeral, tenant,
 * release or engine name.
 *
 * Read off the resolved provenance (`ephemeral:e4f2`), which carries the name
 * a bare `ephemeral` resolved to. A bare `local` provenance carries no
 * name, so it is the engine recorded for this directory — the record the
 * resolver itself read.
 */
function originName(source: Exclude<CodegenSource, { kind: "file" | "workspace" }>, provenance: string, cwd: string): string {
  const colon = provenance.indexOf(":");
  if (colon !== -1) return provenance.slice(colon + 1);
  if (source.kind === "local") return getEngineRecord(cwd)?.name ?? "local";
  return provenance;
}

/**
 * Read the caller's real workspace.
 *
 * The workspace id is the one the credential is bound to — never a hard-coded 1
 * (instances number workspaces from their own sequence) and never a flag.
 */
export async function fetchWorkspaceBundle(
  auth: ResolvedAuth,
  typedBranch?: string,
): Promise<ExportedBundle> {
  const workspaceId = auth.workspaceId;
  let branch = typedBranch;
  if (branch !== undefined) {
    assertReadableBranchLabel(branch);
    // Cheapest question first: a typo is the likeliest reason a branch read
    // fails, and `requireBranch` answers it with the list of labels that DO
    // exist. Without it the engine's own refusal — a bare 500 "Invalid branch" —
    // is the whole error, and it names neither the workspace nor the
    // alternatives. The label read is the one the workspace STORES — a typed
    // `" staging "` resolves to `staging` — since the engine matches exactly.
    step(`Resolving branch "${branch}"`);
    branch = requireBranch(await listBranches(auth, { baseUrl: auth.instance, workspaceId }), branch).label;
    // Then the capability question, BEFORE the read rather than after it: an
    // instance that ignores the parameter would otherwise hand back a complete
    // live-branch bundle, and every later step — the decode, the project tree,
    // the success line — would describe it as the branch that was asked for.
    await assertBranchReadSupported(auth, { base: auth.instance, workspaceId, branch });
  }
  step(
    branch === undefined
      ? `Reading workspace ${workspaceId}`
      : `Reading workspace ${workspaceId} on branch "${branch}"`,
  );
  return exportWorkspaceBundle(auth, {
    base: auth.instance,
    workspaceId,
    label: "workspace export",
    ...(branch !== undefined ? { branch } : {}),
  });
}

/**
 * A branch label the read side will not send.
 *
 * Deliberately NOT `assertUsableBranchLabel`, which the release path uses: that
 * one also rejects the default branch's label, because WRITING to it is a
 * production cutover wearing the clothes of a staged release. Reading it is an
 * ordinary request — "give me the default branch" — and refusing it here would
 * deny a safe operation on the strength of a rule about a dangerous one.
 *
 * The empty label is still refused, for the reason it always was: it is the
 * wire value meaning "whichever branch is live", so accepting it from a caller
 * who typed `--branch` would answer a question they did not ask.
 */
function assertReadableBranchLabel(label: string): void {
  if (label.trim() !== "") return;
  throw new UsageError(
    "`--branch` needs a branch label and was given an empty one.\n" +
      "An empty label is the wire value for \"whichever branch is live\", so it would read live " +
      "while looking like a branch was named. Drop `--branch` to read live deliberately.",
  );
}

/** Read and parse a bundle JSON file, with errors a user can act on. */
export function readBundleFile(path: string): ExportedBundle {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new LocalFileNotFoundError(`No bundle file at "${absolute}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch {
    throw new UsageError(
      `"${absolute}" is not valid JSON. Pass a bundle written by \`xanosdk export\` or \`xanosdk workspace export\`.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || !("payload" in parsed)) {
    throw new UsageError(
      `"${absolute}" has no \`payload\` — it is not a Xano bundle. ` +
        `Pass a bundle written by \`xanosdk export\` or \`xanosdk workspace export\`.`,
    );
  }
  return parsed as ExportedBundle;
}

/** The generated files that are not source, and where each belongs in a project. */
const GENERATED_TSCONFIG = "tsconfig.json";
const GENERATED_README = "README.md";

/**
 * Refuse a decode whose source repeats one guid across records that are not the
 * same object — before anything is written. Such an archive cannot produce a
 * correct tree: the next `export` of it fails with `Duplicate object guid`. The
 * decode report already names both records and where they differ, so the
 * refusal carries the remedy. Shared by every command that writes a decoded
 * tree (`init --from`, `generate`, `pull`) so none of them writes one it will
 * then refuse to build.
 */
export function refuseDuplicateSourceGuids(project: GeneratedProject): void {
  const duplicateGuids = project.report
    .summarize()
    .byCategory.find((g) => g.category === "duplicate-source-guid");
  if (duplicateGuids === undefined) return;
  throw new Error(
    `The source carries ${duplicateGuids.count} ` +
      `${duplicateGuids.count === 1 ? "pair of objects that share" : "sets of objects that share"} ` +
      `one guid but are not the same object:\n` +
      duplicateGuids.entries.map((e) => `  • ${e.detail}`).join("\n") +
      `\nNothing was written. These records come from the archive, not from anything you authored, ` +
      `so renaming an object or pinning a new guid here would repoint references rather than fix it — ` +
      `the repeat has to be resolved in the workspace this was exported from.`,
  );
}

/**
 * Map the decoded tree into project-relative scaffold files.
 *
 * `decodeBundle` emits paths relative to wherever the tree is put — `index.ts`,
 * `_shared.ts`, `functions/signup.ts` — because it is pure and offline and has
 * no reason to know about a project layout. Placing it is the command's job:
 *
 * - Everything gains the BACKEND DIRECTORY's prefix.
 * - The generated `tsconfig.json` is dropped. The project's root tsconfig
 *   already covers the backend, and two tsconfigs in one project is a trap.
 *   (The generated one sets `verbatimModuleSyntax`, which the root does not —
 *   that direction is safe, since the printer already separates type-only
 *   imports.)
 * - The generated `README.md` — the decode report — becomes the backend's
 *   `README.md`, next to the code it describes, leaving the root README for the
 *   project.
 *
 * `backendDir` is that prefix: a project-relative POSIX directory name,
 * defaulting to the `xano/` the scaffold writes. `init --from` is CREATING the
 * layout, so it takes the default and decides; `pull` refreshes a project that
 * already chose one, so it passes what that project uses. The parameter is what
 * makes those two answers one answer — this function is shared precisely so the
 * two commands cannot disagree about where a refreshed tree goes, and a
 * hardcoded prefix here would have re-introduced the disagreement one level
 * down.
 *
 * `displayDir` is how the generated `.env.example` names that directory to its
 * reader — the prefix itself unless the caller places the files under a root of
 * its own (`generate --out`, which passes an empty prefix), where only the
 * caller knows what the directory is called.
 */
export function placeGeneratedFiles(
  project: GeneratedProject,
  backendDir: string = XANO_DIR,
  displayDir: string = backendDir || XANO_DIR,
  /**
   * Where the route manifest's refusal is reported: `entry` spelled as the user
   * pastes it (from their cwd, not the project root), and `deferred` collecting
   * the line so the caller prints it AFTER its "wrote N files" report rather
   * than ahead of the write it describes. Omitted, it warns on the spot.
   */
  routes?: { entry: string; deferred: string[] },
  /**
   * The toolchain modules of the project the tree is placed into, and the
   * route manifest it is replacing, so the manifest carries each module's
   * section exactly as `routes --emit` would write it there — and a module that
   * fails keeps its previous block rather than the file losing it. Discovered
   * by the caller, before any entry is loaded; omitted (`init --from`, a
   * `generate --out` no project holds), the manifest has no module sections.
   */
  modules?: ManifestModules,
): ScaffoldFile[] {
  const out: ScaffoldFile[] = [
    // Generated from the names the source declares, and therefore placed HERE
    // rather than at either call site: `init --from` and `pull` must not be able
    // to disagree about whether a refreshed tree documents its own env vars.
    {
      path: `${backendDir}/${WORKSPACE_ENV_EXAMPLE_BASENAME}`,
      // BACKEND names only. A documentation token has no env var name to list —
      // it is addressed by the object that holds it and stored in the sidecar
      // beside it, which the SDK writes and nobody fills in by hand.
      content: renderWorkspaceEnvExample(envExampleNames(project.env), displayDir),
    },
  ];
  for (const file of project.files) {
    if (file.path === GENERATED_TSCONFIG) continue;
    const path =
      file.path === GENERATED_README
        ? `${backendDir}/${GENERATED_README}`
        : `${backendDir}/${file.path}`;
    out.push({ path, content: file.contents });
  }
  // The route manifest the scaffold's `xano:routes` script writes, from the
  // same payload the tree was decoded from and through the same planner
  // `routes --emit` uses — so the committed file is the one `routes --emit
  // --strict` (the scaffold's `xano:check`) reproduces, and a `pull` refreshes
  // it instead of listing it for deletion. A workspace with no endpoint gets
  // none; one whose manifest cannot be written (a canonical resolving nowhere, a
  // verb+name shared across groups) gets none and a warning saying why.
  const manifest = routeManifestFor(project.source, routes?.entry ?? `${displayDir}/index.ts`, routes?.deferred, modules);
  if (manifest !== undefined) out.push({ path: `${backendDir}/${ROUTES_MANIFEST_BASENAME}`, content: manifest });
  return out;
}

/**
 * The route manifest for a decoded payload, or `undefined` when `routes --emit`
 * would write none. When it cannot be rendered, the file it replaces
 * (`modules.previous`), unchanged, if there is one.
 */
export function routeManifestFor(
  payload: Readonly<Record<string, unknown>>,
  entry?: string,
  deferred?: string[],
  modules?: ManifestModules,
): string | undefined {
  try {
    const file = renderManifestFile(planRouteManifest(payload), modules, entry === undefined ? {} : { entry });
    if (file === undefined) return undefined;
    reportModuleFailures(file.failed, ROUTES_MANIFEST_BASENAME);
    return file.source;
  } catch (err) {
    if (!(err instanceof RouteManifestError)) throw err;
    // The file being replaced comes back unchanged rather than absent: a decode
    // lists a recorded file it did not produce for deletion, and a module block
    // that could not be carried forward is no reason to lose the whole manifest.
    const kept = modules?.previous;
    // Never a silent skip: the scaffold's `xano:check` would fail on the missing
    // (or stale) file with nothing saying why.
    const line =
      kept === undefined
        ? `${ROUTES_MANIFEST_BASENAME} was not written: ${err.message}`
        : `${ROUTES_MANIFEST_BASENAME} was not refreshed and was kept as it was: ${err.message}`;
    if (deferred === undefined) warn(line, "routes.not-written");
    else deferred.push(line);
    return kept;
  }
}

/**
 * The declared names, plus whether each value can live in `xano/.env` at all.
 *
 * The flag is derived HERE, from values that exist only in this process, and the
 * renderer receives the flag rather than the value. That split is what makes it
 * impossible for a secret to reach the committed template.
 */
export function envExampleNames(env: Readonly<Record<string, string>>): EnvExampleName[] {
  return Object.entries(env).map(([name, value]) => {
    // A name the format cannot carry is as unwritable as a value it cannot
    // carry, and for the same reason — the template's `# NAME=` line has to
    // parse back as the name it claims.
    const problem = !isRepresentableName(name) ? "name" : valueProblem(value);
    return { name, representable: problem === undefined, ...(problem === undefined ? {} : { problem }) };
  });
}

/**
 * Load the project that was just written and export it, so it can be diffed
 * against the bundle it came from. Uses the same TS-loading path as every other
 * command, so a generated tree is loaded exactly the way `xanosdk deploy` will.
 */
async function reexport(
  out: string,
  env: Readonly<Record<string, string>>,
  documentationTokens: Readonly<Record<string, { value: string }>>,
  lock?: LockExportContext,
  backendDir: string = XANO_DIR,
  accepted?: Diagnostic[],
): Promise<unknown> {
  const entry = join(out, backendDir, "index.ts");
  const registry = (await loadDefault(entry)) as
    | {
        export?: (args?: {
          envOverrides?: Record<string, string>;
          documentationTokens?: Record<string, string>;
          lock?: LockExportContext;
          knowledge?: ReturnType<typeof resolveKnowledge>;
          accepted?: Diagnostic[];
        }) => unknown;
        knowledge?: () => Parameters<typeof resolveKnowledge>[0];
      }
    | undefined;
  if (typeof registry?.export !== "function") {
    throw new Error(
      `The generated tree at "${entry}" did not default-export a workspace registry — cannot verify it.`,
    );
  }
  // The values IN MEMORY, never on disk. The generated source declares the env
  // names as empty placeholders, so without them the re-export's `payload.env`
  // would carry `""` where the bundle carries a secret and the round trip would
  // report a difference the tree does not have.
  // Documentation tokens ride the same in-memory path and for the same reason:
  // the generated source declares the GATE and carries no value, so without them
  // the re-export would emit no `documentation` block where the bundle carries a
  // real gate — and the round trip would report a difference the tree does not
  // have, on exactly the workspaces this feature exists for.
  //
  // Keyed by scope, which is also what proves the two sides agree: these keys
  // come from the pulled payload's guids, and `export()` looks them up from the
  // guids the generated source re-registers. A mismatch would surface here as a
  // round-trip failure rather than as a token that silently stops being found.
  const tokens = Object.fromEntries(
    Object.entries(documentationTokens).map(([key, entry]) => [key, entry.value]),
  );
  // Knowledge bodies and reference files, read from the tree the way every
  // bundle-producing command reads them (`export()` itself is browser-safe and
  // reads no files). Without them every knowledge item re-exported with an
  // empty `content` and no `knowledge_file` rows, and the round trip of any
  // workspace carrying knowledge failed on bytes the tree does have.
  const knowledge = typeof registry.knowledge === "function" ? resolveKnowledge(registry.knowledge()) : [];
  return registry.export({
    ...(Object.keys(env).length > 0 ? { envOverrides: { ...env } } : {}),
    ...(Object.keys(tokens).length > 0 ? { documentationTokens: tokens } : {}),
    ...(lock === undefined ? {} : { lock }),
    ...(knowledge.length > 0 ? { knowledge } : {}),
    ...(accepted === undefined ? {} : { accepted }),
  });
}

/**
 * Run `fn` with the export warnings it raises collected as well as printed, so
 * a verified round trip can still say what `--strict` refuses in the tree.
 */
async function collectingWarnings<T>(
  fn: (accepted: Diagnostic[]) => Promise<T>,
): Promise<{ value: T; warnings: Diagnostic[]; accepted: Diagnostic[] }> {
  const warnings: Diagnostic[] = [];
  const accepted: Diagnostic[] = [];
  const previous = setDiagnosticSink((d) => {
    if (d.severity === "warning") warnings.push(d);
    previous(d);
  });
  try {
    return { value: await fn(accepted), warnings, accepted };
  } finally {
    setDiagnosticSink(previous);
  }
}

/**
 * Say which warnings a decoded tree carries that its `xano:check` (`--strict`)
 * fails on, with the `diagnostics.allow` that accepts each def's. A decode
 * accepts only the advisory codes; these are shapes the pulled workspace really
 * has, so the choice to fix or accept them is the author's. A def the decode
 * already wrote an allow on is given the MERGED list, to replace that entry —
 * a second `diagnostics` key would be a duplicate property. Returns the count.
 */
export function reportStrictWarnings(
  warnings: readonly Diagnostic[],
  backendDir: string,
  context: { readonly accepted?: readonly Diagnostic[]; readonly report?: DecodeReport } = {},
): number {
  if (warnings.length === 0) return 0;
  const keyOf = (s: { kind: string; name: string }): string => `${s.kind}\u0000${s.name}`;
  // What each def's generated `diagnostics.allow` already accepts.
  const existing = new Map<string, string[]>();
  for (const a of context.accepted ?? []) {
    if (a.subject === undefined) continue;
    const codes = existing.get(keyOf(a.subject)) ?? [];
    if (!codes.includes(a.code)) codes.push(a.code);
    existing.set(keyOf(a.subject), codes);
  }
  const bySubject = new Map<string, { kind: string; name: string; codes: string[] }>();
  const loose: string[] = [];
  for (const w of warnings) {
    if (w.subject === undefined) {
      if (!loose.includes(w.code)) loose.push(w.code);
      continue;
    }
    const key = keyOf(w.subject);
    const entry = bySubject.get(key) ?? { kind: w.subject.kind, name: w.subject.name, codes: [] };
    if (!entry.codes.includes(w.code)) entry.codes.push(w.code);
    bySubject.set(key, entry);
  }
  const n = warnings.length;
  const line = ({ kind, name, codes }: { kind: string; name: string; codes: string[] }): string => {
    const label = `${kind} "${name}"`;
    const located = context.report?.fileOf(`${kind}:${name}`);
    const file = located === undefined ? undefined : `${backendDir}/${located}`;
    const had = existing.get(keyOf({ kind, name })) ?? [];
    const merged = [...had, ...codes.filter((c) => !had.includes(c))];
    const allow = `diagnostics: { allow: [${merged.map((c) => JSON.stringify(c)).join(", ")}] }`;
    if (had.length === 0) return `${label}${file === undefined ? "" : ` (${file})`}: ${allow}`;
    return `${label}: replace the \`diagnostics\` entry ${file === undefined ? "its generated def" : file} already carries with ${allow}`;
  };
  warn(
    `${backendDir}/ carries ${n} export warning${n === 1 ? "" : "s"} (printed above) that \`npm run xano:check\` ` +
      `fails on — it exports with \`--strict\`. They are shapes the source really has, so fix each or accept ` +
      `it on its def:`,
    "init.strict-warnings",
    [
      ...[...bySubject.values()].map(line),
      ...(loose.length > 0 ? [`not tied to one def (fix in source): ${loose.join(", ")}`] : []),
    ],
  );
  return n;
}

/** The workspace settings a release pull keeps from the project's own `workspace.ts`. */
const KEPT_SETTING_KEYS: ReadonlySet<string> = new Set(["canonical", "description", "swagger", "settings", "documentation"]);

/**
 * `pull`'s round trip: the check `init --from` runs, over the backend a pull
 * just rewrote. `true`/`false` is the verdict (mismatches folded into the
 * decode report); `null` is a tree that could not load for want of its
 * dependencies, which is not the tree's fault and is said as such.
 */
export async function verifyPulledTree(
  cwd: string,
  backendDir: string,
  project: {
    readonly source: Record<string, unknown>;
    readonly env: Readonly<Record<string, string>>;
    readonly documentationTokens: Readonly<Record<string, { value: string }>>;
    readonly report: DecodeReport;
  },
  source: string,
  /** The pull kept the project's own `workspace.ts`: its settings are the project's, not the source's. */
  keptSettings = false,
): Promise<boolean | null> {
  let payload = project.source;
  const ws = payload.workspace;
  if (keptSettings && ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
    // Taken out of the source, so the tree's are its own rather than a difference.
    const carried = Object.fromEntries(Object.entries(ws).filter(([k]) => !KEPT_SETTING_KEYS.has(k)));
    payload = { ...payload, workspace: carried };
  }
  try {
    const collected = await collectingWarnings((accepted) =>
      reexport(cwd, project.env, project.documentationTokens, undefined, backendDir, accepted),
    );
    let regenerated = collected.value;
    const into = (regenerated as { payload?: Record<string, unknown> } | undefined)?.payload;
    if (keptSettings && into !== undefined) {
      // The kept file declares the env too: the project's names, not the source's.
      regenerated = { ...(regenerated as object), payload: { ...into, env: payload.env } };
    }
    const result = verifyBundles({ payload }, regenerated, { source });
    reportMismatches(project.report, result);
    if (result.ok) reportStrictWarnings(collected.warnings, backendDir, { accepted: collected.accepted, report: project.report });
    return result.ok;
  } catch (err) {
    const missing = missingDependency(err);
    if (missing !== undefined) {
      // Named by what is missing (E2E pass 30: "its dependencies are not
      // installed. Run `npm install`" when only `tsx` was — and an install
      // that does not add it changes nothing).
      warn(
        `Could not check that ${backendDir}/ round-trips — ` +
          (missing === "tsx"
            ? `loading its TypeScript entry needs \`tsx\`, which is not installed. Run \`npm i -D tsx\``
            : `its dependencies are not installed. Run \`npm install\``) +
          `, then \`xanosdk export ${backendDir}/index.ts --check\`.`,
        "pull.unverified",
      );
      return null;
    }
    project.report.add(verifyCrashEntry(err, join(cwd, backendDir)));
    return false;
  }
}

/**
 * Write the documentation tokens a pull brought down, or say why it did not.
 *
 * The one place in the pull path that writes a secret, and the whole reason the
 * round trip works without a manual step: without this, a pulled tree declares
 * gates whose values live only in the Xano dashboard, and the user has to go
 * copy each one across by hand before the first deploy.
 *
 * Three ways it declines, and each reports rather than failing the command. The
 * tree that just landed is correct either way — it simply carries no tokens, and
 * a later `deploy` refuses rather than clearing a live gate, which is the safe
 * end of the failure.
 *
 * The ignore check GATES the write (see `requireSecretPathGitignored`). A secret
 * at an untracked-but-unignored path is one `git add -A` from being committed,
 * which is the failure this whole line of work exists to prevent.
 */
export function writeDocumentationTokens(
  out: string,
  tokens: Readonly<Record<string, { value: string; label: string; gated?: boolean }>>,
  args: ParsedArgs,
  /** Where these came from, as a line of the file's own provenance record. */
  provenance: string,
  /**
   * The sidecar to write, when the caller has already resolved it. `pull`
   * passes it because it resolved the backend directory once and everything
   * downstream must use that answer; `init --from` omits it, since the tree it
   * just wrote is the scaffold's.
   */
  secretsPath: string = workspaceSecretsPathIn(out),
  /** Where the ignore rule goes, when the sidecar's own layout cannot say (`generate --out`). */
  ignorePlacement?: IgnorePlacement,
): void {
  const scopes = Object.keys(tokens);
  if (scopes.length === 0) return;
  if (args.noSecrets) {
    // Only a GATED scope (`require_token: true`) makes a deploy refuse — the
    // deploy counts nothing else. A fresh workspace stores a token with the gate
    // off, and telling its author a deploy will refuse sends them after a value
    // nothing needs.
    const gated = scopes.filter((k) => tokens[k]!.gated !== false).length;
    const ungated = scopes.length - gated;
    warn(
      `Documentation tokens: ${scopes.length} found and NOT written (--no-secrets). ` +
        (gated > 0
          ? `The tree declares ${gated === 1 ? "a gate" : `${gated} gates`}; a deploy will refuse until ` +
            `${gated === 1 ? "its value is" : "their values are"} supplied with \`--doc-token\` or \`--secrets-file\`.` +
            (ungated > 0 ? ` ${ungated} more ${ungated === 1 ? "is" : "are"} stored with \`require_token: false\` — not a gate, and not needed to deploy.` : "")
          : `${scopes.length === 1 ? "It is" : "Each is"} stored with \`require_token: false\` — the documentation is not gated, and a deploy does not need ${scopes.length === 1 ? "it" : "them"}.`),
      "doc-token.not-written",
    );
    return;
  }
  try {
    requireSecretPathGitignored(secretsPath, { command: "pull" }, ignorePlacement);
  } catch (err) {
    warn(
      `Documentation tokens: ${scopes.length} found and NOT written — ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `The tree is fine and declares the gate${scopes.length === 1 ? "" : "s"}; fix the ignore ` +
        `rule and pull again, or supply the value${scopes.length === 1 ? "" : "s"} at deploy time.`,
      "doc-token.not-written",
    );
    return;
  }
  try {
    writeSecretsFile(secretsPath, {
      version: SECRETS_FILE_VERSION,
      pulledFrom: { instance: provenance, at: new Date().toISOString() },
      // The sidecar holds the value and its label; `gated` is the source's
      // `require_token`, which the tree already declares.
      documentationTokens: Object.fromEntries(
        Object.entries(tokens).map(([k, t]) => [k, { value: t.value, label: t.label }]),
      ),
    });
  } catch (err) {
    // The tree already landed. A full disk or an unwritable `xano/` must not
    // turn a completed pull into a non-zero exit reporting a raw OS error — the
    // two declines above both say "the tree is fine", and this one is no
    // different from the user's side.
    warn(
      `Documentation tokens: ${scopes.length} found and NOT written — ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `The tree is fine and declares the gate${scopes.length === 1 ? "" : "s"}; fix the write ` +
        `error and pull again, or supply the value${scopes.length === 1 ? "" : "s"} at deploy time.`,
      "doc-token.not-written",
    );
    return;
  }
  // Said out loud on every pull, on the same channel the microservice registry
  // credential uses. A secret landing on disk is worth a line every time — the
  // whole class of defect this closes is the kind that happens quietly.
  warn(
    `Documentation tokens: wrote ${scopes.length} to \`${displayPath(secretsPath)}\` — ` +
      `${safeNames(Object.values(tokens).map((t) => t.label))}. That file is SECRET MATERIAL and ` +
      `is gitignored; it is not committed, so a teammate's clone and CI both need ` +
      `\`--secrets-file\` or \`--doc-token\` instead.`,
    "secrets.doc-token-written",
  );
}

/**
 * The backend env VALUES a bundle carried, written to the new project's
 * `xano/.env` — owner-only, gitignored, exactly as `env pull` writes it.
 *
 * `init --from` used to declare the names in `workspace.ts` and drop the values
 * without a word, so the project's first deploy refused on names nobody had
 * been told were empty. The user handed us the bundle; the values in it are
 * theirs to keep, the same way its documentation tokens land in
 * `.secrets.json`. `--no-secrets` declines both, and says so.
 *
 * An EMPTY value is written too, as `NAME=`: the bundle stores the name as
 * empty, and a deploy reads `NAME=` as supplied-empty — so the round trip keeps
 * it empty instead of refusing it as unsupplied. An existing `xano/.env` (a
 * re-run) is never replaced here — that is `env pull`'s job, behind its
 * confirmation.
 */
export function writeBundleEnvValues(
  out: string,
  env: Readonly<Record<string, string>>,
  args: ParsedArgs,
  provenance: string,
  kind: CodegenOrigin["source"],
  /**
   * Where the tree's `.env` goes when it is not `<out>/xano/` — `generate`
   * writes a bare tree at `--out` — with the path as the reader names it, the
   * command that writes it, and where its ignore rule is placed.
   */
  at?: { dir: string; rel: string; command: "init" | "generate"; place?: IgnorePlacement },
): BundleEnvOutcome {
  const values = { ...env };
  const names = Object.keys(values);
  const outcome: BundleEnvOutcome = { declared: names, written: [], notWritten: names };
  if (names.length === 0) return outcome;
  const dir = at?.dir ?? join(out, XANO_DIR);
  const path = join(dir, WORKSPACE_ENV_BASENAME);
  const rel = at?.rel ?? `${XANO_DIR}/${WORKSPACE_ENV_BASENAME}`;
  const command = at?.command ?? "init";
  const count = `${names.length} value${names.length === 1 ? "" : "s"}`;
  const supply =
    `supply ${names.length === 1 ? "it" : "them"} in \`${rel}\` (or \`xanosdk env pull\` from a running backend), ` +
    `or with \`--env-var NAME=VALUE\` at deploy`;
  if (args.noSecrets) {
    warn(
      `Workspace env: the bundle carries ${count} (${safeNames(names)}) — NOT written (--no-secrets). ` +
        `A deploy refuses until they are supplied: ${supply}.`,
      "workspace-env.not-written",
    );
    return { ...outcome, reason: "no-secrets" };
  }
  if (existsSync(path)) {
    // `env pull` reads a RUNNING backend. From a bundle file or a release there
    // is none to read, so the remedy is the values this source carries.
    const live = kind !== "file" && kind !== "release";
    warn(
      `Workspace env: the bundle carries ${count} (${safeNames(names)}); \`${rel}\` already exists and was ` +
        `left as it is. ` +
        (live
          ? `To replace it, run \`xanosdk env pull\`, or edit it by hand.`
          : `To take the ${kind === "file" ? "bundle file's" : "release's"} values, compare ${names.length === 1 ? "that name" : "those names"} ` +
            `with \`${rel}\` and edit it by hand — or move it aside and re-run this command to write it fresh.`),
      "workspace-env.not-written",
    );
    return { ...outcome, reason: "exists" };
  }
  try {
    requireSecretPathGitignored(path, { command }, at?.place);
    const { content, omitted } = renderWorkspaceEnvFile(
      values,
      { source: provenance, at: new Date().toISOString() },
      rel.slice(0, -(WORKSPACE_ENV_BASENAME.length + 1)) || ".",
      existsSync(join(dir, WORKSPACE_ENV_EXAMPLE_BASENAME)),
      command === "init" ? "xanosdk init --from" : "xanosdk generate",
    );
    atomicWrite(path, content, { mode: 0o600 });
    const written = names.filter((n) => !omitted.includes(n));
    const filled = written.filter((n) => values[n] !== "");
    const empty = written.filter((n) => values[n] === "");
    warn(
      `Workspace env: wrote ` +
        [
          filled.length === 0 ? "" : `${filled.length} value${filled.length === 1 ? "" : "s"} (${safeNames(filled)})`,
          empty.length === 0
            ? ""
            : `${empty.length} name${empty.length === 1 ? "" : "s"} the bundle stores empty, as \`NAME=\` so a deploy ` +
              `keeps ${empty.length === 1 ? "it" : "them"} empty (${safeNames(empty)})`,
        ]
          .filter((part) => part !== "")
          .join(" and ") +
        ` from the bundle to \`${rel}\`` +
        `. That file is SECRET MATERIAL: owner-only and gitignored, so a teammate's ` +
        `clone and CI supply ${written.length === 1 ? "it" : "them"} with \`--backend-env-file\` or \`--env-var\`.` +
        (omitted.length === 0
          ? ""
          : ` Not written, because the dotenv format cannot carry ${omitted.length === 1 ? "it" : "them"}: ` +
            `${safeNames(omitted)} — pass ${omitted.length === 1 ? "it" : "each"} with \`--env-var\` at deploy.`),
      "secrets.env-written",
    );
    return { ...outcome, written, notWritten: omitted };
  } catch (err) {
    // The tree already landed; a failed secret write must not fail the command.
    warn(
      `Workspace env: the bundle carries ${count} (${safeNames(names)}) — NOT written: ` +
        `${err instanceof Error ? err.message : String(err)}\nThe tree is fine; ${supply}.`,
      "workspace-env.not-written",
    );
    return { ...outcome, reason: "error" };
  }
}

/**
 * What {@link writeBundleEnvValues} did with a bundle's env: every DECLARED
 * name, the ones whose values landed in `.env`, and the carried values it did
 * not write — with why, when the whole write was declined.
 */
export interface BundleEnvOutcome {
  readonly declared: readonly string[];
  readonly written: readonly string[];
  readonly notWritten: readonly string[];
  readonly reason?: "no-secrets" | "exists" | "error";
}

/**
 * The SDK version the generated tree actually resolved, when it is not the one
 * this CLI wrote the tree with.
 *
 * `reexport()` loads `xano/index.ts` against the SDK installed IN THE TREE, not
 * against this process — and `sdkDep()` floors the scaffolded range at the CLI's
 * version while leaving the ceiling at the next minor, deliberately, so that a
 * project keeps receiving releases. The consequence is that `npm install` can
 * resolve an SDK newer than the CLI that generated the source it is about to
 * check, and on the `0.0.x` line a patch may change what generated source is
 * allowed to say. The round trip then fails on a contract difference between two
 * versions of this package, and every line of the report describes the tree —
 * which is not what is wrong.
 *
 * REPORTED, never refused. A skew is not by itself an error: most of them verify
 * fine, and the generated tree is exactly what the CLI meant to write either
 * way. What it buys is the one fact the failure cannot be read without.
 *
 * Null whenever the two cannot be compared — no install (`--no-install`, or one
 * that failed), an unreadable manifest, or a CLI that does not know its own
 * version. "Cannot compare" must never render as "they differ".
 */
export function installedSdkSkew(out: string, cliVersion: string): string | null {
  if (cliVersion === "" || cliVersion === "unknown") return null;
  const manifest = readInstalledManifest(out, SDK_MODULE);
  if (manifest === null) return null;
  const installed = manifest.version;
  if (typeof installed !== "string" || installed === "" || installed === cliVersion) return null;
  return installed;
}

/**
 * The skew, said where a reader is already looking for the cause of a failed
 * round trip.
 *
 * Names the CLI as the thing to move, because it is: the tree is generated by
 * whichever `xanosdk` ran, and the installed SDK is the newer contract it is
 * being judged against. Upgrading the CLI and re-running produces source the
 * installed SDK accepts; "fixing the source" — what the failure otherwise tells
 * you to do — fixes nothing, because the source is what this CLI meant to write.
 */
export function sdkSkewNote(
  installed: string,
  cliVersion: string,
  /**
   * How THIS CLI was installed, read before the scaffold's `npm install` ran.
   *
   * Passed rather than asked for here, because `detectInstallMode()` answers
   * from `process.cwd()` and this command can have changed that answer: the
   * target defaults to the cwd, and the install just put `@xano/sdk` in its
   * `node_modules`. Asked at this point, a global CLI reads as local and the
   * line below says `-D`, which installs a dependency instead of upgrading the
   * CLI and leaves the skew exactly where it was.
   */
  mode: "global" | "local",
): string {
  // PINNED to the version the tree resolved, never `@latest`: `upgradeCommand()`
  // offers the newest release, which on a fast-moving line is a THIRD version
  // and leaves the skew in place.
  const flag = mode === "global" ? "-g" : "-D";
  return (
    `This CLI is ${cliVersion} and the tree resolved \`${SDK_MODULE}\` ${installed}, so the ` +
    `source it just wrote was checked against a different version of this package. That is the ` +
    `likely cause of the mismatches above, and the source is not what is wrong. Upgrade the CLI ` +
    `(\`npm i ${flag} ${SDK_MODULE}@${installed}\`) and re-run, or re-run with ` +
    `\`--skip-roundtrip\` to keep the tree unverified.`
  );
}

/**
 * Whether a load failure means "this project's dependencies are not installed"
 * rather than "this tree is broken".
 *
 * Deliberately narrow, and it has to look in two places. `loadDefault` does not
 * surface the resolution error directly: it routes `ERR_MODULE_NOT_FOUND` into
 * the tsx fallback, which — when `tsx` is also unresolvable, i.e. exactly the
 * uninstalled state — throws a *fresh* "requires `tsx`" error carrying the
 * original only on `cause`. So the chain is walked, and both shapes count.
 *
 * Anything else is a real failure and must stay one: a too-broad match here
 * would silently retire the round-trip check that is the point of pulling.
 */
export function isMissingDependencyError(err: unknown): boolean {
  return missingDependency(err) !== undefined;
}

/**
 * Which piece {@link isMissingDependencyError} found missing: `"install"` when
 * the SDK itself does not resolve (nothing is installed — `npm install`), or
 * `"tsx"` when only the TypeScript loader is (`npm i -D tsx`). Undefined for
 * any other failure.
 */
export function missingDependency(err: unknown): "install" | "tsx" | undefined {
  let tsx = false;
  for (let cur: unknown = err, depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof e.message === "string" ? e.message : "";
    if (
      (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") &&
      message.includes("@xano/sdk")
    ) {
      return "install";
    }
    // The tsx fallback's own "cannot recover" error — tsx is a scaffold
    // devDependency, so its absence is the uninstalled state too. Its cause
    // says whether the SDK is missing as well (then an install is the answer).
    if (/requires `tsx`/.test(message)) tsx = true;
    cur = e.cause;
  }
  return tsx ? "tsx" : undefined;
}

/**
 * `init --from <source>`: the same project shell a bare `init` writes, with
 * `xano/` decoded from `source` instead of the empty starter.
 *
 * The target directory is `init`'s single positional, defaulting to the cwd
 * exactly as it does without the flag — the source identifies itself inside
 * `--from`, so it never competes for an argument position.
 */
export async function runInitFromCommand(args: ParsedArgs, source: CodegenSource): Promise<void> {
  // A Xano Engine selects no credential, so a `--profile` beside one would
  // pick nothing — refused rather than dropped, before anything is read.
  if (source.kind === "local") {
    refuseProfileForLocal(args.profile, [source.kind], requireBackendSlot("init", undefined, "from"));
  }
  const pathArg = args.positionals[0] ?? ".";
  // Before the read, and OUTSIDE fetchBundle: the `file` arm below never calls
  // it, so a check that lived there would let `--from <file> --branch x` write a
  // whole project with the flag silently dropped.
  assertBranchMatchesSource(args, source);

  // BEFORE the read: a directory the scaffold is going to refuse must cost
  // nothing — not a sign-in, not a download, not a "Writing …" line.
  const target = resolve(pathArg);
  // A non-empty directory this command did not write is an existing project,
  // which gets the backend only, merged in as plain `init` merges it. One a
  // previous `init --from` wrote (its marker is in `xano/`) is refreshed in
  // place, as before.
  const isRefresh = isNonEmptyDir(target) && existsSync(join(target, CODEGEN_MARKER));
  const existing = isNonEmptyDir(target) && !isRefresh;
  // A refresh of a project a previous run wrote with no frontend — the backend
  // added to an existing app, or a `--framework none` project — stays one. Its
  // `xano/` type-checks under `xano/tsconfig.json`, which the lambda config
  // extends; the full app's shell would point that config at a root
  // `tsconfig.json` the project does not have. Read off the signals
  // `detectProjectFrontend` uses, plus the line-ending rule only an existing
  // project keeps inside `xano/`.
  const refreshedBackend: BackendShell["kind"] | undefined =
    isRefresh && !existsSync(join(target, "frontend")) && existsSync(join(target, BACKEND_TSCONFIG_PATH))
      ? existsSync(join(target, XANO_DIR, ".gitattributes"))
        ? "existing"
        : "new"
      : undefined;
  if (refreshedBackend !== undefined) {
    if (args.framework !== undefined && resolveFrameworkValue(args.framework) !== null) {
      throw new UsageError(
        `\`--framework ${args.framework}\` writes a new frontend, and ${target} is a project with no frontend: ` +
          `re-running init refreshes its backend only. Drop --framework, or run init in an empty directory for a full app.`,
        { helpFor: { command: "init" } },
      );
    }
    refuseFrontendOnlyFlags(args, `${target} has no frontend, so re-running init refreshes its backend only`);
  }
  let overrideScripts: readonly string[] = [];
  if (existing) {
    await resolveInitFrontend(args, target, "existing");
    const settled = await settleClashes(
      target,
      backendShellFiles(templateVarsFor(sanitizeAppName(args.name ?? basename(target)), target), { kind: "existing", dir: target }),
      args,
    );
    if (settled === "cancelled") return;
    overrideScripts = settled;
  }

  const { bundle, origin, credentialRead, seed, syncTarget } =
    source.kind === "file"
      ? {
          bundle: readBundleFile(source.path),
          origin: { source: "file", origin: source.path } as const,
          credentialRead: undefined,
          seed: undefined,
          syncTarget: undefined,
        }
      : await fetchBundle(args, source);

  // Validated before any work: a bad `--report` value should not cost a full
  // decode and a written tree before it is reported.
  const mode = reportMode(args.report);

  const out = resolve(pathArg);
  const appName = sanitizeAppName(args.name ?? basename(out));
  const vars: TemplateVars = templateVarsFor(appName, out);
  // Resolved first for the same reason as in `init`: the framework decides
  // what the project is, and feeds the agent-brief prose.
  const preset = existing || refreshedBackend !== undefined ? null : await resolveFrontendPreset(args.framework);
  if (preset === null && !existing && refreshedBackend === undefined) refuseFrontendOnlyFlags(args, "`--framework none` writes none");
  // `codegen` scaffolds the same project shell as `init`, so it takes the same
  // theme questionnaire — a pulled workspace has no more reason to look like
  // stock shadcn than a fresh one does.
  const choice = await resolveThemeChoice(args);

  // BEFORE `scaffoldProject` installs into `out`, which for the default target
  // (`out` === cwd) would otherwise make a global CLI read as local. See
  // `sdkSkewNote`.
  const installMode = detectInstallMode();

  // A release does not name its workspace, so nothing in the source does — the
  // decode's placeholder was `workspace("workspace")`. The project's own name
  // (`--name`, else the directory) is the better stand-in.
  const ws = (bundle.payload as Record<string, unknown> | undefined)?.workspace as { name?: unknown } | undefined;
  const unnamed = typeof ws?.name !== "string" || ws.name.trim() === "";
  const project = decodeBundle(bundle, {
    ...(unnamed ? { workspaceName: appName } : {}),
  });

  // BEFORE any file is written and before `npm install` runs: an archive whose
  // records disagree under one guid cannot produce a correct tree, and a
  // half-scaffolded directory with dependencies installed is a worse place to
  // learn that than an empty one. The decode report already names both records
  // and where they differ, so the refusal carries the remedy with it.
  refuseDuplicateSourceGuids(project);

  // The remedy's entry is spelled from the user's cwd — `out` may be a
  // subdirectory of it — and printed after the "Wrote N files" it follows.
  const routesDeferred: string[] = [];
  const cwdEntry = pastePath(relative(process.cwd(), join(resolve(out), XANO_DIR, "index.ts")).split(sep).join("/"));
  const generated = placeGeneratedFiles(project, XANO_DIR, XANO_DIR, {
    entry: shellWord(isAbsolute(cwdEntry) || cwdEntry.startsWith(".") ? cwdEntry : `./${cwdEntry}`),
    deferred: routesDeferred,
  });
  const readme = renderCodegenReadme(vars, origin, Object.keys(project.env), preset);
  const files: ScaffoldFile[] = [
    ...(existing || refreshedBackend === "existing"
      ? backendShellFiles(vars, { kind: "existing", dir: out })
      : preset === null
        ? backendShellFiles(vars, { kind: "new", readme })
        : projectShellFiles(vars, preset, { readme, landing: codegenLanding(vars, origin) }, choice)),
    ...generated,
    {
      path: `${XANO_DIR}/${CODEGEN_MARKER_BASENAME}`,
      content: stableCodegenMarker(join(out, XANO_DIR, CODEGEN_MARKER_BASENAME), (generatedAt) =>
        renderCodegenMarker(
          vars,
          origin,
          generatedAt,
          project.report.toJson(),
          generated
            .filter((f) => f.path.startsWith(`${XANO_DIR}/`))
            .map((f) => ({ path: f.path.slice(XANO_DIR.length + 1), content: f.content })),
        ),
      ),
    },
  ];

  // A re-run over an existing `xano/` replaces files, so it is planned, listed
  // and confirmed BEFORE anything is written — the way `pull` does it — and
  // removes only what the previous decode wrote, the way `generate --force` does.
  // The brief the scaffold upserts is part of what `--force` rewrites, so the
  // plan compares it as it will land alongside the shell files.
  const agentsMd = plannedAgentsMd(out, {
    agentsMd: !args.noAgentsMd,
    appName,
    regenerable: true,
    sdkVersion: readVersion(),
    frontend: preset,
    theme: choice,
  });
  const replace = await planXanoReplace(
    out,
    // An existing project's merged files are not overwrites: only the backend's own are listed.
    existing ? files.filter((f) => !MERGED_IN_EXISTING.has(f.path)) : files,
    bundle.payload as Record<string, unknown>,
    args,
    describeOrigin(origin),
    existing ? undefined : agentsMd,
  );
  if (replace === "cancelled") {
    info("Cancelled. Nothing was written.");
    return;
  }

  // Decided before the write, so the pointer is among the files listed.
  const pin = await planProfilePin(args, out, { credentialRead: credentialRead === true });
  if (pin.file !== null) files.push(pin.file);

  step(`Writing ${style.bold(appName)} to ${out}`);
  const scaffold = await scaffoldProject({
    targetDir: out,
    files,
    agentsMd: !args.noAgentsMd,
    appName,
    force: args.force,
    noInstall: args.noInstall,
    regenerable: true,
    sdkVersion: readVersion(),
    frontend: preset,
    theme: choice,
    ...(replace.removals === undefined ? {} : { xanoRemovals: replace.removals }),
    // An existing project's clashes were settled before the read, and its
    // manifest is merged into with the project winning.
    ...(existing ? { overwrite: "full" as const, mergePackageJson: "project" as const, overrideScripts } : {}),
  });
  reportXanoReplace(replace);
  for (const line of routesDeferred) warn(line, "routes.not-written");
  // As `pull` says it (E2E pass 25): the rows a seeded release carries are not
  // in the tree, and init --from said nothing of them.
  if (seed !== undefined) reportSeedRows(seed.rows, seed.label, seed.provenance, XANO_DIR, contextFlags(args));
  // The lock a refresh keeps is RECONCILED against the source first — entries
  // it no longer accounts for are dropped, as `pull` drops them — and then
  // brought up to the tree below, so `export --check` agrees with it.
  if (replace.lock !== undefined) {
    const { reconciledLock } = await import("./pull-command.js");
    writeLockFile(
      replace.lock.path,
      reconciledLock(replace.lock.model, replace.lock.reconciliation, bundle.payload as Record<string, unknown>),
    );
  }

  // AFTER the tree lands and before anything suggests committing it. A
  // scaffolded project's bare `.env` already covers this at depth, so this is a
  // no-op there; a pull into a repo whose ignore is root-anchored is the case it
  // exists for. File-level, never `xano/` — see `ensureWorkspaceEnvGitignored`.
  ensureWorkspaceEnvGitignored(out);
  reportWorkflowPlacement(scaffold.written, vars.install, out);
  writeDocumentationTokens(out, project.documentationTokens, args, describeOrigin(origin));
  writeBundleEnvValues(out, project.env, args, describeOrigin(origin), origin.source);
  // What plain `init` leaves too: the committed pointer, so every later `pull`,
  // `env pull` and `deploy` in this project is aimed where it came from.
  pin.report();
  const pinnedProfile = pin.name;

  let verified: boolean | null = null;
  let strictWarnings: Diagnostic[] = [];
  let strictAccepted: Diagnostic[] = [];
  // Written only from a tree the round trip proved; otherwise the first export
  // writes it, as in a plain `init` project.
  let lock: string | null = null;
  if (!args.skipRoundtrip) {
    step("Verifying the generated tree round-trips");
    try {
      // `project.source`, never `bundle`: the tree was generated from the
      // archive AFTER equivalent repeats were merged, so comparing against the
      // unreconciled original would report every merged twin as a missing
      // object and turn the fix into a fresh failure.
      const collected = await collectingWarnings((accepted) =>
        reexport(out, project.env, project.documentationTokens, undefined, XANO_DIR, accepted),
      );
      const result = verifyBundles({ payload: project.source }, collected.value, { source: origin.source });
      reportMismatches(project.report, result);
      verified = result.ok;
      strictWarnings = collected.warnings;
      strictAccepted = collected.accepted;
    } catch (err) {
      // "Dependencies are not installed" is the one load failure that is not the
      // tree's fault — but only when install did not actually report success.
      // An install that succeeded and then failed to load IS the tree's fault,
      // and downgrading that would turn the hard gate into a warning on the
      // default path (offline, registry hiccup, an unpublished version).
      if (scaffold.install !== "installed" && isMissingDependencyError(err)) {
        warn(unverifiedReason(scaffold.install, origin), "init.unverified");
      } else {
        // A verification that CANNOT RUN is a failed verification, not a crash.
        // Rethrowing here skipped `summarize` entirely, so the report describing
        // the decode — which finished long before this step, and which usually
        // names the very defect that broke the re-export — was discarded along
        // with it, and the user got one line about a reference they could not
        // locate. The outcome is unchanged (this still fails the
        // command); what changes is that everything already established gets
        // said first.
        verified = false;
        project.report.add(verifyCrashEntry(err, out));
      }
    }
  }
  // Outside the verify `try`: the round trip already passed, so a lock that
  // cannot be written (a read-only dir, a full disk) is a missing convenience,
  // not a failed verification — the first `export` writes it instead.
  const hadLock = existsSync(join(out, XANO_DIR, "xano.lock"));
  if (verified === true) {
    try {
      lock = await writeTreeLock(out, project.env, project.documentationTokens);
    } catch (err) {
      warn(lockWriteFailure(err), "lock.write-failed");
    }
  } else if (verified === null) {
    // The tree could not be loaded (dependencies not installed, or the round
    // trip skipped), so there is no export to read identities from. The source
    // itself carries them — the same identities `lock import` adopts — and a
    // project handed over with no lock fails its own `xano:check`.
    try {
      lock = writeSourceLock(out, project.source);
    } catch (err) {
      warn(lockWriteFailure(err), "lock.write-failed");
    }
  }
  // Written after the scaffold's "Wrote N files" list, so named on its own.
  // Spelled from where the command was typed, as every other path this run prints.
  if (lock !== null && !hadLock) success(`Wrote ${displayPath(lock)}`);
  // The tree and the branch it was decoded from agree, so this is the
  // branch's first sync baseline (see `deploy/sync-baseline.ts`). A decode
  // reads the whole branch, so it is complete. Not for a tree that failed its
  // round trip: that one does not match the branch.
  if (lock !== null && syncTarget !== undefined && verified !== false) {
    recordSync({ lockPath: lock, target: syncTarget, digests: syncDigests({ held: [bundle] }), by: "init", complete: true });
  }

  // The decode report is written from the report object, so the copy on disk has
  // to be re-rendered once verification has had its say — otherwise the file
  // claims a clean run the CLI just contradicted. Both failing outcomes qualify:
  // a mismatch, and a verification that could not run at all.
  if (verified === false) {
    rewriteReadmeWithReport(project, out);
    // BEFORE `summarize`, which is where the mismatches and the "fix the source"
    // next step are printed. A skew explains both, and a reader who has it in
    // hand reads that list as evidence of a version difference rather than of a
    // defect in the workspace they pulled.
    const cliVersion = readVersion();
    const installed = installedSdkSkew(out, cliVersion);
    if (installed !== null) warn(sdkSkewNote(installed, cliVersion, installMode), "init.sdk-skew");
  }

  summarize(args, project, verified, out, origin, scaffold.install, mode, {
    dir: out,
    name: appName,
    mode: existing || isRefresh ? "existing" : "new",
    framework: preset?.id ?? "none",
    theme: preset === null ? null : choice.theme.id,
    dark: preset === null ? null : choice.dark,
    install: scaffold.install,
    files: runFiles(scaffold.written, lock === null ? [] : [relative(out, lock).split(sep).join("/")]),
    next: deployNextCommand(
      out === process.cwd() ? null : pathArg,
      scaffold.install === "installed" || existsSync(join(out, "node_modules", "@xano", "sdk")) ? null : installCommandFor(out),
      detectPackageManager(out),
    ),
    pinnedProfile,
    lock,
    // What `pull --json` reports for the same refresh: the files kept because
    // no decode wrote them, and how the existing lock reconciled.
    kept: replace.kept.map((p) => `${XANO_DIR}/${p}`),
    removedEdited: replace.removedEdited.map((p) => `${XANO_DIR}/${p}`),
    rewrittenEdited: replace.rewrittenEdited.map((p) => `${XANO_DIR}/${p}`),
    lockKept: replace.lock?.reconciliation.kept.length ?? 0,
    lockDropped: replace.lock?.reconciliation.dropped.length ?? 0,
    seedRows: seed?.rows ?? [],
  }, pin, strictWarnings, strictAccepted);

  // A failed verify is a hard failure, not a warning: the tree on disk does not
  // reproduce the workspace it came from, so anything built on it is built on a
  // silent divergence. The files are left in place to be inspected.
  if (verified === false) {
    throw Object.assign(
      new Error(
        `Round-trip verification failed for the tree at "${out}" — see the mismatches above. ` +
          `The files were written so you can inspect them; do not deploy them.`,
      ),
      // Distinct from a plain 1, which a bundle that could not be read also
      // exits with. Here the tree IS on disk and the findings above describe it,
      // so a caller can tell "nothing was written" from "written, and it does
      // not match" without parsing the message.
      { exitCode: EXIT_VERIFY_FAILED },
    );
  }
}

/** The codegen record `init --from` leaves in `xano/` (the same basename `generate` writes). */
const CODEGEN_MARKER_BASENAME = ".xanosdk-codegen.json";

/** What a re-run of `init --from` over an existing `xano/` will do, decided before any write. */
interface XanoReplacePlan {
  /** `xano/`-relative files to remove; undefined when there was no tree to replace. */
  readonly removals: readonly string[] | undefined;
  /** The removals the author edited since the last decode — deleted with their edits. */
  readonly removedEdited: readonly string[];
  /** Files the author edited since the last decode that this one rewrites — rewritten over their edits. */
  readonly rewrittenEdited: readonly string[];
  /** Files no decode wrote, left in place — the author's. */
  readonly kept: readonly string[];
  /** The existing lock and how it reconciles with the source. */
  readonly lock?: { path: string; model: LockFile; reconciliation: Reconciliation };
}

type Reconciliation = import("./pull-command.js").Reconciliation;

/**
 * Plan a re-run of `init --from` over an existing `xano/` — `pull`'s safety,
 * `generate --force`'s scope.
 *
 * The run REPLACES files, so before any write it: refuses a lock that shares no
 * identity with the source (an unrelated backend) and a `xano/` git reports as
 * dirty, unless `--yes`; lists every file it will remove and every file whose
 * content it will rewrite; and asks — refused without a terminal unless `--yes`.
 * It removes only what the previous decode recorded writing: a file no decode
 * wrote (a hand-added def, notes) is kept and named afterwards.
 *
 * Returns "cancelled" when the answer was no. Nothing is planned when the target
 * has no `xano/` yet, or when the scaffold is about to refuse the directory.
 */
async function planXanoReplace(
  out: string,
  files: readonly ScaffoldFile[],
  payload: Record<string, unknown>,
  args: ParsedArgs,
  label: string,
  agentsMd?: ScaffoldFile,
): Promise<XanoReplacePlan | "cancelled"> {
  const xanoDir = join(out, XANO_DIR);
  const mode = decideOverwrite(out, { force: args.force, regenerable: true });
  if (mode === "refuse") return { removals: undefined, removedEdited: [], rewrittenEdited: [], kept: [] };
  // `--force` over a non-empty directory writes the whole project, so every
  // project file it overwrites is named with the `xano/` ones — not just those.
  const shell =
    mode === "full" && isNonEmptyDir(out)
      ? changedOnDisk(out, [
          ...files.filter((f) => !f.path.startsWith(`${XANO_DIR}/`)),
          ...(agentsMd === undefined ? [] : [agentsMd]),
        ])
      : [];
  if (!existsSync(xanoDir)) {
    if (shell.length > 0 && !(await confirmShellOverwrite(out, shell, args, label))) return "cancelled";
    return { removals: undefined, removedEdited: [], rewrittenEdited: [], kept: [] };
  }
  const { backendDirCleanliness, noneOfTheIdentities, pulledIdentities, reconcileLock } = await import("./pull-command.js");
  const prefix = `${XANO_DIR}/`;
  const incoming = new Map(
    files.filter((f) => f.path.startsWith(prefix)).map((f) => [f.path.slice(prefix.length), f.content] as const),
  );
  const existing = filesUnder(xanoDir).filter(
    (p) => !PRESERVED_ON_REFRESH.includes(p) && !SHELL_FILES_IN_BACKEND.includes(p) && p !== CODEGEN_MARKER_BASENAME,
  );
  const plan = planDecodeReplace(xanoDir, incoming, existing, readDecodeRecord(xanoDir, existing));
  const { removals, kept } = plan;

  const lockPath = join(xanoDir, "xano.lock");
  let lock: XanoReplacePlan["lock"];
  if (existsSync(lockPath)) {
    const model = readLockFile(lockPath);
    const reconciliation = reconcileLock(model, pulledIdentities(payload));
    if (reconciliation.disjoint && args.yes !== true) {
      throw new UsageError(
        `${noneOfTheIdentities(reconciliation.dropped.length, `${XANO_DIR}/xano.lock`)} ${label}. ` +
          `That is what pointing a project at an unrelated backend looks like, and carrying the lock ` +
          `across would arm a wrong prune later. Re-run with \`--yes\` if you meant to repoint this project.`,
        { hintFor: { command: "init" } },
      );
    }
    lock = { path: lockPath, model, reconciliation };
  }

  // A dropped lock entry is an identity given up, so it is confirmed as a
  // deleted file is.
  const lockDrops = lock?.reconciliation.dropped.length ?? 0;
  if (planTouchesExisting(plan) || lockDrops > 0 || shell.length > 0) {
    const cleanliness = backendDirCleanliness(out, XANO_DIR);
    if (cleanliness === "dirty" && args.yes !== true) {
      throw new UsageError(
        `${XANO_DIR}/ has uncommitted changes, and re-running \`init --from\` replaces the files it decodes. ` +
          `Commit or stash them first, or re-run with \`--yes\` to go ahead — it overwrites your edits to ` +
          `decoded files and keeps files you added. ` +
          `\`xanosdk pull\` refreshes an existing project's backend the same way.`,
        { hintFor: { command: "init" } },
      );
    }
    if (cleanliness === "unknown") {
      warn(`Not a git repository — nothing here holds the version of ${XANO_DIR}/ about to be replaced.`, "pull.no-git");
    }
    const list = (paths: readonly string[], pre: string = prefix): string[] => [
      ...paths.slice(0, 20).map((p) => `${pre}${p}`),
      ...(paths.length > 20 ? [`… and ${paths.length - 20} more`] : []),
    ];
    describeDecodeReplace(plan, XANO_DIR, label, (line, files) => warn(line, "pull.replace", files));
    listShellOverwrites(shell);
    if (lockDrops > 0) {
      warn(
        `${lockDrops} ${XANO_DIR}/xano.lock entr${lockDrops === 1 ? "y has" : "ies have"} no counterpart in ${label} ` +
          `and will be dropped:`,
        "pull.lock-dropped",
        list(lock!.reconciliation.dropped.map((key) => displayLockKey(key)), ""),
      );
    }
    // As `pull` says it: kept files the rewritten entry no longer registers,
    // and module registrations it replaces with decoded copies.
    const { keptDuplicates, replacedRegistrations, reportSuperseded } = await import("./pull-superseded.js");
    const shown = relative(process.cwd(), xanoDir).split(sep).join("/") || XANO_DIR;
    reportSuperseded(
      keptDuplicates(xanoDir, incoming, kept, shown),
      replacedRegistrations(xanoDir, incoming, existing.filter((p) => !kept.includes(p)), shown),
      shown,
      cleanliness === "clean",
    );
    if (args.yes !== true) {
      // A refusal off a terminal carries what it would have replaced, so the
      // `--json` failure document names the files the warnings listed.
      const rewritten = [...plan.edited, ...plan.changedBySource, ...plan.rewrittenUnknown].map((p) => `${prefix}${p}`);
      const { rerun, note } = yesRerun(args, "init");
      const ok = await confirm(`Replace ${XANO_DIR}/ in ${displayPath(out)} from ${label}?`, {
        flag: "--yes",
        refusal: {
          details: { written: false, files: [...shell, ...rewritten], removed: removals.map((p) => `${prefix}${p}`) },
          rerun,
          note,
        },
      });
      if (!ok) return "cancelled";
    }
  }
  return {
    removals,
    removedEdited: plan.removedEdited,
    rewrittenEdited: plan.edited,
    kept,
    ...(lock === undefined ? {} : { lock }),
  };
}

/**
 * The codegen marker, keeping the one on disk when only its timestamp would
 * change. A re-run with nothing to refresh otherwise rewrote `generatedAt` and
 * left the tree dirty on every run, with no change a reviewer could act on.
 */
export function stableCodegenMarker(path: string, render: (generatedAt: string) => string): string {
  try {
    const current = readFileSync(path, "utf8");
    const previous = (JSON.parse(current) as { generatedAt?: unknown }).generatedAt;
    if (typeof previous === "string" && render(previous) === current) return current;
  } catch {
    // No marker yet, or an unreadable one: a fresh record below.
  }
  return render(new Date().toISOString());
}

/** The project files outside `xano/` an `init --from --force` overwrites. */
function listShellOverwrites(shell: readonly string[]): void {
  if (shell.length === 0) return;
  // The files are the warning's remedy lines, so its `--json` entry names them
  // rather than ending on a colon (E2E pass 28).
  warn(
    `${shell.length} project file${shell.length === 1 ? "" : "s"} outside ${XANO_DIR}/ will be overwritten (--force):`,
    "init.overwrite",
    [...shell.slice(0, 30), ...(shell.length > 30 ? [`… and ${shell.length - 30} more`] : [])],
  );
}

/** Confirm a `--force` that overwrites project files when there is no `xano/` to plan. */
async function confirmShellOverwrite(out: string, shell: readonly string[], args: ParsedArgs, label: string): Promise<boolean> {
  listShellOverwrites(shell);
  if (args.yes === true) return true;
  // A refusal off a terminal carries the files it would have overwritten.
  const { rerun, note } = yesRerun(args, "init");
  return confirm(`Write the project in ${displayPath(out)} from ${label}?`, {
    flag: "--yes",
    refusal: { details: { written: false, files: shell }, rerun, note },
  });
}

/** Name the files a re-run kept because no decode wrote them. */
function reportXanoReplace(plan: XanoReplacePlan): void {
  if (plan.kept.length === 0) return;
  warn(
    `Kept ${plan.kept.length} file${plan.kept.length === 1 ? "" : "s"} in ${XANO_DIR}/ no decode wrote — ` +
      `${plan.kept.length === 1 ? "it is" : "they are"} yours, and not part of the decoded tree:`,
    "pull.kept-files",
    [
      ...plan.kept.slice(0, 20).map((p) => `${XANO_DIR}/${p}`),
      ...(plan.kept.length > 20 ? [`… and ${plan.kept.length - 20} more`] : []),
    ],
  );
}

/**
 * Write `xano/xano.lock` from an export of the verified tree — the lock the
 * first `export` would write — unless the project already has one, which a
 * refresh keeps untouched.
 *
 * Only after the round trip passed: that proves the tree loads and reproduces
 * the source, so the identities recorded are the source's own, and the lock is
 * byte-for-byte what `export --frozen-lock` expects. Writing it now makes the
 * project whole from the first commit — `pull`'s same-backend check compares
 * against this lock, and with none it has nothing to compare. Returns the
 * lock's path, or null when it wrote none.
 */
async function writeTreeLock(
  out: string,
  env: Readonly<Record<string, string>>,
  documentationTokens: Readonly<Record<string, { value: string }>>,
): Promise<string | null> {
  const path = join(out, XANO_DIR, "xano.lock");
  // A refresh's lock (already reconciled against the source) is the base: the
  // export records the tree's identities into it exactly as `export` would, so
  // the next `export --check` finds nothing to change.
  const base = existsSync(path) ? readLockFile(path) : undefined;
  resetLockOverrides();
  if (base !== undefined) seedLockOverrides(base);
  const ctx = createLockContext(base);
  // Muted: the verification export just printed this tree's warnings, and a
  // second export for its identities would print each of them again.
  const previousSink = setDiagnosticSink(() => {});
  try {
    await reexport(out, env, documentationTokens, ctx);
  } finally {
    setDiagnosticSink(previousSink);
    resetLockOverrides();
  }
  const { lock } = mergeObserved(ctx.lock, ctx.observed);
  if (Object.keys(lock.objects).length === 0) return base === undefined ? null : path;
  // Skips an identical write, so a refresh that changed nothing leaves the file alone.
  writeLockFile(path, lock);
  return path;
}

/**
 * The note for a lock `init --from`/`pull` could not write. Only a filesystem
 * failure (an errno `code`) is one the first `export` gets past; anything else
 * is the identities themselves, which `export` refuses in the same words.
 */
export function lockWriteFailure(err: unknown): string {
  const message = (err as Error).message;
  return typeof (err as { code?: unknown }).code === "string"
    ? `Could not write xano.lock (${message}); the first \`xanosdk export\` writes it.`
    : `Could not write xano.lock: ${message} \`xanosdk export\` refuses the same way until that is fixed.`;
}

/**
 * `xano/xano.lock` from the decoded SOURCE's identities, for a tree that could
 * not be loaded to export one (see {@link writeTreeLock}, the path taken when it
 * can). The lock `lock import` adopts from the same bundle, with one addition:
 * every canonical and guid the source carries is written into the generated
 * code, so each is recorded as the code's (`canonical_source: "code"`,
 * `guid_source: "code"`), exactly as an export of the tree records it. Unless the project already has a lock.
 */
export function writeSourceLock(out: string, source: unknown): string | null {
  const path = join(out, XANO_DIR, "xano.lock");
  // A refresh's (reconciled) lock is adopted INTO, as `lock import` would.
  const base = existsSync(path) ? readLockFile(path) : emptyLock();
  const lock = withSourceIdentities(base, source);
  if (Object.keys(lock.objects).length === 0) return null;
  writeLockFile(path, lock);
  return path;
}

/**
 * `base` with every identity the decoded `source` carries recorded into it —
 * the entries an export of the decoded tree appends, so the next `export
 * --check` finds nothing to add. Shared by `init --from`, `pull` and
 * `generate --force`: a pull that kept only the entries its lock already had
 * left \`xano:check\` failing right after it ("would change xano/xano.lock: add
 * task:…"). The landing record rides along untouched (`withObjects`).
 */
export function withSourceIdentities(base: LockFile, source: unknown): LockFile {
  const { lock, seen } = adoptFromBundle(base, { payload: source }, "the decoded source");
  const fromSource = new Set(seen);
  const objects: LockFile["objects"] = {};
  for (const [key, entry] of Object.entries(lock.objects)) {
    const payloadKey = key.slice(0, key.indexOf(":"));
    const next =
      entry.canonical !== undefined && CANONICAL_PAYLOAD_KEYS.has(payloadKey)
        ? { ...entry, canonical_source: "code" as const }
        : entry;
    // Every generated def writes the guid it was pulled with (`guid:`), so the
    // export records each one as the code's.
    objects[key] = fromSource.has(key) && next.guid !== undefined ? { ...next, guid_source: "code" } : next;
  }
  return withObjects(lock, objects);
}

/** Append the (now final) decode report to the generated README on disk. */
function rewriteReadmeWithReport(project: GeneratedProject, out: string): void {
  const readme = project.files.find((f) => f.path === GENERATED_README);
  if (!readme) return;
  writeFileSync(
    join(out, XANO_DIR, GENERATED_README),
    `${readme.contents.replace(/\n$/, "")}\n\n${project.report.renderMarkdown()}`,
    "utf8",
  );
}

/**
 * The rendering `--report` asked for.
 *
 * An unrecognised value is a usage error rather than a silent fall back to the
 * default: a CI job passing `--report=jsonl` and getting prose on stdout would
 * look like a parsing bug in the job, not a typo in the flag.
 */
type ReportMode = "grouped" | "full" | "json";

function reportMode(value: string | undefined): ReportMode {
  if (value === undefined || value === "grouped") return "grouped";
  if (value === "full" || value === "json") return value;
  throw new UsageError(
    `--report takes grouped, full or json, not "${value}". ` +
      `grouped (the default) collapses repeated findings to one line per root cause, ` +
      `full prints every site, and json prints the findings as data.`,
    { helpFor: { command: "init" } },
  );
}

/** Exit code for a tree that was written but does not re-export as it was pulled. */
const EXIT_VERIFY_FAILED = 2;

/**
 * The finding a verification that could not RUN contributes.
 *
 * It is a `verify-mismatch` like any other: the claim "this tree re-exports as
 * it was pulled" is unproven either way, and splitting "disagreed" from "could
 * not be checked" into two categories would put the same consequence under two
 * headings. What the entry adds is the thrown message and, where the stack
 * gives one, the generated file it came from.
 */
export function verifyCrashEntry(err: unknown, out: string): ReportEntry {
  return {
    category: "verify-mismatch",
    object: blameGeneratedFile(err, out) ?? "bundle",
    detail:
      `the generated tree could not be re-exported to check the round trip: ` +
      `${err instanceof Error ? err.message : String(err)}` +
      // A load-time TypeError ("x is not a function") or ReferenceError is
      // usually the runtime face of a compile error — a duplicate or shadowed
      // binding — which the compiler names where the runtime cannot. Any other
      // throw is the SDK refusing what the tree builds, and says so itself.
      (err instanceof TypeError || err instanceof ReferenceError
        ? ` (\`npx tsc --noEmit\` in the project names the compile error behind it)`
        : ""),
  };
}

/**
 * The generated file a thrown error came from, as `<kind>:<name>`, with the
 * `line:column` the frame gives.
 *
 * A tree that cannot be re-exported usually fails inside ONE generated def, and
 * the stack says which — the first frame under the tree's own directory. That is
 * the only attribution available here: the throw happens while the tree is being
 * LOADED, before any object walk that could name what it was working on, so the
 * error itself carries no object.
 *
 * The tree's directory is matched as the caller spelled it and as the loader
 * resolved it (a symlinked `/tmp` reads as `/private/tmp`), and only on a path
 * boundary, so a relative `out` of `.` cannot match the `xano` in `…/xanosdk-sdk/`.
 *
 * Returns undefined when no frame points into the tree (a failure in the SDK's
 * own code, or an error with no stack), rather than guessing.
 */
export function blameGeneratedFile(err: unknown, out: string): string | undefined {
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  const dirs = new Set([join(resolve(out), XANO_DIR)]);
  try {
    dirs.add(join(realpathSync(resolve(out)), XANO_DIR));
  } catch {
    // An output directory that does not exist has only its spelled path.
  }
  for (const line of stack.split("\n")) {
    for (const dir of dirs) {
      const at = line.indexOf(`${dir}/`);
      if (at === -1) continue;
      const frame = /^([^:)\s]+)(?::(\d+)(?::(\d+))?)?/.exec(line.slice(at + dir.length + 1));
      const file = frame?.[1];
      if (file === undefined) continue;
      // `tool/with_pre.ts` reads as `tool:with_pre`; a top-level file keeps its
      // own name. The path is kept alongside, with the frame's line and column,
      // so the finding is clickable to the statement that threw.
      const parts = file.replace(/\.[tj]s$/, "").split("/");
      const name = parts.length > 1 ? `${parts[0]}:${parts.slice(1).join("/")}` : parts[0]!;
      const position = frame?.[2] === undefined ? "" : `:${frame[2]}${frame[3] === undefined ? "" : `:${frame[3]}`}`;
      return `${name} (${XANO_DIR}/${file}${position})`;
    }
  }
  return undefined;
}

/** Why verification could not run, phrased as the thing to do about it. */
export function unverifiedReason(install: InstallOutcome, origin: CodegenOrigin): string {
  // Not "re-run `init --from`": that scaffolds over the project just written.
  // What the reader can run is the compile, and — for a workspace source — the
  // comparison against the workspace itself.
  const check =
    origin.source === "workspace"
      ? `run \`npm install\` in the project, then \`xanosdk workspace diff ./xano/index.ts` +
        `${origin.branch === undefined ? "" : ` --branch ${shellWord(origin.branch)}`}\` there to compare it with the ` +
        `${origin.branch === undefined ? "workspace" : "branch it was read from"}`
      : `run \`npm install\` in the project, then \`npm run xano:check\` there to confirm the tree compiles`;
  if (install === "skipped") {
    return `Could not verify the round trip: dependencies are not installed (--no-install) — ${check}.`;
  }
  if (install === "already-installed") {
    return `Could not verify the round trip: the project's node_modules does not hold what the tree needs — ${check}.`;
  }
  return `Could not verify the round trip: \`npm install\` did not complete, so the tree could not be loaded — ${check}.`;
}

/** The CLI summary: what was written, what did not round-trip, and what to run next. */
function summarize(
  args: ParsedArgs,
  project: GeneratedProject,
  verified: boolean | null,
  out: string,
  origin: CodegenOrigin,
  install: InstallOutcome,
  mode: ReportMode,
  scaffolded: Record<string, unknown>,
  pin: { signedIn: boolean },
  strictWarnings: readonly Diagnostic[] = [],
  strictAccepted: readonly Diagnostic[] = [],
): void {
  const s = stdoutStyle();
  // Counted from the RECONCILED source, not the bundle as it arrived: this line
  // says what was decoded into the tree, and an archive that repeated one object
  // three times would otherwise claim three where one file exists. The merge
  // itself is reported separately, as its own notice.
  // Named by SDK kind (`table`, `apiGroup`), never by the bundle's storage keys.
  const counts = decodedCounts(project.source);
  info(`Decoded ${counts.length === 0 ? "no objects" : counts.join(", ")} from ${describeOrigin(origin)}`);

  // Derived from the same computed report the README renders, so the two can
  // never disagree about how many problems there were. Severity comes from the
  // report itself rather than a category list restated here — that duplication
  // is exactly how a "problem" count drifts from what the entries actually say.
  const summary = project.report.summarize();
  const groups = summary.byCategory;
  const omitted = groups.find((g) => g.category === "expected-omission")?.count ?? 0;
  const problems = summary.bySeverity.error + summary.bySeverity.warning;
  const rendered =
    mode === "json" ? "" : project.report.renderCli({ full: mode === "full", fileBase: `${displayPath(join(out, XANO_DIR))}/` });
  if (rendered !== "") {
    // A run whose only entries are notices DID round-trip cleanly — saying
    // otherwise trains users to ignore the one header that matters. But only
    // when the check RAN and passed: a skipped or unrunnable check proved
    // nothing, and the line below says so.
    // Marked by what it reports: a problem warns, a clean round trip is a
    // success, and notices alone are information — never a `!` on good news.
    if (problems > 0) warn(`Not everything round-tripped cleanly — ${project.report.headline()} (listed below).`, "decode.findings");
    else if (verified === true) success("Round-tripped cleanly. Some values are deliberately not carried into the tree:");
    else info("Some values are deliberately not carried into the tree:");
    process.stderr.write(`${terminalText(rendered)}\n`);
  }

  if (verified === null) {
    if (args.skipRoundtrip) warn("Skipped the round-trip check (--skip-roundtrip) — the tree is unchecked.", "init.roundtrip-skipped");
  } else if (verified) {
    success(
      omitted > 0
        ? `Verified: re-exporting ${out} reproduces the source bundle, apart from ${omitted} deliberately omitted value${omitted === 1 ? "" : "s"} listed above`
        : `Verified: re-exporting ${out} reproduces the source bundle`,
    );
  } else {
    warn(`Verification FAILED — the objects listed above do not re-export as they were pulled.`, "init.verify-failed");
  }
  // `json` is the machine channel: the findings as data on STDOUT, so a CI gate
  // reads them without scraping the prose the other two modes write to stderr.
  // Through `writeJson`, so a verify failure thrown after it does not get a
  // second (failure) document appended under `--json`: stdout carries one.
  // Machine output writes it whatever `--report` chose: that flag picks the
  // STDERR rendering, and stdout owes a machine reader its one document.
  //
  // Machine output answers what plain `init` does — the directory, the name,
  // the pinned profile — with the findings under `report`, and it is ONE shape
  // whichever way it was switched on: `--json`, or a piped stdout, with or
  // without `--report json`. The findings alone are printed only on a terminal
  // that asked for `--report json`, where no machine reader is waiting.
  // Written AFTER every warning above, so the document's `warnings[]` carries
  // them.
  if (isMachineOutput(args)) {
    writeJson({ ...scaffolded, verified, report: project.report.toJson() });
  } else if (mode === "json") {
    writeJson(project.report.toJson());
  }

  blank();
  // A tree that failed its own round-trip check is NOT ready, and the deploy
  // next steps are the wrong instruction for it: the whole point of the check is
  // that re-exporting this tree does not reproduce what was pulled, so deploying
  // it would write something other than the workspace it came from. The caller
  // throws right after this and names the tree, so what belongs here is the
  // pointer to the report — not a readiness claim the next line contradicts.
  if (verified === false) {
    warn(
      "The tree is NOT verified — do not deploy it.",
      "init.verify-failed",
      [
        `The files were written to ${out} so you can inspect them against the mismatches above. ` +
          `Re-run \`init --from\` once the source is fixed, or open the generated tree and reconcile ` +
          `the objects the report names.`,
      ],
    );
    return;
  }

  // Said where the run ends: a tree whose own `xano:check` fails is not "ready" unqualified.
  const failing = verified === true ? reportStrictWarnings(strictWarnings, XANO_DIR, { accepted: strictAccepted, report: project.report }) : 0;
  if (failing === 0) success("Project ready.");
  else info(`Project ready, except that \`npm run xano:check\` fails until the ${failing} warning${failing === 1 ? "" : "s"} above ${failing === 1 ? "is" : "are"} fixed or accepted.`);
  const cdHint = out === process.cwd() ? "" : `  cd ${shellWord(args.positionals[0] ?? ".")}\n`;
  const steps =
    cdHint +
    (install === "installed" || existsSync(join(out, "node_modules", "@xano", "sdk")) ? `` : `  npm install\n`) +
    // An unverified tree: the check the warning above asks for is a step.
    (verified === null ? `  npm run xano:check     # confirm the tree compiles and the lock agrees\n` : ``) +
    `  npm run xano:deploy    # run it on the Xano Engine, on this machine\n` +
    loginNextStep(pin, out) +
    ephemeralNextStep(scaffolded.framework !== "none");
  // Every line is indented, so `detail` leaves them where they are: nested
  // under the heading here, where plain `init` nests them too.
  detail(`Next steps:\n` + steps.replace(/^ {2}/gm, "    "));
  // The lock line the plain scaffold prints, in the two states this can end in.
  // One `detail` per line: it indents only the first line of what it is given.
  for (const line of [
    scaffolded.lock !== null && scaffolded.lock !== undefined
      ? `${XANO_DIR}/xano.lock was written with the source's identities — commit it. It pins each`
      : `The first export or deploy writes ${XANO_DIR}/xano.lock — commit it. It pins each`,
    `object's identity, so renaming one later renames it instead of deleting and recreating it.`,
  ])
    detail(line);
  // Spelled for the project, where it runs after the install the steps above
  // name — as the login step is — not for the directory `init` was typed in.
  // The source named, not a bare `pull`: a bare one defaults to the backend
  // this project deployed to, and a fresh project has deployed nowhere.
  const selector = refreshSelector(origin);
  const refresh =
    selector === undefined
      ? `\`${projectCli(out)} pull <source>\` refreshes it from a live backend`
      : `\`${projectCli(out)} pull ${shellWord(selector)}${origin.branch === undefined ? "" : ` --branch ${shellWord(origin.branch)}`}\` refreshes it from the same source`;
  detail(
    `${s.bold(`${XANO_DIR}/`)} is your source now — commit it. ${refresh} (listing changes, ` +
      `keeping files you add). \`deploy\` REPLACES an ephemeral; \`promote\` reaches a real workspace.`,
  );
}

/**
 * The `pull` selector that reads the source `init --from` read, by name —
 * `ephemeral:e4f2`, `release:v1`, `workspace` — or undefined for a bundle
 * file, which `pull` does not read.
 */
export function refreshSelector(origin: CodegenOrigin): string | undefined {
  switch (origin.source) {
    case "file":
      return undefined;
    case "workspace":
      return "workspace";
    case "local":
      return origin.origin === "local" ? "local" : `local:${origin.origin}`;
    default:
      return `${origin.source}:${origin.origin}`;
  }
}

/** One table a fetched source carries seed rows for, as `--json` reports it. */
export interface SeedRowsReport {
  table: string;
  rows: number;
}

/**
 * The seed rows a fetched source carries — a release cut with `--seed` is the
 * one source that has any — by table name, in the source's table order. A
 * pulled tree is code: it carries no rows, so these are not in it, and a pull
 * that said nothing dropped them silently (E2E pass 24).
 */
export function carriedSeedRows(archive: Uint8Array, payload: Record<string, unknown>): SeedRowsReport[] {
  const byGuid = seedRowsByTableGuid(archiveSeedContent(archive));
  if (byGuid.size === 0) return [];
  const tables = Array.isArray(payload.dbo) ? (payload.dbo as { guid?: unknown; name?: unknown }[]) : [];
  const named = new Map(tables.flatMap((t) => (typeof t.guid === "string" && typeof t.name === "string" ? [[t.guid, t.name] as const] : [])));
  return [...byGuid].map(([guid, rows]) => ({ table: named.get(guid) ?? guid, rows: rows.length }));
}

/** Say which seed rows a pulled (or `init --from`) tree does not carry, and where they still are. */
export function reportSeedRows(
  seedRows: readonly SeedRowsReport[],
  label: string,
  source: string,
  backendDir: string,
  flags = "",
): void {
  if (seedRows.length === 0) return;
  warn(
    `${label} carries seed rows for ${seedRowsListed(seedRows)}, and a decoded tree carries no rows — they are not in ${backendDir}/.`,
    "release.seed-rows-not-decoded",
    [seedRowsLanding(source, flags)],
  );
}

/** `table note (2 rows), user (1 row)`. */
export function seedRowsListed(seedRows: readonly SeedRowsReport[]): string {
  const listed = seedRows.map((s) => `${s.table} (${s.rows} ${s.rows === 1 ? "row" : "rows"})`).join(", ");
  return `${seedRows.length === 1 ? "table" : "tables"} ${listed}`;
}

/**
 * Where a source's seed rows still are, and the commands that land them — only
 * those that WRITE rows. A release lands its rows through `deploy release:`
 * (this project's ephemeral) or `tenant deploy`; a promote lands logic on a
 * branch and writes no table, and `deploy <release> --to` is refused outright
 * — the command this said before (E2E pass 25).
 */
export function seedRowsLanding(source: string, flags = ""): string {
  const release = /^release:(.+)$/.exec(source)?.[1];
  if (release === undefined) {
    return `They stay on ${source}, and a table's \`seed\` option puts rows in code.`;
  }
  return (
    `They stay on the release: \`xanosdk deploy ${shellQuote(`release:${release}`)} --ephemeral${flags}\` lands them on this ` +
    `project's ephemeral, and \`xanosdk tenant deploy <tenant> ${shellQuote(release)}${flags}\` on a tenant (a promote ` +
    `writes no rows). A table's \`seed\` option puts rows in code.`
  );
}
