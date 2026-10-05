/**
 * `xanosdk release create <name>` — cut a release from something live, and land
 * it in the workspace.
 *
 * Split out of the `release` namespace (`release-ns-command.ts`), which
 * dispatches here. The cut is the one `release` verb that resolves a source,
 * compares it against a local compile, selects rows, and confirms after the
 * write where the server actually cut from — everything below exists for it.
 *
 * ## A release is only ever cut from something live
 *
 * `--from` takes an environment, a tenant, or the workspace — never a bundle on
 * disk and never the local project. The platform's own CLI allows building one
 * from local files; this deliberately does not, because the guarantee is worth
 * more than the shortcut: if a release exists, the code in it came up and
 * answered. Non-live kinds are refused by the parser, before any network call,
 * so the error names the accepted kinds rather than arriving as a server
 * rejection.
 *
 * ## A name that exists is refused
 *
 * With no `--force` to override. Cutting a new name is free, and a release may
 * be what a tenant is currently running — silently replacing it is not a
 * failure mode worth a flag.
 *
 * ## What it reports
 *
 * The shared operation result (`operation-result.ts`), one step: `cut`.
 */
import { assertOneName } from "./name-argument.js";
import { withArticle } from "../util/article.js";
import { suggest } from "../util/suggest.js";
import { join, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { CliError, LocalFileNotFoundError, UsageError } from "./errors.js";
import { differOnlyInNormalisation, differingCodePoints } from "./name-normalisation.js";
import { existsSync, statSync } from "node:fs";
import { tablesCommand } from "./commands.js";
import { isMachineOutput } from "./output.js";
import { confirm } from "./prompt.js";
import {
  step,
  success,
  warn,
  detail,
  info,
  formatTableListing,
  credentialWriteTarget,
  discloseWriteTarget,
} from "./ui.js";
import { CUT_KINDS, type Source } from "./source-selector.js";
import {
  describeBackend,
  isUnansweredLookup,
  refuseWorkspaceless,
  resolveSource,
  type CredentialProvider,
  type ResolvedSource,
} from "./source-resolve.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, selectBackend } from "./tracked-backend.js";
import { shellWord } from "./command-line.js";
import { pastePath } from "./typed-cwd.js";
import { contextFlags } from "./context-flags.js";
import { pipedYes, retryCommand, withheldNote } from "./retry-command.js";
import {
  getRelease,
  createRelease,
  deleteRelease,
  assertUsableReleaseName,
  describeWithOrigin,
  reservedDescriptionLine,
  RESERVED_DESCRIPTION_PREFIX,
  type ReleaseSummary,
} from "../deploy/release.js";
import { guardedIn, listTables, someTableRow, type TableSummary } from "../deploy/table.js";
import { bindingFor } from "../util/http.js";
import { findReleaseSource } from "../deploy/audit-log.js";
import { assertBranchReadSupported, exportWorkspaceBundle, type ExportedBundle } from "../deploy/workspace-export.js";
import { compareToLive, SETTINGS_LABEL } from "../deploy/live-diff.js";
import { describeUncarried, rowHoldsFile, uncarriedFiles } from "../deploy/release-hosted-files.js";
import { assertBundleFile, loadBundleText } from "./bundle-input.js";
import { resolveProjectEntry } from "./deploy-source.js";
import { backendDirIn } from "./backend-dir.js";
import { displayPath, relForwardSlash } from "../util/rel-path.js";
import { listBranches, liveBranchLabel, requireBranch } from "../deploy/branch.js";
import {
  createOperation,
  runOperation,
  OperationError,
  type OperationBuilder,
} from "./operation-result.js";
import { classifyFailure } from "./operation-outcome.js";
import { EXIT_RELEASE_REFUSED, releaseOrigin, describeOrigin, lookupRelease, type ReleaseOrigin } from "./release-common.js";

/**
 * Which live source `release create` cuts from: `--from`, or bare — the
 * backend this project last deployed to.
 *
 * Both halves are the shared ones. The slot the registry declares refuses a
 * Xano Engine with its reason (the cut runs on the instance) whether it was
 * typed or came from the pointer, and the tracked-backend resolver owns the
 * three ways the default can fail — another profile, another workspace, never
 * deployed — so this command names the same fix every other bare command does.
 *
 * A tenant PARSES. Whether this particular tenant may be a source depends on
 * its type, which is not knowable from the string — so that policy lives in
 * `refuseLiveDeployment`, after the lookup. A bundle path is refused here
 * rather than at the server: a perfectly good source for `deploy` and a
 * category error for a release.
 */
type LiveSource = Extract<Source, { kind: (typeof CUT_KINDS)[number] }>;

async function resolveFrom(args: ParsedArgs, credential: CredentialProvider, cwd: string): Promise<LiveSource> {
  const slot = requireBackendSlot("release", "create", "from");
  const source = await selectBackend(slot, args.from, { credential, deps: { cwd } });
  if (!(CUT_KINDS as readonly string[]).includes(source.kind)) {
    throw new Error(`Internal: \`release create --from\` selected ${withArticle(source.kind)}, which its slot does not accept.`);
  }
  return source as LiveSource;
}

/**
 * Refuse to cut from a tenant that is somebody's live deployment.
 *
 * An ALLOW-list, mirroring the server, so a tenant type added later is refused
 * by default rather than silently becoming a valid source by way of a check
 * nobody remembered to extend. A missing or unrecognized type therefore fails
 * too, which is the fail-closed reading.
 *
 * Runs after the tenant lookup because a type cannot be read off the name.
 * That costs one request before the refusal — but nothing is cut anywhere, and
 * the request was already being made to resolve the source at all.
 *
 * Deliberately not inside `resolveSource`: resolving is shared with `deploy`,
 * `pull` and `tenant deploy`, and landing a release ON a standard tenant is the
 * entire point of that last one. Reading from one is what this refuses.
 */
const THROWAWAY_TENANT_TYPES = ["ephemeral", "sandbox"];

async function refuseLiveDeployment(resolved: ResolvedSource): Promise<void> {
  if (resolved.kind !== "tenant") return;
  const type = resolved.target.tenantType;
  if (type !== undefined && THROWAWAY_TENANT_TYPES.includes(type)) return;

  const t = resolved.target.label;
  // A tenant on its own domain has no workspace until a release lands, so its
  // pull finds nothing; the way on is said only when it can work.
  const { tenantHasWorkspace } = await import("../deploy/tenant.js");
  const pullable = resolved.backend?.kind !== "hosted" || (await tenantHasWorkspace(resolved.backend.auth, resolved.target.base));
  throw new UsageError(
    `A release cannot be cut from ${t}` +
      `${type === undefined ? "" : ` — it is a \`${type}\` tenant`}.\n` +
      `Only a throwaway tenant (${THROWAWAY_TENANT_TYPES.join(" or ")}) can be a source: a ` +
      `standard or run tenant is a live deployment. \`xanosdk tenant get ${t}${contextFlags()}\` names the ` +
      `last release landed there, and that release lands anywhere as it is — but any \`deploy --to\` merge ` +
      `since may have changed what the tenant runs.\n` +
      // Never with `--yes`: the pull's own confirmation and its uncommitted-changes
      // check are what keep it from replacing edits, and off a terminal it
      // refuses with its own rerun.
      (pullable
        ? `To start from what it runs now, pull it into this project (\`xanosdk pull tenant:${t}${contextFlags()}\`), ` +
          `\`xanosdk deploy --ephemeral\` it to an ephemeral, and cut from there.`
        : `It has no workspace yet — a tenant on its own domain gets one when its first release lands — so ` +
          `there is nothing on it to pull or cut from until then.`),
    { hintFor: { command: "release", subcommand: "create" } },
  );
}

/** How the source reads in a sentence: `your workspace (branch "x")` for a named branch. */
function sourceLabel(resolved: ResolvedSource, branch: string | undefined): string {
  // An environment by its kind, name and display name (`ephemeral "ebhr-…"
  // ("My App")`): its bare name is a server-assigned handle nobody calls it by.
  if (resolved.kind === "ephemeral" || resolved.kind === "tenant") return describeBackend(resolved);
  return resolved.kind === "workspace" && branch !== undefined
    ? `${resolved.target.label} (branch ${JSON.stringify(branch)})`
    : resolved.target.label;
}

/** An environment source's actual type — `ephemeral`, `sandbox` — for the origin line and the wording. */
function environmentType(resolved: ResolvedSource): string {
  if (resolved.kind === "ephemeral") return "ephemeral";
  return resolved.target.tenantType ?? "environment";
}

/**
 * What the comparison compiles — or `undefined` when there is nothing to
 * compare against.
 *
 * Built here rather than by handing `args` through, because `args.file` is
 * NEVER an entry on this command: it is `positionals[0]`, and for this noun that
 * positional is the RELEASE NAME. Both earlier readings of it were dead. Taking
 * it as an entry made the check fire on every `release create <name>` and fail,
 * and gating on `--bundle` while leaving `file` in place left
 * `loadBundleText` refusing "an entry AND a bundle" on every real command line
 * — the same "Could not compare against a local compile" line, now on the one
 * invocation that had asked for the comparison. So `file` is set
 * deliberately or cleared, and never inherited.
 *
 * The default is the project's own entry, the same one a bare `xanosdk deploy`
 * compiles. An opt-in comparison would be no guard at all: the author who
 * forgot to deploy is the author who forgets to ask.
 *
 * `undefined` covers the project with no discoverable entry, and the caller
 * SAYS so rather than returning in silence. A silent decline is exactly the
 * reading to avoid: a cut that prints nothing would again mean either
 * "compared, and your disk matches" or "never compared at all", and an author
 * cannot tell which. The source's export is read either way — the files guard
 * needs it — so declining skips only the local compile.
 *
 * `--entry` names the entry (a nested backend the default does not find);
 * otherwise it is the project's own. It is resolved against `cwd` before it travels, because
 * `resolveProjectEntry` answers relative to the directory it was asked about
 * and the compile must not then re-resolve it against an ambient one.
 *
 * The lock flags are cleared rather than inherited. They are no longer offered on
 * this command (see `COMPARISON_LOCK_FLAGS` in `commands.ts`), but "not in the
 * help" is not "not parseable": every one of them is read by the one global parse
 * loop, exactly as `--bundle` was. Left inherited, `release create --no-lock` over
 * a committed lock would be REFUSED by the compile and land in the catch as
 * "could not compare" — a flag that silently disables the guard while the output
 * still looks like it ran. The comparison always uses the project's real lock,
 * which is the only lock that makes its answer mean anything.
 */
function comparisonInput(args: ParsedArgs, cwd: string): ParsedArgs | undefined {
  const lockDefaults = {
    lock: false,
    lockPath: undefined,
    noLock: false,
    frozenLock: false,
    allowLockOrphans: false,
    // Read, never written: this compile answers a question, and a cut that
    // created or rewrote `xano.lock` (with its "commit it" notice) changed the
    // project behind a command that only reads it.
    lockReadOnly: true,
  };
  if (args.bundle !== undefined) return { ...args, ...lockDefaults, file: undefined };
  const entry = args.entryPath ?? resolveProjectEntry(cwd);
  if (entry === undefined) return undefined;
  return { ...args, ...lockDefaults, file: resolve(cwd, entry), bundle: undefined };
}

/**
 * How to make the source match the disk, for the source actually being cut.
 *
 * `xanosdk deploy --ephemeral` ships to an EPHEMERAL. Offering it for a `--from
 * workspace` cut sends the author to run a command that leaves the workspace
 * exactly as divergent, and the re-cut then prints the same warning — a guard
 * whose own advice cannot silence it is one people learn to scroll past, which
 * costs the true positives too.
 *
 * A `tenant:<name>` source is worded by its actual type. Only an ephemeral or a
 * sandbox reaches here (`refuseLiveDeployment` refuses the rest), and both are
 * deployed to directly — so the remedy is a deploy to that tenant, not the
 * "cut and land it" a standard tenant would need. A workspace cut of a named
 * branch deploys to THAT branch: without `--branch` the remedy's deploy lands
 * on live, and the re-cut reads the same stale branch.
 */
function remedyFor(
  resolved: ResolvedSource,
  bundle: string | undefined,
  branch?: string,
  name?: string,
  entry?: string,
  /** Whether workspace settings differ: `"only"` when nothing else does. */
  settings?: "only" | "also",
): string {
  // With `--bundle` the comparison was against that file, not this project's
  // compile, so the remedy deploys THAT — "the current code" named nothing
  // the reader had compared.
  // …and the run's credential flags, so the deploy reaches the backend this cut read.
  const flags = contextFlags();
  // `--entry` named the compile compared: the deploy ships that entry, not the default one.
  const input = `${entry === undefined ? "" : ` ${shellWord(entry)}`}${bundle === undefined ? "" : ` --bundle ${shellWord(bundle)}`}${flags}`;
  const what = bundle === undefined ? "the current code" : "that bundle";
  if (resolved.kind === "workspace") {
    if (branch === undefined) {
      return `Run \`xanosdk deploy --to workspace${input}\` first if you meant to cut ${what}.`;
    }
    // Not `deploy --to workspace --branch <this branch>`: a release into a
    // workspace branch creates it, and refuses a label that already exists
    // (SDK_BRANCH_TAKEN) — which the branch just cut always does. So the
    // remedy that runs is a NEW branch, and the cut from it.
    const cutName = name === undefined ? "<name>" : shellWord(name);
    // Workspace settings are not the branch's: no branch deploy applies them,
    // so the new-branch remedy cannot clear a settings difference.
    const settingsNote =
      `Workspace settings are shared by every branch, so no branch deploy changes them — and a promote keeps ` +
      `the destination's own, so they do not change what this release lands. To clear the settings line, declare ` +
      `the workspace's values in this project, or apply yours with \`xanosdk deploy --to workspace${input}\` (onto live).`;
    if (settings === "only") return settingsNote;
    return (
      `To cut ${what}, deploy it to a new branch and cut from that: ` +
      `\`xanosdk deploy --to workspace --branch <new-label>${input}\`, then ` +
      `\`xanosdk release create ${cutName} --from workspace --branch <new-label>${flags}\`. ` +
      `(\`deploy --to workspace --branch\` refuses a label that already exists, so it cannot update ${shellWord(branch)}.)` +
      (settings === "also" ? ` ${settingsNote}` : "")
    );
  }
  if (resolved.kind === "tenant") {
    return `Run \`xanosdk deploy --to tenant:${resolved.target.label}${input}\` first if you meant to cut ${what}.`;
  }
  return `Run \`xanosdk deploy --ephemeral${input}\` first if you meant to cut ${what}.`;
}

/**
 * Warn when the source environment does not match a fresh local compile.
 *
 * A release claims its contents came up — not that they match what is on your
 * disk. An author who edits, forgets to deploy, and cuts a release names the
 * PREVIOUS code after the current one. Best effort by design: this is a
 * courtesy on top of a valid operation, so anything that goes wrong while
 * checking is reported and stepped over rather than raised.
 *
 * The source side is the export the files guard already read (see
 * {@link readSourceExport}); the local side is a REAL compile against the
 * project's lock — the identities a release would send. The lock is read and
 * never written (`lockReadOnly`): a cut is not the command that should create
 * or rewrite it.
 */
async function warnOnDivergence(
  args: ParsedArgs,
  resolved: ResolvedSource,
  cwd: string,
  live: ExportedBundle,
): Promise<CutDrift> {
  const input = comparisonInput(args, cwd);
  if (input === undefined) {
    // Named, not silent. See `comparisonInput`: this is the skip that would
    // otherwise be indistinguishable from a clean comparison.
    const looked = relForwardSlash(cwd, join(backendDirIn(cwd), "index.ts"));
    detail(
      `No project entry found (looked for ${looked}) - skipped the comparison against a local compile. ` +
        `\`--entry=<path>\` names the entry to compare against.`,
    );
    return { checked: false, reason: `no project entry found (looked for ${looked})` };
  }
  const bundleGiven = input.bundle !== undefined;
  try {
    const branch = resolved.kind === "workspace" ? args.branch : undefined;
    const local = await loadBundleText(input, { command: "release", subcommand: "create" });
    // The same question `workspace diff` asks, with the same pins and the same
    // documentation rule, so the two cannot disagree about one workspace.
    const { codePinnedCanonicals, releaseCanonicalLock } = await import("./release-command.js");
    const pinned = codePinnedCanonicals(
      local.bundle,
      releaseCanonicalLock(input, local.classifiedLock),
      input.file !== undefined,
    );
    // Every object, not the report's sample: the `--json` caller is owed the
    // whole list, and the text below caps its own.
    const convergence = compareToLive(
      JSON.parse(local.bundle) as unknown,
      live,
      new Set(pinned.map((p) => `${p.payloadKey}:${p.name}`)),
      { documentation: "compare", sample: "all" },
    );
    // Both classes, counted together and NAMED together. The comparison reports
    // "the environment is running an older one" and "the environment has none of
    // it" apart, because a diff needs them apart — but to this warning they are
    // one fact, and describing two absent objects as objects that "differ" sends
    // the author hunting for a stale copy that was never there.
    //
    // And the third class: objects the source holds that the local side does
    // not declare at all. The release carries them too — a workflow test left
    // on the source rode into the cut while drift reported 0.
    const extra = convergence.liveOnly.length;
    const behind = convergence.differingCount + convergence.missingCount + extra;
    // The settings row by the fields that differ, as `workspace diff` names it.
    // Each class marked, so an object the source lacks does not read as one
    // that differs (E2E pass 19: a missing `mcpServer:` carried no marker
    // while its "not in this project" siblings did).
    const objects = [
      ...convergence.differing.map((name) =>
        name === SETTINGS_LABEL && convergence.settingsFields.length > 0
          ? `${name} — ${convergence.settingsFields.join(", ")}`
          : name,
      ),
      ...convergence.missing.map((name) => `${name} (not on the source)`),
      ...convergence.liveOnly.map((name) => `${name} (not in ${bundleGiven ? "the bundle" : "this project"})`),
    ];
    // One spelling for both inputs: relative to where the command was typed when
    // the file is under it, absolute otherwise — never absolute for one and not the other.
    const against = displayPath(resolve(cwd, local.source));
    if (behind > 0) {
      const label = sentenceStart(sourceLabel(resolved, branch));
      warn(
        `${label} does not match ` +
          `${bundleGiven ? against : "a fresh compile of this project"} ` +
          `(${behind} object${behind === 1 ? "" : "s"} differing, missing or extra).`,
        "release.drift",
        [
          ...objects.slice(0, DRIFT_SHOWN),
          ...(behind > DRIFT_SHOWN ? [`… and ${behind - DRIFT_SHOWN} more`] : []),
          `The release will carry what is RUNNING there, not what ${bundleGiven ? "that bundle holds" : "is on your disk"}.`,
          remedyFor(
            resolved,
            bundleGiven ? against : undefined,
            branch,
            args.positionals[0]?.trim(),
            !bundleGiven && args.entryPath !== undefined ? pastePath(args.entryPath) : undefined,
            convergence.differing.includes(SETTINGS_LABEL) ? (behind === 1 ? "only" : "also") : undefined,
          ),
        ],
      );
    }
    return { checked: true, against, count: behind, objects };
  } catch (err) {
    // A broken xano.lock (conflict markers, a duplicate key) is refused as
    // every other command refuses it — not a comparison quietly skipped.
    if (err instanceof Error && err.message.startsWith("Invalid lock file ")) {
      throw new Error(`${err.message}\nNothing was cut.`, { cause: err });
    }
    detail(`Could not compare against a local compile: ${(err as Error).message}`);
    return { checked: false, reason: (err as Error).message };
  }
}

const FILES_NOT_CARRIED = "SDK_RELEASE_FILES_NOT_CARRIED";

/**
 * A source label as the opening of a sentence. Capitalised only where the label
 * opens with a word ("your workspace", "ephemeral pr-3"): a bare backend name is
 * an identifier, and "Erve-o6hz-3723" is not the name of anything.
 */
function sentenceStart(label: string): string {
  return label.replace(/^(your|ephemeral|tenant|workspace)\b/, (w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`);
}

/**
 * The source's live export, for the files guard and the drift comparison.
 *
 * Read on every cut, with or without a project entry or `--bundle`: whether
 * the release would drop stored files is a fact about the SOURCE, and the files
 * guard cannot vouch for a cut it could not read. So a failed read refuses the
 * cut — exit 8, nothing cut, this command to re-run — rather than cutting blind.
 *
 * The BRANCH being cut, not the one the workspace happens to serve: the export
 * defaults to live. The capability probe comes first because an instance that
 * ignores the parameter answers 200 with the LIVE branch — no answer beats a
 * confident wrong one. Only `workspace` has branches; the command refuses
 * `--branch` for every other kind.
 */
async function readSourceExport(
  args: ParsedArgs,
  auth: ResolvedAuth,
  resolved: ResolvedSource,
): Promise<ExportedBundle> {
  const branch = resolved.kind === "workspace" ? args.branch : undefined;
  try {
    if (branch !== undefined) {
      await assertBranchReadSupported(auth, {
        base: resolved.target.base,
        workspaceId: resolved.target.workspaceId,
        branch,
      });
    }
    return await exportWorkspaceBundle(auth, { ...resolved.target, ...(branch !== undefined ? { branch } : {}) });
  } catch (err) {
    throw cannotVouch(args, resolved, `could not read its export: ${(err as Error).message}`);
  }
}

/**
 * A read the cut waits on, failed before anything was cut — a 5xx, a dropped
 * connection: exit 8 with this command to re-run, as the export and row reads
 * answer. Nothing was sent, so the rerun is safe whatever the failure was.
 */
async function readBeforeCut<T>(args: ParsedArgs, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    const { command, withheld } = retryCommand(args, { command: "release create", creates: true });
    throw new CliError(
      "SDK_ERROR",
      `Could not ${what}: ${(err as Error).message}
Nothing was cut. Re-run \`${command}\` once it answers.${withheldNote(withheld)}`,
      { exitCode: 8 },
    );
  }
}

/** The files guard could not read what it checks: refused, never cut blind. */
function cannotVouch(args: ParsedArgs, resolved: ResolvedSource, why: string): CliError {
  const { command, withheld } = retryCommand(args, { command: "release create", creates: true });
  return new CliError(
    "SDK_ERROR",
    `Could not check ${resolved.target.label} for stored files a release cannot carry — ${why}\n` +
      `A release copies no file bytes, and a cut that was not checked could drop them silently. Nothing was cut. ` +
      `Re-run \`${command}\` once it answers.${withheldNote(withheld)}`,
    { exitCode: 8 },
  );
}

/**
 * Refuse a cut whose contents point at stored files the release cannot carry.
 *
 * The cut runs on the server and copies no file bytes, so a seeded row's file
 * and a `hostedFile()` icon would land as an empty column and a URL that
 * answers 404 — after a cut reported as a success. Deploying the project
 * directly ships the files, which is the remedy printed. Refused with no
 * override: a release that silently drops files is not one to land anywhere.
 *
 * Seeded rows are read (see `uncarriedFiles`) only for a table with a file
 * column over a non-empty library; a read that fails refuses as unchecked.
 */
async function refuseUncarriedFiles(
  payload: Record<string, unknown>,
  selection: SeedSelection | undefined,
  resolved: ResolvedSource,
  args: ParsedArgs,
  auth: ResolvedAuth,
  cwd: string,
): Promise<void> {
  const byGuid = new Map(selection?.tables.map((t) => [t.guid, t]));
  const files = await uncarriedFiles(payload, selection?.tables, async (want, columns) => {
    const table = byGuid.get(want.guid);
    if (table === undefined) return true;
    try {
      return await someTableRow(
        auth,
        {
          workspaceId: resolved.target.workspaceId,
          tableId: table.id,
          base: resolved.target.base,
          binding: bindingFor(auth, resolved.target.workspaceId, resolved.kind !== "workspace"),
        },
        (row) => columns.some((c) => rowHoldsFile(row, c)),
      );
    } catch (err) {
      throw cannotVouch(args, resolved, `could not read table "${table.name}"'s rows: ${(err as Error).message}`);
    }
  });
  if (files.length === 0) return;
  const rows = files.some((f) => f.kind === "table");
  const effects = [
    ...(rows ? ["those rows' files would be empty"] : []),
    ...(files.some((f) => f.kind !== "table") ? ["those icons would answer 404"] : []),
  ];
  const entry = remedyEntry(args, cwd);
  throw new CliError(
    FILES_NOT_CARRIED,
    `${sentenceStart(resolved.target.label)} serves stored files this release would point at but cannot carry:\n` +
      files.map((f) => `  ${describeUncarried(f)}`).join("\n") +
      `\nA release copies no file bytes, so wherever it lands ${effects.join(" and ")}. ` +
      `Land the project with its files by deploying it directly: ` +
      `\`xanosdk deploy${entry.word}--to tenant:<name>${rows ? " --seed" : ""}${contextFlags(args)}\`` +
      `${entry.note}. Nothing was cut.`,
    { exitCode: EXIT_RELEASE_REFUSED, details: { files } },
  );
}

/**
 * The entry the files refusal's deploy compiles, spelled as it was typed. A bare
 * `deploy` compiles `xano/index.ts`, so it is named whenever that is not what
 * the cut was about: an `--entry`, or no project entry here at all — then a
 * placeholder, since nothing records which entry the source was landed from.
 */
function remedyEntry(args: ParsedArgs, cwd: string): { word: string; note: string } {
  if (args.entryPath !== undefined) return { word: ` ${shellWord(args.entryPath)} `, note: "" };
  if (args.bundle === undefined && resolveProjectEntry(cwd) !== undefined) return { word: " ", note: "" };
  return { word: " <entry> ", note: ` (\`<entry>\`: the backend's \`index.ts\` the source was deployed from)` };
}

/** How many drifted objects the text names before it counts the rest. `--json` carries all. */
const DRIFT_SHOWN = 5;

/**
 * What the pre-cut comparison found, for a `--json` caller.
 *
 * The drift warning went to stderr alone, so a script cutting releases in CI
 * could not tell a clean cut from one that carries code older than its disk.
 * Present on every result that reached the comparison: `checked: false` with
 * the `reason` when it could not run, which is a different answer from a
 * clean one.
 */
interface CutDrift {
  /** Whether the source was compared against a local compile at all. */
  checked: boolean;
  /** Why it was not, when it was not. */
  reason?: string;
  /** What it was compared against — the entry compiled, or the `--bundle` read — relative to the cwd. */
  against?: string;
  /**
   * Objects that differ in, are missing from, or are extra in the source. 0 is
   * a clean comparison.
   */
  count?: number;
  /**
   * Those objects, named as `workspace diff` names them — `<sdkKind>:<name>`,
   * a query with its verb and api group, the settings row with the fields that
   * differ.
   */
  objects?: string[];
}

/**
 * Cut a release from a running environment, and land it in the workspace.
 *
 * One call. The release route takes the environment's tenant name as a source,
 * reads that environment's live state, and writes the record here — so the
 * contents describe the environment while the release itself lands where
 * `list`, `show`, `promote` and `tenant deploy` can all see it. Nothing is
 * written to the environment.
 *
 * ## Why the result is confirmed rather than trusted
 *
 * An instance that predates the source parameter does not refuse it. It DROPS
 * it, cuts from this workspace instead, and answers `200` — and the response
 * carries no trace of where the bytes came from, so success and silent
 * substitution are identical on the wire. That is not a compatibility nicety:
 * a release is durable and promotable, and one carrying the wrong code is wrong
 * on every destination it is later landed on.
 *
 * The audit log records the source the server actually resolved, so the cut is
 * confirmed there. An unconfirmed cut is refused — and because the confirmation
 * necessarily arrives AFTER the record exists, refusing also means deleting the
 * release that was just created. Left behind, it would be a release whose
 * contents are not what its name claims, holding the name a corrected re-run
 * needs.
 */
async function cutFromEnvironment(
  auth: ResolvedAuth,
  name: string,
  resolved: ResolvedSource,
  description: { description?: string; tableIds?: number[] },
  op: CutOperation,
  lookFor: CutLookFor,
  flags: string,
  /** This command line, for a confirmation read that got no answer. */
  rerun: { command: string; withheld: readonly string[] },
): Promise<ReleaseSummary> {
  const tenant = resolved.target.env;
  if (tenant === undefined) {
    throw new Error(
      `cut release: ${resolved.target.label} did not resolve to a tenant name, so it cannot be ` +
        `named as a source. Nothing was added to your workspace.`,
    );
  }

  // Cut and land in ONE call, against this workspace. The environment is named
  // as the source; its own meta API is not addressed at all.
  const cut = await sendCut(auth, op, lookFor, () =>
    createRelease(auth, {
      workspaceId: auth.workspaceId,
      name,
      branch: "",
      sourceTenant: tenant,
      // Carries `tableIds` when rows were asked for — the TENANT's ids, resolved
      // against the tenant's own listing, because a tenant's workspace is always
      // id 1 and ids from anywhere else name other tables.
      ...description,
      // The origin, on the description's last line: the record keeps no source
      // field and the audit entry that names one is pruned with the log, so
      // `release show` and a landing's password-hash warning read it here.
      description: describeWithOrigin(description.description, { type: environmentType(resolved), name: tenant }),
    }),
  );

  detail(`Confirming it was cut from ${resolved.target.label}`);
  // Confirmed under the name the server STORED, not the one we asked for. A
  // taken name is suffixed rather than refused (`v2` → `v2-a019`), and the
  // audit entry records the suffixed one — so a lookup by the requested name
  // finds nothing and discards a correct cut, or finds a concurrent cut's entry
  // and confirms a source this release was never cut from.
  await confirmCutFrom(auth, op, {
    name: cut.name !== "" ? cut.name : name,
    tenant,
    cut,
    label: resolved.target.label,
    flags,
    rerun,
  });

  // Read back BY ID, never by the name we asked for. The create response is the
  // record the server actually wrote, and its id is the one handle on it that
  // the write cannot have changed under us — the import behind a cut can rename
  // what it just stored, and a reconcile by name then finds nothing and reports
  // the release we are holding as gone. It is also one request against one
  // record rather than a walk of every page of the list.
  //
  // A create that returned no id, an id the server no longer answers for, or a
  // read that fails outright, falls back to the create response: it is still
  // the record of what was cut, and it has been confirmed. The read only
  // refreshes the identity — losing it must not turn a release that exists and
  // was vouched for into a reported failure.
  if (cut.id === undefined) return cut;
  try {
    return (await getRelease(auth, { workspaceId: auth.workspaceId, id: cut.id })) ?? cut;
  } catch (err) {
    // The failure's own cause only: a transport error's "Nothing was changed —
    // retry" speaks of the read, and here the cut has already landed — a retry
    // is refused, as the name is taken.
    const cause = causeOnly(err);
    const shown = cut.name !== "" ? cut.name : name;
    detail(
      `The release was cut, but reading it back failed (${cause}); reporting it as the cut returned it. ` +
        `\`xanosdk release show ${shellWord(shown)}${contextFlags()}\` reads it again.`,
    );
    return cut;
  }
}

/**
 * Refuse a release the server did not cut from the tenant we named.
 *
 * Both failures — no source recorded, or a different one — mean the same thing
 * to the caller and get the same treatment: remove the release, then raise.
 *
 * A failed confirmation READ is also a refusal. An instance that cannot say
 * where it cut from is, from here, indistinguishable from one that cut from the
 * wrong place, and `assertBranchReadSupported` refuses a missing signal on the
 * read side for the same reason.
 */
async function confirmCutFrom(
  auth: ResolvedAuth,
  op: CutOperation,
  opts: {
    name: string;
    tenant: string;
    cut: ReleaseSummary;
    label: string;
    flags: string;
    rerun: { command: string; withheld: readonly string[] };
  },
): Promise<void> {
  let recorded: Awaited<ReturnType<typeof findReleaseSource>>;
  try {
    recorded = await findReleaseSource(auth, { workspaceId: auth.workspaceId, releaseName: opts.name });
  } catch (err) {
    // A read that got no answer exits 8 with this command to re-run, as every
    // other unanswered read does; the cut it could not vouch for is removed
    // first, or named with the delete that frees its name.
    const unanswered = isUnansweredLookup(err);
    const again = `re-run \`${opts.rerun.command}\` once it answers.${withheldNote(opts.rerun.withheld)}`;
    return refuseCut(
      auth,
      op,
      opts.cut,
      opts.name,
      opts.flags,
      (removal) =>
        `Cut "${opts.name}" from ${opts.label}, but could not confirm where it was cut from: ${causeOnly(err)}.\n` +
        (removal.removed
          ? `The release has been removed rather than left with contents that cannot be vouched for` +
            (unanswered ? ` — ${again.charAt(0).toUpperCase()}${again.slice(1)}` : ".")
          : `It was left behind and could NOT be removed — delete it with \`${removal.removeWith}\`` +
            (unanswered ? `, then ${again}` : ` before re-cutting, or the name will collide.`)),
      unanswered ? 8 : undefined,
    );
  }

  // Compare what the server RESOLVED against the handle we resolved, not
  // against anything the user typed — the tracked name is already the
  // server-assigned one, so normalization on either side cannot make a correct
  // cut look wrong.
  if (recorded !== null && recorded.tenantName === opts.tenant) return;

  const source = recorded?.tenantName;
  return refuseCut(auth, op, opts.cut, opts.name, opts.flags, (removal) =>
    source === undefined
      ? `Refusing the release "${opts.name}": this instance ignored the source and cut from your ` +
          `workspace instead.\n` +
          `  instance: ${auth.instance}\n` +
          `It accepted \`${opts.tenant}\` as a source and recorded no source at all, which is what ` +
          `an instance predating this capability does. The release would have carried YOUR ` +
          `workspace's current state under ${opts.label}'s name — ` +
          (removal.removed ? `so it has been removed.` : `and it could NOT be removed: ${removal.remedy}`) +
          `\nCut \`--from workspace\` if that is what you want, or wait for this instance to take the ` +
          `update.`
      : `Refusing the release "${opts.name}": it was cut from "${source}", not from ` +
          `${opts.label} (\`${opts.tenant}\`). ` +
          (removal.removed ? `It has been removed.` : `It could NOT be removed — ${removal.remedy}`),
  );
}

/**
 * Remove a release that must not be kept.
 *
 * Best effort by construction: the caller is already raising, and a failed
 * cleanup must not replace the reason for the refusal with a reason about the
 * cleanup. What it must never do is let the refusal become a success.
 */
async function discard(auth: ResolvedAuth, cut: ReleaseSummary): Promise<boolean> {
  if (cut.id === undefined) return false;
  return deleteRelease(auth, { workspaceId: auth.workspaceId, id: cut.id }).then(
    () => true,
    () => false,
  );
}

/**
 * Discard a cut the command will not vouch for, record the outcome, and raise.
 *
 * The cut is recorded `no` EXPLICITLY, before the throw. Left to the throw, a
 * plain refusal raised after the create was sent would classify as a write
 * that may have landed — `unknown`, exit 9, and a resolver sending the caller
 * to look for a release this command has just deleted. The state is known
 * either way: removed, or still there under a name this can say.
 *
 * Whether the removal worked decides two things together, so they cannot
 * disagree: the `residue` the result carries, and what the message claims. A
 * message saying "removed" over a failed delete leaves the reader believing the
 * name is free when it is not.
 */
async function refuseCut(
  auth: ResolvedAuth,
  op: CutOperation,
  cut: ReleaseSummary,
  storedName: string,
  /** `--yes` where this run was not asked, then its `--profile`/`--config`, so the removal acts on this workspace. */
  deleteFlags: string,
  message: (removal: { removed: boolean; remedy: string; removeWith: string }) => string,
  /** The exit code of a refusal whose cause was a read that got no answer. */
  exitCode?: number,
): Promise<never> {
  const removed = await discard(auth, cut);
  const removeWith = `xanosdk release delete ${shellWord(storedName)}${deleteFlags}`;
  if (!removed) {
    op.setResidue({ ...(cut.id === undefined ? {} : { id: cut.id }), name: storedName, removeWith });
  }
  op.finish("cut", "no");
  const text = message({
    removed,
    removeWith,
    remedy: `delete it with \`${removeWith}\` before re-cutting, or the name will collide.`,
  });
  throw exitCode === undefined ? new Error(text) : new CliError("SDK_ERROR", text, { exitCode });
}

/**
 * A failure's own cause, first line only, without a transport error's "Nothing
 * was changed — retry": by the time a read after a cut fails, the cut has
 * landed, so that sentence would be false.
 */
function causeOnly(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n")[0] ?? "")
    .replace(/\s*Nothing was (?:changed|created)[^.]*\.?/g, "")
    .trim()
    .replace(/[.:;]$/, "");
}

// ── row selection (`--seed`) ────────────────────────────────────────────────

/**
 * What `--seed` resolved to: the ids to send, and the tables they name.
 *
 * `undefined` when `--seed` was not given at all, which is distinct from an
 * empty selection — the former sends no `table_ids` key, and there is no
 * spelling for the latter. The tables carry both identifiers: the guid the
 * caller selected by, and the id the wire needs.
 */
interface SeedSelection {
  readonly tables: TableSummary[];
}

/**
 * The one-line help pointer under a `--seed` value that does not parse — the
 * sentence already names the fix, so the whole usage block would only bury it.
 * A refusal of what the SOURCE holds (no tables, a stale guid) carries none:
 * the stale-guid one prints the real listing.
 */
const SEED_HELP = { hintFor: { command: "release", subcommand: "create" } } as const;

/** The one-line help pointer every `release create` refusal of what was typed ends with. */
const CREATE_HINT = { hintFor: { command: "release", subcommand: "create" } } as const;

/**
 * The `tables` invocation that lists the guids of a given source:
 * `xanosdk tables ephemeral:pr-3`.
 *
 * Per-source rather than always the workspace, because the workspace's tables
 * are NOT the ephemeral's: a deploy preserves the guids of the objects the
 * PROJECT carries, and says nothing about tables a destination holds that the
 * project does not. A refusal that pointed at the wrong listing would hand the
 * reader a second set of guids that also do not match, from inside the message
 * meant to end the first confusion.
 *
 * Built from the source's provenance — the selector spelling that names it —
 * so it is exactly what `tables` parses back to the same backend.
 * `release-create-seed.test.ts` asserts that for every cuttable kind.
 */
export function listingVerb(resolved: ResolvedSource): string {
  return tablesCommand(resolved.provenance);
}

/**
 * Parse `--seed=<guids>` into guid tokens.
 *
 * DELIBERATELY PERMISSIVE on shape. Two spellings are in play — the
 * SDK derives 32-char hex, the engine assigns ~27-char base64url — and a
 * validator pinned to either would reject legitimate input the moment the other
 * appeared. The hex shape must parse in particular, because an unmatched one
 * earns a SPECIFIC refusal below rather than a syntax error.
 *
 * So the only syntactic gates are the two that rule out a name: a comma is the
 * delimiter, and whitespace never appears in a guid while a table name may hold
 * it freely (the engine declares the name as unfiltered free text and its own
 * documented example is `new table 123`). Everything else is left to the
 * membership check against the source's listing — the only check that can
 * actually tell a valid guid from a stale one.
 */
function parseSeedGuids(raw: string): string[] {
  const tokens = raw.split(",").map((t) => t.trim());
  if (tokens.every((t) => t === "")) {
    throw new UsageError(
      `\`--seed=\` names no tables. Use bare \`--seed\` for every table's rows, or ` +
        `\`--seed=<guids>\` with guids from \`${tablesCommand()}\`.`,
      SEED_HELP,
    );
  }
  const guids: string[] = [];
  for (const token of tokens) {
    // Two different mistakes, so two different sentences: an empty token is a
    // stray comma, while one carrying whitespace is a table name.
    if (token === "") {
      throw new UsageError(
        `\`--seed\` has an empty entry — a stray comma in ` +
          `${JSON.stringify(raw)}. List one guid per comma.`,
        SEED_HELP,
      );
    }
    if (/\s/.test(token)) {
      throw new UsageError(
        `\`--seed\` takes table GUIDS, and ${JSON.stringify(token)} is not one — a guid holds no ` +
          `whitespace. A table NAME cannot be used here: a name may contain a comma or a space, ` +
          `and renaming a table would silently re-target a saved selection. Run ` +
          `\`${tablesCommand()}\` for the guids.`,
        SEED_HELP,
      );
    }
    // Deduped rather than refused: naming a table twice asks for one thing.
    if (!guids.includes(token)) guids.push(token);
  }
  return guids;
}

/**
 * The shape of a guid the engine assigns: ~27 base64url characters. Loose on
 * length on purpose — it only has to tell a guid from a word someone typed.
 */
const ENGINE_GUID_SHAPE = /^[A-Za-z0-9_-]{20,}$/;

/** The 32-char hex shape this project derives, in either case — hex case carries nothing. */
function isHexGuid(guid: string): boolean {
  return /^[0-9a-f]{32}$/i.test(guid);
}

/**
 * Why a guid the source does not have might not match, named specifically.
 *
 * Two causes, because the remedies differ and guessing wrong sends the reader
 * hunting. The split is by the guid's SHAPE, which says who minted it, and each
 * shape has its own likely story now that a deploy PRESERVES the guids the
 * archive carries:
 *
 *  • 32-char hex is what this project derives (`md5(dbo:<name>)`) and pins in
 *    `xano.lock`. A deploy stores it verbatim, so it normally DOES match — and
 *    the thing that breaks it is a RENAME, because the name is the seed. The
 *    remedy is `xanosdk lock rename`, not retyping the guid.
 *  • Anything else was assigned by the engine, which happens for a backend this
 *    project did not deploy, or one deployed before guid preservation. Those
 *    guids are per-environment and do not travel.
 *
 * Both lines appear when a selection mixes the two.
 *
 * Before either: a value that is no guid at all. A table NAME is the likeliest
 * (the source's listing says which guid it has), and anything shaped like
 * neither guid is named as not-a-guid — telling someone who typed a name that
 * it "belongs to a backend this project did not deploy" sends them hunting for
 * a backend.
 */
function unmatchedGuidCauses(
  unmatched: readonly string[],
  tables: readonly TableSummary[] = [],
): string {
  const lines: string[] = [];
  // A table NAME is the likeliest thing to be typed here, and "a guid in the
  // engine's own format" is the wrong story for it. Said first, with the guid
  // to use instead when the name is one the source has.
  const byName = new Map(tables.map((t) => [t.name, t]));
  const named = unmatched.filter((g) => byName.has(g));
  for (const name of named) {
    lines.push(`"${name}" is a table NAME, and \`--seed\` expects a table guid — its guid is ${byName.get(name)!.guid}.`);
  }
  // A table's numeric ID, read off a listing that prints both (E2E pass 30:
  // `--seed=1` was called "not a table guid" with no word of the guid meant).
  const byId = tableById(tables);
  const ids = unmatched.filter((g) => !byName.has(g) && byId.has(g));
  for (const id of ids) {
    const t = byId.get(id)!;
    lines.push(`${id} is table "${t.name}"'s ID, and \`--seed\` expects its guid — ${t.guid}. IDs are per host; the guid travels.`);
  }
  // A guid a character or two off one the source holds is a mistyped copy, not
  // a rename (E2E pass 28: `…39bfF` for `…39bfe` was blamed on a rename).
  const guids = tables.flatMap((t) => (t.guid === undefined ? [] : [t.guid]));
  const byGuid = new Map(tables.map((t) => [t.guid, t]));
  const typos = new Map<string, TableSummary>();
  for (const g of unmatched) {
    if (byName.has(g) || byId.has(g) || (!isHexGuid(g) && !ENGINE_GUID_SHAPE.test(g))) continue;
    const near = suggest(g, guids);
    if (near !== undefined) typos.set(g, byGuid.get(near)!);
  }
  for (const [g, t] of typos) {
    lines.push(
      `${g} is close to table "${t.name}"'s guid ${t.guid} but not it — a mistyped copy? Use ${t.guid}` +
        (isHexGuid(g) ? "." : ` (an engine guid is matched exactly, case included).`),
    );
  }
  const rest = unmatched.filter((g) => !byName.has(g) && !byId.has(g) && !typos.has(g));
  // Nothing the engine or this project mints looks like this: short, or carrying
  // a character no guid uses. Named as not-a-guid rather than blamed on a backend.
  const notGuids = rest.filter((g) => !isHexGuid(g) && !ENGINE_GUID_SHAPE.test(g));
  if (notGuids.length > 0) {
    lines.push(
      `${notGuids.map((g) => JSON.stringify(g)).join(", ")} ${notGuids.length === 1 ? "is" : "are"} not a table guid — ` +
        // The listing is named once, by the refusal's own "Run …" line (E2E pass 19: twice).
        `\`--seed\` expects table guids.`,
    );
  }
  const derived = rest.some(isHexGuid);
  const engineMinted = rest.some((g) => !isHexGuid(g) && ENGINE_GUID_SHAPE.test(g));
  if (derived) {
    lines.push(
      `A 32-character hex guid is the value THIS PROJECT derives and pins in \`xano.lock\`, and a ` +
        `deploy stores it as-is — so one that does not match usually means the table was RENAMED ` +
        `or removed in code since the guid was noted (the name is what the guid derives from). ` +
        `Re-read it from the listing below, or run \`xanosdk lock rename\` if the rename was intended.`,
    );
  }
  if (engineMinted) {
    lines.push(
      `A guid in the engine's own format belongs to a backend this project did not deploy, or to ` +
        `one deployed before guids were preserved. Those are per-environment and do not travel — ` +
        `the listing below is the source of truth for the source being cut from.`,
    );
  }
  return lines.join("\n");
}

/** The source's tables by their numeric ID, as typed (`"1"`) — never a selector, only recognised. */
function tableById(tables: readonly TableSummary[]): Map<string, TableSummary> {
  return new Map(tables.filter((t) => t.guid !== undefined).map((t) => [String(t.id), t]));
}

/**
 * A `--seed` guid the source has no table for: a named thing that is not there,
 * so `SDK_ERROR`, exit 8, like every other named thing not found (E2E pass 23:
 * it exited 1; pass 24: it said `SDK_USAGE`, which the error table keeps for a
 * mistyped command line and a missing local path).
 */
class SeedTableNotFoundError extends UsageError {
  readonly code = "SDK_ERROR";
  readonly exitCode = 8;
  /** Every guid meant, when several unmatched guids each had one (`suggestion` is the first). */
  readonly suggestions: string[] | undefined;
  constructor(message: string, near: readonly string[]) {
    super(message, near.length === 0 ? {} : { suggestion: near[0] });
    this.suggestions = near.length > 1 ? [...near] : undefined;
  }
}

/**
 * The guid each unmatched `--seed` value most likely meant — a table NAME's
 * guid, or the guid a mistyped copy is one slip from — for the refusal's
 * `suggestion` (E2E pass 29: the text named it, the JSON did not).
 */
function nearSeedGuids(unmatched: readonly string[], tables: readonly TableSummary[]): string[] {
  const byName = new Map(tables.map((t) => [t.name, t.guid]));
  const guids = tables.flatMap((t) => (t.guid === undefined ? [] : [t.guid]));
  const byId = tableById(tables);
  const near = unmatched.flatMap((g) => {
    const named = byName.get(g) ?? (byName.has(g) ? undefined : byId.get(g)?.guid);
    if (named !== undefined) return [named];
    if (!isHexGuid(g) && !ENGINE_GUID_SHAPE.test(g)) return [];
    const close = suggest(g, guids);
    return close === undefined ? [] : [close];
  });
  return [...new Set(near)];
}

/**
 * Resolve `--seed` against the SOURCE's own tables.
 *
 * Listed from the source rather than the workspace because the numeric ID is
 * not portable across the full-replace import `xanosdk deploy` performs: it
 * reassigns every id — measured: one redeploy of the same project moves a
 * table's id, with a no-redeploy control confirming the new values are stable.
 * The deploy sends `preserve_guids`, so the guid is the one thing that DOES
 * survive. Which is exactly why it is the selector and the id
 * is not.
 *
 * The server does not reject an identifier it does not recognize; it ignores it
 * and answers 200. That is why the guid is what a user selects by: a stale guid
 * is ABSENT from this listing and refuses here, before anything is cut, while a
 * stale id — ids being small dense integers — almost certainly matches a real
 * but DIFFERENT table and would be cut silently into a durable, promotable
 * artifact. The refusal prints the source's real tables for the same reason it
 * names the per-source listing verb: those guids are not obtainable anywhere
 * else for the source being cut from.
 *
 * Guids are resolved to THIS host's numeric ids before the request is built —
 * the engine's `table_ids` parameter is int-typed, so the wire is unchanged.
 */
async function resolveSeedSelection(
  args: ParsedArgs,
  auth: ResolvedAuth,
  resolved: ResolvedSource,
): Promise<SeedSelection | undefined> {
  if (!args.seed) return undefined;
  // Parsed only when a value was given: a bare `--seed` means every table and
  // must not depend on a guid being current.
  const requested = args.seedTableGuids === undefined ? undefined : parseSeedGuids(args.seedTableGuids);

  const tables = await readBeforeCut(args, `list ${resolved.target.label}'s tables for \`--seed\``, () =>
    listTables(auth, {
      workspaceId: resolved.target.workspaceId,
      base: resolved.target.base,
      binding: bindingFor(auth, resolved.target.workspaceId, resolved.kind !== "workspace"),
    }),
  );
  // An id the credential cannot see lists 200 with no rows: not "has no tables".
  if (tables.length === 0 && resolved.kind === "workspace") {
    const { refuseUnreachableWorkspace } = await import("./workspace-binding.js");
    await refuseUnreachableWorkspace(auth);
  }
  if (tables.length === 0) {
    throw new UsageError(
      `${resolved.target.label} has no tables, so there are no rows to carry. Drop \`--seed\`.`,
    );
  }

  if (requested === undefined) return { tables };

  const known = new Map(tables.map((t) => [t.guid, t]));
  // A 32-char hex guid is a hex NUMBER, so its case carries nothing: an
  // uppercased copy (a spreadsheet, a shell `tr`) names the same table (E2E
  // pass 24: it was refused as "a backend this project did not deploy").
  // An engine guid is base64url, where case IS the value, so it matches exactly.
  const lookup = (guid: string): TableSummary | undefined =>
    known.get(guid) ?? (isHexGuid(guid) ? known.get(guid.toLowerCase()) : undefined);
  const unmatched = requested.filter((guid) => lookup(guid) === undefined);
  if (unmatched.length > 0) {
    // One listing command, the source named and the run's credential flags on
    // it, for both lines that print one (E2E pass 17: one carried `--config`
    // and no backend, the other the backend and no `--config`).
    const listing = `${listingVerb(resolved)}${contextFlags(args)}`;
    throw new SeedTableNotFoundError(
      `${resolved.target.label} has no table with ` +
        `${unmatched.length === 1 ? `guid ${unmatched[0]}` : `guids ${unmatched.join(", ")}`}.\n` +
        `${unmatchedGuidCauses(unmatched, tables)}\n` +
        `Run \`${listing}\` for the current ones.\n` +
        `Tables in ${resolved.target.label}:\n${formatTableListing(tables, "  ")}`,
      nearSeedGuids(unmatched, tables),
    );
  }
  // `requested` order is preserved, and every guid is known by here.
  // Deduped by table: `ABC…` and `abc…` ask for one thing.
  return { tables: [...new Set(requested.flatMap((guid) => lookup(guid) ?? []))] };
}

/**
 * The selection's guarded columns, completed from the source's export.
 *
 * The table listing does not say which columns are `sensitive` — measured, it
 * carries `sensitive: null` on every column, even one the table declares
 * sensitive — while the export's table schema does. So each selected table's
 * schema is read from the export too, by guid. A table the export does not
 * carry is named in `unchecked`, so the confirmation never implies a check it
 * could not make.
 */
export function withExportedGuards(
  selection: SeedSelection,
  payload: unknown,
): SeedSelection & { unchecked: string[] } {
  const rows = (payload as { dbo?: unknown } | null | undefined)?.dbo;
  const byGuid = new Map<string, unknown>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = r as { guid?: unknown; schema?: unknown } | null;
    if (typeof row?.guid === "string") byGuid.set(row.guid, row.schema);
  }
  const unchecked: string[] = [];
  const tables = selection.tables.map((t) => {
    if (!byGuid.has(t.guid)) {
      unchecked.push(t.name);
      return t;
    }
    return { ...t, guardedColumns: [...new Set([...t.guardedColumns, ...guardedIn(byGuid.get(t.guid))])] };
  });
  return { tables, unchecked };
}

/**
 * Confirm before carrying rows from columns the schema marks non-public.
 *
 * Warn-and-confirm rather than the hard refusal `findSeedLeaks` applies to a
 * static host: that publishes to the open web, where a non-public value is
 * unambiguously wrong, while a release is an internal artifact and seeding one
 * from a real backend is an ordinary thing to want. So this names what it found
 * and asks.
 *
 * The test is `access: "internal"` or `sensitive: true`, mirroring
 * `collectNonPublicSeedValues`. NOT `access !== "public"`: access is
 * three-valued, and `private` columns come back in ordinary responses — the
 * system `created_at` is private — so guarding them would fire on nearly every
 * table and train the reader to wave it through.
 */
async function confirmNonPublicRows(args: ParsedArgs, selection: SeedSelection & { unchecked?: string[] }): Promise<boolean> {
  const flagged = selection.tables.filter((t) => t.guardedColumns.length > 0);
  const unchecked = selection.unchecked ?? [];
  if (unchecked.length > 0) {
    warn(
      `Could not read which columns are sensitive in ${unchecked.length === 1 ? "this table" : "these tables"} — ` +
        `the source's export does not carry ${unchecked.length === 1 ? "it" : "them"}, so only \`internal\` and ` +
        `password columns were checked: ${unchecked.join(", ")}`,
      "seed.guarded-columns",
    );
  }
  if (flagged.length === 0) return true;
  // Printed even under `--yes`. The waiver answers the question; it does not
  // make the answer uninteresting — a CI run that skips the prompt is exactly
  // the one where the only record of what rode along is this listing.
  warn(`These tables have non-public columns whose values would ride along:`, "seed.guarded-columns", [
    ...flagged.map((t) => `${t.name}: ${t.guardedColumns.join(", ")}`),
    `A release is durable and can be landed on another environment.`,
  ]);
  if (args.yes) return true;
  // A decline is the reader's own answer, not a failure: the caller records the
  // cut as not done and the run exits 0, as every other declined confirmation does.
  // Off a terminal: the needs-confirmation refusal, with what it asked about
  // and the exact rerun.
  const { yesRerun } = await import("./retry-command.js");
  const { rerun, note } = yesRerun(args, "release create");
  return confirm(`Carry these rows anyway?`, {
    flag: "--yes",
    refusal: {
      details: {
        verb: "create",
        created: false,
        guardedColumns: Object.fromEntries(flagged.map((t) => [t.name, [...t.guardedColumns]])),
      },
      rerun,
      note,
    },
  });
}

/**
 * Refuse a cut that carried fewer tables' rows than were asked for.
 *
 * The input boundary cannot prove this on its own: the server silently ignores
 * an id it does not recognize and still answers 200, so a rows-free release can
 * be reported as a success. The created release's per-table row-count list
 * enumerates what actually resolved — measured, a REQUESTED table with no rows
 * is listed with count 0 rather than omitted, so this comparison is sound.
 */
async function assertRowsLanded(
  auth: ResolvedAuth,
  op: CutOperation,
  created: ReleaseSummary,
  requested: string,
  selection: SeedSelection,
  flags: string,
): Promise<void> {
  // COUNT is the invariant, because it is the axis that cannot lie here: every
  // requested table that resolved comes back, with 0 when it holds no rows.
  if (created.seededTables.length >= selection.tables.length) return;
  // Named by GUID, which is what the selection was made by and what a rename
  // between the listing and the cut does not change. The manifest carries both,
  // so this is exact rather than best-effort; the name is only what gets
  // PRINTED, since a guid names nothing to a reader. A row whose guid the server
  // omitted falls back to the name so a manifest missing guids degrades to the
  // old approximate answer instead of reporting everything as missing.
  const landedGuids = new Set(created.seededTables.flatMap((t) => (t.guid === undefined ? [] : [t.guid])));
  const landedNames = new Set(created.seededTables.map((t) => t.name));
  const missing = selection.tables
    .filter((t) => (landedGuids.size > 0 ? !landedGuids.has(t.guid) : !landedNames.has(t.name)))
    .map((t) => t.name);
  // Removed, not merely reported — the same treatment `confirmCutFrom` gives a
  // release it cannot vouch for. Left behind, this one holds the name the
  // corrected re-run needs, so the retry collides on a release whose contents
  // were never what its name claimed.
  // Say which of the two actually happened. Reporting a removal that failed
  // would leave the reader believing the name is free when it is not.
  const stored = created.name !== "" ? created.name : requested;
  return refuseCut(auth, op, created, stored, flags, (removal) =>
    `Release "${stored}" carries rows for ${created.seededTables.length} of the ` +
      `${selection.tables.length} tables asked for` +
      `${missing.length === 0 ? "" : ` (missing ${missing.map((m) => JSON.stringify(m)).join(", ")})`}` +
      `. The server accepted the cut and ` +
      `dropped those tables silently.\n` +
      (removal.removed ? `The release was removed.` : `It could NOT be removed — ${removal.remedy}`) +
      ` Check the ids against the source with \`${tablesCommand()}\`.`,
  );
}

// ── the create result ───────────────────────────────────────────────────────

/**
 * `release create`'s one step.
 *
 * ONE step, `cut`, even on a `--from ephemeral:` cut whose audit confirmation
 * and by-id read-back happen after the write. The requested outcome is "a
 * release holding what was asked for", and the confirmation is part of what
 * makes a release that — not a second outcome beside it. Split out, a refused
 * confirmation would read `cut: yes, confirm: no`, which says a release exists
 * when the refusal has just deleted it. As one step the answer is the state:
 * `yes` (cut and vouched for), `no` (never cut, or cut and discarded, with any
 * `residue` named), or `unknown` (the create, or the cleanup of a refused one,
 * was cut off mid-request).
 *
 * A Ctrl-C during the confirmation is therefore `unknown` for the cut, which is
 * the truth from outside: the release exists, and nobody has vouched for it.
 */
type CutStep = "cut";

/**
 * Where to look in `xanosdk release list --json` for a cut whose outcome is
 * unknown. The server suffixes a taken name rather than refusing it, so the
 * cut may be listed as the name asked for OR as that name plus `-` and four
 * hex characters — and only a release created after the run began can be it.
 */
interface CutLookFor {
  name: string;
  /** Anchored pattern for the suffixed spelling, e.g. `^v2-[0-9a-f]{4}$`. */
  suffixPattern: string;
  /**
   * A floor under the run's `startedAt` (see `createdAfterBound`): a release of
   * that name created before it is not this cut.
   */
  createdAfter: string;
}

interface CutExtras {
  /** The name asked for, present only when the server stored another. */
  requestedName: string;
  /** Present only while the cut's outcome is unknown. */
  lookFor: CutLookFor | undefined;
  /** The pre-cut comparison against this project's compile (see {@link CutDrift}). */
  drift: CutDrift;
  /**
   * Where the release was cut from — the `origin` `release list`/`show` report
   * for it, read back from the stored record. `null` when nothing records it.
   */
  origin: ReleaseOrigin | null;
  /** Whether a confirmation was declined. Always present, so every ending reads one shape. */
  declined: boolean;
}

type CutOperation = OperationBuilder<CutStep, CutExtras>;

/**
 * The release as stored. A create response always names the record; an empty
 * name is a floor that falls back to the one asked for rather than reporting
 * a release with no name.
 */
function storedIdentity(auth: ResolvedAuth, release: ReleaseSummary, requested: string) {
  return {
    instance: auth.instance,
    workspaceId: auth.workspaceId,
    id: release.id,
    name: release.name !== "" ? release.name : requested,
  };
}

/** The read that settles an unknown cut, against the workspace this run cut into. */
function resolveCut(args: ParsedArgs): string {
  return `xanosdk release list --json${contextFlags(args)}`;
}

/** Allowance for this machine's clock running ahead of the server's. */
const CREATED_AFTER_SKEW_MS = 5_000;

/**
 * The `createdAfter` an unknown cut is looked for by: the run's start, floored
 * to the whole second and less {@link CREATED_AFTER_SKEW_MS}.
 *
 * The server stamps `createdAt` in whole seconds, from its own clock. Taken raw,
 * the client's millisecond start makes a cut the server stored in that same
 * second — or a second "earlier" by skew — look older than the run, and the
 * caller discards the very release it is looking for. A bound that admits a few
 * extra seconds costs nothing: the name pattern still has to match. Computed
 * once, so the JSON and the human line cannot disagree.
 */
function createdAfterBound(startedAt: number): string {
  return new Date(Math.floor(startedAt / 1000) * 1000 - CREATED_AFTER_SKEW_MS).toISOString();
}

function lookForCut(name: string, startedAt: number): CutLookFor {
  return {
    name,
    suffixPattern: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{4}$`,
    createdAfter: createdAfterBound(startedAt),
  };
}

/**
 * Send the create — the one request that makes a release — and keep the
 * result's `lookFor` true to it.
 *
 * `lookFor` is set BEFORE the request goes, because a Ctrl-C mid-request
 * snapshots the result synchronously and never reaches a catch. It is cleared
 * as soon as the answer is known: a cut the server answered, or a failure the
 * classifier can call `no` (a 4xx, a connection that never opened), leaves
 * nothing to look for.
 */
async function sendCut(
  auth: ResolvedAuth,
  op: CutOperation,
  /** Built once per run (see `runReleaseCreate`); its `name` is the one asked for. */
  lookFor: CutLookFor,
  send: () => Promise<ReleaseSummary>,
): Promise<ReleaseSummary> {
  const name = lookFor.name;
  op.begin("cut");
  op.set("lookFor", lookFor);
  op.sending();
  try {
    const cut = await send();
    op.set("lookFor", undefined);
    // The identity the server stored, from the moment it says — so a refusal
    // after this (an unconfirmed source, dropped rows) reports the release it
    // actually made, whose residue it may be.
    op.setRelease(storedIdentity(auth, cut, name));
    return cut;
  } catch (err) {
    if (classifyFailure(err, { writeSent: true }) === "no") op.set("lookFor", undefined);
    throw err;
  }
}

export async function runReleaseCreate(args: ParsedArgs): Promise<void> {
  const typed = args.positionals[0];
  // Not `requireName`: its pointer at `release list` helps a verb that acts on
  // an EXISTING release, and this one needs a name no release holds yet. One
  // line and the help pointer: the sentence already says what to type.
  if (typed === undefined) {
    throw new UsageError(
      `\`xanosdk release create\` needs a name for the new release — one no release in this ` +
        `workspace holds yet, e.g. \`xanosdk release create v2${contextFlags()}\`.`,
      CREATE_HINT,
    );
  }
  // Trimmed, as `deploy --name` is: the server trims a name before it checks
  // it is free, so " v2 " beside an existing "v2" was stored as a SUFFIXED
  // copy — exit 0, and a release nobody asked for. Trimming here makes the
  // duplicate check below ask about the name the server will store.
  const name = typed.trim();
  assertOneName(typed, "the release name", { args, helpFor: CREATE_HINT.hintFor });
  // BEFORE anything is resolved or sent. The engine stores a release name
  // verbatim, and nothing downstream re-checks it — an export derives its
  // filename from the name, so this is the last point at which a name that is
  // really a path can still be refused rather than lived with. An empty name
  // and a blank one get the same answer here. A refusal of what was TYPED, so
  // it is a usage error with the help pointer.
  try {
    assertUsableReleaseName(name);
  } catch (err) {
    throw new UsageError((err as Error).message, CREATE_HINT);
  }
  // `release show` reads a release's origin off lines the CLI appends to the
  // description, each starting with the reserved prefix: one the author typed
  // would be read as a record of where the release came from.
  const reserved = args.description === undefined ? undefined : reservedDescriptionLine(args.description);
  if (reserved !== undefined) {
    throw new UsageError(
      `\`--description\` cannot hold a line starting with \`${RESERVED_DESCRIPTION_PREFIX}\`, and this one does: ` +
        `${JSON.stringify(reserved.trim())}.\nThe CLI writes those lines itself to record where a release came from, ` +
        `and \`release show\` reads them back as its origin. Reword that line. Nothing was cut.`,
      CREATE_HINT,
    );
  }
  // `--bundle` names the file the comparison reads. A path that is not there is
  // a mistake in the command line, and the cut it would otherwise sit beside is
  // durable — so it is refused before anything is sent, not reported as a
  // comparison that "could not run" under a release that exists anyway.
  // Parsed as well as found: a directory or an unparseable file used to reach
  // the comparison, which reported "could not compare" beside a release cut
  // anyway.
  assertBundleFile(args, { command: "release", subcommand: "create" }, "Nothing was cut.");
  // `--entry` names what the comparison compiles, refused the same way.
  if (args.entryPath !== undefined) {
    if (args.bundle !== undefined) {
      throw new UsageError(
        "`--entry` and `--bundle` both name what the cut is compared against — pass one. Nothing was cut.",
        CREATE_HINT,
      );
    }
    if (!existsSync(args.entryPath) || !statSync(args.entryPath).isFile()) {
      const Refusal = existsSync(args.entryPath) ? UsageError : LocalFileNotFoundError;
      throw new Refusal(
        `\`--entry ${args.entryPath}\` ${existsSync(args.entryPath) ? "is not a file" : "does not exist"}. Nothing was cut. ` +
          `Pass the backend's entry file (its \`index.ts\`).`,
        CREATE_HINT,
      );
    }
  }
  const cwd = process.cwd();
  // The source first, through a memoized provider: a bare cut after a local
  // deploy is refused off the pointer before any credential is read, and the
  // ephemeral lookup and the cut below share one read.
  const credential = memoCredential(() => getAccessToken(args));
  const source = await resolveFrom(args, credential, cwd);
  const auth = await credential();

  // From here the command knows what it is attempting — which name, into which
  // workspace — so every ending, a refusal before the cut included, answers in
  // the one result shape.
  //
  // `branch` is the SOURCE branch: as requested until the cut resolves it —
  // a workspace cut fills in the live branch's label before it sends anything —
  // and `null` for an environment, which has no branch to name (the value every
  // operation document uses where no branch applies). The label sent rather
  // than the one stored, so it reads the same whether or not the cut answered.
  const op = createOperation<CutStep, CutExtras>({
    operation: "release create",
    destination: { ...credentialWriteTarget(auth), kind: "workspace" },
    release: { instance: auth.instance, workspaceId: auth.workspaceId, id: undefined, name },
    branch: args.branch ?? null,
    steps: ["cut"],
    extras: { declined: false },
  });

  // Built ONCE from the run's start: the result's `lookFor` and the human "Look
  // for" line below both read this value, so they cannot name different bounds.
  const lookFor = lookForCut(name, op.startedAt);

  let done: { created: ReleaseSummary; provenance: string } | undefined;
  let declined = false;
  try {
    await runOperation(
      op,
      { machine: isMachineOutput(args), resolveWith: resolveCut(args), what: "the release cut" },
      async () => {
        const result = await cut(args, auth, source, name, cwd, op, lookFor);
        if (result === "declined") declined = true;
        else done = result;
      },
    );
  } catch (err) {
    // A decline is not a failure: the result says the cut is `no`, and the run exits 0.
    if (declined) return;
    // The generic resolver line has been said; this names what to look FOR in
    // that listing, which only this command knows.
    if (err instanceof OperationError && err.result.resolveWith !== undefined) {
      detail(
        `Look for "${name}", or "${name}-" plus four hex characters, created after ` +
          `${lookFor.createdAfter}.`,
      );
    }
    throw err;
  }

  // Said on the progress stream whatever stdout is: a cut piped into a log (or
  // run with `--json`) otherwise ended on "Confirming …" with no line saying
  // it had worked — the document on stdout is for the script, not the reader.
  if (done === undefined) return;
  const { created, provenance } = done;
  success(`Cut release ${created.name}`);
  detail(`from ${provenance}`);
  if (created.seededTables.length === 0) {
    // Not a warning: ROWS are opt-in, and a caller expecting them should learn
    // that here rather than after landing the release somewhere. Says "rows"
    // and not "tables" on purpose — every table's schema IS in there.
    detail(`Carries no table rows — every table's schema and logic is included.`);
  }
}

/** Everything from resolving the source to a confirmed cut. Runs inside the operation. */
async function cut(
  args: ParsedArgs,
  auth: ResolvedAuth,
  source: LiveSource,
  name: string,
  cwd: string,
  op: CutOperation,
  lookFor: CutLookFor,
): Promise<{ created: ReleaseSummary; provenance: string } | "declined"> {
  // A standard tenant is refused as a source whether or not it has a workspace yet.
  const resolved = await resolveSource(source, async () => auth, { cwd, workspaceless: "any" });
  await refuseLiveDeployment(resolved);
  await refuseWorkspaceless(resolved, "read");

  // Cheapest refusal, and the one that protects a release a tenant may be
  // running right now. Always against the WORKSPACE: wherever the contents are
  // cut, the release itself lands here, and here is where the name has to be
  // free.
  //
  // A refusal, not a usage error: nothing was mistyped, so no help block, and
  // exit 2 — the "ran and was refused" code `release transfer` gives a taken
  // name, which a script must not retry. `error.details.conflictsWith` names
  // the holder in the result, as a transfer's does.
  const existing = await lookupRelease(auth, name);
  if (existing !== null) {
    const holder = { id: existing.id, name: existing.name !== "" ? existing.name : name };
    // The branch a cut would have read, which the refusal comes too early to
    // have resolved: without it the result named no branch for a workspace cut.
    // Best effort — a failed listing must not replace the refusal the caller
    // needs with a transport error, so it falls back to the placeholder.
    if (resolved.kind === "workspace" && args.branch === undefined) {
      try {
        const target = { baseUrl: resolved.target.base, workspaceId: resolved.target.workspaceId };
        op.setBranch(liveBranchLabel(await listBranches(auth, target)) ?? null);
      } catch {
        // Keep `null`; the refusal below is the answer.
      }
    }
    // Worded by where it really came from: "from a branch" described a release
    // cut from an ephemeral as a workspace cut.
    const origin = await releaseOrigin(auth, existing);
    throw new CliError(
      "SDK_RELEASE_NAME_TAKEN",
      `A release named "${name}" already exists (cut ${existing.createdAt ?? "earlier"}` +
        `${origin === undefined ? "" : ` from ${describeOrigin(origin)}`}). Releases are not replaced — cut a new name.`,
      { exitCode: EXIT_RELEASE_REFUSED, details: { conflictsWith: holder } },
    );
  }

  // A name that renders the same as one already here but is stored as other
  // code points (NFC `é` against NFD `e` + accent) would make two releases no
  // reader can tell apart. Only a name with non-ASCII characters can.
  if (/[\u0080-\uffff]/.test(name)) {
    const { releaseNames } = await import("./source-resolve.js");
    const twin = (await releaseNames(auth).catch(() => [])).find((n) => differOnlyInNormalisation(n, name));
    if (twin !== undefined) {
      const [there, typed] = differingCodePoints(twin, name);
      throw new CliError(
        "SDK_RELEASE_NAME_TAKEN",
        `A release named "${twin}" already exists, and "${name}" differs from it only in Unicode normalisation ` +
          `(${there} there, ${typed} typed), so the two would read as the same name everywhere. Nothing was cut — ` +
          `cut a different name.`,
        { exitCode: EXIT_RELEASE_REFUSED, details: { conflictsWith: { name: twin } } },
      );
    }
  }

  // `--branch` names a branch of a WORKSPACE. An environment has exactly one,
  // so a label here would scope nothing — refused rather than ignored, which is
  // what the flag would otherwise be.
  if (resolved.kind !== "workspace" && args.branch !== undefined) {
    throw new UsageError(
      `\`--branch\` names a branch of your workspace, and ${resolved.target.label} has one ` +
        `branch. Drop it, or cut \`--from workspace --branch ${args.branch}\` instead.`,
      { hintFor: { command: "release", subcommand: "create" } },
    );
  }

  // A label the workspace does not have comes back from the server as a bare
  // 500 "Invalid branch", which reads as a broken instance rather than the typo
  // it almost always is. The same pre-flight `promote` and `codegen` perform:
  // ask the branch list first, and answer with the labels that DO exist.
  // Before the seed lookup and the cut, so a corrected re-run finds the name
  // still free. The empty label never reaches here — the parser refuses it.
  //
  // Without `--branch` a listing names the LIVE branch, and the cut is sent
  // under that label. The server cuts the live branch for an empty label too,
  // but STORES the empty string rather than resolving it, so the release would
  // record no branch — where a release cut in the dashboard always records the
  // label it came from. `""` only when the server names no live branch, which
  // leaves the cut to pick it as before. That listing is read immediately
  // before the cut, not here: the seed confirmation below can sit open for
  // minutes, and a promotion landing meanwhile would cut the branch that USED
  // to be live.
  const branchTarget = { baseUrl: resolved.target.base, workspaceId: resolved.target.workspaceId };
  let branch = "";
  if (resolved.kind === "workspace" && args.branch !== undefined) {
    branch = requireBranch(await readBeforeCut(args, "list the workspace's branches", () => listBranches(auth, branchTarget)), args.branch).label;
    op.setBranch(branch);
  }

  // Resolved BEFORE the cut: listing the source's tables is the only thing that
  // can catch a foreign id, and after the cut it is too late — the release
  // exists, holding the name a corrected re-run needs.
  const selection = await resolveSeedSelection(args, auth, resolved);
  // The files guard before the non-public confirmation: a `--yes` rerun that
  // confirmation prints must not then be refused for files. Always, whatever
  // the drift comparison below can do — the export it reads is the SOURCE's.
  // The branch as STORED: a padded `--branch` resolved above.
  const readArgs = args.branch !== undefined ? { ...args, branch } : args;
  const live = await readSourceExport(readArgs, auth, resolved);
  await refuseUncarriedFiles(live.payload, selection, resolved, args, auth, cwd);
  if (selection !== undefined && !(await confirmNonPublicRows(args, withExportedGuards(selection, live.payload)))) {
    info("Release create cancelled — nothing was cut.");
    op.set("declined", true);
    op.finish("cut", "no");
    return "declined";
  }

  // The step line below names where the contents are cut FROM, which is the
  // interesting half of a `--from env:` cut and says nothing about where the
  // release object itself lands. It lands here, in the credential's own
  // workspace, and a cut aimed at the wrong account is the same wrong-target
  // mistake a deploy makes — so the destination is disclosed on its own line
  // rather than left to be inferred from the absence of one. Under the step it
  // belongs to: an indented "on …" line printed ABOVE the step read as the
  // tail of whatever came before it.
  step(`Cutting "${name}" from ${sourceLabel(resolved, args.branch !== undefined ? branch : undefined)}`);
  discloseWriteTarget(credentialWriteTarget(auth));
  if (selection !== undefined) {
    detail(
      `Carrying rows from ${selection.tables.length} table` +
        `${selection.tables.length === 1 ? "" : "s"}: ${selection.tables.map((t) => t.name).join(", ")}`,
    );
  }
  op.set("drift", await warnOnDivergence(readArgs, resolved, cwd, live));

  if (resolved.kind === "workspace" && args.branch === undefined) {
    branch = liveBranchLabel(await readBeforeCut(args, "list the workspace's branches", () => listBranches(auth, branchTarget))) ?? "";
    op.setBranch(branch === "" ? null : branch);
  }

  const description = args.description !== undefined ? { description: args.description } : {};
  const seeding = selection !== undefined ? { tableIds: selection.tables.map((t) => t.id) } : {};
  // What a printed `release delete` of this cut carries after its name: it
  // asks before it deletes, so `--yes` where this run was not asked.
  const deleteFlags = `${pipedYes(args)}${contextFlags(args)}`;
  const created =
    resolved.kind === "workspace"
      ? // The label resolved above: the one named, or the live branch's.
        await sendCut(auth, op, lookFor, () =>
          createRelease(auth, {
            workspaceId: auth.workspaceId,
            name,
            branch,
            ...description,
            ...seeding,
          }),
        )
      : await cutFromEnvironment(
          auth,
          name,
          resolved,
          { ...description, ...seeding },
          op,
          lookFor,
          deleteFlags,
          retryCommand(args, { command: "release create", creates: true }),
        );

  // Again, from what the read-back returned: the import behind a cut can
  // rename what it stored (see `cutFromEnvironment`).
  const identity = storedIdentity(auth, created, name);
  op.setRelease(identity);
  const stored = identity.name;

  // The input boundary is not proof. See assertRowsLanded.
  if (selection !== undefined) await assertRowsLanded(auth, op, created, name, selection, deleteFlags);

  // The name was free at the pre-check, but the server can still store the
  // release under another: a cut racing this one takes it first, or the write
  // fails and is retried under a suffix. A caller that then addresses the name
  // it asked for — `promote <name>` in the next CI step — lands the OTHER
  // release, so this is the taken-name refusal, not a success with a warning:
  // the name asked for is not this cut's, and the suffixed release is residue.
  if (stored !== name) {
    op.set("requestedName", name);
    const removeWith = `xanosdk release delete ${shellWord(stored)}${deleteFlags}`;
    op.setResidue({ ...(identity.id === undefined ? {} : { id: identity.id }), name: stored, removeWith });
    op.finish("cut", "no");
    throw new CliError(
      "SDK_RELEASE_NAME_TAKEN",
      `The server stored this cut as "${stored}", not the "${name}" asked for — the name was taken while it was ` +
        `being cut. Anything that addresses "${name}" (a \`promote ${shellWord(name)}\`) does not reach this release.\n` +
        `Delete this one with \`${removeWith}\`, then cut again under a free name.`,
      { exitCode: EXIT_RELEASE_REFUSED, details: { conflictsWith: { name }, storedAs: stored } },
    );
  }

  // What the release was cut FROM, as `release list` reports it — read from the
  // stored record, so the two can never describe one release two ways. Best
  // effort: the cut stands whether or not its origin can be read.
  op.set("origin", (await releaseOrigin(auth, created).catch(() => undefined)) ?? null);
  op.finish("cut");
  // A named branch is part of where it came from: "from workspace" said
  // nothing about which branch a `--branch` cut read.
  return {
    created,
    provenance:
      resolved.kind === "workspace" && args.branch !== undefined
        ? `${resolved.provenance} (branch ${JSON.stringify(branch)})`
        : resolved.provenance,
  };
}
