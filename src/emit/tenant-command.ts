/**
 * `xanosdk tenant <list|get|deploy|delete>` — the tenants a
 * backend is delivered to.
 *
 * A tenant and an ephemeral are one primitive on the server; an ephemeral is a
 * tenant carrying an expiry. They stay separate command surfaces because the
 * audiences differ: an ephemeral is a development environment you create
 * constantly and destroy without thinking, a tenant is somebody's deployment.
 * The dev loop should not have to learn tenant vocabulary to do its job, and a
 * tenant verb should not inherit an ephemeral's casualness.
 *
 * `tenant deploy <tenant> <release>` is the second of the two taught paths to a
 * real destination, and carries the same trade as `promote`: the platform lands
 * the release, so the local pre-flight does not run, and the command says so
 * before it writes.
 */
import { assertOneName } from "./name-argument.js";
import { describeWrite } from "../util/sent-writes.js";
import type { ParsedArgs } from "./cli.js";
import { shellWord } from "./command-line.js";
import { contextFlags } from "./context-flags.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { unknownSubcommand, UsageError } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { confirm } from "./prompt.js";
import {
  step,
  success,
  warn,
  detail,
  info,
  stdoutStyle,
  safeText,
  printHuman,
  discloseWriteTarget,
  backendDestinationPayload,
  writeTargetPayload,
  type WriteTarget,
} from "./ui.js";
import { isBackendHandle, parseSource, verbBackendName } from "./source-selector.js";
import {
  describeBackend,
  isUnansweredLookup,
  resolveSource,
  SourceError,
  type ResolveDeps,
  type ResolvedSource,
} from "./source-resolve.js";
import { passwordSeedColumns } from "./deploy-source.js";
import { passwordHashesWarning, passwordOrigin, readUnanswered } from "./release-common.js";
import { displayNameHint, displayNameOwner, displayNameOwnerOfEither, isShared, sharedDisplayHint } from "./display-name-hint.js";
import {
  listTenants,
  getTenant,
  deployReleaseToTenant,
  tenantHasWorkspace,
  deleteTenant,
  isFailedMicroservice,
  type TenantSummary,
  type TenantDeployOutcome,
  type TenantMicroserviceOutcome,
} from "../deploy/tenant.js";
import { createOperation, runOperation, OperationError } from "./operation-result.js";
import { SettledWriteFailure } from "./operation-outcome.js";
import { downloadRelease, listReleases, promotableReleaseName, untenantDeployableReleasePart } from "../deploy/release.js";
import { reportEnvLanding } from "./env-landing-report.js";
import { forgetLanding, holdsLanding, landingLockPath, recordForeignLanding, type LandingReport } from "./landing-record.js";
import { clearEnvironment, ephemeralStatePath, getEnvironment, readEphemeralState } from "../deploy/ephemeral-state.js";
import { displayPath } from "../util/rel-path.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { reportNotRun, assertNoMergeFlags } from "./promote-command.js";
import {
  additiveChanges,
  alteringChanges,
  stoppingRetypes,
  CONSTRAINT_FIX,
  CONSTRAINT_PHRASE,
  constraintStop,
  constraintWhere,
  assertStorageModesKept,
  xdoConversionRefused,
  xdoConversionRefusal,
  discloseCanonicalMoves,
  discloseTableEffects,
  droppedAndAdded,
  droppedTableLine,
  movesClause,
  namedConstraint,
  releaseCanonicalMoves,
  readOnce,
  releaseTableEffects,
  tableEffectsPayload,
  type CanonicalMove,
  type ConstraintStop,
  type TableEffects,
} from "./plan-disclosure.js";
import { exportWorkspaceBundle, type ExportedBundle } from "../deploy/workspace-export.js";
import { asWorkspaceArchive } from "./deploy-source.js";
import { assertReleaseIdentitiesFree } from "./release-command.js";
import { countTableRows, listTables, tableRowCounter } from "../deploy/table.js";
import { certificateFailureCode, certificateFailureHost, UNTRUSTED_CERTIFICATE } from "../util/http.js";

export { constraintStop, type ConstraintStop };

export async function runTenantCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "list":
      return runList(args);
    case "get":
      return runGet(args);
    case "deploy":
      return runDeploy(args);
    case "delete":
      return runDelete(args);
    default:
      throw unknownSubcommand("tenant", args.subcommand, args.positionals);
  }
}

function requireTenant(args: ParsedArgs, verb: string, at = 0): string {
  const name = args.positionals[at];
  if (name === undefined || name === "") {
    throw new UsageError(
      `\`xanosdk tenant ${verb}\` needs a tenant name. Run \`xanosdk tenant list${contextFlags(args)}\` to see them.`,
      // One line and the pointer: the sentence says what to type.
      { hintFor: { command: "tenant", subcommand: verb } },
    );
  }
  assertOneName(name, "the tenant name", { args, helpFor: { command: "tenant", subcommand: verb } });
  // `tenant:<name>` — the `selector` a `--json` document carries — names the same one.
  return verbBackendName(name, "tenant", { command: "tenant", subcommand: verb }, contextFlags(args));
}

/**
 * How a tenant verb's not-found names the tenant it probably meant.
 *
 * Every tenant has a NAME, which the routes address it by, and a display name,
 * which is what people call it. Given the display name, the lookup finds
 * nothing and "No tenant named" reads as a tenant that does not exist. The
 * resolver makes the one list read that turns that into the name to type (see
 * `display-name-hint.ts`); this spells the fix as this verb, not as a selector.
 */
function tenantVerbHint(verb: string, args: ParsedArgs, lead = ""): Pick<ResolveDeps, "displayNameOf" | "displayNameFix"> {
  // A display name addresses the same tenant, so its corrected command is this
  // run again under the right name — `--yes` and `--json` kept, or it fails as
  // printed wherever the original ran without a terminal. A near NAME is a
  // different tenant: its command keeps `--json` but never the `--yes` given
  // for the one typed, so it asks before acting on the one it guessed.
  return {
    displayNameOf: displayNameOwner,
    displayNameFix: (_kind, name, typo) =>
      typo === true
        ? `run \`xanosdk tenant ${verb} ${shellWord(name)}${lead}${jsonFlag(args)}${contextFlags()}\`.`
        : `tenant commands take its name: \`xanosdk tenant ${verb} ${shellWord(name)}${lead}${answerFlags(args)}${contextFlags()}\`.`,
  };
}

/**
 * `tenant deploy <release> <tenant>`: the first argument named no tenant and
 * the second names one, so the order was swapped. Answered with the order the
 * command takes — asking first, since the reading is a guess. `undefined` when
 * the failure is anything else, or the second argument is no tenant.
 */
async function swappedDeployArgs(err: unknown, auth: ResolvedAuth, first: string, second: string, args: ParsedArgs): Promise<SourceError | undefined> {
  if (!(err instanceof SourceError) || err.liveness !== "gone" || isMalformedName(second)) return undefined;
  const bare = second.startsWith("tenant:") ? second.slice("tenant:".length) : second;
  const tenant = await getTenant(auth, { workspaceId: auth.workspaceId, name: bare }).catch(() => null);
  if (tenant === null) return undefined;
  const release = first.startsWith("release:") ? first.slice("release:".length) : first;
  return new SourceError(
    `No tenant named "${first}", and "${bare}" is a tenant — \`xanosdk tenant deploy\` takes the tenant first, then the release. ` +
      `Nothing was sent.\nRun \`xanosdk tenant deploy ${shellWord(bare)} ${shellWord(release)}${jsonFlag(args)}${contextFlags()}\`.`,
    "gone",
    "tenant",
    bare,
  );
}

/** A value no tenant name can be: a selector of another kind. */
function isMalformedName(value: string): boolean {
  return /^(?:release|ephemeral|workspace|branch|local):/.test(value);
}

/** The run's `--json`, as a near name's command repeats it — never its `--yes`. */
function jsonFlag(args: ParsedArgs): string {
  return args.json === true ? " --json" : "";
}

/** The run's `--yes` and `--json`, as a corrected command must repeat them. */
function answerFlags(args: ParsedArgs): string {
  return `${args.yes ? " --yes" : ""}${args.json === true ? " --json" : ""}`;
}

// ── list / get ──────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  // A listing that got no answer exits 8 with this run as the rerun, as `get`
  // does — not 1 with a bare "retry" (E2E pass 22).
  const rows = await listTenants(auth, { workspaceId: auth.workspaceId }).catch((err: unknown) => {
    throw readUnanswered("tenant", "list tenants", "an empty list", err);
  });
  const releases = await releaseNamesById(auth, rows);
  if (isMachineOutput(args)) {
    // Each row with the selector the next command's backend slot takes.
    writeJson({
      tenants: rows.map((t) => ({ ...withDeployFields(t, releases), selector: `tenant:${t.name}`, workspaceId: auth.workspaceId })),
    });
    return;
  }
  if (rows.length === 0) {
    info("No tenants under this workspace.");
    return;
  }
  const s = stdoutStyle();
  for (const t of rows) {
    // The display name beside the name, because it is what people call the
    // tenant and the name is what commands take — a reader needs both.
    const display = t.display !== undefined && t.display !== t.name ? `  ${s.dim(`(${safeText(t.display)})`)}` : "";
    printHuman(`${s.bold(safeText(t.name))}${display}  ${safeText(t.state ?? "-")}  ${safeText(t.url ?? "")}\n`);
    detail(deployedLine(t, releases));
  }
}

/**
 * A tenant row for `--json`, with the deploy fields ALWAYS present — `null`
 * when nothing was deployed, the value `tenant deploy` reports for the same
 * absence — so a script reads one key rather than having to know it may be
 * missing. `deployedReleaseName` is the name the text shows beside the id
 * (E2E pass 25: `--json` had the id alone), `null` when the workspace's release
 * list no longer holds it.
 */
function withDeployFields(
  t: TenantSummary,
  releases: ReadonlyMap<number, string>,
): Omit<TenantSummary, "deployedAt" | "deployedReleaseId"> & {
  deployedAt: string | null;
  deployedReleaseId: number | null;
  deployedReleaseName: string | null;
} {
  return {
    ...t,
    deployedAt: t.deployedAt ?? null,
    deployedReleaseId: t.deployedReleaseId ?? null,
    deployedReleaseName: t.deployedReleaseId === undefined ? null : (releases.get(t.deployedReleaseId) ?? null),
  };
}

/**
 * What a tenant serves, in one line: the release last landed on it and when.
 * The record carries only the release's id, so the name comes from the
 * workspace's release list when it still holds that id.
 */
function deployedLine(t: TenantSummary, releases: ReadonlyMap<number, string>): string {
  if (t.deployedReleaseId === undefined) return "release: none deployed";
  const name = releases.get(t.deployedReleaseId);
  const which = name === undefined ? `#${t.deployedReleaseId} (no longer listed)` : `${safeText(name)} (#${t.deployedReleaseId})`;
  return `release: ${which}${t.deployedAt === undefined ? "" : `, deployed ${safeText(t.deployedAt)}`}`;
}

/**
 * Release names by id, read only when some tenant has one deployed. Best
 * effort: a listing that fails leaves every release named by id alone.
 */
async function releaseNamesById(
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  tenants: readonly TenantSummary[],
): Promise<Map<number, string>> {
  if (!tenants.some((t) => t.deployedReleaseId !== undefined)) return new Map();
  const rows = await listReleases(auth, { workspaceId: auth.workspaceId }).catch(() => []);
  return new Map(rows.flatMap((r) => (r.id === undefined ? [] : [[r.id, r.name] as const])));
}

async function runGet(args: ParsedArgs): Promise<void> {
  const name = requireTenant(args, "get");
  const auth = await getAccessToken(args);
  // The liveness gate, so a suspended tenant reads as unreachable rather than
  // as a URL that will not answer.
  //
  // The record the gate reads is kept rather than fetched a second time: it
  // carries what the last `tenant deploy` left behind, which is how a caller
  // settles whether an interrupted deploy landed. One read, so the answer and
  // the liveness check cannot come from two different moments.
  let record: TenantSummary | null = null;
  const resolved = await resolveSource(
    parseSource(name, ["tenant"], { command: "tenant", subcommand: "get" }),
    async () => auth,
    { getTenant: async (a, o) => (record = await getTenant(a, o)), workspaceless: "any", ...tenantVerbHint("get", args) },
  );
  const seen = record as TenantSummary | null;
  const releases = seen === null ? new Map<number, string>() : await releaseNamesById(auth, [seen]);
  if (isMachineOutput(args)) {
    // The fields `tenant list --json` carries for the same tenant, plus what
    // the last deploy left — one tenant should not read as two shapes.
    writeJson({
      id: seen?.id,
      name,
      display: seen?.display,
      type: seen?.type,
      url: resolved.target.base,
      state: seen?.state,
      deployedAt: seen?.deployedAt ?? null,
      deployedReleaseId: seen?.deployedReleaseId ?? null,
      deployedReleaseName: seen?.deployedReleaseId === undefined ? null : (releases.get(seen.deployedReleaseId) ?? null),
      selector: `tenant:${name}`,
      workspaceId: auth.workspaceId,
    });
    return;
  }
  const s = stdoutStyle();
  const display = seen?.display !== undefined && seen.display !== name ? `  ${s.dim(`(${safeText(seen.display)})`)}` : "";
  printHuman(`${s.bold(safeText(name))}${display}\n`);
  detail(resolved.target.base);
  if (seen?.type !== undefined) detail(`type: ${safeText(seen.type)}`);
  if (seen?.state !== undefined) detail(`state: ${safeText(seen.state)}`);
  if (seen !== null) detail(deployedLine(seen, releases));
}

// ── deploy ──────────────────────────────────────────────────────────────────

async function runDeploy(args: ParsedArgs): Promise<void> {
  assertNoMergeFlags(args);
  const tenant = requireTenant(args, "deploy");
  const releaseArg = args.positionals[1];
  if (releaseArg === undefined || releaseArg === "") {
    throw new UsageError(
      `\`xanosdk tenant deploy\` needs a release: \`xanosdk tenant deploy ${shellWord(tenant)} <release>${contextFlags(args)}\`. ` +
        `Run \`xanosdk release list${contextFlags(args)}\` to see them.`,
      { hintFor: { command: "tenant", subcommand: "deploy" } },
    );
  }
  // Before any request, with the per-name loop, as the tenant name is checked.
  assertOneName(releaseArg, "the release name", { args, helpFor: { command: "tenant", subcommand: "deploy" } });
  // The landing route reads these in the name it is sent, so it would end in
  // a raw 400 or 404 after the checks passed. `release create` refuses them.
  const unlandable = untenantDeployableReleasePart(releaseArg);
  if (unlandable !== undefined) {
    throw new UsageError(
      `Release "${releaseArg}" cannot be landed on a tenant: its name holds \`${unlandable}\`, which the ` +
        `landing route cannot address (\`|\` reads as a filter, and a name holding \`=\` is never found). ` +
        `Nothing was sent.\nCut it again as \`xanosdk release create ${shellWord(promotableReleaseName(releaseArg))}\` ` +
        `from the source \`xanosdk release show ${shellWord(releaseArg)}${contextFlags(args)}\` names, and land that.`,
      { hintFor: { command: "tenant", subcommand: "deploy" } },
    );
  }

  // Static hosting on a tenant is its own surface and this does not touch it.
  // Said out loud rather than ignored: a flag that silently did nothing would
  // teach that a site was published.
  if (args.static !== undefined) {
    throw new UsageError(
      `\`--static\` publishes a site into the workspace a deploy writes, and a tenant's static ` +
        `hosting is scoped to the tenant. \`xanosdk tenant deploy\` does not publish one.`,
      { helpFor: { command: "tenant", subcommand: "deploy" } },
    );
  }

  const auth = await getAccessToken(args);
  // The tenant's record is kept from the read that resolves it, as `tenant get`
  // keeps it: its `deployedAt` is the value an interrupted deploy is settled
  // against, so it has to be the one read BEFORE the write.
  let before: TenantSummary | null = null;
  const target = await resolveSource(
    parseSource(tenant, ["tenant"], { command: "tenant", subcommand: "deploy" }),
    async () => auth,
    {
      getTenant: async (a, o) => (before = await getTenant(a, o)),
      // A tenant with no workspace yet gets one from this landing.
      workspaceless: "any",
      ...tenantVerbHint("deploy", args, ` ${shellWord(releaseArg)}`),
    },
  ).catch(async (err: unknown) => {
    throw (await swappedDeployArgs(err, auth, tenant, releaseArg, args)) ?? err;
  });
  const release = await resolveSource(
    parseSource(releaseArg, ["release"], { command: "tenant", subcommand: "deploy" }),
    async () => auth,
  );
  const previous = before as TenantSummary | null;
  const previousDeployedAt = previous?.deployedAt ?? null;
  const previousDeployedReleaseId = previous?.deployedReleaseId ?? null;
  // By name too, as `tenant get --json` names it (E2E pass 26): the release
  // being deployed answers for itself; any other is read off the release list.
  // A listing that answered without it says the release was deleted: the
  // tenant's record keeps the id of a release that no longer exists.
  let previousReleaseDeleted = false;
  const previousDeployedReleaseName =
    previousDeployedReleaseId === null
      ? null
      : previousDeployedReleaseId === release.release?.id
        ? release.release.name
        : await listReleases(auth, { workspaceId: auth.workspaceId }).then(
            (rows) => {
              const hit = rows.find((r) => r.id === previousDeployedReleaseId);
              previousReleaseDeleted = hit === undefined;
              return hit?.name ?? null;
            },
            () => null,
          );

  // Named as the `--json` document's `destination` names it: the instance and
  // the workspace the tenant lives under. The tenant's own internal workspace
  // number means nothing to its reader, and a line derived from it read as a
  // different destination from the document's (E2E pass 34: "workspace 1" over
  // `workspaceId: 93`). Which tenant is the headline's job.
  // Named by its actual type: `tenant deploy` can name an ephemeral, and the
  // JSON's `kind` already said so while the text called it a tenant.
  const ephemeral = target.target.tenantType === "ephemeral";
  const named = `${ephemeral ? "ephemeral" : "tenant"} "${tenant}"`;
  const display = target.target.display !== undefined && target.target.display !== "" ? target.target.display : undefined;
  // No label: the headline right above names the tenant (with its display
  // name), and saying it again on the host line read as two destinations.
  const destination: WriteTarget = {
    base: auth.instance,
    workspaceId: auth.workspaceId,
  };
  // Under a headline, as `promote`'s is: the indented "on …" line printed
  // first read as the tail of whatever the terminal showed before, and the
  // `Landing` line came only after the env and password warnings.
  step(`Deploying release ${release.target.label} to ${describeBackend(target)}`);
  discloseWriteTarget(destination);
  // What it runs now, which this replaces — `--json` named it, the text never
  // did (E2E pass 27).
  if (previousDeployedReleaseId !== null) {
    const shown =
      previousDeployedReleaseName !== null
        ? `"${previousDeployedReleaseName}"`
        : `#${previousDeployedReleaseId}${previousReleaseDeleted ? " (deleted since)" : ""}`;
    // The last release LANDED, not what it runs: a `deploy --to tenant:` merge
    // since changes what it serves and not this record — the caveat `release
    // create --from tenant:` carries (E2E pass 29: "currently runs" after merges).
    detail(
      `last landed release ${shown}${previousDeployedAt !== null ? ` (deployed ${previousDeployedAt})` : ""}` +
        (previousDeployedReleaseId === release.release?.id ? " — this lands it again" : "") +
        ` — any \`deploy --to tenant:\` merge since may have changed what it runs`,
    );
  }

  // The release archive, downloaded ONCE for every read of it below — the env
  // courtesy, the password-hash check and the landing record each fetched it
  // (E2E pass 23: `release/<id>/export` twice before landing). A failed fetch
  // is not kept, so a later reader tries again rather than inheriting it.
  let archiveBytes: Promise<Uint8Array> | undefined;
  const releaseBytes = (): Promise<Uint8Array> => {
    const id = release.release?.id;
    if (id === undefined) return Promise.reject(new Error("the release carries no id"));
    archiveBytes ??= downloadRelease(auth, { workspaceId: release.target.workspaceId, id, base: release.target.base }).catch(
      (err: unknown) => {
        archiveBytes = undefined;
        throw err;
      },
    );
    return archiveBytes;
  };

  const loadArchive = readOnce(async () =>
    release.release?.id === undefined ? undefined : decodeWorkspaceArchive(await releaseBytes()),
  );
  // A tenant on its own domain has no workspace until its first release lands
  // (the per-workspace reads there answer 404 "Invalid workspace"): nothing is
  // served to preview, protect, or check names against, so the reads of what it
  // runs are skipped and the release is landed through the tenant deploy route.
  const firstLanding = !ephemeral && !(await tenantHasWorkspace(auth, target.target.base));
  const loadLive = readOnce(() =>
    firstLanding
      ? Promise.resolve<ExportedBundle>({ payload: {} })
      : exportWorkspaceBundle(auth, {
          base: target.target.base,
          workspaceId: target.target.workspaceId,
          label: `reading ${named}`,
          safeErrors: true,
        }),
  );
  if (firstLanding) {
    detail(`${named} has no workspace yet, so this is its first landing: nothing is served there to preview or replace.`);
  } else {
    await assertPreLandingReadsAnswered(args, {
      reads: [
        ...(release.release?.id === undefined ? [] : [{ what: `release "${release.target.label}"'s archive`, read: releaseBytes }]),
        { what: `what ${named} serves`, read: loadLive },
      ],
      command: `tenant deploy ${shellWord(tenant)} ${shellWord(release.target.label)}`,
      named,
    });
  }
  // Before the table check and the confirmation, as on `promote`: a name the
  // tenant gives to another object is not replaced in place. Measured: a
  // release carrying table "reviews" under a new identity landed it as
  // "reviews_01" and dropped the tenant's "reviews" with its rows, and the
  // deploy answered success.
  if (!firstLanding) await assertTenantIdentitiesFree(args, auth, {
    releaseBytes,
    loadArchive,
    loadLive,
    label: release.target.label,
    tenant: {
      base: target.target.base,
      workspaceId: target.target.workspaceId,
      type: ephemeral ? "ephemeral" : "tenant",
      name: tenant,
      ...(display === undefined ? {} : { display }),
    },
    named,
  });
  // Read first, so the line that says the table changes are checked below
  // says so only when something IS below.
  const tables = firstLanding
    ? undefined
    : await releaseTableEffects(loadArchive, loadLive, {
        mode: "replace",
        skipTables: new Set((release.release?.seededTables ?? []).map((t) => t.name)),
      });
  /** The release's effects on the tables it does not reseed, once read — dropped tables with their rows counted. */
  const landingEffects: TableEffects | undefined =
    tables !== undefined && "effects" in tables ? await withDroppedRows(auth, tables.effects, target.target) : undefined;
  if (!firstLanding) {
    reportNotRun(
      "tenant",
      landingEffects === undefined || alteringChanges(landingEffects).length + additiveChanges(landingEffects).length > 0,
    );
  }

  // BEFORE the confirmation, as on `promote`. A tenant is somebody's live
  // deployment, so "which env vars does this create there" is the half of the
  // decision the result cannot tell you afterwards.
  await reportEnvLanding(auth, {
    release: { id: release.release?.id, name: release.target.label },
    releaseHost: { base: release.target.base, workspaceId: auth.workspaceId },
    target: target.target,
    targetLabel: named,
    // A tenant write asks first and refuses off a terminal without `--yes`; an
    // ephemeral write does not ask.
    envSetTo: ephemeral
      ? ` --to ${shellWord(`ephemeral:${tenant}`)}${contextFlags(args)}`
      : ` --to ${shellWord(`tenant:${tenant}`)} --yes${contextFlags(args)}`,
    loadArchive,
    loadLive,
  });
  // Also before the confirmation: what the landing does to the tenant's rows.
  // Measured: a seeded table's rows are REPLACED by the release's (300 → 3);
  // every other table the release carries keeps its rows under the release's
  // definition, converted where a column changes type; and a table the
  // release does not carry is DROPPED with its rows.
  const seedRows = firstLanding ? [] : await seedRowsReplaced(auth, release, target.target, named);
  if (landingEffects !== undefined) {
    discloseTableEffects(landingEffects, { subject: "the tenant deploy", additiveWhere: `${named}'s tables` });
    await assertStorageModesKept(landingEffects.storageChanges, tableRowCounter(auth, target.target), {
      target: named,
      subject: "the tenant deploy",
      mode: "replace",
    });
  } else if (tables !== undefined && "failure" in tables) {
    warn(
      `Could not read ${named}'s tables (${tables.failure}), so what the landing does to the columns it keeps — ` +
        `drops, retypes, removed enum values — is not checked.`,
      "plan.target-unreadable",
    );
  }
  // Also before the confirmation: a public URL the release serves under another
  // slug moves the moment it lands, and every client of the old one breaks.
  const moves: CanonicalMove[] = await Promise.all([loadArchive(), loadLive()]).then(
    ([archive, live]) => releaseCanonicalMoves(archive, live),
    () => [],
  );
  discloseCanonicalMoves(moves, { subject: "the tenant deploy" });
  // Also before the confirmation: seeded password rows that land here cannot
  // be logged in with, and that is part of what is being agreed to.
  const passwordHashesUnverifiable = await warnPasswordHashes(auth, release, tenant, named, ephemeral, releaseBytes);

  // The release is an object on the PARENT: the deploy route answers with the
  // tenant, not the release, so its identity comes from the resolved source.
  // `branch` is null — a tenant deploy lands a release, it names no branch.
  //
  // The result's `destination` names the instance and workspace the tenant
  // lives under, with `kind: "tenant"` — not the tenant's own URL as
  // `instance`, which no wrapper comparing it against its configured instance
  // could ever match. The tenant itself is `tenant: { name, url }`.
  const op = createOperation<"deploy", TenantDeployExtras>({
    operation: "tenant deploy",
    // The one destination shape: `kind` by the target's actual type (a tenant
    // deploy can name an ephemeral), `label` its bare name, `url` its own URL.
    destination: backendDestinationPayload(auth, {
      kind: ephemeral ? "ephemeral" : "tenant",
      name: tenant,
      url: target.target.base,
      ...(display === undefined ? {} : { display }),
    }),
    release: {
      instance: release.target.base,
      workspaceId: release.target.workspaceId,
      id: release.release?.id,
      name: release.release?.name ?? release.target.label,
    },
    branch: null,
    steps: ["deploy"],
    extras: {
      tenant: { name: tenant, url: target.target.base, ...(display === undefined ? {} : { display }) },
      previousDeployedAt,
      previousDeployedReleaseId,
      previousDeployedReleaseName,
      // The text's caveat, for the `--json` reader (E2E pass 30): the previous
      // release is the last one LANDED, not necessarily what it runs.
      previousDeployedCaveat:
        previousDeployedReleaseId === null
          ? null
          : "the last landed release; a `deploy --to tenant:` merge since may have changed what it runs",
      declined: false,
      firstLanding,
      landingRecord: null,
      seedRowsReplaced: seedRows,
      tableEffects: landingEffects === undefined ? null : tableEffectsPayload(landingEffects),
      canonicalMoves: moves.map((m) => ({ ...m })),
      // The stderr warning's columns, for the `--json` reader who never sees it.
      ...(passwordHashesUnverifiable !== undefined ? { passwordHashesUnverifiable } : {}),
    },
  });

  const resolveWith = `xanosdk tenant get ${shellWord(tenant)} --json${contextFlags(args)}`;
  // With no release to put back, why — and what puts code back instead: this
  // project's, merged onto it. `deploy` reaches an ephemeral as `tenant:` too,
  // and takes no `ephemeral:`.
  const { pipedYes } = await import("./retry-command.js");
  const noRecovery = previousReleaseDeleted
    ? `The release it last landed (#${previousDeployedReleaseId}) has been deleted, so there is none to put back. ` +
      `Re-cut it from the source it came from and land that, or put this project's code back with ` +
      `\`xanosdk deploy --to ${shellWord(`tenant:${tenant}`)}${pipedYes(args)}${contextFlags(args)}\`.`
    : "No earlier release is recorded on it to put back.";
  // Landing the release it last ran puts back everything a stopped deploy
  // replaced; `null` when the tenant has no landed release to put back.
  const recoverWith =
    previousDeployedReleaseName === null
      ? null
      : `xanosdk tenant deploy ${shellWord(tenant)} ${shellWord(previousDeployedReleaseName)} --yes${contextFlags(args)}`;
  let outcome: TenantDeployOutcome | undefined;
  let declined = false;
  try {
    await runOperation(
      op,
      { machine: isMachineOutput(args), resolveWith, what: "the tenant deploy" },
      async (o) => {
        // Inside the operation, so a decline still answers `--json` with the one
        // document every landing command writes: `deploy` did not happen.
        if (args.yes !== true) {
          // The refusal `deploy --to tenant:` gives off a terminal, with the
          // same `error.details` (E2E pass 28), and this run with `--yes` as
          // the command that answers it (E2E pass 30).
          const { yesRerun } = await import("./retry-command.js");
          const { rerun, note } = yesRerun(args, `tenant deploy ${shellWord(tenant)} ${shellWord(release.target.label)}`);
          const dropped = landingEffects?.droppedTables ?? [];
          const droppedColumns = landingEffects?.droppedColumns ?? [];
          const paired = landingEffects === undefined ? [] : droppedAndAdded(landingEffects);
          const stopping = landingEffects === undefined ? [] : stoppingRetypes(landingEffects);
          const ok = await confirm(
            (firstLanding
              ? `Land release "${release.target.label}" on ${named}? It is the tenant's first landing.`
              : `Replace what ${named} serves with release "${release.target.label}"? ` +
                `Anything not in the release — an API an earlier landing or a \`deploy --to tenant:\` merge added — is removed. Static hosting is kept.`) +
              (dropped.length === 0
                ? ""
                : ` It DROPS ${dropped.length === 1 ? "table" : "tables"} ` +
                  `${dropped.map(droppedTableLine).join(", ")}` +
                  ` with every row — the release does not carry ${dropped.length === 1 ? "it" : "them"}.`) +
              (droppedColumns.length === 0
                ? ""
                : ` It DROPS ${droppedColumns.length === 1 ? "column" : "columns"} ${droppedColumns.join(", ")} with every value.`) +
              (seedRows.length === 0
                ? ""
                : ` It also REPLACES the rows of ${seedRows.map((r) => `${r.table} (${rowsPhrase(r)})`).join(", ")}.`) +
              (stopping.length === 0
                ? ""
                : ` It can STOP partway on ${stopping.join(", ")} (see above), leaving ${named} partly replaced.`) +
              movesClause(moves),
            {
              flag: "--yes",
              refusal: {
                details: {
                  landed: false,
                  declined: false,
                  droppedTables: dropped.map((t) => ({ ...t })),
                  droppedColumns: [...droppedColumns],
                  pairedColumns: paired,
                  canonicalMoves: moves.map((m) => ({ ...m })),
                },
                rerun,
                note,
              },
            },
          );
          if (!ok) {
            info("Deploy cancelled — nothing was written.");
            o.set("declined", true);
            declined = true;
            o.finish("deploy", "no");
            return;
          }
        }
        step(`Landing ${release.target.label} on ${tenant}`);
        o.begin("deploy");
        o.sending();
        outcome = await deployReleaseToTenant(auth, {
          workspaceId: auth.workspaceId,
          tenant,
          release: release.target.label,
        }).catch((err: unknown) => {
          // The instance refusing a table's switch back to JSON storage changes
          // nothing: a known outcome, not a lost answer (the check above refuses
          // it first whenever the tenant's tables could be read).
          if (xdoConversionRefused(err)) {
            throw xdoConversionRefusal(named, err as Error, new SettledWriteFailure((err as Error).message, { cause: err }));
          }
          // A data constraint the release breaks is the server's answer, not a
          // lost one: the deploy ran, stopped, and stops the same way again.
          const found = constraintStop(err);
          if (found === undefined) throw err;
          const stop = namedConstraint(found, landingEffects);
          o.set("partlyReplaced", true);
          o.set("constraint", stop);
          o.set("recoverWith", recoverWith);
          throw new SettledWriteFailure(err instanceof Error ? err.message : String(err), { cause: err });
        });
        o.set("deployedAt", outcome.deployedAt ?? null);
        o.set("microservices", outcome.microservices);
        o.finish("deploy");
        // A tenant deploy REPLACES what the tenant serves, so the record for it
        // becomes what the release carried when the release is this project's,
        // and nothing otherwise. Best effort: the landing stands either way.
        o.set("landingRecord", await recordTenantLanding(auth, args, release, tenant, ephemeral, releaseBytes));
      },
    );
  } catch (err) {
    // A decline is not a failure: the result says `no`, and the run exits 0.
    if (declined) return;
    if (err instanceof SettledWriteFailure) {
      const stop = namedConstraint(constraintStop(err.cause)!, landingEffects);
      // Measured: the tables a conversion reached before it stopped keep their
      // converted values, and putting the previous release back does not undo them.
      const conversion = stop.kind === "conversion";
      warn(
        `The deploy stopped partway: ${conversion ? "a stored value does not convert to a column type" : `the tenant's data breaks ${CONSTRAINT_PHRASE[stop.kind]}`} ` +
          `release "${release.target.label}" declares${constraintWhere(stop)}` +
          (stop.notNull === true
            ? ` — answered as a NOT NULL violation, though the release makes no field required: the value converts to null, and the column is not nullable. `
            : `. `) +
          `${named} may be partly replaced — serving some of "${release.target.label}" and some of what it ran before` +
          (conversion ? `, with the values of the tables it reached already converted for good.` : `.`),
        "tenant.deploy-partial",
        recoverWith === null
          ? [noRecovery, `${CONSTRAINT_FIX[stop.kind]}, then land "${release.target.label}" again.`]
          : [
              `Put back what it ran: \`${recoverWith}\``,
              `Then ${lowerFirst(CONSTRAINT_FIX[stop.kind])}, and land "${release.target.label}" again.`,
            ],
      );
    }
    if (err instanceof OperationError && err.result.completed === "unknown") {
      // What to compare, and why the id alone cannot answer it: a redeploy of
      // the release already there leaves `deployedReleaseId` where it was, so
      // only `deployedAt` moving says this deploy happened. An unmoved
      // `deployedAt` does not say the tenant is untouched: a deploy that
      // stopped partway leaves it as well, so the safe answer to it is putting
      // the last landed release back.
      warn(
        `Compare its \`deployedAt\` and \`deployedReleaseId\` with what they were before this deploy ` +
          `(deployedAt ${previousDeployedAt ?? "none"}, deployedReleaseId ${previousDeployedReleaseId ?? "none"}). ` +
          `A redeploy of the same release leaves the id unchanged, so \`deployedAt\` is the one that moves.`,
        "tenant.deploy-unconfirmed",
        [
          `Moved: "${release.target.label}" landed.`,
          `Unmoved: it did not land, but a deploy that stopped partway can leave ${named} partly replaced` +
            (recoverWith === null ? `.` : ` — \`${recoverWith}\` puts back what it ran.`),
          ...(recoverWith === null ? [noRecovery] : []),
        ],
      );
    }
    throw err;
  }

  // Landed. A microservice that did not come up does not fail the landing —
  // the release is on the tenant — but it is not something to report as clean.
  const failed = (outcome?.microservices ?? []).filter(isFailedMicroservice);
  if (failed.length > 0) {
    warn(
      `${failed.length} microservice(s) did not come up on ${named}: ` +
        failed.map((m) => (m.detail === undefined ? m.name : `${m.name} (${m.detail})`)).join("; ") +
        `. The release landed; these need attention.`,
      "microservice.failed",
    );
  }
  // On stderr, so off a terminal too: stdout (the machine document) is not where it goes.
  success(`Landed ${release.target.label} on ${tenant}${firstLanding ? " (its first landing)" : ""}`);
  detail(target.target.base);
}

/**
 * Refuse to go on when a read the pre-landing checks need got no answer — a
 * network failure or a server error. Each check below degrades to a warning
 * when its input is missing, which is right for an input the instance cannot
 * give (an older instance, an undecodable archive) and wrong for one it simply
 * did not give this time: a replace that may drop tables and columns would
 * land with every check off. Exit 8, nothing sent, and this run as the rerun.
 * Any other failure passes on to the checks, which say what they could not do.
 */
async function assertPreLandingReadsAnswered(
  args: ParsedArgs,
  ctx: { reads: { what: string; read: () => Promise<unknown> }[]; command: string; named: string },
): Promise<void> {
  for (const { what, read } of ctx.reads) {
    let failure: unknown;
    try {
      await read();
      continue;
    } catch (err) {
      failure = err;
    }
    const { LookupFailedError, isTransportFailure, isUnansweredLookup } = await import("./source-resolve.js");
    if (!isUnansweredLookup(failure)) continue;
    const { retryCommand, withheldNote } = await import("./retry-command.js");
    const retry = retryCommand(args, { command: ctx.command });
    // The cause is not quoted: the archive read can carry its signed download
    // link. A refused certificate is named by its code and host, which carry none.
    const certificate = certificateFailureCode(failure);
    const cause =
      certificate !== undefined
        ? `${UNTRUSTED_CERTIFICATE} (${certificate}) at ${certificateFailureHost(failure)} — a certificate or proxy configuration problem, not a network blip`
        : isTransportFailure(failure)
          ? "a network failure"
          : "a server error";
    const refused = new LookupFailedError(
      `Could not read ${what}, which the checks before a landing compare (${cause}). ` +
        `Nothing was sent and ${ctx.named} is untouched — a replace does not land with its checks off`,
      "unreachable",
      "tenant",
      `run \`${retry.command}\` again`,
    );
    refused.message += withheldNote(retry.withheld);
    throw refused;
  }
}

/**
 * Refuse a release whose names or pinned public URL slugs the tenant already
 * gives to other objects — the check `promote` runs, planned against the
 * tenant. A replace does not take a same-named object over: it lands the
 * release's under a suffixed name and drops the tenant's, and a table goes
 * with its rows. A check that cannot run is said, not refused.
 */
async function assertTenantIdentitiesFree(
  args: ParsedArgs,
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  ctx: {
    releaseBytes: () => Promise<Uint8Array>;
    loadArchive: () => Promise<unknown>;
    loadLive: () => Promise<ExportedBundle>;
    label: string;
    tenant: { base: string; workspaceId: number; type: "tenant" | "ephemeral"; name: string; display?: string };
    named: string;
  },
): Promise<void> {
  let typed: Uint8Array | undefined;
  let bundle: unknown;
  try {
    typed = asWorkspaceArchive(await ctx.releaseBytes(), ctx.label);
    bundle = await ctx.loadArchive();
  } catch {
    // Dropped, never printed: a failure here can carry the signed download link.
    typed = undefined;
  }
  let reason: string | undefined;
  if (typed === undefined || bundle === undefined) {
    reason = "the release archive could not be read";
  } else {
    const check = await assertReleaseIdentitiesFree(args, auth, {
      archive: typed,
      bundle,
      lockPath: landingLockPath(args),
      live: await ctx.loadLive().catch(() => undefined),
      tenant: ctx.tenant,
      subject: `deploy release "${ctx.label}"`,
      verb: "tenant deploy",
      remedySuffix:
        `A release's names and slugs are fixed when it is cut: make the change in the project, deploy ` +
        `it, cut a new release from it with \`xanosdk release create\`, and deploy that one.`,
    });
    if (!check.checked) reason = check.reason;
  }
  if (reason === undefined) return;
  warn(
    `Whether this release's names and pinned public URL slugs are free on ${ctx.named} was not checked — ${reason}.`,
    "tenant.identities-unchecked",
    [
      `A name the tenant gives to another object lands as a suffixed second object, and the tenant's own is dropped — a table with its rows.`,
    ],
  );
}

/**
 * Record a tenant deploy's landing (see `landing-record.ts`): the release's own
 * archive, read back, decides whether it is this project's. An archive that
 * cannot be read records nothing — and says so, since a replace has just made
 * whatever was recorded for the tenant stale.
 */
async function recordTenantLanding(
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  args: ParsedArgs,
  release: ResolvedSource,
  tenant: string,
  /** An ephemeral's record is kept in local state, lock or not (see `landing-record.ts`). */
  ephemeral: boolean,
  /** The release archive's bytes, shared with the reads before the landing. */
  releaseBytes: () => Promise<Uint8Array>,
): Promise<LandingReport | null> {
  const lockPath = landingLockPath(args);
  const id = release.release?.id;
  if ((lockPath === undefined && !ephemeral) || id === undefined) return null;
  let archive: unknown;
  try {
    archive = decodeWorkspaceArchive(await releaseBytes());
  } catch {
    archive = undefined;
  }
  return recordForeignLanding({
    lockPath,
    instance: auth.instance,
    dest: { kind: ephemeral ? "ephemeral" : "tenant", name: tenant },
    // Unreadable: nothing on the tenant is known to be this project's any more.
    bundle: archive ?? {},
    mode: "replace",
    ...(archive === undefined ? { unreadable: true } : {}),
  });
}

/**
 * Warn when a seeded release carries password hashes, which only verify in the
 * workspace they were made in (see `passwordSeedColumns`).
 *
 * Read only for a release that carries rows at all, and best effort: a
 * courtesy that cannot download the archive says nothing rather than refusing a
 * landing it does not authorize. Silent when the tenant IS where the release
 * was cut — there the hashes verify — the rule `deploy` follows.
 */
async function warnPasswordHashes(
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  release: ResolvedSource,
  tenant: string,
  named: string,
  ephemeral: boolean,
  /** The release archive's bytes, shared with the other reads of it. */
  releaseBytes: () => Promise<Uint8Array>,
): Promise<string[] | undefined> {
  const found = release.release;
  if (found?.id === undefined || (found.seededTables ?? []).length === 0) return undefined;
  try {
    const bytes = await releaseBytes();
    const columns = passwordSeedColumns(bytes);
    if (columns.length === 0) return undefined;
    const origin = await passwordOrigin(auth, found);
    if (origin?.name === tenant) return undefined;
    // An ephemeral can be deployed from an entry file; a standard tenant only
    // takes a release, so its remedy says what can be done there instead.
    warn(passwordHashesWarning(found.name, columns, named, "the landing", origin?.phrase, ephemeral), "seed.password-hashes");
    return [...columns];
  } catch {
    // Nothing is known, so nothing is said.
    return undefined;
  }
}

/**
 * The extras `tenant deploy` carries beside the contract's core.
 *
 * `previous*` are read before the write, so an `unknown` can be settled by
 * comparing them with what `tenant get` reports afterwards. `deployedAt` and
 * `microservices` come from the deploy's own answer, present once it landed.
 */
/** A table whose rows a seeded release replaces on the tenant. */
interface SeedRowsReplaced {
  table: string;
  /** The rows the tenant holds now, `null` when they could not be counted, `0` for a table it does not have yet. */
  liveRows: number | null;
  /** The rows the release carries for it, `null` when the release records no count. */
  seedRows: number | null;
}

/**
 * The effects with each dropped table's rows counted on the tenant — said in
 * the confirmation, so the reader agrees to a number. A count that cannot be
 * read stays `null` and is said as such; it never hides the table.
 */
async function withDroppedRows(
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  effects: TableEffects,
  target: { base: string; workspaceId: number },
): Promise<TableEffects> {
  if (effects.droppedTables.length === 0) return effects;
  const listed = await listTables(auth, { workspaceId: target.workspaceId, base: target.base }).catch(() => undefined);
  const droppedTables = [];
  for (const t of effects.droppedTables) {
    const here = listed?.find((l) => l.name === t.table);
    const rows =
      here === undefined
        ? null
        : ((await countTableRows(auth, { workspaceId: target.workspaceId, tableId: here.id, base: target.base }).catch(
            () => undefined,
          )) ?? null);
    droppedTables.push({ ...t, rows });
  }
  return { ...effects, droppedTables };
}

function rowsPhrase(r: SeedRowsReplaced): string {
  const live = r.liveRows === null ? "its rows" : `${r.liveRows} ${r.liveRows === 1 ? "row" : "rows"}`;
  const seed = r.seedRows === null ? "the release's rows" : `${r.seedRows} seed ${r.seedRows === 1 ? "row" : "rows"}`;
  return `${live} replaced by ${seed}`;
}

/**
 * Name each table whose rows a seeded release replaces on the tenant, with the
 * rows there now — said before the confirmation, which repeats it. Measured: a
 * tenant deploy of a release cut with `--seed` replaces a seeded table's rows
 * with the release's (300 → 3) and keeps every other table's rows. A count
 * that cannot be read is said as such; it never hides the table.
 */
async function seedRowsReplaced(
  auth: Awaited<ReturnType<typeof getAccessToken>>,
  release: ResolvedSource,
  target: { base: string; workspaceId: number },
  named: string,
): Promise<SeedRowsReplaced[]> {
  const seeded = release.release?.seededTables ?? [];
  if (seeded.length === 0) return [];
  const listed = await listTables(auth, { workspaceId: target.workspaceId, base: target.base }).catch(() => undefined);
  const out: SeedRowsReplaced[] = [];
  for (const t of seeded) {
    const here = listed?.find((l) => (t.guid !== undefined && l.guid === t.guid) || l.name === t.name);
    const liveRows =
      listed === undefined
        ? null
        : here === undefined
          ? 0
          : ((await countTableRows(auth, { workspaceId: target.workspaceId, tableId: here.id, base: target.base }).catch(
              () => undefined,
            )) ?? null);
    out.push({ table: t.name, liveRows, seedRows: t.count ?? null });
  }
  const one = out.length === 1;
  warn(
    `"${release.target.label}" was cut with rows, and a tenant deploy REPLACES ${one ? "that table's" : "those tables'"} ` +
      `rows on ${named} with the release's — every row there now is deleted:`,
    "tenant.seed-replaces-rows",
    [
      ...out.map((r) => `table ${r.table}: ${rowsPhrase(r)}`),
      `Every other table the release carries keeps its rows. To keep these too, land a release cut without \`--seed\`.`,
    ],
  );
  return out;
}

interface TenantDeployExtras {
  /** Tables whose rows a seeded release replaced (or would have), with the counts said before confirming. */
  seedRowsReplaced: SeedRowsReplaced[];
  /** What the landing does to the tables it does not reseed (see `plan-disclosure.ts`), or `null` when unread. */
  tableEffects: Record<string, unknown> | null;
  /** The public URL slugs the landing moves, said before confirming. */
  canonicalMoves: CanonicalMove[];
  /** The tenant landed on, by the name the routes take, the URL it serves at, and what people call it. */
  tenant: { name: string; url: string; display?: string };
  previousDeployedAt: string | null;
  previousDeployedReleaseId: number | null;
  /** The name of that release, or `null` when none was deployed or the list does not hold it. */
  previousDeployedReleaseName: string | null;
  /** Why the previous release may not be what it runs (a merge since), or null when it had none. */
  previousDeployedCaveat: string | null;
  deployedAt: string | null;
  microservices: TenantMicroserviceOutcome[];
  /** Present only when the stderr warning fired: the seeded password columns whose hashes will not verify here. */
  passwordHashesUnverifiable?: string[];
  /** Whether the confirmation was declined. Always present, so every ending reads one shape. */
  declined: boolean;
  /** The tenant had no workspace yet: nothing was served there, so nothing was previewed or replaced. */
  firstLanding: boolean;
  /** Present only when the deploy stopped on a data constraint: the tenant may serve part of the release. */
  partlyReplaced?: true;
  /** What stopped it, and where when the server's answer names it. Present with `partlyReplaced`. */
  constraint?: ConstraintStop;
  /** The command that lands the previous release again, or `null` when none was landed. Present with `partlyReplaced`. */
  recoverWith?: string | null;
  /**
   * What the landing recorded in the project's lock for `deploy --to tenant:<x>
   * --prune` (see `lock/landed.ts`), or `null` when there is no lock here.
   */
  landingRecord: LandingReport | null;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ── delete ──────────────────────────────────────────────────────────────────

async function runDelete(args: ParsedArgs): Promise<void> {
  const name = requireTenant(args, "delete");
  const auth = await getAccessToken(args);
  // Read first, for what it IS: `tenant delete` takes an ephemeral too, and
  // "Deleted tenant …" with `kind: "tenant"` described one as the other. A
  // failed read is not a reason to refuse a delete — the route answers for the
  // name either way — so it falls back to "tenant". A read that ANSWERED "no
  // such name" is a different fact, kept apart from the failure below. A read
  // that got NO answer is neither: the platform is unreachable, so it is the
  // lookup failure `ephemeral delete` and `release delete` answer — exit 8,
  // "a network failure", the rerun named — not a DELETE put to a host that
  // cannot be reached and reported as "Nothing was sent" (E2E pass 22).
  let readFailed = false;
  const record = await getTenant(auth, { workspaceId: auth.workspaceId, name }).catch(async (err: unknown) => {
    if (isUnansweredLookup(err)) {
      // The headline first, as `release delete` prints it before its lookup:
      // the failure below otherwise arrived with nothing saying what was being
      // deleted (E2E pass 23). The kind is unread, so it is the verb's own noun.
      step(`Deleting tenant "${name}"`);
      discloseWriteTarget({ base: auth.instance, workspaceId: auth.workspaceId });
      const { deleteLookupFailed } = await import("./ephemeral-command.js");
      throw deleteLookupFailed("tenant", name, err);
    }
    readFailed = true;
    return null;
  });
  const kind: "ephemeral" | "tenant" = record?.type === "ephemeral" ? "ephemeral" : "tenant";
  const display = record?.display !== undefined && record.display !== name ? record.display : undefined;
  const named = `${kind} "${name}"${display === undefined ? "" : ` (${JSON.stringify(display)})`}`;
  // The destination every delete document carries: the backend, under the
  // instance and workspace it lives in (its own URL is not read for a delete).
  // …and the name people call it, when its record carries one — as
  // `ephemeral delete` carries it.
  // `url` and `display` are always present, `null` when the read found none, so
  // an already-gone answer carries the same key set as a delete.
  const destination = {
    ...writeTargetPayload({ base: auth.instance, workspaceId: auth.workspaceId, kind, label: name }),
    url: record?.url ?? null,
    display: display ?? null,
  };
  if (record === null) {
    // A display name finds no record, and 404s like a deleted tenant. Answering
    // it as "already gone" (exit 0) let a CI cleanup step that used the display
    // name pass while the backend kept running — so it is a failure: exit 8, the
    // code every named backend that could not be addressed exits with, naming
    // the one meant and its ACTUAL kind (the tenant list shows no ephemerals, so
    // both are asked). Settled BEFORE the prompt: "Delete tenant …?" about a
    // name already known not to be one is a question with no true answer.
    const owner = await displayNameOwnerOfEither(auth, name);
    if (isShared(owner)) {
      // Several carry it: which was meant is unknown, so each is named with a
      // delete that asks first — never a confirmed delete of one of them.
      throw new SourceError(
        `No tenant or ephemeral named "${name}" — nothing was deleted.\n` +
          sharedDisplayHint(name, owner, (o) => `\`xanosdk tenant delete ${shellWord(o.name)}${jsonFlag(args)}${contextFlags(args)}\` deletes it, after asking to confirm.`),
        "gone",
        "tenant",
        owner.owners[0]!.name,
        owner.owners.map((o) => o.name),
      );
    }
    if (owner !== undefined) {
      throw new SourceError(
        `No tenant or ephemeral named "${name}" — nothing was deleted.\n` +
          displayNameHint(owner.kind, name, owner.name, `tenant commands take its name: \`xanosdk tenant delete ${shellWord(owner.name)}${answerFlags(args)}${contextFlags(args)}\`.`),
        "gone",
        "tenant",
      );
    }
    // The read answered that the name is not there: nothing to confirm and
    // nothing to send. Still the idempotent outcome a retried cleanup expects.
    // Only what is known: a name the read did not find may never have existed,
    // so "already gone" would claim a history nobody saw.
    if (!readFailed) {
      // With the near names the lists hold (E2E pass 27: a typo exited 0 with
      // the backend meant still running), each as its delete, run as printed.
      // Read strictly: "no near name" decides the exit-0 answer below.
      const { nearForDelete, confirmMissEverywhere } = await import("./ephemeral-command.js");
      const { nearBackendLines } = await import("./display-name-hint.js");
      const near = await nearForDelete(auth, ["tenant", "ephemeral"], name, "tenant");
      const names = near === undefined ? [] : [...(near.names ?? [near.name])];
      const deleteFix = (n: string): string =>
        `\`xanosdk tenant delete ${shellWord(n)}${jsonFlag(args)}${contextFlags(args)}\` deletes it, after asking to confirm.`;
      // A miss on what cannot be a handle names nothing that ever existed, and
      // one a slip from a live name is most likely that one mistyped: neither
      // is an idempotent "already gone" — exit 8, as a display name is.
      if (!isBackendHandle(name) || names.length > 0) {
        throw new SourceError(
          `No tenant or ephemeral named "${name}" — nothing was deleted. \`xanosdk tenant list${contextFlags(args)}\` shows the tenants that exist.` +
            (near === undefined ? "" : nearBackendLines(near, deleteFix)),
          "gone",
          "tenant",
          names[0],
          names.length > 1 ? names : undefined,
        );
      }
      // A landing record this project still keeps for the name is stale: the
      // backend it describes is not there (E2E pass 29: deleted from another
      // copy, the record stayed, and `lock rename` refused against a backend
      // that no longer existed). Cleared either way the name was meant — a
      // tenant's from the lock, an ephemeral's from the local state — and only
      // once no workspace this credential reaches holds the name: a miss under
      // the wrong pinned workspace is the refusal naming the one that does.
      await confirmMissEverywhere(auth, name, "either", "tenant", `xanosdk tenant delete ${shellWord(name)}${answerFlags(args)}${contextFlags(args)}`);
      const lockPath = landingLockPath(args);
      // An ephemeral's tracked pointer goes with its record, as `ephemeral
      // delete` clears it (E2E pass 30: the landing went, and
      // `.xano/ephemeral.json` still bound the project to the gone name) — and
      // is said, as the lock's change is said.
      const ephemeralLanding = forgetLanding(lockPath, auth.instance, { kind: "ephemeral", name });
      const tracked = getEnvironment(readEphemeralState(process.cwd()), auth)?.name === name && clearEnvironment(process.cwd(), auth);
      if (ephemeralLanding !== undefined || tracked) {
        info(`Removed this project's record of ephemeral "${name}" from ${displayPath(ephemeralStatePath(process.cwd()))}.`);
      }
      const clearedLandingRecord =
        forgetLanding(lockPath, auth.instance, { kind: "tenant", name }) !== undefined || ephemeralLanding !== undefined || tracked;
      warn(
        `No tenant or ephemeral named "${name}" — nothing was deleted` +
          `${clearedLandingRecord ? "; this project's landing record for it was stale, so it was cleared" : ""}.`,
        "tenant.not-found",
        names.map((n) => `Did you mean ${near!.kind} "${safeText(n)}"? \`xanosdk tenant delete ${shellWord(n)}${jsonFlag(args)}${contextFlags(args)}\` deletes it, after asking to confirm.`),
      );
      if (isMachineOutput(args)) {
        writeJson({
          verb: "delete",
          destination,
          name,
          deleted: false,
          alreadyGone: true,
          declined: false,
          clearedLandingRecord,
          // As every did-you-mean in a document: `suggestion`, and `suggestions` when a tie named several.
          ...(names.length === 0 ? {} : { suggestion: names[0] }),
          ...(names.length > 1 ? { suggestions: names } : {}),
        });
      }
      return;
    }
  }
  // The headline and where, once the delete is going ahead — before the
  // confirmation, or the refusal off a terminal, which says what it WOULD
  // delete — as `ephemeral delete` says it. Never above a miss.
  const refusing = args.yes !== true && process.stdin.isTTY !== true;
  step(`${refusing ? "Would delete" : "Deleting"} ${named}`);
  discloseWriteTarget({ base: auth.instance, workspaceId: auth.workspaceId });
  if (args.yes !== true) {
    // Off a terminal, the refusal every delete and landing document carries
    // (E2E pass 29: a bare SDK_USAGE with no details), and this delete with `--yes`.
    const ok = await confirm(`Delete ${named}? This destroys it and everything it serves.`, {
      flag: "--yes",
      refusal: {
        details: { verb: "delete", name, deleted: false, alreadyGone: false, declined: false, clearedLandingRecord: false },
        rerun: `xanosdk tenant delete ${shellWord(name)} --yes${args.json === true ? " --json" : ""}${contextFlags(args)}`,
      },
    });
    if (!ok) {
      info("Deletion cancelled — nothing was deleted.");
      // A decline answers `--json` too: the caller asked a question and is owed
      // a document saying the answer was no, not an empty stdout.
      if (isMachineOutput(args)) {
        writeJson({ verb: "delete", destination, name, deleted: false, alreadyGone: false, declined: true, clearedLandingRecord: false });
      }
      return;
    }
  }
  // An unknown outcome (sent, not confirmed) keeps every record below: the
  // tenant may well still be serving.
  const { alreadyGone } = await describeWrite(
    { what: `the delete of ${named}`, resolveWith: `xanosdk tenant get ${shellWord(name)}${contextFlags(args)}` },
    () => deleteTenant(auth, { workspaceId: auth.workspaceId, name }),
  ).catch(async (err: unknown) => {
    const { unknownDeleteOutcome } = await import("./ephemeral-command.js");
    // "Its local record was kept" only over a record there was: this project's
    // landing on it, or — an ephemeral — the one it tracks.
    const recordKept =
      holdsLanding(landingLockPath(args), auth.instance, { kind, name }) ||
      (kind === "ephemeral" && getEnvironment(readEphemeralState(process.cwd()), auth)?.name === name);
    throw unknownDeleteOutcome(err, named, name, contextFlags(args), kind === "ephemeral" ? "ephemeral" : "tenant", recordKept);
  });
  // After a failed read, a "not there" from the delete is only that once no
  // workspace this credential reaches holds the name — as the read's own miss above.
  if (alreadyGone && record === null) {
    const { confirmMissEverywhere } = await import("./ephemeral-command.js");
    await confirmMissEverywhere(auth, name, "either", "tenant", `xanosdk tenant delete ${shellWord(name)}${answerFlags(args)}${contextFlags(args)}`);
  }
  // What this project landed there is gone with it: an ephemeral's record (and
  // its tracked pointer, as `ephemeral delete` clears it) from local state, a
  // tenant's from the lock.
  // `clearedLandingRecord` says so in `--json`, as `ephemeral delete` does:
  // a tenant's record lives in the committed lock, which this just changed.
  // An ephemeral's is cleared first, silently, so the line below can say so as
  // `ephemeral delete` does; a tenant's lock change is said on its own line.
  let clearedLandingRecord = false;
  if (kind === "ephemeral") {
    clearedLandingRecord = forgetLanding(landingLockPath(args), auth.instance, { kind, name }) !== undefined;
    const tracked = getEnvironment(readEphemeralState(process.cwd()), auth);
    if (tracked?.name === name) clearedLandingRecord = clearEnvironment(process.cwd(), auth) || clearedLandingRecord;
  }
  const clearedNote = kind === "ephemeral" && clearedLandingRecord ? " (cleared its local record)" : "";
  // The read found it and the delete did not is the one case that IS "already
  // gone" — a race. After a failed read, the route's answer is all there is.
  if (alreadyGone) {
    warn(
      record === null
        ? `No tenant or ephemeral named "${name}" — nothing was deleted.`
        : `${kind === "ephemeral" ? "Ephemeral" : "Tenant"} "${name}" was already gone${clearedNote}.`,
      "tenant.not-found",
    );
  } else success(`Deleted ${named}${clearedNote}`);
  if (kind !== "ephemeral") {
    clearedLandingRecord = forgetLanding(landingLockPath(args), auth.instance, { kind, name }) !== undefined;
  }
  if (isMachineOutput(args)) {
    // `declined` on every delete document, so a wrapper reads one shape.
    writeJson({ verb: "delete", destination, name, deleted: !alreadyGone, alreadyGone, declined: false, clearedLandingRecord });
  }
}
