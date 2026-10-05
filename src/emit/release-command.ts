/**
 * The client-side merge behind `xanosdk deploy --to` — a compiled workspace into a REAL destination
 * workspace (the production target), as opposed to `xanosdk deploy`, which ships
 * to a disposable ephemeral.
 *
 * Where a bare `deploy` full-replaces (correct for a throwaway env), `--to`
 * MERGES: objects that already exist are updated in place, new ones are added,
 * and nothing else is touched. Table rows are never written unless you ask.
 * Every destructive behavior — deleting objects the project no longer defines,
 * emptying tables, or a full replace — is opt-in, previewed first, and
 * confirmed.
 *
 * The destination is resolved by the caller and passed in; there is no
 * `--workspace` override, so this can only ever reach a workspace the caller's
 * token is bound to, or a tenant under it.
 *
 * `deploy --to` is this module's ONLY entry point, which is why every refusal
 * here targets `deploy`'s help. The `release` NOUN is a different thing
 * entirely (`release-ns-command.ts`) — the stored record of a backend that ran.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import type { ErrorCode } from "../codes.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { shellWord } from "./command-line.js";
import { pastePath } from "./typed-cwd.js";
import { contextFlags } from "./context-flags.js";
import { shellQuote } from "../util/shell-quote.js";
import { shownLabel } from "./branch-commands.js";
import { assertBundleFile, assertBundleInput, loadBundleText } from "./bundle-input.js";
import { getAccessToken } from "../auth/token.js";
import type { BearerTarget, ResolvedAuth } from "../auth/token.js";
import type { ExportedBundle } from "../deploy/workspace-export.js";
import type { StaticPublishSummary } from "./deploy-command.js";
import { encodeWorkspaceArchive } from "../validate/archive.js";
import { calcSignatureJson, signatureHolds, type Bundle } from "../workspace/export.js";
import {
  assertBranchAbsent,
  assertUsableBranchLabel,
  derivedLabelTail,
  createBranch,
  DEFAULT_BRANCH_LABEL,
  listBranchListing,
  liveBranchLabel,
  setLiveBranch,
  type BranchListing,
  type BranchRecord,
} from "../deploy/branch.js";
import {
  compareToLive,
  sharedSchemaChanges,
  storedColumnsAfter,
  type StoredColumnTypes,
  type IndexChange,
  type NarrowedEnum,
  type RetargetedRef,
  type RetypedColumn,
  type SharedSchemaChange,
  type TightenedColumn,
} from "../deploy/live-diff.js";
import {
  xanosdkImport,
  XanoSdkImportRefusal,
  XANOSDK_IMPORT_CONFLICT_CODE,
  XANOSDK_IMPORT_UNIQUENESS_CODE,
  type ImportOperation,
  type ImportPlan,
  type XanoSdkCanonicalReport,
  type XanoSdkImportConflict,
  type XanoSdkImportResponse,
} from "../deploy/xanosdk-import.js";
import { describeWrite } from "../util/sent-writes.js";
import { isSignatureRefusal, type ImportMode, type MergeOptions } from "../deploy/import.js";
import { CliError, statesOutcomeUnknown, UsageError } from "./errors.js";
import { EXIT_OUTCOME_UNKNOWN } from "./operation-registry.js";
import {
  step,
  success,
  warn,
  detail,
  info,
  link,
  blank,
  describeWriteTarget,
  writeTargetPayload,
  backendDestinationPayload,
  type WriteTarget,
} from "./ui.js";
import { safeNames } from "./workspace-env.js";
import { confirm, needsConfirmation } from "./prompt.js";
import { isMachineOutput, writeJson } from "./output.js";
import { resolveLockPath } from "./cli.js";
import { readLockFile } from "../lock/io.js";
import { isUnansweredLookup, LookupFailedError, unansweredCause } from "./source-resolve.js";
import { archiveSeedContent } from "./deploy-source.js";
import { listTables, tableRowCounter, tableRowIds } from "../deploy/table.js";
import { seedRowsByTableGuid, type SeedContentFile } from "../workspace/seed.js";
import type { SourceKind } from "./source-selector.js";
import { isTimeoutError, TransportError } from "../util/http.js";
import { adoptFromBundle, codePinnedTables, identityNamesByGuid, lockKey, lockNameForObject, sdkKindName } from "../lock/lock.js";
import type { LandedEntry, LockFile } from "../lock/lock.js";
import type { PendingRename } from "./keep-data-merge.js";
import {
  groupNames,
  isEphemeralDestinationKey,
  landedIdentities,
  landedKeyForRow,
  storedColumnsOf,
  withStoredColumns,
  type LandingDestination,
} from "../lock/landed.js";
import { ephemeralLandedOn } from "../deploy/ephemeral-state.js";
import { displayPath } from "../util/rel-path.js";
import { backendDirIn } from "./backend-dir.js";
import { withArticle } from "../util/article.js";
import { destinationKey } from "../lock/landed.js";
import { landedRecordFor, landingLockPath, recordForeignLanding, recordLanding, type LandingReport } from "./landing-record.js";
import { recordSync, type SyncReport } from "./sync-record.js";
import { objectDigests, syncDigests } from "../deploy/sync-baseline.js";
import { REFERENCEABLE_KIND_PAYLOAD_KEYS, rawDeriveGuid } from "../refs/guid.js";
import { envValuesOf, payloadOf, planTypeSection, rowLabeler, sectionKind, uniqueIndexLabels } from "../deploy/live-diff.js";
import { assertStorageModesKept, discloseCanonicalMoves, storageChangesPayload, movesClause, type CanonicalMove, type PairedColumns } from "./plan-disclosure.js";
import { pipedYes, retryCommand, withheldNote } from "./retry-command.js";
import {
  assertStaticHostExists,
  EXIT_STATIC_FAILED,
  noteStaticTakenDown,
  readStaticTeardown,
  refuseStaticHostAReplaceClears,
  staticRemovedField,
  staticRetryCommand,
  staticRetryHint,
  unknownStaticOutcome,
  warnStaticTeardown,
  type StaticTeardown,
} from "./static-teardown.js";
import {
  countActions,
  countTypes,
  deletedRows,
  presentOperations,
  presentRows,
  sdkKindForPlanType,
  tableRenames,
  type PlanContext,
  type PresentedOperation,
  type TargetNoun,
} from "./plan-presentation.js";

/** Actions in a plan that destroy something the user did not just author. */
const DESTRUCTIVE_ACTIONS = new Set(["delete", "truncate", "drop"]);

/**
 * Types whose operations say nothing about whether object IDENTITIES matched.
 *
 * `workspace` is the workspace's own settings row: every import updates it, so
 * counting it would mask a plan in which not one real object corresponded.
 */
const IDENTITY_EXEMPT_TYPES = new Set(["workspace"]);

/** What a release will ask the server to do, resolved from the flags. */
interface ReleasePlanRequest extends MergeOptions {
  mode: ImportMode;
  /** The branch to land on, or `undefined` for "whichever one is live". */
  branch?: string;
  /**
   * Keep the archive's object guids instead of letting the route mint new ones.
   * Set on the replace path and nowhere else — see {@link resolveRequest}.
   *
   * It rides on the request rather than being applied at the two call sites
   * because the preview and the apply must send the SAME value: the route runs
   * its guid validity check under `dry_run` too, and a preview taken under
   * different rules than the write it previews is not a preview.
   */
  preserveGuids?: boolean;
}

/**
 * Flags a branch release cannot honor, and why each one is refused rather than
 * quietly dropped.
 *
 * `--backup-branch` is the interesting entry: it is not unsupported, it is
 * POINTLESS. A branch release does not write to the live branch's logic, so
 * snapshotting it protects nothing — accepting both would sell a safety measure
 * that does nothing, which is worse than refusing.
 */
const BRANCH_INCOMPATIBLE: ReadonlyArray<{ flag: string; why: string }> = [
  {
    flag: "--replace",
    why: "a replace wipes the whole workspace, which is not something a branch can scope",
  },
  {
    flag: "--backup-branch",
    why: "a deploy to a branch does not overwrite the live branch, so there is nothing for a backup to protect",
  },
];

/**
 * Map flags → wire options, rejecting the combinations the server would reject
 * anyway. Doing it here buys a message that names the flag the user typed
 * rather than the query parameter it became.
 */
function resolveRequest(args: ParsedArgs): ReleasePlanRequest {
  // The trimmed, validated label — the one sent and reported. `--branch " x "`
  // stages on `x`, never on a padded branch nothing can name afterwards.
  let branch: string | undefined;
  if (args.branch !== undefined) {
    // Cheapest refusals first, and all of them before anything reaches the wire.
    branch = assertUsableBranchLabel(args.branch, "--branch");

    const conflicting = BRANCH_INCOMPATIBLE.filter(({ flag }) =>
      flag === "--replace" ? args.replace : args.backupBranch !== undefined,
    );
    if (conflicting.length > 0) {
      const { flag, why } = conflicting[0]!;
      throw new UsageError(
        `\`--branch\` cannot be combined with \`${flag}\`: ${why}.\n` +
          `Drop \`${flag}\` to stage this deploy on "${branch}", or drop \`--branch\` to ` +
          `deploy to the live branch.`,
        { helpFor: { command: "deploy" } },
      );
    }
  } else if (args.setLive) {
    // A silent no-op here would be the worst outcome: the user asked for a
    // promote and nothing promoted anything.
    throw new UsageError(
      "`--set-live` promotes the branch a deploy just landed on, and this deploy names no branch.\n" +
        "Add `--branch <label>` to stage the deploy and promote it, or use " +
        `\`xanosdk workspace branch set-live <label>${contextFlags()}\` to promote a branch that already exists.`,
      { helpFor: { command: "deploy" } },
    );
  }
  // A typed snapshot label, refused before anything reaches the wire — on a
  // dry run too. Whether it is free is answered once the branches are read.
  if (typeof args.backupBranch === "string") {
    assertUsableBranchLabel(args.backupBranch, "--backup-branch", "drop the flag to deploy without a snapshot");
  }

  if (args.replace) {
    // Measured against a live engine: a full replace DELETES the workspace's
    // non-live branches. So the snapshot would be taken, wiped by the very
    // import it exists to protect against, and the run would still print a
    // rollback command naming a branch that no longer exists — a false promise
    // at exactly the moment someone needs a true one.
    if (args.backupBranch !== undefined) {
      throw new UsageError(
        "`--replace` cannot be combined with `--backup-branch`: a replace deletes the workspace's " +
          "non-live branches, so it would destroy the snapshot along with everything else and leave " +
          "you with a rollback target that does not exist.\n" +
          "Drop `--replace` to merge (which a backup CAN protect), or take a workspace export first " +
          `with \`xanosdk workspace export${contextFlags()}\`.`,
        { helpFor: { command: "deploy" } },
      );
    }

    // Two different reasons, and collapsing them into one sentence told a lie.
    // `--prune` and `--reset-data` really are meaningless here: a replace has
    // already deleted every object and emptied every table, so there is nothing
    // for either to describe. `--seed` is NOT meaningless — a replace carries
    // the project's seed rows in the archive and the workspace comes back with
    // them — it is merely REDUNDANT. Saying "nothing left to describe" about it
    // would tell a user their seed data was deliberately dropped, and they would
    // go build a second pass to put back rows that were never missing.
    const clearedByReplace = [args.prune ? "--prune" : "", args.resetData ? "--reset-data" : ""].filter(Boolean);

    if (clearedByReplace.length > 0) {
      throw new UsageError(
        `\`--replace\` cannot be combined with ${clearedByReplace.join(" or ")}. ` +
          `A replace already clears every object and every table row, so there is nothing ` +
          `left for those flags to describe. Drop \`--replace\` to merge, or drop ${clearedByReplace.join("/")}.`,
        { helpFor: { command: "deploy" } },
      );
    }

    if (args.seed) {
      throw new UsageError(
        "`--replace` cannot be combined with `--seed`, because a replace already writes this " +
          "project's seed rows — the archive carries them and the replaced workspace comes back " +
          "with them. The flag is redundant here, not refused because seeding is impossible.\n" +
          "Drop `--seed` to keep the replace (your seed rows still land), or drop `--replace` to " +
          "merge and seed an existing workspace.",
        { helpFor: { command: "deploy" } },
      );
    }
    // The archive's guids are the contract, so the workspace must come back
    // holding them. The SDK derives them deterministically (`md5(payloadKey:name)`,
    // frozen in `xano.lock`), which is what makes this safe AND necessary: safe
    // because the next release sends the same values, necessary because without
    // it a replace hands back a workspace whose identities match nothing the
    // project holds, and the release after it duplicates every object.
    //
    // Only here. A merge already preserves the archive's guids by matching rows
    // on them, and the route treats the flag as inert under merge — sending it
    // there would suggest a choice that does not exist.
    return { mode: "replace", preserveGuids: true };
  }

  return {
    mode: "merge",
    prune: args.prune,
    records: args.seed,
    truncate: args.resetData,
    ...(branch !== undefined ? { branch } : {}),
  };
}

/**
 * The label for a `--backup-branch` that was given none.
 *
 * Derived rather than fixed, because a taken label is refused: a constant would
 * fail on the second release of the day, on the flag whose entire purpose is to
 * add safety. Sorts chronologically so a workspace's backups read in order.
 */
function derivedBackupLabel(now: Date): string {
  return `backup-${derivedLabelTail(now)}`;
}

/** The label a `--backup-branch` snapshot takes: the typed one, usable and free, else a derived one. */
function plannedBackupLabel(flag: string | boolean, branches: readonly BranchRecord[]): string {
  const label = assertUsableBranchLabel(
    typeof flag === "string" ? flag : derivedBackupLabel(new Date()),
    "--backup-branch",
    "drop the flag to deploy without a snapshot",
  );
  assertBranchAbsent(branches, label, "backup");
  return label;
}

/**
 * True when the request can destroy something — the trigger for a mandatory
 * preview and confirmation.
 *
 * `records` counts. Writing the bundle's rows is an UPSERT, so a row whose id
 * collides with a live one is overwritten: "additive" is only true when the ids
 * happen not to overlap, and that is not something the caller can know without
 * looking. Treating a seed as safe would let `--seed` quietly rewrite production
 * rows with no preview and no prompt.
 */
function isDestructive(req: ReleasePlanRequest): boolean {
  return req.mode === "replace" || req.prune === true || req.truncate === true || req.records === true;
}

/** Count a plan's operations by action (as presented), so the summary line needs no server support. */
function countByAction(operations: readonly { action: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const op of operations) {
    counts.set(op.action, (counts.get(op.action) ?? 0) + 1);
  }
  return counts;
}

/**
 * How much of the target the bundle actually recognized, by action.
 *
 * A merge is only meaningful when object identities line up. When none do, the
 * plan still looks routine — a pile of creates, and under `--prune` a pile of
 * deletes — while describing something categorically different from a promote.
 */
function correspondence(plan: ImportPlan): { matched: number; created: number; orphaned: number } {
  let matched = 0;
  let created = 0;
  let orphaned = 0;
  for (const op of plan.operations) {
    if (IDENTITY_EXEMPT_TYPES.has(op.type)) continue;
    if (op.action === "create") created++;
    else if (op.action === "delete") orphaned++;
    // Anything else names an object the bundle RECOGNIZED. The action vocabulary
    // is the server's and open-ended, so matching on `update` alone would let a
    // backend that says `unchanged` or `noop` trip the loudest warning here on a
    // routine release. Only create and delete mean "no correspondence".
    else matched++;
  }
  return { matched, created, orphaned };
}

/**
 * Say plainly when a merge matched NOTHING.
 *
 * A target this project has never released to — one built by hand, or by
 * another project — shares no identity with the bundle. Merging into it cannot update anything. With `--prune` that
 * is not a promote at all: it empties the workspace and rebuilds it from
 * lookalikes, which is the single most destructive thing this command can be
 * talked into doing, and it reads as an ordinary plan without this.
 */
function warnOnZeroCorrespondence(
  plan: ImportPlan,
  req: ReleasePlanRequest,
  targetIsEmpty: boolean,
  noun: string = "workspace",
  /**
   * The creates whose name the target already holds under another identity,
   * by label — or undefined when the target could not be read. Only those make
   * "two of everything"; a create of a name the target lacks is a new object.
   */
  sameNamed?: readonly string[],
  /** A preview says what WOULD happen; a real run's plan, what WILL (E2E pass 24). */
  dryRun = true,
  /** The plan's operations as presented — a settings row proved equal to the target's is `unchanged`. */
  presented: readonly { type: string; action: string }[] = plan.operations,
): void {
  if (req.mode !== "merge") return;
  const { matched, created, orphaned } = correspondence(plan);
  if (matched > 0 || created === 0) return;
  // An EMPTY target is the one case where nothing matching is not a warning: a
  // first release into a fresh workspace has nothing to match, so the alarm
  // fired on every correct new project — every scaffold walkthrough, every new
  // environment. The lesson taught was "this warning appears when
  // things are fine", retained for the one occasion when they are not.
  if (targetIsEmpty) return;

  const objects = (n: number): string => `${n} object${n === 1 ? "" : "s"}`;
  const would = dryRun ? "would" : "will";
  blank();
  if (orphaned > 0) {
    warn(
      `NOTHING MATCHED. ${created === 1 ? "The 1 object" : `All ${objects(created)}`} ${would} be created and ` +
        `${objects(orphaned)} already in this ${noun} deleted — not one of them shares an identity with this project.`,
      "plan.nothing-matched",
      [
        `This is not an update. It empties the ${noun} and rebuilds it from scratch.`,
        // "Never released to" was false beside a stale record: the question is what it holds NOW.
        `That is what landing on ${withArticle(noun)} with no current landing of this project looks like.`,
        "To adopt what is already there, pin those objects' guids on your defs first. A prune here is not recoverable.",
      ],
    );
  } else {
    // The plan's own `update` count includes the settings row every import
    // touches, so "none updated" beside `update: 1` read as a contradiction.
    // Nor when the settings row is shown `unchanged` (E2E pass 28: "none updated
    // but the tenant's own settings" beside a plan that updated nothing).
    const settings = presented.some(
      (op) => IDENTITY_EXEMPT_TYPES.has(op.type) && !["create", "delete", "unchanged"].includes(op.action),
    );
    const landing = `Only ${withArticle(noun)} holding a current landing of this project will match.`;
    // The line under the warning is its remedy, so `--json` carries it too
    // (E2E pass 29: printed as a detail(), the document lost it).
    let line: string;
    if (sameNamed === undefined) {
      line =
        `If this ${noun} is already populated, its objects carry different identities and you ` +
        `will end up with two of everything. ${landing}`;
    } else if (sameNamed.length === 0) {
      // E2E pass 16: "two of everything" was said of a plan whose every
      // object is a name the target does not hold — nothing is doubled.
      line =
        `None of them shares a name with anything already in this ${noun}: they are all new objects, ` +
        `added beside what is there.`;
    } else {
      const shown = sameNamed.slice(0, 5).join(", ") + (sameNamed.length > 5 ? `, … ${sameNamed.length - 5} more` : "");
      line =
        `${sameNamed.length === 1 ? "1 of them shares its name" : `${sameNamed.length} of them share a name`} with ` +
        `an object already in this ${noun} under a different identity (${shown}) — you will end up with two of ` +
        `${sameNamed.length === 1 ? "it" : "each"}. ${landing}`;
    }
    warn(
      `Nothing matched: ${created === 1 ? "the 1 object" : `all ${objects(created)}`} ${would} be created, ` +
        `${settings ? `none updated but the ${noun}'s own settings` : "none updated"}.`,
      "plan.nothing-matched",
      [line],
    );
  }
}

/**
 * The creates in `plan` whose name the target already holds — by label, from
 * `presented` — or undefined when the target was not read. A create matched
 * nothing by identity, so a same-named row there is a second object of that
 * name, not the one this project means.
 *
 * Where a name is not the whole identity the composed one must match: a
 * query's verb and api group, a channel's server, a message's channel. `ping`
 * in group notes and a new `ping` in another group are two objects, not one
 * doubled (E2E pass 23) — the labels `rowLabeler` composes, as the plan prints.
 */
function sameNamedCreates(
  plan: ImportPlan,
  presented: readonly PresentedOperation[],
  live: ExportedBundle | undefined,
): string[] | undefined {
  if (live === undefined) return undefined;
  const payload = payloadOf(live);
  const label = rowLabeler(payload);
  const out: string[] = [];
  plan.operations.forEach((op, i) => {
    if (op.action !== "create" || IDENTITY_EXEMPT_TYPES.has(op.type)) return;
    const section = planTypeSection(op.type);
    const rows = payload[section];
    const shown = presented[i]?.label;
    const composed = COMPOSED_IDENTITY_SECTIONS.has(section) && shown !== undefined;
    const held =
      Array.isArray(rows) &&
      rows.some(
        (r) =>
          r !== null &&
          typeof r === "object" &&
          (r as { name?: unknown }).name === op.name &&
          (!composed || label(section, r as Record<string, unknown>) === shown),
      );
    if (held) out.push(shown ?? `${op.type}:${op.name}`);
  });
  return out;
}

/**
 * How many env names the outgoing bundle carries, and which of them the target
 * does not hold yet — the only ones an add-only merge creates. Undefined when
 * the target was not read.
 */
function envCarriedBy(bundle: unknown, live: ExportedBundle | undefined): { names: number; created: string[] } | undefined {
  if (live === undefined) return undefined;
  const ours = envValuesOf(bundle);
  const theirs = envValuesOf(live);
  return { names: ours.size, created: [...ours.keys()].filter((name) => !theirs.has(name)) };
}

/** Sections whose identity is more than a name — compared by composed label. */
const COMPOSED_IDENTITY_SECTIONS: ReadonlySet<string> = new Set(["query", "channel", "message"]);

/**
 * Resolve a plan operation's `type` to the payload key the lock is keyed by.
 *
 * The server's type vocabulary is not the lock's. A plan reports `table` and
 * `api_group` where the lock records `dbo:` and `app:`, and it can equally
 * report the payload key itself — so both spellings have to land on the same
 * key. `agent` and `mcp_server` both collapse to `toolset`, which is exactly
 * what the lock does, so a prune cannot be talked into sparing one by naming it
 * the other way.
 *
 * An unrecognised type resolves to itself: an unknown kind must be treated as
 * untracked (and therefore protected), never silently waved through.
 */
function payloadKeyFor(type: string): string {
  return (Object.hasOwn(REFERENCEABLE_KIND_PAYLOAD_KEYS, type) ? REFERENCEABLE_KIND_PAYLOAD_KEYS[type] : undefined) ?? type;
}

/** Objects `--prune` would delete, split by whether this project landed them here. */
interface CollateralDeletes {
  /** Planned deletions this project never landed on this destination. */
  readonly collateral: readonly ImportOperation[];
  /** Planned deletions this project did land here — the ones prune is actually for. */
  readonly owned: readonly ImportOperation[];
  /** `owned`'s identities, as the landing record keys them — what the prune removes from it. */
  readonly ownedIdentities: Record<string, LandedEntry>;
}

/**
 * Split a prune's planned deletions into what this project LANDED on this
 * destination and everything else.
 *
 * On the wire `--prune` is not scoped at all: it maps to the endpoint's
 * `delete` parameter, and the server deletes everything absent from the
 * archive — objects predating the project, built by hand, landed by another
 * project, populated with production data. The server owns the delete set and
 * cannot be told to narrow it, so the scope is enforced here, on the plan,
 * before the import is sent.
 *
 * Ownership is the landing record (`lock/landed.ts`), not the lock's entries.
 * A lock entry only says this project once EXPORTED an object of that name, and
 * guids are name-derived — so every project that ever defined a `double`
 * function owned every workspace's `function:double`, and a project that only
 * ever ran `xanosdk export` pruned another project's agent. An object is owned
 * iff the record for THIS destination names its key AND its guid AND — where
 * one key holds two kinds (`agent`/`mcpServer`) — its kind.
 *
 * Judged on the object the route will actually delete — the target row
 * `deletedRows` places — never on the plan's bare name: judged by name, a
 * project that landed `GET ping` "owned" a `POST ping` someone else merged. A
 * delete with no target row to check is not owned: fail closed.
 */
function splitPruneDeletes(
  plan: ImportPlan,
  record: Readonly<Record<string, LandedEntry>> | undefined,
  ctx: Pick<PlanContext, "bundle" | "live">,
): CollateralDeletes {
  const rows = deletedRows(plan.operations, ctx);
  const ownedIdentities: Record<string, LandedEntry> = {};
  const ownedAs = landedOwnerKey(record, ctx.live);
  const collateral: ImportOperation[] = [];
  const owned: ImportOperation[] = [];
  plan.operations.forEach((op, index) => {
    if (op.action !== "delete") return;
    // The workspace settings row is not an object anyone authored and is never
    // pruned as one; it has no lock entry by construction.
    if (IDENTITY_EXEMPT_TYPES.has(op.type)) return;
    const key = ownedAs(op, rows[index]);
    if (key === undefined) {
      collateral.push(op);
      return;
    }
    owned.push(op);
    ownedIdentities[key] = record![key]!;
  });
  return { collateral, owned, ownedIdentities };
}

/**
 * The key a planned delete is recorded under, or `undefined` when the record
 * does not name that object (see {@link splitPruneDeletes}). The record is the
 * destination's landing record for ownership; the lock's `objects`, read the
 * same way, answer only whether this project once declared it.
 */
function landedOwnerKey(
  record: Readonly<Record<string, { guid?: string; type?: "agent" }>> | undefined,
  live: unknown,
): (op: ImportOperation, row: Record<string, unknown> | undefined) => string | undefined {
  const liveGroups = groupNamesByRef(live);
  return (op, row) => {
    if (record === undefined) return undefined;
    const payloadKey = payloadKeyFor(op.type);
    // A query's key carries its api group and verb, so it needs the row;
    // without one there is no key, and a name alone owns nothing.
    const key =
      row !== undefined
        ? landedKeyForRow(payloadKey, { ...row, name: op.name }, liveGroups)
        : payloadKey === "query"
          ? undefined
          : lockKey(payloadKey, op.name);
    const entry = key === undefined ? undefined : record[key];
    if (key === undefined || entry === undefined) return undefined;
    // Guid next: it is what the engine matches on. A row whose guid the record
    // does not hold under that key is a DIFFERENT object, whatever it is called.
    const guid = typeof row?.guid === "string" && row.guid !== "" ? row.guid : undefined;
    if (guid !== undefined && entry.guid !== guid) return undefined;
    // `agent` and `mcpServer` share the `toolset` key AND the guid (both derive
    // from `toolset:<name>`): the record says which one this project landed.
    if (payloadKey === "toolset") {
      const isAgent = row !== undefined ? row.type === "agent" : op.type === "agent";
      if ((entry.type === "agent") !== isAgent) return undefined;
    }
    return key;
  };
}

/**
 * What the project's records say about each object a prune would delete, for
 * the plan's prose (see {@link DeleteProvenance}). The ownership CHECK is
 * {@link assertPruneStaysInScope}; this only picks the sentence, and reads
 * nothing it cannot — a lock that is missing or unreadable says nothing.
 */
function pruneProvenance(
  args: ParsedArgs,
  landingKey: string | undefined,
  live: unknown,
): PlanContext["provenance"] {
  let record: Readonly<Record<string, LandedEntry>> | undefined;
  let objects: LockFile["objects"] | undefined;
  try {
    const lockPath = resolveLockPath(args, args.file ?? ".");
    const lockExists = existsSync(lockPath);
    if (landingKey !== undefined && (lockExists || isEphemeralDestinationKey(landingKey))) {
      record = landedRecordFor(lockPath, landingKey).record;
    }
    if (lockExists) objects = readLockFile(lockPath).objects;
  } catch {
    // The refusal that reads the same files says what is wrong with them.
  }
  const landed = landedOwnerKey(record, live);
  const declared = landedOwnerKey(objects, live);
  return (op, row) => {
    if (record === undefined && objects === undefined) return undefined;
    const landedKey = landed(op, row);
    // Landed, but only ever adopted: a release that matched the lock recorded
    // it, and the project's source never had it to "no longer declare".
    if (landedKey !== undefined) return objects?.[landedKey]?.adopted === true ? "adopted" : "landed";
    return declared(op, row) !== undefined ? "locked" : "never";
  };
}

/** A payload's composed-key parents (api groups, realtime servers, channels) by reference → name. */
function groupNamesByRef(bundle: unknown): Map<unknown, string> {
  const payload = (bundle as { payload?: unknown } | null | undefined)?.payload;
  return payload !== null && typeof payload === "object" ? groupNames(payload as Record<string, unknown>) : new Map();
}

/**
 * Refuse a WRITE the loss report could not be computed for.
 *
 * The route's plan is complete about objects and silent about two things only a
 * read of the target can answer: a column this release drops, which the plan
 * calls a routine in-place table update and which destroys the data in it, and
 * the workspace's own rename. Neither is recoverable, and neither is visible in
 * the screen someone confirms against when the read failed.
 *
 * A failed read is UNKNOWN, not clear. Reported as a warning it looked exactly
 * like a clean bill of health — the release proceeded, the plan said `update: 1`,
 * and a column went with it.
 *
 * The escape hatch is deliberately not a flag: there is no version of "release
 * anyway without checking" that is safer than reading the workspace, and the
 * condition is a transport failure that fixes itself.
 *
 * **A dry run is not refused.** It writes nothing, and the loss report says in
 * so many words that it did not run — so the reader gets the plan plus an honest
 * account of what is missing from it, rather than nothing at all.
 */
function assertLiveWorkspaceWasRead(
  live: ExportedBundle | undefined,
  /** The destination as the reader knows it: `workspace #12`, or `tenant "acme"`. */
  destNoun: string,
  branch: string | undefined,
  /** Why the read failed, from {@link readLive}. */
  failure?: unknown,
  /** The destination's kind, for the exit-8 refusal. */
  kind: SourceKind = "workspace",
): void {
  if (live !== undefined) return;
  const scope = branch === undefined ? "" : ` on branch "${branch}"`;
  const reason = liveReadReason(failure);
  const because = reason === undefined ? "" : ` (${reason})`;
  // No answer at all — a network failure or a server error, still failing
  // after the read's retries — is the unreachable contract: exit 8, nothing
  // written, and the dispatcher names this command line as the rerun.
  if (failure !== undefined && isUnansweredLookup(failure)) {
    const cause = unansweredCause(failure);
    throw new LookupFailedError(
      `Refusing to deploy into ${destNoun}${scope}: it could not be read${because}, so whether this deploy drops ` +
        `a column or renames the workspace is unknown. ${cause} — nothing was written`,
      "unreachable",
      kind,
    );
  }
  throw new UsageError(
    `Refusing to deploy into ${destNoun}${scope}: it could not be read${because}, so whether ` +
      `this deploy drops a column or renames the workspace is unknown.\n` +
      `The import reports a dropped column as a routine table update, and the data in it is not ` +
      `recoverable — so the one check that would have caught it has to have run.\n` +
      `Retry when the instance is reachable. \`--dry-run\` still prints the plan and says which ` +
      `checks could not be made.`,
    { hintFor: { command: "deploy" } },
  );
}

/**
 * Report what the plan cannot: dropped columns, and env that will not update.
 *
 * Reads the live workspace once and answers both questions from it (see
 * `deploy/live-diff.ts`). An unavailable live export says the check did not run
 * rather than staying silent, which is what a reader of a `--dry-run` gets;
 * a release that would WRITE is refused instead, by
 * {@link assertLiveWorkspaceWasRead}.
 */
async function readLiveWorkspace(
  auth: ResolvedAuth,
  dest: MergeDest,
  branch?: string,
): Promise<ExportedBundle | undefined> {
  return (await readLive(auth, dest, branch)).live;
}

/** A read of the target, and — when it failed — why. */
interface LiveRead {
  live: ExportedBundle | undefined;
  /** The last attempt's failure; absent when the read succeeded. */
  failure?: unknown;
}

/**
 * Pauses between attempts at the target read. A dropped connection or a server
 * error (5xx) is retried within this bound, as the readiness poll retries one:
 * 2 of ~12 live dry runs onto an ephemeral lost this read to a network blip and
 * reported the loss check as not run (E2E pass 30). A timeout is not retried —
 * the read's own deadline is already generous, and a second one doubles it.
 */
const LIVE_READ_RETRY_PAUSES_MS = [250, 750] as const;

/** A failure worth reading the target again for: no answer, not a refusal. */
function isTransientReadFailure(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (isTimeoutError(err) || isTimeoutError(cause) || (err instanceof TransportError && err.timeout)) return false;
  return isUnansweredLookup(err);
}

/** {@link readLiveWorkspace}, keeping the failure so the report and the refusal can say why. */
async function readLive(auth: ResolvedAuth, dest: MergeDest, branch?: string): Promise<LiveRead> {
  const { exportWorkspaceBundle } = await import("../deploy/workspace-export.js");
  let failure: unknown;
  for (let attempt = 0; attempt <= LIVE_READ_RETRY_PAUSES_MS.length; attempt++) {
    try {
      const live = await exportWorkspaceBundle(auth, {
        base: dest.base,
        workspaceId: dest.workspaceId,
        label: "reading the target workspace",
        ...(branch !== undefined ? { branch } : {}),
      });
      return { live };
    } catch (err) {
      failure = err;
      const pause = LIVE_READ_RETRY_PAUSES_MS[attempt];
      if (pause === undefined || !isTransientReadFailure(err)) break;
      await new Promise((r) => setTimeout(r, pause));
    }
  }
  return { live: undefined, failure };
}

/** A failed read's reason on one line, for the warning and the refusal. */
function liveReadReason(failure: unknown): string | undefined {
  if (failure === undefined) return undefined;
  const first = ((failure instanceof Error ? failure.message : String(failure)).split("\n")[0] ?? "").trim();
  return first === "" ? undefined : first.replace(/[.:]$/, "");
}

/**
 * The bundle, carrying the workspace name the target already has.
 *
 * For a TENANT destination only (see the caller): its workspace is named by the
 * platform, and the project's `workspace("…")` name describes a different
 * workspace. Returned unchanged when the target could not be read, carries no
 * name, or already matches — and when the bundle does not parse, which the
 * import itself will then report.
 */
export function keepWorkspaceName(bundle: string, live: ExportedBundle | undefined): string {
  const liveWs = (live as { payload?: { workspace?: { name?: unknown } } } | undefined)?.payload?.workspace;
  const liveName = typeof liveWs?.name === "string" && liveWs.name !== "" ? liveWs.name : undefined;
  if (liveName === undefined) return bundle;
  let parsed: Record<string, unknown> & { payload?: { workspace?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(bundle) as typeof parsed;
  } catch {
    return bundle;
  }
  const ws = parsed?.payload?.workspace;
  if (ws === null || typeof ws !== "object" || Array.isArray(ws) || ws.name === liveName) return bundle;
  const held = signatureHolds(bundle) !== false;
  ws.name = liveName;
  // Re-signed over exactly what is sent: the import recomputes the bundle's
  // signature and refuses one that does not match ("Invalid workspace
  // signature") — measured on a tenant merge.
  return resigned(parsed, held);
}

/**
 * The bundle re-signed after the CLI changed it — only when its signature held
 * before (`signatureHolds`). A hand-edited `--bundle` keeps its stale one, so
 * the import refuses it with `withSignatureHint`'s remedy whether or not the
 * CLI renamed or trimmed the workspace on the way: re-signing it previewed an
 * edited bundle clean only when the names differed (E2E pass 19). A bundle
 * this SDK exported round-trips its signature through JSON exactly.
 */
function resigned(parsed: Record<string, unknown>, held: boolean): string {
  const { sig, ...unsigned } = parsed;
  if (sig === undefined) return JSON.stringify(unsigned);
  return JSON.stringify({ ...unsigned, sig: held ? calcSignatureJson(unsigned) : sig });
}

/**
 * The workspace-row settings a merge writes, and every one of them is shared by
 * every branch: they live on the workspace, not on a branch.
 */
const WORKSPACE_LEVEL_SETTINGS = new Set(["name", "description", "preferences", "realtime", "history", "middleware"]);

/** The ones the SDK only emits when authored — omitted, a merge leaves the stored value alone. */
const OMITTABLE_WORKSPACE_SETTINGS = ["preferences", "realtime", "history", "middleware"] as const;

/**
 * The bundle a BRANCH landing sends: the objects, and none of the workspace's
 * own settings.
 *
 * A branch stages logic, and the workspace row — its name, description,
 * preferences, realtime, request history and workspace-tier middleware — is not
 * branch-scoped: an import onto a new branch writes it for the whole workspace,
 * live branch included. `deploy --to workspace --branch staging` renamed the
 * workspace from `workspace("…")` under a flag that reads as "leave production
 * alone". So a branch landing leaves every one of them as the workspace has it:
 * the name and description are sent as they are live (the engine expects both on
 * the row, and the tenant path already does this for the name), and the rest are
 * left out, which a merge reads as "keep the stored value".
 *
 * Returns the settings that DIFFER from live — what this landing did not apply —
 * as the dotted paths the convergence check names them by, so the caller can say
 * so. Env is not withheld: a merge only ever CREATES a name the workspace lacks,
 * and the staged logic reads it.
 *
 * An unreadable live workspace withholds the omittable settings and leaves the
 * name and description as authored (there is nothing to copy); that only reaches
 * a dry run, because a write needs the target read (`assertLiveWorkspaceWasRead`).
 */
export function withholdWorkspaceSettings(
  bundle: string,
  live: ExportedBundle | undefined,
): { bundle: string; withheld: string[] } {
  let parsed: Record<string, unknown> & { payload?: { workspace?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(bundle) as typeof parsed;
  } catch {
    return { bundle, withheld: [] };
  }
  const ws = parsed?.payload?.workspace;
  if (ws === null || ws === undefined || typeof ws !== "object" || Array.isArray(ws)) return { bundle, withheld: [] };
  const held = signatureHolds(bundle) !== false;

  let withheld: string[] = [];
  if (live !== undefined) {
    try {
      const order = [...WORKSPACE_LEVEL_SETTINGS];
      const rank = (path: string): number => order.indexOf(path.split(".")[0]!);
      withheld = compareToLive(parsed, live, undefined, { documentation: "skip", sample: "all" })
        .settingsFields.filter((path) => rank(path) !== -1)
        // The name first: it is the one a reader notices.
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    } catch {
      // A comparison that could not be made names nothing; the settings are
      // withheld below either way.
      withheld = [];
    }
  }

  const liveWs = (live as { payload?: { workspace?: Record<string, unknown> } } | undefined)?.payload?.workspace;
  let changed = false;
  for (const key of ["name", "description"] as const) {
    const value = liveWs?.[key];
    if (typeof value === "string") {
      if (ws[key] !== value) {
        ws[key] = value;
        changed = true;
      }
    } else if (key === "description" && live !== undefined && Object.hasOwn(ws, key)) {
      // A live row with no description to copy: left out, which a merge reads
      // as "keep the stored one". The name stays — the row is expected to
      // carry one.
      delete ws[key];
      changed = true;
    }
  }
  for (const key of OMITTABLE_WORKSPACE_SETTINGS) {
    if (Object.hasOwn(ws, key)) {
      delete ws[key];
      changed = true;
    }
  }
  if (!changed) return { bundle, withheld };
  // Re-signed over exactly what is sent, as `keepWorkspaceName` does.
  return { bundle: resigned(parsed, held), withheld };
}

/**
 * The branch the collision check must be computed against.
 *
 * A release targets either the live branch or a NEW one, because a `--branch`
 * whose label the workspace already has is refused before this (see
 * `assertBranchAbsent`). A new branch starts as a copy of live, so live is what
 * the archive is about to collide with — and the export route rejects a label
 * the workspace does not have yet, so asking for one would refuse every branch
 * release for a reason that has nothing to do with collisions.
 *
 * `undefined` therefore means "the live branch", which is the answer today for
 * every release. The label is returned when the workspace already has it, so a
 * caller that gains the ability to release into an existing branch is scoped
 * correctly without touching this.
 */
export function collisionBranch(
  branches: readonly { label: string }[],
  target: string | undefined,
): string | undefined {
  if (target === undefined) return undefined;
  return branches.some((b) => b.label === target) ? target : undefined;
}

/**
 * Whether the target holds no objects at all.
 *
 * The zero-correspondence alarm is meaningless against an empty workspace —
 * there is nothing there to fail to match. `undefined` when the live read
 * failed: unknown is not empty, so the alarm still fires rather than being
 * suppressed by a diagnostic that did not run.
 */
function targetIsEmpty(live: ExportedBundle | undefined): boolean {
  if (live === undefined) return false;
  const payload = live.payload;
  if (payload === null || typeof payload !== "object") return false;
  return !Object.entries(payload).some(
    // The workspace settings row is present in every workspace, empty or not.
    ([key, value]) => key !== "workspace" && Array.isArray(value) && value.length > 0,
  );
}

/**
 * Decide whether this release has anything to do, by comparing the outgoing
 * bundle against the live workspace object by object.
 *
 * The server's dry run cannot answer this. It reports an `update` for every
 * identity that MATCHES, which is a different question from whether the object
 * differs — so an unchanged project rewrote every object and reported
 * `upToDate: false` forever, touching every `updated_at` and churning anything
 * watching the workspace. Answering it here is what makes `release`
 * usable as an idempotent reconcile step: safe on a schedule, on every merge, or
 * behind a "make production match main" button.
 *
 * Scoped to what the comparison can actually see:
 *
 * - **Merge only.** A `--replace` clears the workspace and mints fresh
 *   identities; there is no reading under which it changes nothing.
 * - **No row-level flags.** `--seed` writes table rows and `--reset-data` empties
 *   them, and the live read deliberately carries no rows — so with either flag
 *   set, "the objects match" says nothing about what the import would do.
 * - **Under `--prune`, the workspace must hold nothing extra**, because prune's
 *   whole job is to delete exactly those.
 * - **The live read must have succeeded.** Without it there is no comparison,
 *   and a failed read must never read as convergence.
 */
async function convergedWithLive(
  live: ExportedBundle | undefined,
  req: ReleasePlanRequest,
  outgoingBundle: string,
  /**
   * The slugs this project pins, as `<payloadKey>:<name>`.
   *
   * The comparison needs the same answer the import gets, or it reports a
   * difference on every slug the project never named — a build maintains a
   * lock, so those arrive MINTED rather than empty, and a minted slug is not a
   * value the workspace will adopt on an update. Derived from the pins already
   * computed for the import so the two cannot drift apart.
   */
  pinned: readonly PinnedCanonical[],
): Promise<boolean> {
  if (live === undefined || req.mode !== "merge") return false;
  if (req.records === true || req.truncate === true) return false;

  const { compareToLive } = await import("../deploy/live-diff.js");
  let result;
  try {
    result = compareToLive(
      JSON.parse(outgoingBundle),
      live,
      new Set(pinned.map((p) => `${p.payloadKey}:${p.name}`)),
      // A merge does not write the `documentation` block, so it can never be a
      // reason to send; `warnAboutLiveLosses` says what stays behind instead.
      { documentation: "skip" },
    );
  } catch {
    // A comparison that could not be made is not a match. Same posture as the
    // loss report above: the release proceeds exactly as it did before.
    return false;
  }
  if (!result.converged) return false;
  if (req.prune === true && result.liveOnly.length > 0) return false;
  return true;
}

/**
 * The objects of a merge that is NOT converged as a whole which already match
 * the target one by one — by the label {@link presentOperations} gives them —
 * and whether the workspace settings row does. `undefined` whenever
 * {@link convergedWithLive} could not have answered (no live read, a replace,
 * a row-level flag, a comparison that failed): then nothing is relabelled.
 *
 * The route reports every identity that MATCHED as an `update`, so one real
 * change beside five untouched objects planned six "Will be updated in place"
 * (E2E pass 27). Conservative the same way: an object not proven equal stays
 * an update.
 */
async function unchangedWithLive(
  live: ExportedBundle | undefined,
  req: ReleasePlanRequest,
  outgoingBundle: string,
  pinned: readonly PinnedCanonical[],
): Promise<{ labels: ReadonlySet<string>; settings: boolean } | undefined> {
  if (live === undefined || req.mode !== "merge") return undefined;
  if (req.records === true || req.truncate === true) return undefined;
  const { compareToLive, declaredLabels, payloadOf, SETTINGS_LABEL } = await import("../deploy/live-diff.js");
  try {
    const outgoing = JSON.parse(outgoingBundle) as unknown;
    const result = compareToLive(outgoing, live, new Set(pinned.map((p) => `${p.payloadKey}:${p.name}`)), {
      documentation: "skip",
      sample: "all",
    });
    const changed = new Set([...result.differing, ...result.missing]);
    // A label two objects share (the comparison could not tell them apart) is never proven equal.
    const declared = declaredLabels(outgoing);
    const once = declared.filter((l, i) => declared.indexOf(l) === i && declared.lastIndexOf(l) === i);
    // Settings only when the archive carries them to compare.
    const settings = "workspace" in payloadOf(outgoing) && !changed.has(SETTINGS_LABEL);
    return { labels: new Set(once.filter((l) => !changed.has(l))), settings };
  } catch {
    return undefined;
  }
}

/**
 * The presented plan with each `update` {@link unchangedWithLive} proved equal
 * shown as `unchanged` — counted and listed that way, in the text and `--json`.
 */
function markUnchanged(
  presented: readonly PresentedOperation[],
  unchanged: { labels: ReadonlySet<string>; settings: boolean } | undefined,
  noun: TargetNoun,
): PresentedOperation[] {
  if (unchanged === undefined) return [...presented];
  return presented.map((op) => {
    if (op.action !== "update") return op;
    const same = op.type === "workspace" ? unchanged.settings : unchanged.labels.has(op.label);
    if (!same) return op;
    const { details: _d, reason: _r, ...rest } = op;
    return { ...rest, action: "unchanged", details: `Already matches the ${noun}; nothing about it changes` };
  });
}

/** What a printed replace remedy costs, said beside it. */
const REPLACE_DROPS = "which deletes every table's rows there (only seed rows come back)";

/**
 * This run's `deploy … --to …` as the replace that applies what a merge leaves
 * behind, backticked and ending its sentence: the flags a replace refuses
 * (`--prune`, `--branch x`, …) and the preview/confirm skips are dropped, and
 * no secret is reprinted (E2E pass 20: the hint named a replace flag on
 * `release`, which has none).
 */
async function replaceCommandHint(args: ParsedArgs): Promise<string> {
  const { retryCommand, withheldNote } = await import("./deploy-command.js");
  const valued = new Set(["--branch", "--backup-branch", "--expect-live"]);
  const dropped = new Set(["--prune", "--reset-data", "--seed", "--set-live", "--dry-run", "--replace", "--yes", "-y"]);
  const argv: string[] = [];
  const typed = args.argv ?? [];
  for (let i = 0; i < typed.length; i++) {
    const spelling = typed[i]!.split("=")[0]!;
    if (valued.has(spelling)) {
      if (spelling === typed[i]) i += 1;
    } else if (!dropped.has(spelling)) argv.push(typed[i]!);
  }
  // Never `--yes`, typed or added: a replace is a different, more destructive
  // run than the one this plan showed, and its own plan and confirmation are
  // where its row loss is shown — off a terminal it refuses naming it.
  const { command, withheld } = retryCommand(args.argv === undefined ? args : { ...args, argv }, { add: ["--replace"] });
  return `\`${command}\`.${withheldNote(withheld)}`;
}

/** A landing document's table-effect keys, picked from {@link warnAboutLiveLosses}'s answer. */
function landingTableFields(losses: Awaited<ReturnType<typeof warnAboutLiveLosses>>) {
  const { droppedColumns, retypedColumns, narrowedEnums, retargetedRefs, indexChanges, notNullKept, notNullTightened, renamedTables, pairedColumns } =
    losses;
  return {
    renamedTables,
    droppedColumns,
    // The dropped-and-added pairs the column-drop warning names, as `--keep-data` carries them.
    ...(pairedColumns.length > 0 ? { pairedColumns } : {}),
    notNullKept,
    retypedColumns,
    narrowedEnums,
    retargetedRefs,
    indexChanges,
    notNullTightened,
    storageChanges: storageChangesPayload(losses.storageChanges),
  };
}

async function warnAboutLiveLosses(
  live: ExportedBundle | undefined,
  req: ReleasePlanRequest,
  outgoingBundle: string,
  /** Where a value is set by hand, as `env set --to` takes it: `tenant:eu`, else `workspace`. */
  setWhere = "workspace",
  /** The archive is a `--bundle` file, not this project's compile: the env DROP detail speaks of the bundle. */
  fromBundle = false,
  /** This run's command as a replace, backticked, with any withheld-secret note (see {@link replaceCommandHint}). */
  replaceHint = "`xanosdk deploy <source> --to <destination> --replace`.",
  /** What the target IS — an ephemeral reached as `tenant:<name>` is not "the workspace" (E2E pass 22). */
  noun: TargetNoun = "workspace",
  /** Why the target read failed, when it did — said in the warning. */
  failure?: unknown,
  /** Per table guid, the column storage the destination's landing record knows. */
  stored?: StoredColumnTypes,
): Promise<
  // The table effects under the keys every landing document uses (see `plan-disclosure.ts`).
  Omit<ReturnType<typeof import("./plan-disclosure.js").tableEffectFields>, "storageChanges"> & {
  renamedTables: { from: string; to: string }[];
  pairedColumns: PairedColumns[];
  unchangedEnv: string[];
  droppedEnv: string[];
  unappliedDocumentation: string[];
  workspaceRename?: { from: string; to: string };
  /** Tables the landing switches to the other storage mode (see `assertStorageModesKept`). */
  storageChanges: readonly import("../deploy/live-diff.js").StorageModeChange[];
}> {
  const { NO_TABLE_EFFECTS, tableEffectsOf, discloseTableEffects, tableEffectFields, alteringChanges, droppedAndAdded } = await import(
    "./plan-disclosure.js"
  );
  const none = {
    ...tableEffectFields(NO_TABLE_EFFECTS),
    renamedTables: [],
    pairedColumns: [],
    unchangedEnv: [],
    droppedEnv: [],
    unappliedDocumentation: [],
    storageChanges: [],
  };
  // Every block here ENDS with its blank line rather than opening with one:
  // the plan above already closes on one, and a leading blank doubled it.
  if (live === undefined) {
    const reason = liveReadReason(failure);
    warn(
      `Could not read the target ${noun}${reason === undefined ? "" : ` (${reason})`}, so this plan does not account ` +
        `for dropped columns or env that will not update.`,
      "plan.target-unreadable",
    );
    blank();
    return none;
  }

  const { diffAgainstLive, tableAdditions } = await import("../deploy/live-diff.js");
  let diff;
  let additions;
  try {
    const outgoing = JSON.parse(outgoingBundle);
    diff = diffAgainstLive(outgoing, live, { mode: req.mode, ...(stored === undefined ? {} : { stored }) });
    additions = tableAdditions(outgoing, live);
  } catch {
    return none;
  }

  // One disclosure for every landing path (see `plan-disclosure.ts`): the plan
  // reports each of these as a routine in-place table update.
  // A `--replace` recreates every table and its rows: a rebuild, not the
  // replace a tenant deploy makes (see `plan-disclosure.ts`).
  const effects = tableEffectsOf(diff, additions, { mode: req.mode === "replace" ? "rebuild" : "merge" });
  discloseTableEffects(effects, {
    subject: "the deploy",
    stages: "deploys",
    remedies: {
      "plan.column-drop": "The plan reports these as a routine in-place table update; they are not recoverable.",
      "plan.not-null-kept":
        `Later plans cannot see it. A replace recreates the table, which relaxes it — and replaces its rows: ${replaceHint}`,
      "plan.not-null-tightened": `A replace recreates the table — and replaces its rows: ${replaceHint}`,
    },
  });
  if (alteringChanges(effects).length > 0) blank();

  if (diff.unchangedEnv.length > 0) {
    warn(
      `${diff.unchangedEnv.length} environment variable${diff.unchangedEnv.length === 1 ? "" : "s"} ` +
        `will NOT be updated: ${diff.unchangedEnv.map((e) => e.name).join(", ")}`,
      "plan.env-kept",
      [
        "A merge is add-only for env: it creates keys that do not exist and leaves existing ones as they are.",
        // The command, not "set them in tenant … directly" (E2E pass 23).
        // `--yes`: a workspace or tenant write asks first, and off a terminal
        // refuses without it — the printed command has to run as printed.
        `To change these values, run \`printf %s "$VALUE" | xanosdk env set NAME --to ${shellQuote(setWhere)}` +
          `${noun === "ephemeral" ? "" : " --yes"}${contextFlags()}\` ` +
          `for each, or rebuild the ${noun} with a replace, ${REPLACE_DROPS}: ${replaceHint}`,
      ],
    );
    blank();
  }

  if (diff.droppedEnv.length > 0) {
    const one = diff.droppedEnv.length === 1;
    warn(
      `${diff.droppedEnv.length} environment variable${one ? "" : "s"} ` +
        `will be DROPPED: ${safeNames(diff.droppedEnv.map((e) => e.name))}`,
      "plan.env-drop",
      // A `--bundle` sends that file's env set, not this project's: worded by
      // what the BUNDLE carries (E2E pass 13 L3) — "not declared in this
      // project" was false for a name the project declares and the bundle lacks.
      fromBundle
        ? [
            `A replace rebuilds the ${noun} from the archive, so its env set becomes exactly what the bundle carries.`,
            `${one ? "This one is" : "These are"} set on the target and not carried by the bundle.`,
            `Send a bundle that carries ${one ? "it" : "them"} to keep ${one ? "it" : "them"}, or deploy ` +
              `without \`--replace\` (a merge leaves existing values alone).`,
          ]
        : [
            `A replace rebuilds the ${noun} from the archive, so its env set becomes exactly what ` +
              `\`workspaceConfig({ env })\` declares.`,
            `${one ? "This one is" : "These are"} set on the target and not declared in this project — ` +
              `added through the UI, or by an earlier deploy — so nothing else here mentions ` +
              `${one ? "it" : "them"}.`,
            `Declare ${one ? "the name" : "the names"} to keep ${one ? "it" : "them"}, or deploy ` +
              `without \`--replace\` (a merge leaves existing values alone).`,
          ],
    );
    blank();
  }

  // The build resolved the token and the import answers "applied", so without
  // this a merge reports success over a gate it never wrote.
  if (diff.unappliedDocumentation.length > 0) {
    const what = diff.unappliedDocumentation.includes("require_token")
      ? diff.unappliedDocumentation.includes("token") ? "documentation gate and token" : "documentation gate"
      : "documentation token";
    warn(
      `The workspace ${what} will NOT be updated.`,
      "plan.doc-not-updated",
      [
        "A merge does not write the workspace's `documentation` block; the live one stays as it is.",
        `To apply it, rebuild the ${noun} with a replace, ${REPLACE_DROPS}: ${replaceHint}`,
      ],
    );
    blank();
  }

  // The workspace's own name. The server DOES report this, as an ordinary
  // `update` on the workspace — which `renderPlan` folds into a count with
  // every other update, and which the server labels with the name the
  // workspace has NOW. So the one screen a user reads before confirming says
  // `update: 1` and nothing about the workspace being renamed out from under
  // them. It is not destructive, so it is a warning rather than a refusal.
  if (diff.workspaceRename !== undefined) {
    warn(
      `This workspace will be RENAMED: "${diff.workspaceRename.from}" → "${diff.workspaceRename.to}"`,
      "plan.workspace-rename",
      [
        "An import carries the workspace's own settings, so deploying a project renames the workspace it lands in.",
        // A `--bundle` has no project source to edit (E2E pass 20): its name is what lands.
        fromBundle
          ? `The bundle's name replaces the workspace's. To keep "${diff.workspaceRename.from}", send a bundle exported under that name.`
          : `To keep the current name, change the name in \`workspace("…")\` to "${diff.workspaceRename.from}".`,
      ],
    );
    blank();
  }

  return {
    ...tableEffectFields(effects),
    // The plan's "rename table … (rows kept)" lines, for the `--json` reader.
    renamedTables: req.mode === "merge" ? tableRenames(JSON.parse(outgoingBundle), live) : [],
    pairedColumns: droppedAndAdded(effects),
    unchangedEnv: diff.unchangedEnv.map((e) => e.name),
    droppedEnv: diff.droppedEnv.map((e) => e.name),
    unappliedDocumentation: [...diff.unappliedDocumentation],
    ...(diff.workspaceRename !== undefined ? { workspaceRename: diff.workspaceRename } : {}),
    storageChanges: effects.storageChanges ?? [],
  };
}

/**
 * Refuse a prune that would reach outside what this project LANDED here, and
 * return what it may delete (for the record to drop once it has).
 *
 * Deleting a populated table nobody asked to delete is not recoverable, so this
 * is a hard refusal rather than a warning or a confirmation prompt — an operator
 * who has typed `--prune --yes` in CI has already said yes to everything, and
 * the whole failure mode is that they did not know what they were saying yes to.
 *
 * The escape hatch is deliberately NOT another flag. What makes an object this
 * project's to delete is that this project put it there, and that is recorded by
 * the landing itself — a flag could only assert it.
 *
 * The out-of-scope refusal is a state conflict, not a usage mistake: the flags
 * are right and the destination holds objects that are not this project's. So
 * it is refused as the identity and kind conflicts are — `SDK_PRUNE_OUT_OF_SCOPE`,
 * exit 2 (running it again changes nothing), and under `--json` the one refusal
 * document, `details.refused: "pruneOutOfScope"`, with the objects under
 * `details.outOfScope`.
 * No lock at all is the same state — no landing record for this destination —
 * and is refused the same way. Only `--bundle` without `--lock` stays a usage
 * error: there the flags themselves leave nothing to read a record from.
 */
function assertPruneStaysInScope(
  args: ParsedArgs,
  plan: ImportPlan,
  /** The destination's landing-record key, and how the prose names it. */
  where: { key: string | undefined; noun: string },
  /** The bundle sent and the target read — what a delete is identified against. */
  ctx: PlanContext = { bundle: undefined, live: undefined, tenant: false },
  presented: readonly PresentedOperation[] = presentOperations(plan.operations, ctx),
  /** The refusal document's frame, and the branch the route planned against. */
  refusal?: { frame: RefusalFrame; branch: string | null | undefined },
): Record<string, LandedEntry> {
  // An ephemeral's record is not in the lock: it lives in `.xano/ephemeral.json`,
  // written by every landing there lock or not — so a prune there needs no lock,
  // and refusing for want of one named a file that could not have helped.
  const ephemeral = where.key !== undefined && isEphemeralDestinationKey(where.key);
  // A prune needs the lock: the landing record lives in it.
  //
  // `--bundle` carries no entry file to derive a lock beside, so an explicit
  // `--lock=<path>` is the way to prune a pre-exported bundle — the CI shape
  // where the compile and the release are separate steps.
  if (!ephemeral && args.lockPath === undefined && args.file === undefined) {
    throw new UsageError(
      "`--prune` needs a lock file to know which objects this project landed here, and " +
        "`--bundle` carries none. Pass `--lock=<path>` to name the project's lock, release from " +
        "the entry file instead, or drop `--prune`.",
      { helpFor: { command: "deploy" } },
    );
  }
  const lockPath = resolveLockPath(args, args.file ?? ".");
  // No lock is no landing record: the same state as a lock without one, so the
  // same out-of-scope refusal (exit 2, the refusal document) rather than a
  // usage error — the flags are right, and running it again changes nothing.
  // A build writes the lock by default, so its absence almost always means
  // `--no-lock` on this very command, which the refusal names.
  const noLock = !ephemeral && !existsSync(lockPath);

  // An ephemeral's record is in the uncommitted local state, not the lock.
  const kept =
    where.key === undefined
      ? undefined
      : noLock
        ? { record: undefined, file: displayPath(lockPath), local: false }
        : landedRecordFor(lockPath, where.key);
  const record = kept?.record;
  const { collateral, owned, ownedIdentities } = splitPruneDeletes(plan, record, ctx);
  // No lock, nothing to delete: still refused. The build just said `--prune`
  // is unavailable without the lock, and a run that then reported `prune: true`
  // and exit 0 contradicted it — and a prune that deleted nothing only because
  // the destination happens to hold nothing extra today proves nothing.
  if (collateral.length === 0 && noLock) {
    throw refusalError(
      refusal?.frame,
      "pruneOutOfScope",
      `\`--prune\` is unavailable here: there is no lock at ${displayPath(lockPath)}, so no landing record ` +
        `for ${where.noun}${where.key === undefined ? "" : ` (${where.key})`} to say what this project owns there. ` +
        `Nothing was written. Drop \`--prune\`${args.noLock ? " and keep `--no-lock`" : ""}, or deploy here once ` +
        `without \`--prune\`${args.noLock ? " or `--no-lock`" : ""} — that writes the lock and records what it lands.`,
      { branch: refusal?.branch, outOfScope: [] },
    );
  }
  if (collateral.length === 0) return ownedIdentities;

  const lines = collateral.map((op) => {
    const shown = presented[plan.operations.indexOf(op)];
    const reason = shown?.reason;
    return `  ${shown?.label ?? `${op.type}:${op.name}`}${reason !== undefined ? ` — ${reason}` : ""}`;
  });
  const n = collateral.length;
  const outOfScope = collateral.map((op): OutOfScopeDelete => {
    const shown = presented[plan.operations.indexOf(op)];
    return {
      type: shown?.type ?? op.type,
      name: op.name,
      label: shown?.label ?? `${op.type}:${op.name}`,
      ...(shown?.reason === undefined ? {} : { reason: shown.reason }),
    };
  });
  // Where the record lives decides the last sentence: a lock is committed, so
  // a record can be missing from a clone; an ephemeral's is kept per project
  // on this machine, so another checkout of it holds its own.
  const lastLine = ephemeral
    ? `To keep the objects above, drop \`--prune\`. If one of them is this project's, it was landed from ` +
      `another checkout of it (${kept?.file ?? ".xano/ephemeral.json"} is kept per project, on this machine) or before the ` +
      `record existed: delete it by hand, or define it again, deploy here, and remove it once the landing is recorded.`
    : `To keep the objects above, drop \`--prune\`. If one of them is this project's, it was landed before ` +
      `the record existed or from a lock that was not committed: delete it by hand, or define it again, ` +
      `deploy, and remove it once the landing is recorded.`;
  throw refusalError(
    refusal?.frame,
    "pruneOutOfScope",
    `\`--prune\` would delete ${n} object${n === 1 ? "" : "s"} this project never landed on ${where.noun}:\n` +
      `${lines.join("\n")}\n\n` +
      `\`--prune\` deletes only what this project put here, as ${kept?.file ?? displayPath(lockPath)} records it per ` +
      `destination — but the endpoint deletes everything absent from the bundle, including objects ` +
      `another project or a person put there. Sharing a name with an object in this project's lock does ` +
      `not make it this project's. Dropping a populated table is not recoverable.\n` +
      (record === undefined
        ? noLock
          ? `There is no lock at ${displayPath(lockPath)}, so no landing record for ${where.noun}` +
            `${where.key === undefined ? "" : ` (${where.key})`}. Deploy here once without \`--prune\`` +
            `${args.noLock ? " or `--no-lock`" : ""} — that writes the lock and records what it lands — and ` +
            `commit the lock. A lock written by \`xanosdk export\` records no landing, so a prune would still be refused.\n`
          : kept?.local === true
          ? `${kept.file} has no landing record for ${where.noun} (${where.key}): this project has not ` +
            `deployed to it (not from this checkout), or its record was cleared when a release or another ` +
            `backend's copy that is not this project's replaced what it serves. Deploy here once without ` +
            `\`--prune\` — that records what it lands.\n`
          : `The lock has no landing record for ${where.noun} (${where.key ?? "unknown destination"}): ` +
            `this project has not landed here since the lock started recording landings, this is a fresh ` +
            `clone of a lock whose record was never committed, or the record was cleared when ${clearedBy(where.key)}. ` +
            `Deploy here once without \`--prune\` — that records what it lands — and commit the lock.\n`
        : owned.length > 0
          ? `The ${owned.length} deletion${owned.length === 1 ? "" : "s"} this project did land here would have been correct.\n`
          : "") +
      lastLine,
    // No `--help` pointer: the flags are fine, and the help cannot say which
    // objects this project landed. The message above is the whole answer.
    { branch: refusal?.branch, outOfScope },
  );
}

/**
 * What clears a lock-kept landing record, for this destination's kind: a
 * workspace's only by a `--replace` of a bundle that is not this project's (a
 * promote adds), a tenant's by a `tenant deploy` of a release that is not, too.
 */
function clearedBy(key: string | undefined): string {
  if (key !== undefined && /\/workspace\/[^/]+$/.test(key)) {
    return "a `deploy --to workspace --replace` of a bundle that is not this project's replaced what it serves";
  }
  if (key !== undefined && /\/tenant\/[^/]+$/.test(key)) {
    return (
      "a release or a bundle that is not this project's replaced what it serves (`tenant deploy`, or " +
      "`deploy --to tenant:<name> --replace --bundle`)"
    );
  }
  return "a release or another backend's copy that is not this project's replaced what it serves";
}


/**
 * Render the plan to stderr.
 *
 * Destructive operations are listed individually and everything else is
 * summarized: a user approving a promote needs to read every deletion, not
 * every update.
 */
/** One table a `--seed` merge writes rows into: how many, and how many land on an id the destination holds. */
interface SeedWrite {
  table: string;
  rows: number;
  /** Seed rows whose id the destination's table already holds — `null` when its rows could not be read. */
  overwrites: number | null;
}

function seedWritePhrase(t: SeedWrite): string {
  const rows = `${t.rows} ${t.rows === 1 ? "row" : "rows"}`;
  if (t.overwrites === null) return `${rows} written; how many overwrite a live row could not be read`;
  return `${rows} written, ${t.overwrites} of them overwriting ${t.overwrites === 1 ? "a live row" : "live rows"}`;
}

/** The live rows a `--seed` merge overwrites, as the confirmation names them — empty when none. */
function seedOverwriteClause(seeded: readonly SeedWrite[]): string {
  const hit = seeded.filter((t) => t.overwrites !== null && t.overwrites > 0);
  const total = hit.reduce((n, t) => n + t.overwrites!, 0);
  const unread = seeded.filter((t) => t.overwrites === null).map((t) => t.table);
  const parts = [
    total > 0 ? ` It overwrites ${total} live ${total === 1 ? "row" : "rows"} by id (${hit.map((t) => `${t.table}: ${t.overwrites}`).join(", ")}).` : "",
    unread.length > 0 ? ` The live rows of ${unread.join(", ")} could not be read, so what it overwrites there is unknown.` : "",
  ];
  return parts.join("");
}

/**
 * What a `--seed` merge writes per table: its seed rows, and how many land on
 * an id the destination's table already holds — the write is by id, so those
 * live rows are overwritten. Read from the archive's rows and the
 * destination's row ids; a table the destination does not hold overwrites
 * nothing, and one whose rows cannot be read says so rather than guessing.
 */
async function seedWrites(
  auth: BearerTarget,
  archive: Uint8Array,
  bundle: unknown,
  dest: { base: string; workspaceId: number },
): Promise<SeedWrite[]> {
  const byGuid = seedRowsByTableGuid(archiveSeedContent(archive));
  if (byGuid.size === 0) return [];
  const tables = (bundle as { payload?: { dbo?: unknown } } | undefined)?.payload?.dbo;
  const names = new Map<string, string>();
  for (const t of Array.isArray(tables) ? (tables as { guid?: unknown; name?: unknown }[]) : []) {
    if (typeof t.guid === "string" && typeof t.name === "string") names.set(t.guid, t.name);
  }
  const listed = await listTables(auth, { workspaceId: dest.workspaceId, base: dest.base }).catch(() => undefined);
  const out: SeedWrite[] = [];
  for (const [guid, rows] of byGuid) {
    if (rows.length === 0) continue;
    const table = names.get(guid) ?? guid;
    const here = listed?.find((l) => l.guid === guid) ?? listed?.find((l) => l.name === table);
    const overwrites =
      listed === undefined
        ? null
        : here === undefined
          ? 0
          : await tableRowIds(auth, { workspaceId: dest.workspaceId, tableId: here.id, base: dest.base }).then(
              (ids) => rows.filter((r) => r.id !== undefined && r.id !== null && ids.has(String(r.id))).length,
              () => null,
            );
    out.push({ table, rows: rows.length, overwrites });
  }
  return out;
}

function renderPlan(
  plan: ImportPlan,
  req: ReleasePlanRequest,
  workspaceId: number,
  targetIsEmpty: boolean,
  converged = false,
  listing: BranchListing = { branches: [], unaddressable: [] },
  branchReadFailed = false,
  /**
   * The tenant's display label (`tenant "acme"`) when the destination is one.
   * A tenant's internal workspace is always #1 and its row carries the parent's
   * name, so naming the workspace would describe a backend the reader never chose.
   */
  tenantLabel?: string,
  /** {@link presentOperations} of `plan.operations`, index for index. */
  presented: readonly PresentedOperation[] = presentOperations(plan.operations, {
    bundle: undefined,
    live: undefined,
    tenant: tenantLabel !== undefined,
  }),
  /** How the prose names the target: an ephemeral reached as `tenant:<name>` is still one. */
  noun: TargetNoun = tenantLabel === undefined ? "workspace" : "tenant",
  /** {@link sameNamedCreates}: undefined when the target was not read. */
  sameNamed?: readonly string[],
  /** {@link envCarriedBy}: undefined when the target was not read. */
  envCarried?: { names: number; created: readonly string[] },
  /** Whether this plan previews (`--dry-run`) or precedes a real write. */
  dryRun = true,
  /** {@link tableRenames}: tables a merge renames, keeping their rows. */
  renamed: readonly { from: string; to: string }[] = [],
  /** {@link seedWrites}: the tables a `--seed` merge writes rows into, with the live ids it overwrites. */
  seeded: readonly SeedWrite[] = [],
): void {
  const counts = countByAction(presented);
  const label = plan.workspaceName !== undefined ? `${plan.workspaceName} (#${workspaceId})` : `#${workspaceId}`;

  blank();
  // The branch too: a plan for a branch landing read as one for the live branch.
  const onBranch = tenantLabel === undefined && req.branch !== undefined ? ` branch ${JSON.stringify(req.branch)}` : "";
  step(tenantLabel !== undefined ? `Plan for ${tenantLabel}` : `Plan for workspace ${label}${onBranch}`);

  // A converged comparison overrides the server's counts, which describe
  // identities that MATCHED rather than objects that differ. Printing both would
  // leave the reader to decide which one the command believes.
  if (converged) {
    detail(
      `no changes — every object this project defines already matches the ${noun}`,
    );
    return;
  }

  const order = ["create", "update", "delete", "truncate", "drop"];
  const seen = [...order.filter((a) => counts.has(a)), ...[...counts.keys()].filter((a) => !order.includes(a))];
  if (seen.length === 0) {
    detail("no changes");
  } else {
    for (const action of seen) {
      detail(`${action}: ${counts.get(action)}`);
    }
  }
  // Under a replace every table is dropped and created again, so only a merge renames.
  if (req.mode === "merge") {
    for (const { from, to } of renamed) detail(`The merge ${dryRun ? "would" : "will"} rename table ${from} → ${to} (rows kept).`);
  }

  const destructive = presented.filter((op) => DESTRUCTIVE_ACTIONS.has(op.action));
  if (destructive.length > 0) {
    blank();
    // Each as the warning's remedies, so `--json`'s message names them too
    // (E2E pass 27: it stopped at the colon). `reason` is where the server
    // reports row loss from a pruned table — the consequence most likely to
    // change whether this is approved. Named as `workspace diff` names the
    // same object, in the SDK's words.
    warn(
      `${destructive.length} destructive operation${destructive.length === 1 ? "" : "s"}:`,
      "deploy.destructive",
      destructive.map((op) => `${op.action} ${op.label}${op.reason !== undefined ? ` — ${op.reason}` : ""}`),
    );
  }

  if (plan.hasRecords) {
    blank();
    if (seeded.length === 0) {
      warn(`Table rows from the bundle ${dryRun ? "would be" : "WILL be"} written.`, "deploy.rows-written");
    } else {
      warn(
        `Table rows from the bundle ${dryRun ? "would be" : "WILL be"} written — each by its id, overwriting the row ` +
          `the ${noun} holds at that id:`,
        "deploy.rows-written",
        [
          ...seeded.map((t) => `table ${t.table}: ${seedWritePhrase(t)}`),
          "A seed row authored without an `id` is numbered by its position (1, 2, …), so it lands on that id too.",
        ],
      );
    }
  }

  // Say what happens to env, in the human-readable plan, conditioned on the
  // server's own `has_env` flag.
  //
  // The server's per-operation `details` prose claims "Workspace settings and
  // environment variables will be updated from the archive" as a FIXED string —
  // it says so when the archive carries no env at all. The accurate signal is
  // `has_env`, in the same payload, and until now it reached only the raw JSON
  // blob. For anyone reasoning about secrets this is the line in
  // the plan that matters most, so it is stated here either way rather than
  // left to be inferred from a sentence that is not conditioned on anything.
  blank();
  if (plan.hasEnv && req.mode === "merge" && envCarried !== undefined && envCarried.names > 0 && envCarried.created.length === 0) {
    // Every key already exists on the target: an add-only merge writes none of
    // them, and "WILL be written" said otherwise (E2E pass 23). A differing
    // value is named by the "will NOT be updated" warning below.
    detail(
      `Every environment variable the bundle carries already exists on the ${noun} — a merge is add-only, ` +
        `so none is written and existing keys are NOT updated.`,
    );
  } else if (plan.hasEnv) {
    // `release` is add-only, so "written" overstates it for a key
    // that already exists. Saying which is the difference between a promote that
    // rotates a secret and one that silently keeps the old value.
    warn(
      `Environment variables from the bundle ${dryRun ? "would be" : "WILL be"} written.`,
      "deploy.env-written",
      req.mode === "merge" ? ["Merge is add-only: keys that do not exist are created; existing keys are NOT updated."] : [],
    );
  } else if (req.mode === "replace") {
    // A replace clears the workspace first, env included, so "left untouched"
    // was false here — and it sat above the "WILL be DROPPED" list naming the
    // very keys it claimed were safe.
    warn(
      `The archive carries no environment variables, and \`--replace\` clears the ` +
        `${noun}'s env — it comes back with none.`,
      "release.no-env",
    );
  } else {
    detail("The archive carries no environment variables — existing env is left untouched.");
  }

  // The server flags where its own preview is incomplete. A replace preview is
  // built from a branch-scoped read while the clear deletes workspace-wide, so
  // presenting that operation list as exhaustive would understate the damage.
  // Already made presentable when the plan was read (see `presentableNotes`),
  // for the kind of target it is — a tenant's carry no branch.
  const notes = (Array.isArray(plan.summary.notes) ? plan.summary.notes : []).filter(
    (note): note is string => typeof note === "string",
  );
  if (notes.length > 0) {
    blank();
    for (const note of notes) warn(note, "plan.server-note");
  }

  if (req.mode === "replace") {
    blank();
    // A tenant has no branches of its own, so naming them there describes a
    // loss that cannot happen.
    warn(
      tenantLabel !== undefined
        ? `\`--replace\` wipes ${tenantLabel} before importing — including table data and history.`
        : "`--replace` wipes this workspace before importing — including table data, history, and " +
            "every one of its branches.",
      "deploy.replace-wipe",
    );

    // The server's plan is built from a branch-scoped read while the clear runs
    // workspace-wide, so it can say THAT branches go without ever naming one.
    // This is the only place the two facts meet: the SDK holds the inventory.
    //
    // Every branch but the default one is counted as loss, the live one
    // included: the clear keeps only `v1`, and the archive lands there.
    // A waived-but-unreadable inventory is NOT the same as an empty one, and
    // printing nothing for both made them identical on screen — the one case
    // where the operator most needs the word "unknown" was the one that said
    // least.
    if (branchReadFailed) {
      blank();
      warn(
        "The branch inventory could not be read, so what this wipe destroys is UNKNOWN.",
        "branch.inventory-unknown",
        ["`--allow-branch-deletion` accepted the deletion; it did not establish what is lost."],
      );
    }

    const doomed = branchReadFailed
      ? { named: [], unnamed: 0, total: 0, backups: 0, authored: 0 }
      : doomedBranches(listing);
    if (doomed.total > 0) {
      blank();
      warn(`${doomedHeadline(doomed)} will be permanently deleted and CANNOT be recovered:`, "branch.deletion", branchDisclosureLines(doomed));
    }
  }

  // Last, so it is the line still on screen when the confirmation is answered.
  warnOnZeroCorrespondence(plan, req, targetIsEmpty, noun, sameNamed, dryRun, presented);

  blank();
}

/**
 * How many branch labels a disclosure prints before it summarizes the rest.
 *
 * Measured against a real workspace carrying 1841 non-live branches, most of
 * them platform backups: printing every label buries the one sentence the
 * reader has to act on, and a terminal scrollback is not an inventory. The
 * COUNT is always exact and always stated — this caps only the enumeration.
 */
const BRANCH_DISCLOSURE_LIMIT = 10;

/**
 * Everything a `--replace` destroys without bringing it back.
 *
 * Both halves of the listing, because the engine's DELETE is by workspace and
 * does not care whether a row can be NAMED. The unaddressable rows — real
 * branches carrying no usable label — are the case that matters most here: they
 * are invisible in every ordinary view, which is exactly how a workspace comes
 * to hold several without anyone knowing (see `UnaddressableBranch`). Counting
 * only the named ones would reproduce, inside the guard written to prevent it,
 * the silent loss of branches nobody could see.
 *
 * Only the default branch (`v1`) is left out. It is the one branch the clear
 * keeps, and the archive lands on it. A live branch that is not `v1` is lost
 * like any other, so it is listed.
 */
function doomedBranches(listing: BranchListing): {
  named: readonly BranchRecord[];
  unnamed: number;
  total: number;
  backups: number;
  authored: number;
} {
  const named = listing.branches.filter((b) => b.label !== DEFAULT_BRANCH_LABEL);
  // An unaddressable row is a branch row, and the clear deletes every one.
  const unnamedRows = listing.unaddressable;
  const backups = named.filter((b) => b.backup).length + unnamedRows.filter((b) => b.backup).length;
  const total = named.length + unnamedRows.length;
  return { named, unnamed: unnamedRows.length, total, backups, authored: total - backups };
}

/**
 * The headline count, split by who made the branches.
 *
 * Measured on a real workspace: 1841 non-live branches, nearly all of them
 * created by the platform rather than by anyone. A bare total reads as 1841
 * things you are about to lose, when the number that decides whether to go
 * ahead is how many you MADE. The split is the first line so that judgement
 * takes one glance instead of ten labels.
 */
function doomedHeadline(doomed: ReturnType<typeof doomedBranches>): string {
  const noun = `branch${doomed.total === 1 ? "" : "es"}`;
  const counted = `${doomed.total} ${noun} besides ${DEFAULT_BRANCH_LABEL}`;
  if (doomed.backups === 0 || doomed.authored === 0) return counted;
  return (
    `${counted} — ${doomed.authored} yours, ` +
    `${doomed.backups} platform backup${doomed.backups === 1 ? "" : "s"}`
  );
}

/** The labels to show, plus the lines for what was cut and what cannot be named. */
function branchDisclosureLines(doomed: ReturnType<typeof doomedBranches>): string[] {
  const shown = doomed.named.slice(0, BRANCH_DISCLOSURE_LIMIT);
  const lines = shown.map(
    (b) => `${shownLabel(b.label)}${b.live ? " (live — the deploy lands on " + DEFAULT_BRANCH_LABEL + " instead)" : ""}${b.backup ? " (platform backup)" : ""}`,
  );
  const rest = doomed.named.length - shown.length;
  if (rest > 0) {
    // No total is quoted: `branch list` also prints the live branch and the
    // unaddressable rows, so any count stated here would not be the count it
    // shows.
    lines.push(`… and ${rest} more — \`xanosdk workspace branch list${contextFlags()}\` prints the full inventory`);
  }
  if (doomed.unnamed > 0) {
    lines.push(
      doomed.unnamed === 1
        ? `1 branch with no label, which cannot be named here or exported — it is deleted all the same`
        : `${doomed.unnamed} branches with no label, which cannot be named here or exported — ` +
          `they are deleted all the same`,
    );
  }
  return lines;
}

/**
 * The branch loss a `--replace` is about to cause, for machine output.
 *
 * The human plan renders this too, but an IDE driving the CLI reads `--json`,
 * and a scope it cannot see is a scope it cannot put in front of anyone. Shaped
 * to be read without knowing this command: an exact `total`, the split by who
 * made them, the labels that HAVE labels, and a separate count for the rows the
 * engine reports without one.
 *
 * `unknown: true` when the inventory could not be read — distinct from a
 * workspace with nothing to lose, which is `total: 0`.
 */
function branchDeletionReport(
  req: ReleasePlanRequest,
  listing: BranchListing,
  readFailed: boolean,
  destHasBranches: boolean,
): Record<string, unknown> | undefined {
  if (req.mode !== "replace" || !destHasBranches) return undefined;
  if (readFailed) return { unknown: true };
  const doomed = doomedBranches(listing);
  return {
    unknown: false,
    total: doomed.total,
    authored: doomed.authored,
    platformBackups: doomed.backups,
    unlabeled: doomed.unnamed,
    labels: doomed.named.map((b) => ({ label: b.label, backup: b.backup })),
  };
}

/**
 * Refuse a `--replace` that would silently destroy the workspace's other branches.
 *
 * The clear a replace runs is scoped to the WORKSPACE, not to the branch being
 * imported, so every branch in it is deleted outright — not hidden, not
 * detached. Nothing brings one back: the same clear removes the saved versions
 * that would otherwise be the route home. This is the most destructive thing the
 * CLI can do and it was the least disclosed, because the plan it previews is
 * built from a branch-scoped read and enumerates none of them.
 *
 * A refusal with a named flag rather than a prompt, on the same reasoning as
 * {@link assertSharedSchemaAcknowledged}: the failure mode is not knowing, and
 * someone who has typed `--yes` in CI has already answered every prompt. Passing
 * `--allow-branch-deletion` is a record that the fact was read.
 *
 * Scoped to workspaces that actually HAVE non-live branches, which keeps the
 * disposable-workspace case — a fresh ephemeral with only `v1` — a single
 * command with no extra ceremony.
 *
 * An UNREADABLE inventory refuses too. A timed-out branch list is not evidence
 * that there are no branches to lose, and the issue that prompted this reported
 * exactly that timeout against exactly this endpoint.
 */
function assertBranchDeletionAcknowledged(
  args: ParsedArgs,
  req: ReleasePlanRequest,
  listing: BranchListing,
  readError: unknown,
  workspaceId: number,
): void {
  if (req.mode !== "replace") return;
  if (args.allowBranchDeletion) return;

  if (readError !== undefined) {
    throw new UsageError(
      `Refusing to \`--replace\` workspace #${workspaceId}: its branch list could not be read, so ` +
        `whether this wipe destroys other branches is unknown.\n` +
        `A replace deletes every branch in the workspace and none of them can be recovered. ` +
        `A failed read is not evidence that there are none.\n` +
        `Retry when the instance is reachable, or pass \`--allow-branch-deletion\` to proceed anyway.`,
      { hintFor: { command: "deploy" } },
    );
  }

  const doomed = doomedBranches(listing);
  if (doomed.total === 0) return;

  const listed = branchDisclosureLines(doomed)
    .map((l) => `  - ${l}`)
    .join("\n");

  // `workspace export` reads ONE branch, and with no `--branch` it reads the
  // LIVE one. When that is v1 it is the one branch the replace keeps, so the
  // advice carries the flag that reaches the others. When a non-default branch is live
  // it is one of the doomed — the replace keeps only v1 — so it is named first.
  const liveDoomed = doomed.named.find((b) => b.live);
  const copy =
    doomed.named.length === 0
      ? `A label-less branch cannot be exported, because every branch route addresses a branch by label`
      : liveDoomed !== undefined
        ? `Take a copy of each one first — \`xanosdk workspace export --branch <label>${contextFlags()}\`, once per ` +
          `branch. The live branch, ${JSON.stringify(liveDoomed.label)}, is deleted too: back it up with ` +
          `\`xanosdk workspace export --branch ${shellWord(liveDoomed.label)}${contextFlags()}\``
        : `Take a copy of each one first — \`xanosdk workspace export --branch <label>${contextFlags()}\`, once per ` +
          `branch (a bare \`workspace export\` reads only the live branch, ${DEFAULT_BRANCH_LABEL}, which the replace ` +
          `keeps but overwrites)`;

  throw new UsageError(
    `Refusing to \`--replace\` workspace #${workspaceId}: it has ${doomedHeadline(doomed)}, ` +
      `and the clear deletes branches by WORKSPACE.\n` +
      `These will be permanently deleted and CANNOT be recovered:\n${listed}\n\n` +
      `\`--yes\` does not cover this — it waives the confirmation, not the loss.\n` +
      `${copy}.\n` +
      `Or drop \`--replace\` to merge (which leaves other branches untouched), or pass ` +
      `\`--allow-branch-deletion\` to accept the deletion.`,
    // A one-line pointer, as every refusal of what the TARGET holds gets here:
    // the flags parsed fine, and a usage block under this list would bury it.
    { hintFor: { command: "deploy" } },
  );
}

/**
 * Refuse a branch release that would change the workspace's SHARED schema.
 *
 * Someone typing `--branch` is buying safety, and this is the part the branch
 * does not sell them: tables and microservices carry no branch dimension, so a
 * column added here lands on production in the same call that "staged" the
 * release, and the plan calls it a routine in-place update.
 *
 * A refusal rather than a prompt, for the same reason `--prune` is scoped by the
 * lock rather than by a confirmation: the failure mode is not knowing, and
 * someone who has typed `--yes` in CI has already answered every prompt. The
 * escape hatch is a flag whose name states the fact, so passing it is a record
 * that the fact was read.
 *
 * An UNREADABLE target refuses too. Not being able to see the live schema is not
 * evidence that this release does not change it.
 */
function assertSharedSchemaAcknowledged(
  args: ParsedArgs,
  live: ExportedBundle | undefined,
  bundle: string,
  branch: string,
): readonly SharedSchemaChange[] | undefined {
  // `prune` decides whether an omitted table is a REMOVAL: an ordinary merge
  // leaves it alone, so reporting it would refuse releases over a deletion that
  // was never going to happen.
  // A non-unique index added or dropped changes how rows are found, not what
  // they hold: disclosed (`plan.index-change`) and let through, as `promote`
  // lets it through. A unique index added can refuse over the rows there.
  const changes = gatedSchemaChanges(sharedSchemaChanges(JSON.parse(bundle) as unknown, live, { prune: args.prune }));

  // This run with the flag that waives the refusal, as it can be pasted.
  const waive = retryCommand(args, { add: ["--allow-shared-schema-changes"] });
  const waived = `\`${waive.command}\`${withheldNote(waive.withheld)}`;
  if (changes === undefined) {
    // `undefined` propagates: the caller must not report "changed no shared
    // schema" for a state it could not read. The flag waives the REFUSAL, not
    // the uncertainty.
    if (args.allowSharedSchemaChanges) return undefined;
    return refuseOrReport(
      args,
      `Refusing to deploy to branch "${branch}": the live workspace could not be read, so ` +
        `whether this deploy changes shared schema is unknown.\n` +
        `Tables and microservices are shared by every branch, so a schema change reaches ` +
        `production even on a deploy to a branch. A failed read is not evidence that there is none.\n` +
        `Retry when the instance is reachable. \`--allow-shared-schema-changes\` waives THIS check, ` +
        `but a deploy that cannot read its target is refused either way — use \`--dry-run\` to see ` +
        `the plan without writing.`,
      undefined,
      { reason: "tables-unreadable", changes: null },
    );
  }

  if (changes.length === 0 || args.allowSharedSchemaChanges) return changes;

  const lines = changes.map((c) => {
    const detailText = c.details === undefined || c.details.length === 0 ? "" : ` — ${c.details.join(", ")}`;
    return `  ${c.action} ${c.kind === "dbo" ? "table" : "microservice"} "${c.name}"${detailText}`;
  });

  return refuseOrReport(
    args,
    `\`--branch ${branch}\` cannot stage ${changes.length} change${changes.length === 1 ? "" : "s"} ` +
      `to this workspace's SHARED schema:\n${lines.join("\n")}\n\n` +
      `Tables and microservices carry no branch in Xano — one set is shared by every branch. ` +
      `These would be applied to the LIVE workspace by the same import that stages your logic ` +
      `on "${branch}", and the plan would report them as routine.\n` +
      `Deploy without \`--branch\` if applying them is what you want, take them out of this ` +
      `deploy, or stage the logic and apply the schema knowing both happen: ${waived}.`,
    changes,
    { reason: "shared-schema-changes", changes: lines.map((l) => l.trim()) },
  );
}

/** The shared-schema changes a `--branch` deploy lets through — non-unique index changes — one line each. */
export function ungatedSchemaChanges(changes: readonly SharedSchemaChange[] | undefined): string[] {
  const gated = gatedSchemaChanges(changes) ?? [];
  return (changes ?? []).flatMap((c) => {
    if (c.action !== "alter" || c.details === undefined) return [];
    const kept = gated.find((g) => g.kind === c.kind && g.name === c.name)?.details ?? [];
    return c.details.filter((d) => !kept.includes(d)).map((d) => `table "${c.name}": ${d}`);
  });
}

/** The shared-schema changes a `--branch` deploy gates: every one but a non-unique index change. */
export function gatedSchemaChanges(
  changes: readonly SharedSchemaChange[] | undefined,
): readonly SharedSchemaChange[] | undefined {
  if (changes === undefined) return undefined;
  const gated = (d: string): boolean => !/^drop index /.test(d) && !/^add index (?!unique\()/.test(d);
  return changes.flatMap((c) => {
    if (c.action !== "alter" || c.details === undefined) return [c];
    const details = c.details.filter(gated);
    return details.length === 0 ? [] : [{ ...c, details }];
  });
}

/**
 * A shared-schema finding: refused on a real run — a fact about the workspace,
 * not a mistyped command line, so `SDK_SHARED_SCHEMA_CHANGE` (exit 2) as
 * `promote` refuses it, with no usage hint — and reported
 * as the plan's finding under `--dry-run`, which is the preview the guide
 * sends a reader to (E2E pass 24: the dry run refused too).
 */
function refuseOrReport<T>(args: ParsedArgs, message: string, result: T, details?: Record<string, unknown>): T {
  // The refusal `promote` gives for the same change set: a conflict, exit 2.
  if (!args.dryRun) {
    throw new CliError("SDK_SHARED_SCHEMA_CHANGE", message, {
      exitCode: 2,
      details: { landed: false, declined: false, ...details },
    });
  }
  const [head, ...rest] = message.split("\n");
  warn(/^Refusing/.test(head!) ? head!.replace(/^Refusing/, "A real run would refuse") : `A real run would refuse: ${head!}`, "deploy.dry-run-refusal");
  for (const line of rest) {
    if (line.trim() === "") continue;
    detail(line.trim());
  }
  blank();
  return result;
}

/** The lock payload keys whose objects carry a public URL slug. */
type CanonicalPayloadKey = "app" | "toolset" | "realtime_server";

/**
 * One slug the PROJECT requires the workspace to serve.
 *
 * Which canonicals are contracts and which are values the SDK minted once and
 * merely remembers is a lock-level classification; the pins are what rides the
 * import request, so the instance serves them or refuses. Nothing here derives,
 * guesses, or writes back a classification — a served token must never become
 * the project's next request, or two workspaces sharing a lock alternate slugs
 * forever.
 */
interface PinnedCanonical {
  readonly payloadKey: CanonicalPayloadKey;
  /** The object's name as the workspace knows it — how a row is matched. */
  readonly name: string;
  /** The slug the project pins. What the workspace must be serving. */
  readonly canonical: string;
  /** The object's identity, when the bundle carries one. Matched before the name. */
  readonly guid?: string;
}

/**
 * The lock a release classifies public URL slugs against, or `undefined`.
 *
 * `--bundle` names a pre-compiled archive with no entry file to derive a lock
 * beside, so the classification is only available when `--lock=<path>` names
 * one — the CI shape where compiling and releasing are separate steps. Missing
 * or absent, every slug is a preference: the release insists on nothing, which
 * is the reading that cannot refuse over a URL nobody promised.
 */
export function releaseCanonicalLock(
  args: ParsedArgs,
  /**
   * The lock the compile of this run classified against, when it compiled one.
   * It wins over the file: a real release defers the lock write until its
   * refusals pass and a dry run never writes, so the file can be one export
   * behind — and an object new to it, with a `canonical` written in code, must
   * pin on its FIRST release, dry or real, not on the one after.
   */
  classified?: LockFile,
): LockFile | undefined {
  if (classified !== undefined) return classified;
  const lockPath =
    args.lockPath ?? (args.file !== undefined ? resolveLockPath(args, args.file) : undefined);
  if (lockPath === undefined || !existsSync(lockPath)) return undefined;
  return readLockFile(lockPath);
}

/**
 * The public URL slugs this release requires the workspace to SERVE — the
 * project's contracts, not everything it happens to declare.
 *
 * Every canonical-bearing object in the archive carries a slug, because the SDK
 * fills the empty ones in. Which of them the author actually asked for is not
 * in the archive at all: it is `canonical_source` in the lock, written at
 * export. Only a `"code"` entry is a contract with
 * a frontend and worth failing a release over. A minted token exists to keep a
 * fresh import's URL stable and was never a promise — insisting on it would
 * re-slug a live API the moment a project adopts an existing workspace.
 *
 * An entry with no classification is a lock written before the field existed:
 * unknown, therefore not pinned. Re-exporting classifies it.
 *
 * Nothing here writes a served value back. A release that adopted the slug it
 * found would make the next release from the same lock request it, and two
 * workspaces sharing one project would alternate slugs forever — whichever
 * frontend was built last pointing at the other workspace.
 */
export function codePinnedCanonicals(
  bundle: string,
  lock: LockFile | undefined,
  /**
   * Whether the bundle was COMPILED from source in this run.
   *
   * It decides what an absent lock means. A compile with no lock mints nothing
   * — a slug the code does not name exports empty — so every non-empty slug in
   * the bundle came from the code and is a pin. Without this, a build with no
   * lock sent no pins at all, and a `canonical` written in code was quietly
   * treated as a preference and replaced with a token: the exact silent
   * substitution the pin exists to prevent.
   *
   * A build maintains a lock by default, so this now answers for `--no-lock`
   * rather than for the ordinary case. It stays because the two paths must
   * agree: the pin set a project sends does not change when it acquires a lock,
   * since a slug written in code classifies as `code` and pins either way.
   *
   * A pre-exported `--bundle` is the opposite case and stays unpinned: its
   * slugs may be values a lock minted somewhere else, and nothing in the file
   * says which.
   */
  compiledFromSource = false,
): readonly PinnedCanonical[] {
  if (lock === undefined && !compiledFromSource) return [];
  let payload: Record<string, unknown>;
  try {
    const parsed = (JSON.parse(bundle) as { payload?: unknown } | null)?.payload;
    if (parsed === null || typeof parsed !== "object") return [];
    payload = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const pinned: PinnedCanonical[] = [];
  for (const payloadKey of ["app", "toolset", "realtime_server"] as const) {
    const section = payload[payloadKey];
    if (!Array.isArray(section)) continue;
    for (const row of section) {
      if (row === null || typeof row !== "object") continue;
      const { name, canonical, guid } = row as { name?: unknown; canonical?: unknown; guid?: unknown };
      if (typeof name !== "string" || name === "") continue;
      if (typeof canonical !== "string" || canonical === "") continue;
      // Keyed by `<payloadKey>:<name>` — the same key the export wrote the
      // classification under. These three kinds lock under their plain name.
      // With a lock, the classification decides. Without one there is no
      // minted class to tell apart from a pin.
      if (lock !== undefined && lock.objects[lockKey(payloadKey, name)]?.canonical_source !== "code") {
        continue;
      }
      pinned.push({
        payloadKey,
        name,
        canonical,
        ...(typeof guid === "string" && guid !== "" ? { guid } : {}),
      });
    }
  }
  return pinned;
}

/**
 * The identities behind {@link codePinnedCanonicals} — what a workspace import
 * is told to honor rather than resolve for itself.
 *
 * A pinned slug is addressed by the object's identity, not its name: a rename
 * keeps the identity and a same-named object elsewhere is a different object.
 * An object with no identity in the archive contributes nothing, because there
 * would be no way to say which object the pin belongs to.
 */
export function pinnedCanonicalGuids(
  bundle: string,
  lock: LockFile | undefined,
  compiledFromSource = false,
): readonly string[] {
  const guids: string[] = [];
  for (const entry of codePinnedCanonicals(bundle, lock, compiledFromSource)) {
    if (entry.guid !== undefined && !guids.includes(entry.guid)) guids.push(entry.guid);
  }
  return guids;
}

/**
 * Exit code for a release the instance RAN and disagreed with.
 *
 * A conflict is not a transport problem and not a bad argument: the archive was
 * uploaded, the instance planned it against the real workspace, and the answer
 * was "these identities are already taken". A caller scripting around `release`
 * retries a 1 and must not retry this — nothing about running it again changes
 * the answer. Same meaning, and deliberately the same number, as `preflight`'s
 * "the check ran and the workspace disagreed".
 */
const EXIT_IMPORT_CONFLICT = 2;

/** The bundle text as a value, or `undefined` when it does not parse (the import then says why). */
function parsedOrUndefined(bundle: string): unknown {
  try {
    return JSON.parse(bundle) as unknown;
  } catch {
    return undefined;
  }
}

/** The row named `name` of a reported kind, in the bundle or the target — for a kind read per row. */
function namedRow(ctx: PlanContext | undefined, kind: string, name: string): Record<string, unknown> | undefined {
  const section = planTypeSection(kind);
  for (const side of [ctx?.bundle, ctx?.live]) {
    const rows = payloadOf(side)[section];
    if (!Array.isArray(rows)) continue;
    const row = rows.find((r) => r !== null && typeof r === "object" && (r as { name?: unknown }).name === name);
    if (row !== undefined) return row as Record<string, unknown>;
  }
  return undefined;
}

/** The instance's public-URL report, with each object's kind as the SDK names it. */
function canonicalsForOutput(
  canonicals: readonly XanoSdkCanonicalReport[],
  ctx?: PlanContext,
): XanoSdkCanonicalReport[] {
  return canonicals.map((c) => ({ ...c, kind: sdkKindForPlanType(c.kind, namedRow(ctx, c.kind, c.name)) }));
}

/**
 * A dry run's public-URL report: `served` is what the target WOULD serve, and
 * `live` what it serves now (`null` for an object it does not hold yet) — a
 * preview's `served` alone read as the target's current URL.
 */
function plannedCanonicalsForOutput(
  canonicals: readonly XanoSdkCanonicalReport[],
  ctx: PlanContext,
): (XanoSdkCanonicalReport & { live: string | null })[] {
  return canonicalsForOutput(canonicals, ctx).map((c, i) => ({ ...c, live: liveSlug(ctx.live, canonicals[i]!) ?? null }));
}

/** The slug the target serves now for a canonical report entry: its row by guid, else a guid-less row by name. */
function liveSlug(live: unknown, c: XanoSdkCanonicalReport): string | undefined {
  const rows = payloadOf(live)[planTypeSection(c.kind)];
  if (!Array.isArray(rows)) return undefined;
  const records = rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
  const row =
    (c.guid === undefined ? undefined : records.find((r) => r.guid === c.guid)) ??
    records.find((r) => r.name === c.name && (typeof r.guid !== "string" || r.guid === ""));
  return typeof row?.canonical === "string" && row.canonical !== "" ? row.canonical : undefined;
}

/** Each public URL the import moves off the slug the target serves now. */
function plannedCanonicalMoves(canonicals: readonly XanoSdkCanonicalReport[], ctx: PlanContext): CanonicalMove[] {
  return plannedCanonicalsForOutput(canonicals, ctx)
    .filter((c) => c.live !== null && c.served !== undefined && c.served !== c.live)
    .map((c) => ({ kind: c.kind, name: c.name, from: c.live!, to: c.served! }));
}

/**
 * Say each public URL the import moves, before anything is written — a dry
 * run and a real one alike. `when` ends the lead for a branch landing, whose
 * slugs move only once the branch is live.
 */
function reportPlannedCanonicalMoves(moves: readonly CanonicalMove[], will: "will" | "would", when?: string): void {
  if (moves.length === 0) return;
  discloseCanonicalMoves(moves, { subject: "the deploy", will, ...(when === undefined ? {} : { when }) });
  blank();
}

/** The instance's identity conflicts, with each object's kind as the SDK names it. */
function conflictsForOutput(conflicts: readonly XanoSdkImportConflict[], ctx?: PlanContext): XanoSdkImportConflict[] {
  return conflicts.map((c) => ({ ...c, kind: sdkKindForPlanType(c.kind, namedRow(ctx, c.kind, c.identity)) }));
}

/**
 * The plan a `--json` caller reads: the route's plan with every object named as
 * the SDK names it, the per-kind counts recounted under those names, the row
 * summary in the SDK's key spelling — and no branch for a tenant, which has none.
 */
function planForOutput(
  plan: ImportPlan,
  presented: readonly PresentedOperation[],
  tenant: boolean,
  /**
   * Every object already matches the target. The route still reports each
   * matched identity as an `update`, and the text plan says "no changes" — so
   * the operations are shown as `unchanged` and counted that way, or the
   * document would contradict both the text and the real run's `upToDate`.
   */
  converged = false,
  noun: TargetNoun = tenant ? "tenant" : "workspace",
): Record<string, unknown> {
  const { branch, operations: _operations, summary, ...rest } = plan;
  // The route's own wire flags (`delete`, `records`, `truncate`) are left out:
  // they echo the query it was sent — `delete: false` beside five deletes on a
  // replace, `records: false` beside rows the replace writes — and say nothing
  // about what the plan does. `actions` and `types` are recounted from the
  // operations as presented, so the counts and the list cannot disagree.
  const {
    types: _types,
    actions: _actions,
    delete: _delete,
    records: _records,
    truncate: _truncate,
    rows,
    ...kept
  } = summary;
  const shownRows = presentRows(rows);
  const shown: readonly PresentedOperation[] = converged
    ? presented.map(({ details: _d, reason: _r, ...op }) => ({
        ...op,
        action: "unchanged",
        details: `Already matches the ${noun}; nothing is sent for it`,
      }))
    : presented;
  return {
    ...rest,
    summary: {
      ...kept,
      actions: countActions(shown),
      types: countTypes(shown),
      ...(shownRows === undefined ? {} : { rows: shownRows }),
    },
    operations: shown,
    ...(tenant ? {} : { branch: branch ?? null }),
  };
}

/**
 * Where this release writes, for a `--json` caller: the one destination shape.
 *
 * The workspace is `{ instance, workspaceId, kind: "workspace" }`. An
 * ephemeral or tenant is `backendDestinationPayload`'s — the PARENT's instance
 * and workspace, `kind` its actual type (an ephemeral named as
 * `tenant:<name>` is still an ephemeral), `label` its bare name, and its own
 * base URL under `url`.
 */
function destinationPayload(
  resolved: MergeDest,
  dest: MergeDest | undefined,
  auth: ResolvedAuth,
): ReturnType<typeof writeTargetPayload> & { url?: string } {
  if (dest?.kind !== "tenant") return writeTargetPayload({ base: resolved.base, workspaceId: resolved.workspaceId, kind: "workspace" });
  return backendDestinationPayload(auth, {
    kind: dest.type ?? "tenant",
    name: dest.name ?? resolved.label ?? "",
    url: resolved.base,
    ...(dest.display === undefined ? {} : { display: dest.display }),
  });
}

/**
 * The import route's response, in the shape the plan renderer reads.
 *
 * `ImportPlan` is what `renderPlan` and the prune-scope check speak, and keeping
 * the translation in one function is what stops a second reading of the same
 * response from drifting into the parts of the command that consume it.
 */
function planFromRoute(res: XanoSdkImportResponse, tenant = false, otherBranches?: number): ImportPlan {
  // The raw body is not carried: this plan is what `--json` prints, and the
  // body holds the notes before {@link presentableNotes} has read them.
  const { notes, ...summary } = res.plan.summary;
  return {
    workspaceName: res.workspace.name,
    summary: notes === undefined ? summary : { ...summary, notes: presentableNotes(notes, tenant, otherBranches) },
    hasRecords: res.plan.hasRecords,
    hasEnv: res.plan.hasEnv,
    operations: res.plan.operations,
    branch: res.branch,
  };
}

/**
 * An internal identifier in a note (`namespace:operation_name`). The instance's
 * notes are written for its own maintainers, and one of them names the
 * operation a replace runs — a name that means nothing to a reader and is not
 * the CLI's to publish. Generic on purpose: any such token withholds the note.
 */
const INTERNAL_IDENTIFIER = /\b[a-z]+:[a-z_]+\b/;

/**
 * The note the instance attaches to every replace preview: the clear runs
 * workspace-wide, so objects on other branches go too and the operation list
 * does not show them. Recognised by what it says, not by the identifier in it.
 */
const REPLACE_CLEAR_NOTE = /other branch/i;

/** "branches, " as an item of the list of what a clear removes — true of a workspace only. */
const BRANCHES_IN_LIST = /\bbranches, /;

/**
 * The instance's preview notes, as the CLI can show them.
 *
 * A note with no internal identifier is shown as written. The replace-clear note
 * is said in the CLI's own words. Any other note carrying an identifier is
 * withheld — and COUNTED, because a note exists to say the preview is
 * incomplete, and dropping it silently would make the plan read as exhaustive.
 */
/** How the server's replace-clears-every-branch note is shown for a workspace. */
const REPLACE_CLEAR_TEXT =
  "A replace clears the whole workspace, not one branch: every object on every other branch " +
  "of this workspace is destroyed too, and none of them is listed in this plan.";

export function presentableNotes(notes: unknown, tenant = false, otherBranches?: number): string[] {
  const all = typeof notes === "string" ? [notes] : Array.isArray(notes) ? notes : [];
  const shown: string[] = [];
  let withheld = 0;
  for (const note of all) {
    if (typeof note !== "string" || note === "") continue;
    // A tenant has no branches: a note about what happens on its OTHER branches
    // — the replace clear's, or a prune's scope — describes a workspace, and a
    // list of what the clear removes does not include branches there.
    if (tenant && REPLACE_CLEAR_NOTE.test(note)) continue;
    // Nor on a workspace whose inventory was read and holds no other branch:
    // "every object on every other branch … is destroyed" described a loss
    // there was nothing to suffer. Unknown (`undefined`) keeps the note.
    if (otherBranches === 0 && REPLACE_CLEAR_NOTE.test(note)) continue;
    if (tenant && BRANCHES_IN_LIST.test(note)) {
      shown.push(note.replace(BRANCHES_IN_LIST, ""));
      continue;
    }
    if (!INTERNAL_IDENTIFIER.test(note)) shown.push(note);
    else if (REPLACE_CLEAR_NOTE.test(note)) {
      shown.push(REPLACE_CLEAR_TEXT);
    } else withheld += 1;
  }
  if (withheld > 0) {
    shown.push(
      `The instance attached ${withheld} more note${withheld === 1 ? "" : "s"} about this preview ` +
        `that the CLI cannot show — treat the plan as incomplete.`,
    );
  }
  return shown;
}

/**
 * Where a refused release was headed, and what it was asked to do — the part of
 * every refusal document that does not depend on WHY it was refused.
 *
 * One frame for the three refusals (an identity already taken, an object of
 * another kind under the same identity, and the instance refusing at apply
 * time), so a `--json` caller reads one document shape whichever fired: the
 * dry run's keys, `landed: false`, and the reason under `refused`.
 */
interface RefusalFrame {
  /** The destination's internal workspace id (a tenant's is always 1). */
  readonly workspaceId: number;
  /** The running command, as a conflict line names what it carries (default `deploy`). */
  readonly verb?: string;
  /** How the prose names the destination: `workspace #7`, `tenant "eu" ("Europe")`, `ephemeral "x"`. */
  readonly noun: string;
  /** The destination is a tenant or an ephemeral — no branches, and its workspace row names nothing the reader chose. */
  readonly tenant: boolean;
  /** {@link destinationPayload}, as every other `--json` document carries it. */
  readonly destination: ReturnType<typeof destinationPayload>;
  readonly mode: ImportMode;
  readonly prune: boolean;
  readonly dryRun: boolean;
  /**
   * How to adopt what the destination already holds, as a clause that ends the
   * remedy — or `undefined` where nothing can be adopted from (see {@link adoptRemedy}).
   */
  readonly adopt: string | undefined;
  /**
   * The lock already holds every identity the destination has, so the adopt
   * remedy would change nothing (E2E pass 16) — set only when that was read.
   */
  readonly adoptAddsNothing?: boolean;
  /**
   * The `lock rename` remedy when the holder's guid is pinned in xano.lock under
   * another name of the same kind — a def renamed in code (see {@link lockRenameRemedy}).
   */
  readonly lockRename?: (ownerGuid: string, sending: { kind: string; name: string; payloadKey: string; lockName: string }) => string | undefined;
  /**
   * Whether the def sending `guid` pins it with `guid:` in code (see
   * {@link codePinnedGuid}) — where adopting into xano.lock changes nothing sent.
   */
  readonly pinnedInCode?: (guid: string, sending: { payloadKey: string; name: string; lockName: string }) => boolean;
}

/**
 * Whether a sent guid is a def's own `guid:` rather than the lock's or its
 * name's: the lock (as on disk — a refused release has not written it) records
 * it as the def's (`guid_source: "code"`), or neither the lock nor the name
 * derivation gives it. A def's guid wins over xano.lock, so an
 * adopt remedy (export, then `lock import`) cannot change what that def sends.
 * The same test `assertNoKindSwap` splits its code- and lock-pinned causes by.
 */
function codePinnedGuid(args: ParsedArgs): RefusalFrame["pinnedInCode"] {
  let lock: LockFile | undefined;
  try {
    lock = readLockFile(resolveLockPath(args, args.file ?? "."));
  } catch {
    lock = undefined;
  }
  return (guid, sending) => {
    const key = lockKey(sending.payloadKey, sending.lockName);
    // An export recorded the def's own `guid:` into the lock it wrote.
    const entry = lock?.objects[key];
    if (entry?.guid === guid && entry.guid_source === "code") return true;
    if (guid === rawDeriveGuid(key)) return false;
    // A lock written before query identity was composed pins the bare name.
    const legacy = sending.payloadKey === "query" ? lock?.objects[lockKey("query", sending.name)]?.guid : undefined;
    return lock?.objects[key]?.guid !== guid && legacy !== guid;
  };
}

/**
 * A conflict that is this project's own rename. The lock pins the holder's guid
 * under the OLD name — the entry this build orphaned — so moving that entry to
 * the new name makes the release update the object already there, keeping its
 * guid and its canonical. Pinning a guid or adopting reads as a different
 * object; neither says what happened.
 */
function lockRenameRemedy(args: ParsedArgs): RefusalFrame["lockRename"] {
  const lockPath = resolveLockPath(args, args.file ?? ".");
  let lock: LockFile;
  try {
    lock = readLockFile(lockPath);
  } catch {
    return undefined;
  }
  return (ownerGuid, sending) => {
    const prefix = `${sending.payloadKey}:`;
    const key = Object.keys(lock.objects).find(
      (k) => k.startsWith(prefix) && lock.objects[k]?.guid === ownerGuid && k !== `${prefix}${sending.lockName}`,
    );
    if (key === undefined) return undefined;
    let [kind, oldName, newName] = [sending.kind, key.slice(prefix.length), sending.lockName];
    // A query whose group was renamed (`A|GET|x` → `B|GET|x`): the group's
    // rename carries every query key with it, so that is the one to run.
    const [og, ...orest] = oldName.split("|");
    const [ng, ...nrest] = newName.split("|");
    if (sending.payloadKey === "query" && og !== ng && orest.join("|") === nrest.join("|") && `app:${og}` in lock.objects) {
      [kind, oldName, newName] = ["apiGroup", og!, ng!];
    }
    // The same for a realtime channel/message under a renamed server, and a
    // message under a renamed channel (`<server>|<path>|<name>`).
    const [o, n] = [oldName.split("|"), newName.split("|")];
    if (sending.payloadKey === "channel" || sending.payloadKey === "message") {
      if (og !== ng && orest.join("|") === nrest.join("|") && `realtime_server:${og}` in lock.objects) {
        [kind, oldName, newName] = ["realtimeServer", og!, ng!];
      } else if (
        sending.payloadKey === "message" && o[1] !== n[1] && o[0] === n[0] && o[2] === n[2] && `channel:${o[0]}|${o[1]}` in lock.objects
      ) {
        [kind, oldName, newName] = ["realtimeChannel", `${o[0]}|${o[1]}`, `${n[0]}|${n[1]}`];
      }
    }
    const entry = args.file === undefined ? "" : ` --entry=${shellWord(displayPath(args.file))}`;
    return (
      `This is a rename of ${kind} "${oldName}" to "${newName}": xano.lock still pins that guid ` +
      `under the old name. Run \`xanosdk lock rename ${kind} ${shellWord(oldName)} ${shellWord(newName)} ` +
      `--lock=${shellWord(displayPath(lockPath))}${entry}\`, then retry — the object already there is updated in ` +
      `place, keeping its guid and canonical.`
    );
  };
}

/**
 * The adopt remedy for this destination. `lock import` takes an exported
 * bundle, so the remedy names the export that writes one: a workspace's
 * `workspace export`, an ephemeral's `ephemeral export`. A standard tenant has
 * no export, but `xanosdk pull tenant:<name>` decodes it into this project and
 * records every identity it holds in the lock — offered when the lock is the
 * one a pull of this project's backend writes (E2E pass 16).
 */
function adoptRemedy(args: ParsedArgs, dest: MergeDest | undefined): string | undefined {
  const lockPath = resolveLockPath(args, args.file ?? ".");
  const lockFlag = lockPath === resolve("xano.lock") ? "" : ` --lock=${shellWord(displayPath(lockPath))}`;
  const creds = contextFlags(args);
  // `--yes`: the export holds the identities the lock pins differently — that
  // is the conflict — so the import always overwrites, and choosing this remedy
  // IS choosing that overwrite. Without it a piped run refused every time.
  const importIt = `\`xanosdk lock import live.json${lockFlag} --yes\``;
  // The scope, said where the command is: the import adopts EVERY identity the
  // export holds, not the one that conflicted, and an adopted object is one a
  // later `--prune` from this project may delete once a landing records it.
  const scope =
    " — every identity in that file becomes this project's, and a later `--prune` from this project can delete " +
    "any of those objects once they have landed";
  if (dest?.kind !== "tenant") {
    return `export it with \`xanosdk workspace export --path live.json${creds}\`, then ${importIt}${scope}`;
  }
  if (dest.name === undefined || dest.name === "") return undefined;
  if (dest.type !== "ephemeral") return pullRemedy(dest.name, lockPath, creds);
  return `export it with \`xanosdk ephemeral export ${shellWord(dest.name)} --format json --path live.json${creds}\`, then ${importIt}${scope}`;
}

/**
 * A standard tenant's adopt remedy: `xanosdk pull tenant:<name>`, which rewrites
 * the decoded files of this project's backend from the tenant and adopts its
 * identities into the lock beside them. Undefined when `lockPath` is not that
 * lock — a pull writes `<backend>/xano.lock`, and adopting into a file this
 * release does not read would change nothing. `--yes` rides along when stdin
 * is not a terminal, where pull cannot ask before replacing.
 */
function pullRemedy(tenant: string, lockPath: string, creds: string): string | undefined {
  const backend = dirname(lockPath);
  if (!existsSync(join(backend, "index.ts"))) return undefined;
  const cwd = process.cwd();
  const rel = relative(cwd, backend).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return undefined;
  const dirFlag = resolve(backendDirIn(cwd)) === resolve(backend) ? "" : ` --backend-dir ${shellWord(pastePath(rel))}`;
  const yes = process.stdin.isTTY === true ? "" : " --yes";
  return (
    `pull it into this project with \`xanosdk pull tenant:${shellWord(tenant)}${dirFlag}${creds}${yes}\` (commit ` +
    `first) — it rewrites the files a decode wrote in ${rel}/, your edits to them included, and keeps the files ` +
    `you added; every identity the tenant holds becomes this project's, and a later \`--prune\` from this project ` +
    `can delete any of those objects once they have landed`
  );
}

/**
 * Whether adopting `live` into the lock this release reads would change
 * nothing: every identity it holds is already there, as it is. Then the adopt
 * remedy is a no-op, and the conflict is with an object under another name.
 */
function adoptionAddsNothing(args: ParsedArgs, live: ExportedBundle | undefined): boolean {
  // A read that came back with no identities says nothing about the lock —
  // "already holds all of none" is not coverage.
  if (live === undefined || kindsByGuid(live).size === 0) return false;
  const lockPath = resolveLockPath(args, args.file ?? ".");
  if (!existsSync(lockPath)) return false;
  try {
    const { added, changed } = adoptFromBundle(readLockFile(lockPath), live, "the destination");
    return added.length === 0 && changed.length === 0;
  } catch {
    return false;
  }
}

/** Which check refused, as the refusal document names it. */
type RefusalReason = "identityConflict" | "kindConflict" | "importRefused" | "uniqueViolation" | "pruneOutOfScope" | "renamePending";

/** One object a prune would delete that this project never landed there, as the refusal document lists it. */
interface OutOfScopeDelete {
  readonly type: string;
  readonly name: string;
  readonly label: string;
  readonly reason?: string;
}

/** The code each refusal carries — every one a state conflict or a refusal, never `SDK_ERROR`. */
export const REFUSAL_CODES: Readonly<Record<RefusalReason, ErrorCode>> = {
  identityConflict: "SDK_IDENTITY_CONFLICT",
  renamePending: "SDK_IDENTITY_CONFLICT",
  kindConflict: "SDK_KIND_CONFLICT",
  importRefused: "SDK_IMPORT_REFUSED",
  uniqueViolation: "SDK_IMPORT_REFUSED",
  pruneOutOfScope: "SDK_PRUNE_OUT_OF_SCOPE",
};

/**
 * The tables renamed in code that xano.lock was not told about: a lock entry
 * whose guid the outgoing bundle no longer carries, still held by the target,
 * while the plan creates a table. A merge matches on guid, so the new name
 * lands empty beside the old table and its rows. The lock on disk is the one
 * this build read; it is written only once the landing is confirmed.
 */
async function unrecordedTableRenames(
  args: ParsedArgs,
  bundle: string,
  live: unknown,
  plan: ImportPlan,
  /** The lock this build merged — which guids are a def's, and which a def's replaced. */
  classified?: LockFile,
): Promise<PendingRename[]> {
  const entry = args.file;
  if (entry === undefined) return [];
  const created = plan.operations.filter((o) => o.action === "create" && (o.type === "table" || o.type === "dbo")).map((o) => o.name);
  if (created.length === 0) return [];
  const lockPath = resolveLockPath(args, entry);
  let lock: LockFile;
  try {
    lock = readLockFile(lockPath);
  } catch {
    return [];
  }
  const guidsOf = (doc: unknown): Map<string, string> => {
    const rows = payloadOf(doc).dbo;
    const out = new Map<string, string>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const row = r as { guid?: unknown; name?: unknown } | null;
      if (typeof row?.guid === "string" && row.guid !== "") out.set(row.guid, typeof row.name === "string" ? row.name : row.guid);
    }
    return out;
  };
  let outgoingDoc: unknown;
  try {
    outgoingDoc = JSON.parse(bundle) as unknown;
  } catch {
    return [];
  }
  const outgoing = guidsOf(outgoingDoc);
  const outgoingNames = new Set(outgoing.values());
  const held = guidsOf(live);
  const codePinned = codePinnedTables(outgoingDoc, lock, classified);
  const { orphanFixUps } = await import("./cli.js");
  const { setGuidRemedy, clearReplacedCommand } = await import("./keep-data-merge.js");
  const run = (line: string | undefined) => (line ?? "").replace(/^(renamed|deleted)\? run: /, "");
  const out: PendingRename[] = [];
  const seen = new Set<string>();
  // An orphan entry's guid, and every guid a def's `guid:` replaced — the
  // lock this build merged has both; the one on disk, the orphans it read.
  for (const [key, e] of Object.entries((classified ?? lock).objects)) {
    if (!key.startsWith("dbo:")) continue;
    // An entry the build still exports is only reached by an identity-only prune.
    const orphan = !outgoingNames.has(key.slice("dbo:".length));
    const guids = [...(typeof e.guid === "string" ? [e.guid] : []), ...(e.replaced ?? [])];
    for (const guid of guids) {
      if (outgoing.has(guid) || seen.has(guid)) continue;
      const table = held.get(guid);
      if (table === undefined) continue;
      seen.add(guid);
      const [rename, prune] = orphanFixUps(key, entry, lockPath, undefined, [], created.length === 1 ? created[0] : undefined);
      // An entry still exported cannot be moved by a `lock rename`: the def carries the guid instead.
      const setGuid =
        setGuidRemedy(guid, created, codePinned) ??
        (orphan ? undefined : { ...(created.length === 1 ? { table: created[0] } : {}), guid, pins: [] });
      out.push({
        table,
        guid,
        candidates: created,
        ...(setGuid === undefined ? { rename: run(rename) } : { setGuid }),
        prune: orphan ? run(prune) : clearReplacedCommand(key.slice("dbo:".length), lockPath),
      });
    }
  }
  // A table the disk lock pinned under a key whose def now pins another guid.
  for (const [name, t] of codePinned) {
    for (const guid of t.replaces ?? []) {
      if (outgoing.has(guid) || seen.has(guid)) continue;
      const table = held.get(guid);
      if (table === undefined) continue;
      seen.add(guid);
      const setGuid = setGuidRemedy(guid, created, codePinned);
      const [rename] = orphanFixUps(`dbo:${name}`, entry, lockPath, undefined, [], created.length === 1 ? created[0] : undefined);
      out.push({
        table,
        guid,
        candidates: created,
        ...(setGuid === undefined ? { rename: run(rename) } : { setGuid }),
        prune: clearReplacedCommand(name, lockPath),
      });
    }
  }
  return out;
}

/** {@link unrecordedTableRenames}, refused: nothing is written until the lock says which it is. */
async function pendingRenameRefusal(
  frame: RefusalFrame,
  pending: readonly PendingRename[],
  prune: boolean,
  branch: string | null | undefined,
): Promise<CliError> {
  const { pendingRenameLines, pendingRenameFollowUp, pendingRenameDetail, sameNameRepin } = await import("./keep-data-merge.js");
  const one = pending.length === 1;
  const lines = pending.flatMap((p) =>
    pendingRenameLines(
      p,
      prune ? "the old table would still be dropped" : "the new table would still be created empty beside the old one",
      prune ? {} : { addFlag: "--prune" },
    ),
  );
  const err = refusalError(
    frame,
    "renamePending",
    (pending.every(sameNameRepin)
      ? `Refusing to deploy into ${frame.noun}: ${one ? "a table's def pins" : "table defs pin"} a new guid under ` +
        `the name the table already has. A merge matches on guid, so it would create the new table empty ` +
        (prune ? `and DROP the old one with every row.` : `beside the old one, which the target refuses by name.`)
      : `Refusing to deploy into ${frame.noun}: the project adds a table while xano.lock still pins ` +
        `${one ? "a table" : "tables"} the build no longer declares — a rename the lock was not told about. A merge ` +
        `matches on guid, so it would create the new table empty ` +
        (prune ? `and DROP the old one with every row.` : `beside the old one, which keeps the rows the app no longer reads.`)) +
      `\n${lines.join("\n")}\n` +
      `Nothing was written. ` +
      pendingRenameFollowUp(pending, `it is no longer this project's.`),
    { branch },
  );
  (err.details as Record<string, unknown>).renames = pending.map(pendingRenameDetail);
  return err;
}

/**
 * The one refusal, as the error the CLI's failure document is written from:
 * `{ ok: false, error: { code, message, exitCode, details } }`, the shape of
 * every other failure. `details` carries the whole refusal — every key always
 * present (an empty list, or `null`) — so a wrapper reads `details.refused`
 * and the list that goes with it without testing which keys exist.
 */
function refusalError(
  frame: RefusalFrame | undefined,
  refused: RefusalReason,
  message: string,
  lists: {
    branch: string | null | undefined;
    conflicts?: readonly XanoSdkImportConflict[];
    kindConflicts?: readonly KindSwap[];
    canonicals?: readonly unknown[];
    outOfScope?: readonly OutOfScopeDelete[];
    /** For a uniqueness refusal: the unique indexes the landing adds, which it can be about. */
    indexes?: readonly { table: string; index: string }[];
    /** For a uniqueness refusal: the unique indexes on tables this run seeds, which its seed rows can collide on. */
    seededIndexes?: readonly { table: string; index: string }[];
    /** The instance's own refusal code, for an apply-time refusal. */
    serverCode?: string;
    code?: ErrorCode;
    exitCode?: number;
  },
): CliError {
  const details: Record<string, unknown> = {
    refused,
    ...(lists.serverCode === undefined ? {} : { serverCode: lists.serverCode }),
    landed: false,
    ...(frame === undefined
      ? {}
      : {
          dryRun: frame.dryRun,
          declined: false,
          workspaceId: frame.workspaceId,
          destination: frame.destination,
          mode: frame.mode,
          prune: frame.prune,
          // A tenant has no branches: the route's echo of its internal default
          // describes nothing the reader chose.
          branch: frame.tenant ? null : (lists.branch ?? null),
        }),
    conflicts: frame === undefined ? [...(lists.conflicts ?? [])] : conflictsForRefusal(lists.conflicts ?? [], frame),
    kindConflicts: lists.kindConflicts ?? [],
    canonicals: lists.canonicals ?? [],
    outOfScope: lists.outOfScope ?? [],
    ...(lists.indexes === undefined ? {} : { uniqueViolation: true, indexes: lists.indexes.map((i) => ({ ...i })) }),
    ...(lists.seededIndexes === undefined ? {} : { seededIndexes: lists.seededIndexes.map((i) => ({ ...i })) }),
    // Nothing was written, so nothing was landed.
    landingRecord: null,
  };
  return new CliError(lists.code ?? REFUSAL_CODES[refused], message, {
    details,
    exitCode: lists.exitCode ?? EXIT_IMPORT_CONFLICT,
  });
}

/** Does this owner hold the identity on the destination itself (rather than on another workspace)? */
function ownerIsDestination(owner: XanoSdkImportConflict["owner"], frame: RefusalFrame): boolean {
  return owner.workspaceId === frame.workspaceId;
}

/**
 * The conflicts as a refusal document carries them. On a tenant or an
 * ephemeral the owner's workspace name and branch are the platform's internal
 * row (a generated name, the default branch), which name nothing the reader
 * chose — `destination` names the target instead.
 */
function conflictsForRefusal(conflicts: readonly XanoSdkImportConflict[], frame: RefusalFrame): XanoSdkImportConflict[] {
  if (!frame.tenant) return [...conflicts];
  return conflicts.map((c) => {
    if (!ownerIsDestination(c.owner, frame)) return c;
    // Undefined rather than absent: the fields are part of the type, and the
    // document serializer leaves an undefined key out.
    return { ...c, owner: { ...c.owner, workspaceName: undefined, branch: undefined } };
  });
}

/** How the owner of a conflicting identity is named in the refusal. */
function describeOwner(owner: XanoSdkImportConflict["owner"], frame: RefusalFrame): string {
  const guid = owner.guid !== undefined ? ` (${owner.guid})` : "";
  const deleted = owner.deleted ? ", deleted but still holding the name" : "";
  // A tenant's own workspace is named as the tenant: its row's name is the
  // platform's, and "this workspace" is not what the reader released into.
  if (frame.tenant && ownerIsDestination(owner, frame)) return `${frame.noun}${guid}${deleted}`;
  const where = ownerIsDestination(owner, frame) ? "this workspace" : `workspace #${owner.workspaceId}`;
  const named = owner.workspaceName !== undefined ? ` "${owner.workspaceName}"` : "";
  const branch = owner.branch !== undefined && !frame.tenant ? ` on branch "${owner.branch}"` : "";
  return `${where}${named}${branch}${guid}${deleted}`;
}

/**
 * What the reader can actually DO about one conflict — which depends entirely
 * on who holds the identity.
 *
 * When the owner is the destination being released into, every remedy is in the
 * caller's own project: rename the object, pin the identity that is already
 * there so the release updates it, or adopt what the destination holds. When the
 * owner is a DIFFERENT workspace, not one of those helps — the identity is held
 * somewhere this project has no say over, and printing "rename or adopt" there
 * sends the reader to edit files that cannot possibly change the answer. So
 * that case names the workspace by id and says the fix lives in it.
 */
function conflictRemedy(
  c: XanoSdkImportConflict,
  frame: RefusalFrame,
  bundle?: unknown,
  all: readonly XanoSdkImportConflict[] = [],
): string {
  const purge = c.owner.deleted
    ? " A deleted object still holds its identity, so it has to be purged before the name is free."
    : "";
  const sibling = siblingHolder(c, frame, bundle);
  if (sibling !== undefined) return siblingRemedy(c, sibling, all);

  if (!ownerIsDestination(c.owner, frame)) {
    const named = c.owner.workspaceName !== undefined ? ` ("${c.owner.workspaceName}")` : "";
    return (
      `Nothing in this project can free it: the identity is held by workspace ` +
      `#${c.owner.workspaceId}${named}, not by the one being released into. ` +
      `${c.kind === "canonical" ? "Change the `canonical` on yours (or drop it to have one minted)" : "Rename yours"}, or free it ` +
      `in workspace #${c.owner.workspaceId}.${purge}`
    );
  }

  if (c.owner.guid !== undefined && c.archiveGuid !== undefined && frame.lockRename !== undefined) {
    const sending = kindsByGuid(bundle).get(c.archiveGuid);
    const rename = sending === undefined ? undefined : frame.lockRename(c.owner.guid, sending);
    if (rename !== undefined) return `${rename}${purge}`;
  }

  const holder = frame.tenant ? frame.noun : "the workspace";
  const pin =
    c.owner.guid !== undefined
      ? // A def's `guid:` wins over the lock's entry for it (the next build
        // re-pins the lock and says so), so this is the whole step.
        `pin it on the def (\`guid: "${c.owner.guid}"\`) so this ${frame.verb ?? "deploy"} UPDATES the object that is already there`
      : undefined;
  // A public URL slug is the object's `canonical`, not its name: renaming the
  // object leaves the slug it asks for exactly where it was.
  const fix =
    c.kind === "canonical"
      ? `change the \`canonical\` on this project's def to a slug nothing else serves, or drop it to have the instance mint one`
      : "rename it in this project";
  const Fix = `${fix.charAt(0).toUpperCase()}${fix.slice(1)}`;
  // The def pins its own `guid:`, which wins over xano.lock: adopting what the
  // destination holds rewrites the lock and leaves the guid sent unchanged, so
  // the fix is the def's `guid:` itself (E2E pass 21).
  const sent = c.archiveGuid === undefined ? undefined : kindsByGuid(bundle).get(c.archiveGuid);
  if (c.kind !== "canonical" && sent !== undefined && frame.pinnedInCode?.(c.archiveGuid!, sent) === true) {
    const setIt =
      c.owner.guid !== undefined
        ? `change it to \`guid: "${c.owner.guid}"\` so this ${frame.verb ?? "deploy"} UPDATES the object that is already there, or remove it`
        : "change or remove it";
    return (
      `${Fix}, or ${setIt}: the def pins \`guid: "${c.archiveGuid}"\` in code, and a def's \`guid:\` wins over ` +
      `xano.lock, so adopting into the lock cannot change what this ${frame.verb ?? "deploy"} sends.${purge}`
    );
  }
  if (frame.adopt === undefined) {
    return `${Fix}${pin === undefined ? "" : `, or ${pin}`}.${purge}`;
  }
  if (frame.adoptAddsNothing === true) {
    // The lock already holds every identity the destination has: re-adopting
    // changes nothing, so offering it sent the reader round a loop.
    const why =
      c.kind === "canonical"
        ? `the slug is held by an object under a different name (a differently named group, say), which adopting cannot make this one`
        : `adopting cannot free it`;
    return (
      `${pin === undefined ? Fix : `${pin.charAt(0).toUpperCase()}${pin.slice(1)}, or ${fix}`}. Adopting again ` +
      `changes nothing: xano.lock already holds every identity ${holder} holds, and ${why}.${purge}`
    );
  }
  // The narrow remedy first: pinning takes over this one object, where
  // adopting takes over everything the destination holds.
  if (pin !== undefined) {
    return (
      `${pin.charAt(0).toUpperCase()}${pin.slice(1)}, or ${fix}. To adopt everything ` +
      `${holder} holds instead: ${frame.adopt}.${purge}`
    );
  }
  return `${Fix}, or adopt everything ${holder} holds: ${frame.adopt}.${purge}`;
}

/**
 * The instance refuses an archive whose signature does not match its content
 * with a bare 500 ("Invalid workspace signature"). The SDK signs what it
 * compiles, so the usual cause is a `--bundle` edited after it was exported —
 * said, with the way out. The error keeps its class, so its exit code stands.
 */
export function withSignatureHint(err: unknown, bundlePath: string | undefined): unknown {
  if (!isSignatureRefusal(err)) return err;
  err.message +=
    `\nThe archive's signature does not match its content` +
    (bundlePath === undefined
      ? "."
      : `: ${bundlePath} was changed after it was exported. ${exportAgain(bundleOrigin(bundlePath))} rather than ` +
        `editing the bundle, or deploy from the entry file.`);
  return err;
}

/**
 * Which command wrote a bundle, from the bundle itself: a live backend's
 * export carries the platform's own workspace record (its `guid` and `iv`),
 * which a compiled one never does. `undefined` when the file cannot be read.
 * A live export does not say WHICH backend — an ephemeral's and the
 * workspace's look alike — so that answer names both.
 */
export function bundleOrigin(path: string): "compiled" | "live" | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { payload?: { workspace?: Record<string, unknown> } };
    const ws = parsed.payload?.workspace;
    if (ws === undefined || ws === null || typeof ws !== "object") return undefined;
    return "guid" in ws || "iv" in ws ? "live" : "compiled";
  } catch {
    return undefined;
  }
}

/** The export to run again, by the bundle's origin (E2E pass 22: an edited `ephemeral export` was sent to `xanosdk export`). */
function exportAgain(origin: "compiled" | "live" | undefined): string {
  if (origin === "compiled") return "Export it again (`xanosdk export <entry>`)";
  if (origin === "live") {
    return "Export it again from the backend it came from (`xanosdk ephemeral export <name>` or `xanosdk workspace export`)";
  }
  return "Export it again with the command that wrote it (`xanosdk export <entry>`, `xanosdk ephemeral export <name>` or `xanosdk workspace export`)";
}

/** One conflict as the refusal prose lists it: what, who holds it, and what to do. */
function conflictLine(
  c: XanoSdkImportConflict,
  frame: RefusalFrame,
  ctx?: PlanContext,
  all: readonly XanoSdkImportConflict[] = [],
): string {
  const other = otherKindHolder(c, frame, ctx?.live);
  return (
    `  ${c.kind} "${c.identity}" — held by ` +
    (other === undefined ? "" : `${other.kind} "${other.name}" in `) +
    describeOwner(c.owner, frame) +
    (c.archiveGuid !== undefined ? `; this ${frame.verb ?? "deploy"} carries ${c.archiveGuid}` : "") +
    `\n      ${other === undefined ? conflictRemedy(c, frame, ctx?.bundle, all) : otherKindRemedy(c, other, frame)}`
  );
}

/**
 * The destination's object holding the name, when it is ANOTHER kind than the
 * def asking for it — an MCP server where this project declares an agent of its
 * name, the two sharing one name space. Needs the target read.
 */
function otherKindHolder(
  c: XanoSdkImportConflict,
  frame: RefusalFrame,
  live: unknown,
): { kind: string; name: string } | undefined {
  if (live === undefined || c.kind === "canonical" || c.owner.guid === undefined) return undefined;
  if (!ownerIsDestination(c.owner, frame)) return undefined;
  const held = kindsByGuid(live).get(c.owner.guid);
  return held === undefined || held.kind === c.kind ? undefined : held;
}

/**
 * The remedy for {@link otherKindHolder}: pinning the holder's guid would turn
 * that object into this one — the kind conflict the next run refuses — so the
 * guid pin is not offered, and neither is adopting it.
 */
function otherKindRemedy(c: XanoSdkImportConflict, holder: { kind: string; name: string }, frame: RefusalFrame): string {
  const purge = c.owner.deleted
    ? " A deleted object still holds its identity, so it has to be purged before the name is free."
    : "";
  const where = frame.tenant ? frame.noun : "the workspace";
  return (
    `${c.kind.charAt(0).toUpperCase()}${c.kind.slice(1)} and ${holder.kind} names share one name space, and pinning that guid would turn the ${holder.kind} ` +
    `into this ${c.kind}. Rename one of them: this project's ${c.kind}, or the ${holder.kind} on ${where} if it ` +
    `is yours to rename.${purge}`
  );
}

/** A def of this release, by the kind and name the SDK gives it. */
interface BundleDef {
  kind: string;
  name: string;
}

/**
 * The def in THIS release that already carries the holder's identity, when the
 * holder is on the destination and the bundle declares it too — two of this
 * project's own defs trading a name or a slug. Pinning the holder's guid on the
 * conflicting def would then give two defs one identity (the build refuses a
 * duplicate guid), and adopting cannot free it either.
 */
function siblingHolder(
  c: XanoSdkImportConflict,
  frame: RefusalFrame,
  bundle: unknown,
): { holder: BundleDef; sending: BundleDef | undefined } | undefined {
  if (bundle === undefined || c.owner.guid === undefined || !ownerIsDestination(c.owner, frame)) return undefined;
  if (c.owner.guid === c.archiveGuid) return undefined;
  const defs = kindsByGuid(bundle);
  const holder = defs.get(c.owner.guid);
  if (holder === undefined) return undefined;
  return { holder, sending: c.archiveGuid === undefined ? undefined : defs.get(c.archiveGuid) };
}

/**
 * The remedy when the holder is another def of this same release (see
 * {@link siblingHolder}). One deploy checks each identity against what the
 * destination holds when it starts, so an identity changes hands only in the
 * deploy after its holder left it — and a swap (the holder wants the
 * sender's in return) needs one side parked on a free one first.
 */
function siblingRemedy(
  c: XanoSdkImportConflict,
  { holder, sending }: { holder: BundleDef; sending: BundleDef | undefined },
  all: readonly XanoSdkImportConflict[] = [],
): string {
  const what = c.kind === "canonical" ? "canonical" : "name";
  const held = `${holder.kind} "${holder.name}"`;
  const mine = sending === undefined ? "the def that asks for it" : `${sending.kind} "${sending.name}"`;
  const swap = all.some(
    (o) => o !== c && o.kind === c.kind && o.archiveGuid === c.owner.guid && o.owner.guid === c.archiveGuid,
  );
  const move = swap
    ? `They trade ${what}s, and one deploy checks each against what the destination holds when it starts, so it ` +
      `takes three: deploy with ${mine}'s ${what} set to one nobody holds and ${held}'s left as it is now, then ` +
      `with ${held}'s as declared, then with ${mine}'s as declared.`
    : `To move it from one to the other, deploy once with ${mine}'s ${what} set to something else (that lands ` +
      `${held}'s change and frees it), then claim it in a second deploy.`;
  return (
    `It is held by ${held}, which this project also declares — so pinning its guid would give two defs one ` +
    `identity, and adopting cannot free it. Change the ${what} on one of the two: keep it on ${held}, or give ` +
    `${mine} another. ${move}`
  );
}

/**
 * Refuse a release the instance says it cannot land, and say who holds what.
 *
 * Rendered BEFORE the prune scope check and before the plan itself, because a
 * conflicting identity makes the rest of the preview a description of something
 * that is not going to happen — including a prune whose delete set was computed
 * against objects the archive was never going to take over.
 *
 * `--yes` is deliberately not consulted. It waives the CONFIRMATION, which is a
 * question about whether the reader wants a plan applied; this is not a question
 * at all. Same posture as {@link assertPruneStaysInScope}: an operator who has
 * typed `--yes` in CI has already said yes to everything, and not knowing is the
 * entire failure mode.
 */
function assertNoImportConflicts(
  res: XanoSdkImportResponse,
  frame: RefusalFrame,
  ctx: PlanContext = { bundle: undefined, live: undefined, tenant: false },
): void {
  if (res.conflicts.length === 0) return;
  const conflicts = conflictsForOutput(res.conflicts, ctx);
  const lines = conflicts.map((c) => conflictLine(c, frame, ctx, res.conflicts));

  // The failure document carries the list: a CI run reads stdout, and a refusal
  // that only ever reached stderr would leave a wrapper with an exit code and no list.
  throw refusalError(
    frame,
    "identityConflict",
    `Refusing to deploy into ${frame.noun}: ${res.conflicts.length} identit` +
      `${res.conflicts.length === 1 ? "y is" : "ies are"} already taken by something else.\n` +
      `${lines.join("\n")}\n\n` +
      `Nothing was written. The instance refuses these rather than inventing a name or a URL for ` +
      `them — a suffixed second object reports success and then splits your workspace in half, and ` +
      `a substituted public URL answers 404 on every route built from the one you pinned.`,
    { branch: res.branch, conflicts, canonicals: canonicalsForOutput(res.canonicals, ctx) },
  );
}

/** One object a merge would turn into a different kind of object under the same guid. */
interface KindSwap {
  guid: string;
  name: string;
  /** The kind this release sends under that guid, as the SDK names it. */
  sending: string;
  /** The kind the destination holds under it. */
  holds: string;
  /** The destination object's name, when it differs. */
  holdsName: string;
}

/** A payload's identity-bearing rows as guid → { kind, name }, kinds in the SDK's words. */
function kindsByGuid(bundle: unknown): Map<string, { kind: string; name: string; payloadKey: string; lockName: string }> {
  const out = new Map<string, { kind: string; name: string; payloadKey: string; lockName: string }>();
  const payload = (bundle as { payload?: unknown } | null | undefined)?.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return out;
  const apps = identityNamesByGuid(payload as Record<string, unknown>);
  for (const payloadKey of Object.values(REFERENCEABLE_KIND_PAYLOAD_KEYS)) {
    const rows = (payload as Record<string, unknown>)[payloadKey];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const { guid, name, type } = row as { guid?: unknown; name?: unknown; type?: unknown };
      if (typeof guid !== "string" || guid === "" || typeof name !== "string") continue;
      const kind = payloadKey === "toolset" ? (type === "agent" ? "agent" : "mcpServer") : sdkKindName(payloadKey);
      // A query's lock name is composed (`group|VERB|name`) — the key its entry is under.
      out.set(guid, { kind, name, payloadKey, lockName: lockNameForObject(payloadKey, row as { name: string }, apps) });
    }
  }
  return out;
}

/**
 * Refuse a merge that would turn an object on the destination into a
 * different KIND of object.
 *
 * The merge matches on guid. An agent and an MCP server of one name share one —
 * both derive from `toolset:<name>` — so a project's MCP server `bot` merged
 * onto a workspace where another project's AGENT `bot` lives converts the agent
 * in place, and the plan calls it "updated in place". That is not an update; it
 * is someone else's object replaced by one of a different kind, and the same
 * refusal as any identity already taken by something else (exit 2) applies. The
 * check is kind-generic, so any two kinds that ever share a guid are caught.
 *
 * Needs the target read; without one there is nothing to compare, and the write
 * path is refused for that on its own (`assertLiveWorkspaceWasRead`).
 */
function assertNoKindSwap(
  bundle: unknown,
  live: ExportedBundle | undefined,
  frame: RefusalFrame,
  /** The branch the route planned against, for the refusal document. */
  branch: string | undefined,
  /** The project's lock as on disk (this run has not written it), and where it is. */
  lock?: { file: LockFile; path: string },
): void {
  if (live === undefined || bundle === undefined) return;
  const destNoun = frame.noun;
  const held = kindsByGuid(live);
  const swaps: KindSwap[] = [];
  // Sent under a guid its name does not derive: the def pins `guid:` (a pulled
  // tree pins one on every def), so renaming it keeps the guid and the swap.
  // Split by cause, because the remedies differ: a same-name pair shares the
  // guid its name derives (rename), while a pin of ANOTHER-named object's guid
  // is resolved by removing `guid:` alone (no rename).
  const pinnedDefs: string[] = [];
  const pinnedOthers: string[] = [];
  // The same, pinned by xano.lock rather than by code: removing `guid:` changes
  // nothing there, so the remedy drops the entry instead.
  const lockPinned: string[] = [];
  let shared = 0;
  for (const [guid, sent] of kindsByGuid(bundle)) {
    const there = held.get(guid);
    if (there === undefined || there.kind === sent.kind) continue;
    swaps.push({ guid, name: sent.name, sending: sent.kind, holds: there.kind, holdsName: there.name });
    // A query's identity is composed from more than its name; it never swaps kinds.
    const key = lockKey(sent.payloadKey, sent.name);
    const pinned = sent.payloadKey !== "query" && guid !== rawDeriveGuid(key);
    if (pinned && there.name !== sent.name && lock?.file.objects[key]?.guid === guid) lockPinned.push(`${sent.kind}:${sent.name}`);
    else if (pinned && there.name !== sent.name) pinnedOthers.push(`${sent.kind} "${sent.name}"`);
    else {
      shared++;
      if (pinned) pinnedDefs.push(`${sent.kind} "${sent.name}"`);
    }
  }
  if (swaps.length === 0) return;
  const lines = swaps.map(
    (s) =>
      `  ${s.sending} "${s.name}" — ${destNoun} holds ${s.holds} "${s.holdsName}" under the same identity (${s.guid})`,
  );
  const one = swaps.length === 1;
  const oneShared = shared === 1;
  throw refusalError(
    frame,
    "kindConflict",
    `Refusing to deploy into ${destNoun}: ${swaps.length} object${one ? "" : "s"} would replace ` +
      `a different kind of object in place.\n${lines.join("\n")}\n\n` +
      `A merge matches objects by identity, so this would turn the ${swaps[0]!.holds} there into this ` +
      `project's ${swaps[0]!.sending}, and the plan would call it an update. Nothing was written.` +
      (shared === 0
        ? ""
        : `\nAn agent and an MCP server of the same name share one identity. ` +
          `Rename ${oneShared ? "the object" : "these objects"} in this project, or remove the ${oneShared ? "one" : "ones"} ` +
          `on ${destNoun} first if ${oneShared ? "it is" : "they are"} yours to remove.` +
          (pinnedDefs.length === 0
            ? ""
            : `\nA rename alone keeps the guid ${pinnedDefs.join(", ")} ${pinnedDefs.length === 1 ? "pins" : "pin"} in ` +
              `code (\`guid:\` on the def): remove that \`guid:\`, or change it, when you rename.`)) +
      (pinnedOthers.length === 0
        ? ""
        : `\n${pinnedOthers.join(", ")} ${pinnedOthers.length === 1 ? "pins" : "pin"} another object's guid in code ` +
          `(\`guid:\` on the def). Removing that \`guid:\` alone resolves it — no rename is needed.`) +
      (lockPinned.length === 0 || lock === undefined
        ? ""
        : `\n${displayPath(lock.path)} pins another object's guid to ${lockPinned.join(", ")} — the lock, not code. ` +
          `Drop ${lockPinned.length === 1 ? "that entry" : "those entries"} so the next compile derives ` +
          `${lockPinned.length === 1 ? "its" : "their"} own (and remove any \`guid:\` on the def): ` +
          `\`xanosdk lock prune --identity-only ${lockPinned.map(shellWord).join(" ")} --yes ` +
          `--lock=${shellWord(displayPath(lock.path))}\`.`),
    { branch, kindConflicts: swaps },
  );
}

/**
 * The public URL slugs the instance did NOT serve as asked.
 *
 * A slug the project PINS is never in here: the route serves a pin or refuses
 * the whole import, so a pin that could not be served arrived as a conflict
 * above. What is left is the preferences — a slug the lock minted, or one an
 * object already had — where the instance kept or substituted a value. That is
 * still worth every reader's attention, because anything built from the
 * compiled slug points somewhere else.
 *
 * An entry the archive carried no slug for is not a difference: there was
 * nothing to disagree with.
 */
function canonicalDifferences(canonicals: readonly XanoSdkCanonicalReport[]): XanoSdkCanonicalReport[] {
  return canonicals.filter(
    (c) => c.requested !== undefined && c.requested !== "" && c.served !== c.requested,
  );
}

/**
 * Warn about public URLs this project leaves for the instance to invent.
 *
 * An api group, toolset or realtime server that names no `canonical` is
 * exported with an empty one, and the import mints a token for it. That is
 * correct — a URL has to exist — but nothing in the project records WHICH one,
 * and three things follow that nobody asked for: the value differs in every
 * workspace the project is released to, a frontend cannot derive the route
 * because the project does not know it, and the object can never be compared
 * against the workspace, so it is excluded from the convergence check.
 *
 * The lock is what closes this: with one, a slug is minted LOCALLY, written
 * down, and sent — the instance honors it on create and the project owns the
 * value from then on. So this only fires when there is no lock.
 *
 * A build maintains a lock by default, so "no lock" is no longer the ordinary
 * state — it is a `--no-lock` build or a pre-exported `--bundle`, which carries
 * no entry file to find a lock beside. Both are deliberate, and for both the
 * warning is still exactly true, so it stays; only the advice changes, because
 * `--lock` is no longer how anyone acquires a lock.
 *
 * A warning rather than a refusal: releasing without a lock is a legitimate
 * thing to do, and the minted URL works. What is lost is knowing it.
 */
function warnAboutUnnamedPublicUrls(bundle: string, hasLock: boolean): readonly string[] {
  if (hasLock) return [];

  let payload: Record<string, unknown>;
  try {
    const parsed = (JSON.parse(bundle) as { payload?: unknown } | null)?.payload;
    if (parsed === null || typeof parsed !== "object") return [];
    payload = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const unnamed: string[] = [];
  for (const payloadKey of ["app", "toolset", "realtime_server"] as const) {
    const section = payload[payloadKey];
    if (!Array.isArray(section)) continue;
    for (const row of section) {
      if (row === null || typeof row !== "object") continue;
      const { name, canonical } = row as { name?: unknown; canonical?: unknown };
      if (typeof name !== "string" || name === "") continue;
      if (typeof canonical === "string" && canonical !== "") continue;
      // Named by SDK kind, as every other object this command lists.
      unnamed.push(`${sectionKind(payloadKey, row as Record<string, unknown>)}:${name}`);
    }
  }

  if (unnamed.length === 0) return [];

  // Closes on its blank line, as the loss warnings do: the plan above ends on one.
  warn(
    `${unnamed.length} public URL${unnamed.length === 1 ? "" : "s"} will be invented by the instance, ` +
      `and this project will not know ${unnamed.length === 1 ? "it" : "them"}:`,
    "canonical.invented",
    [
      ...unnamed,
      "A workspace has to serve some URL, so the instance mints one — a different one in every workspace you deploy to.",
      "Set `canonical` on the def to choose it, or build with a lock — an ordinary `xanosdk export <entry>` writes one — which records the minted value and sends it back on every later release.",
      "A deploy from `--no-lock` or from a pre-exported `--bundle` has no lock to record it in, which is why this is the only case left where the instance still decides.",
    ],
  );
  blank();
  return unnamed;
}

/** Print every slug the instance served under a different value than the archive asked for. */
function reportCanonicalDifferences(
  differences: readonly XanoSdkCanonicalReport[],
  ctx?: PlanContext,
  /** A dry run: said as what the release WOULD serve. */
  planned = false,
): void {
  if (differences.length === 0) return;
  differences = canonicalsForOutput(differences, ctx);
  // A dry run reaches here from the plan's blocks, each of which already ENDS
  // on its blank line — opening with another doubled it (E2E pass 30). The
  // real run reaches here from the import's progress lines, which do not.
  if (!planned) blank();
  const one = differences.length === 1;
  warn(
    `${differences.length} public URL${one ? "" : "s"} ` +
      `${planned ? "would not be" : one ? "is not" : "are not"} the value this project compiled:`,
    "canonical.differs",
    [
      ...differences.map(
        (c) =>
          `${c.kind} "${c.name}" — asked for "${c.requested ?? ""}", ${planned ? "would serve" : "serves"} ` +
          `"${c.served ?? ""}" (${c.outcome})`,
      ),
      "A public URL is unique across the whole instance, not per workspace, so an import keeps the one " +
        "an object already had and substitutes a token when another workspace owns the one asked for.",
      "Anything built from the compiled value answers 404. Pin these in code to make the instance serve them or refuse.",
    ],
  );
  // Ending on its blank line, as the plan's other blocks do.
  if (planned) blank();
}

/**
 * Refuse to publish a frontend built against URLs the workspace does not serve.
 *
 * `--static` uploads a build whose route paths were derived from the compiled
 * slugs. When even one of them is served under a different value, that build is
 * a set of dead links — and uploading it is worse than not uploading it, because
 * the deploy reports success and the 404s surface later as a backend problem.
 *
 * The release itself is NOT failed: the backend landed, and the slugs that
 * differ are the ones this project never pinned (see {@link canonicalDifferences}).
 * Only the publish is refused.
 */
function assertStaticMatchesServedUrls(differences: readonly XanoSdkCanonicalReport[], ctx?: PlanContext): void {
  if (differences.length === 0) return;
  differences = canonicalsForOutput(differences, ctx);
  const lines = differences.map(
    (c) => `  ${c.kind} "${c.name}" — built against "${c.requested ?? ""}", the workspace serves "${c.served ?? ""}"`,
  );
  throw new Error(
    `The workspace was updated, but \`--static\` was not published: the frontend was built against ` +
      `${differences.length} public URL${differences.length === 1 ? "" : "s"} the workspace does not serve:\n` +
      `${lines.join("\n")}\n\n` +
      `Every route derived from ${differences.length === 1 ? "that value" : "those values"} would answer 404, ` +
      `and a published build that 404s is harder to diagnose than one that was never published.\n` +
      `Pin ${differences.length === 1 ? "the slug" : "the slugs"} in code so the instance must serve ` +
      `${differences.length === 1 ? "it" : "them"} or refuse the release, or free ${differences.length === 1 ? "it" : "them"} ` +
      `on whichever workspace holds ${differences.length === 1 ? "it" : "them"} and deploy again.`,
  );
}

/** The unique indexes, by table, on every table the outgoing bundle carries seed rows for. */
function seededUniqueIndexes(bundle: string, content: readonly SeedContentFile[]): Array<{ table: string; index: string }> {
  const seeded = new Set(seedRowsByTableGuid(content).keys());
  if (seeded.size === 0) return [];
  const dbo = (JSON.parse(bundle) as { payload?: { dbo?: unknown } }).payload?.dbo;
  if (!Array.isArray(dbo)) return [];
  return dbo.flatMap((t: unknown) => {
    const table = (t ?? {}) as Record<string, unknown>;
    if (typeof table.guid !== "string" || typeof table.name !== "string" || !seeded.has(table.guid)) return [];
    const name = table.name;
    return uniqueIndexLabels(table).map((index) => ({ table: name, index }));
  });
}

/**
 * A refusal at APPLY time: the instance re-ran its checks inside the write and
 * something had changed since the preview.
 *
 * The distinction this exists to make is that nothing was written. The failure
 * next door — {@link xanosdkImport} throwing anything else — may have written part of
 * an archive, which is why it prints the restore-from-backup instruction. Doing
 * that here would talk someone into rolling a workspace back to a snapshot to
 * undo an import that never happened, and a restore is not free: it swaps the
 * live branch under whatever traffic the workspace is serving.
 *
 * A backup branch taken moments ago is therefore named as REDUNDANT rather than
 * as a rollback target — it exists, it protected nothing, and the reader should
 * know they can delete it.
 */
function reportApplyRefusal(
  err: XanoSdkImportRefusal,
  frame: RefusalFrame,
  /** The branch the preview planned against — the one the refused import was headed for. */
  branch: string | undefined,
  backupLabel: string | undefined,
  /** This run as a paste-ready command, for the in-progress refusal: running it again is the remedy. */
  rerun?: { command: string; note: string },
  /** The index changes the plan disclosed — what a uniqueness refusal, which names no table, is about. */
  indexChanges: readonly IndexChange[] = [],
  /** The unique indexes on tables this run writes seed rows into, which those rows can collide on. */
  seededUnique: ReadonlyArray<{ table: string; index: string }> = [],
): never {
  if (backupLabel !== undefined) {
    blank();
    detail(`The pre-deploy snapshot on branch "${backupLabel}" is redundant — nothing was written for it to protect.`);
    detail(`Delete it with \`xanosdk workspace branch delete ${backupLabel}${pipedYes()}${contextFlags()}\`.`);
  }

  const conflicts =
    err.conflicts.length > 0 ? `\n${err.conflicts.map((c) => conflictLine(c, frame)).join("\n")}\n` : "";

  // The rows already there break a unique index the landing adds — the plan
  // named the index, and nothing changed in between. Nothing was written: the
  // instance says so, and an exit 2 like the merge's (E2E pass 36).
  if (err.code === XANOSDK_IMPORT_UNIQUENESS_CODE) {
    const uniqueAdds = indexChanges.filter((c) => c.action === "add" && c.unique);
    // The refusal names no table, so the message names what it can be about:
    // a unique index this deploy adds over the rows already there, or seed
    // rows this deploy writes colliding with live rows on an index both share.
    const added = new Set(uniqueAdds.map((c) => `${c.table}\0${c.index}`));
    const seeded = seededUnique.filter((c) => !added.has(`${c.table}\0${c.index}`));
    const lines = (list: ReadonlyArray<{ table: string; index: string }>): string =>
      list.length === 0 ? "" : `${list.map((c) => `  table ${c.table}: ${c.index}`).join("\n")}\n`;
    const why =
      uniqueAdds.length > 0 && seeded.length === 0
        ? `the rows already there break a unique index this deploy adds`
        : uniqueAdds.length === 0 && seeded.length > 0
          ? `the seed rows this deploy writes collide with rows already there on a unique index`
          : uniqueAdds.length > 0
            ? `the rows already there break a unique index this deploy adds, or the seed rows it writes collide with them`
            : `rows break a unique index`;
    const remedy =
      uniqueAdds.length > 0 && seeded.length === 0
        ? `Remove the duplicate rows or the index, then deploy again.`
        : seeded.length > 0
          ? (uniqueAdds.length > 0 ? `Remove the duplicate rows or the index you add, or ` : ``) +
            `${uniqueAdds.length > 0 ? "change" : "Change"} the colliding seed values, or delete or merge the live rows they collide with, then deploy again.`
          : `Remove the duplicate rows, then deploy again.`;
    throw refusalError(
      frame,
      "uniqueViolation",
      `${frame.noun.charAt(0).toUpperCase()}${frame.noun.slice(1)} was NOT changed: ${why}, so the instance refused ` +
        `the import. Nothing was written.\n` +
        lines(uniqueAdds) +
        (seeded.length > 0 ? `${uniqueAdds.length > 0 ? "Seeded tables' unique indexes:\n" : ""}${lines(seeded)}` : "") +
        remedy,
      {
        branch,
        serverCode: err.code,
        indexes: uniqueAdds.map((c) => ({ table: c.table, index: c.index })),
        ...(seeded.length > 0 ? { seededIndexes: seeded.map((c) => ({ table: c.table, index: c.index })) } : {}),
      },
    );
  }

  // A taken identity found at apply time is the same conflict the preview
  // refuses (`SDK_IDENTITY_CONFLICT`, exit 2); any other refusal is its own.
  const conflict = err.code === XANOSDK_IMPORT_CONFLICT_CODE;
  throw refusalError(
    frame,
    "importRefused",
    `${frame.noun.charAt(0).toUpperCase()}${frame.noun.slice(1)} was NOT changed: the instance refused the import when it ran it.\n` +
      `${err.reason}\n${conflicts}` +
      (err.retryable
        ? `\nIt was busy with another import. Nothing here has to change — ` +
          (rerun === undefined ? "deploy again in a moment." : `run \`${rerun.command}\` again in a moment.${rerun.note}`)
        : `\nThe preview passed and this did not, so something changed on ${frame.noun} in between. ` +
          `Deploy again once the identities above are free.`),
    {
      branch,
      serverCode: err.code,
      conflicts: conflictsForOutput(err.conflicts),
      canonicals: canonicalsForOutput(err.canonicals),
      // In progress is transient: exit 8, as a failure to reach the instance is.
      ...(conflict ? { code: REFUSAL_CODES.identityConflict } : { exitCode: err.retryable ? 8 : 1 }),
    },
  );
}

/**
 * Say which workspace settings a branch landing did not apply (see
 * `withholdWorkspaceSettings`), beside the other things the plan cannot say.
 * Silent when the project's settings already match: nothing was held back.
 */
function reportWithheldSettings(branch: string, withheld: readonly string[]): void {
  if (withheld.length === 0) return;
  warn(
    `${withheld.length} workspace setting${withheld.length === 1 ? "" : "s"} will NOT be applied from ` +
      `branch "${branch}": ${withheld.join(", ")}`,
    "branch.settings-withheld",
    [
      "Workspace settings are shared by every branch, so a branch landing leaves them as the workspace has them.",
      "To apply them, deploy without `--branch` — onto the live branch, which after `--set-live` is the one you staged.",
    ],
  );
  blank();
}

/**
 * Put a live branch back after a replace, when the replace left none.
 *
 * The replace clears every branch row and the import brings back the one it
 * landed on — without its live flag, so the runtime serves nothing and every
 * later `promote --expect-live` or `publish --branch` refuses. With nothing
 * live there is no branch to cut over FROM, and the replace itself was already
 * confirmed as destructive, so this is not the cutover `set-live` asks about:
 * it only ever sets the branch the instance says it landed on, and only while
 * no row — addressable or not — reports as live. Any failure warns with the
 * repair command rather than throwing, because the import has succeeded.
 *
 * Returns the label it set live, or undefined when it set nothing.
 */
async function restoreLiveAfterReplace(
  auth: ResolvedAuth,
  target: { baseUrl: string; workspaceId: number },
  landed: string,
): Promise<string | undefined> {
  const repair = (): void => {
    warn(
      `No branch reports as live after the replace, so the workspace serves nothing.`,
      "branch.none-live",
      [`Set it with \`xanosdk workspace branch set-live ${landed} --yes${contextFlags()}\`.`],
    );
  };
  // A failed read says nothing about the branches, so it must not claim none
  // is live — only that it could not look.
  let listing;
  try {
    listing = await listBranchListing(auth, target);
  } catch {
    warn(
      `Could not verify whether a branch is live after the replace.`,
      "branch.live-unverified",
      [
        `If none is, the workspace serves nothing — set it with \`xanosdk workspace branch set-live ${landed} --yes${contextFlags()}\`.`,
      ],
    );
    return undefined;
  }
  try {
    if (liveBranchLabel(listing.branches) !== undefined || listing.unaddressable.some((b) => b.live)) {
      return undefined;
    }
    if (!listing.branches.some((b) => b.label === landed)) {
      repair();
      return undefined;
    }
    await setLiveBranch(auth, { ...target, label: landed });
  } catch {
    repair();
    return undefined;
  }
  success(`Branch "${landed}" is live again — a replace clears the live flag.`);
  return landed;
}

function reportBranchCaveats(
  branch: string,
  setLive: boolean,
  changed: number | undefined,
  /** The non-unique index changes the deploy let through, which land on the shared tables too. */
  indexChanges: readonly string[] = [],
  /** ` --yes` for the printed set-live where this run was not asked ({@link pipedYes}). */
  yes = "",
): void {
  blank();
  if (changed === undefined) {
    warn(
      "The live workspace could not be read, so whether this changed shared schema is UNKNOWN.",
      "branch.shared-schema-unknown",
      ["Tables and microservices are shared by every branch — a change there reached production."],
    );
  } else if (changed > 0) {
    warn(
      `${changed} shared-schema change${changed === 1 ? " was" : "s were"} applied to the LIVE workspace.`,
      "branch.shared-schema-changed",
      ["Tables and microservices are shared by every branch — only your logic is staged."],
    );
  } else if (indexChanges.length > 0) {
    warn(
      `Only logic was staged on "${branch}", but ${indexChanges.length === 1 ? "an index change was" : `${indexChanges.length} index changes were`} ` +
        `applied to the tables every branch shares, live included:`,
      "branch.shared-schema-changed",
      [...indexChanges, "A non-unique index changes how rows are found, not what they hold."],
    );
  } else {
    detail(`Only logic was staged on "${branch}" — this deploy changed no shared schema.`);
  }
  // Both pointers, in the order a reader would act in: look at what staged,
  // then serve it. The commands that CREATE a staged branch name the read, and
  // this is the other one besides `promote` — a reader who has just staged
  // should not have to already know the read exists in order to find it.
  detail(`See what staged with \`xanosdk workspace export --branch ${branch}${contextFlags()}\`.`);
  if (!setLive) {
    detail(`Nothing serves "${branch}" yet. Promote it with \`xanosdk workspace branch set-live ${branch}${yes}${contextFlags()}\`.`);
  }
}

/**
 * Where a client-side merge writes.
 *
 * Was implicit — the credential's instance and workspace, read at ten call
 * sites. A merge can now target a tenant too, and `base` may carry a path
 * prefix, so it is resolved once and threaded rather than re-derived.
 */
/**
 * Exactly a {@link WriteTarget}: base, workspace, and the optional label a
 * destination that is not the credential's own workspace names itself with.
 *
 * Declared as an extension rather than a second interface of the same shape, so
 * a field added to what a write destination IS cannot land on one of the two
 * and be missed on the other — the two are threaded along the same call path
 * and rendered by the same emitter.
 */
export type MergeDest = WriteTarget & {
  /**
   * Which kind of destination this is, when the caller knows.
   *
   * Branches are a WORKSPACE feature: a tenant has none (see the refusal in
   * `deploy-command.ts` over `--branch`/`--set-live`/`--backup-branch`), and an
   * ephemeral never reaches this command at all. Omitted means the credential's
   * own workspace, which has them.
   */
  readonly kind?: "workspace" | "tenant";
  /** A tenant destination's actual type: an ephemeral is addressed as a tenant too. */
  readonly type?: "ephemeral" | "tenant";
  /** A tenant destination's bare name, for the machine payload (`label` is prose). */
  readonly name?: string;
  /** A tenant destination's display name, when its record carries one other than its name. */
  readonly display?: string;
};

export async function runReleaseCommand(
  args: ParsedArgs,
  dest?: MergeDest,
  opts: {
    /**
     * The credential the caller already resolved — `deploy --to` resolves one
     * to find the destination. Passed through so it is resolved ONCE: resolving
     * it again printed the profile notice twice on every run.
     */
    auth?: ResolvedAuth;
    /**
     * Run once the destination holds this release — written, or already
     * converged — and never on a dry run, a declined prompt or a refusal.
     * `deploy --to` says here what the landing did not store, so the note
     * never precedes a run that is then refused. Handed the bundle landed.
     */
    afterLanding?: (bundle: unknown) => void;
    /** How to see the destination's state after a merge whose outcome is unknown — `deploy --to`'s own `--dry-run`. */
    stateCheck?: string;
  } = {},
): Promise<void> {
  const req = resolveRequest(args);
  // Every later read of the flag sees the label `resolveRequest` validated and
  // trimmed, so the refusal payloads and reports name what was actually sent.
  if (req.mode === "merge" && req.branch !== undefined) args = { ...args, branch: req.branch };

  // Cheapest refusal first: a bare invocation is a usage problem, and
  // answering it with "not signed in" would answer the wrong question.
  assertBundleInput(args, { command: "deploy" });
  assertBundleFile(args, { command: "deploy" });

  // Then auth, before the compile: `getAccessToken` reads (and at most
  // refreshes) a cached credential, while `loadBundleText` may run a whole
  // compile and write the lockfile. Signed out, compiling first would make you
  // pay for the compile before being told to log in; this way it lands in a
  // second.
  // Nothing reaches the target workspace until the plan/import calls below, so
  // the reorder costs no safety.
  const auth = opts.auth ?? (await getAccessToken(args));
  // `withSeed` resolves the tables' declared rows into signed `content/` entries.
  // Asked for under `--seed`, and ALSO under `--replace`. Not under a plain
  // merge: the server is not told to write rows there, so carrying them would
  // upload production seed data nobody asked to send. Under `--seed` it must be
  // asked for, or `--seed` would set `records=true` on the wire and then ship an
  // archive with no rows in it — a silent no-op.
  //
  // Replace is the asymmetric case and the reason this is not simply
  // `req.records`. A replace empties every table, and the wire flag that asks
  // for rows is rejected outright on a replace — so if the archive carries no
  // content, the project's seed rows are gone and nothing can put them back.
  // The archive's content files ARE loaded on a replace regardless of that flag,
  // so packing them is both necessary and sufficient: pack the content, never
  // send the flag (`resolveRequest` returns no `records` for replace, which is
  // what keeps it off the wire).
  const withSeed = req.mode === "replace" || req.records === true;
  // A dry run reads the lock and writes nothing — not even `xano.lock`, whose
  // "commit it" notice would contradict the "nothing was written" the preview
  // ends on. The same rule `reset-tables` and the `release create` comparison
  // follow.
  //
  // A real run DEFERS the lock write: every refusal below — the prune scope, a
  // taken identity, an unreadable target, a declined confirmation — must leave
  // `xano.lock` as it was, and the lock still lands before the identities it
  // records are shipped. `commitLock` runs once, just before the first write.
  // Toolchain modules load BEFORE the compile, which loads the user's entry and
  // unregisters the TypeScript loader behind it — the same order every other
  // deploy arm keeps. Their `onBundle` checks fire below, before any write.
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  const toolchain = await discoverToolchainPlugins(process.cwd(), { frozen: args.frozenLock === true });
  const loaded = await loadBundleText(
    args.dryRun ? { ...args, lockReadOnly: true } : args,
    { command: "deploy" },
    // A `--prune` preview says its orphan warning once the prune is planned,
    // without the entries that prune deletes — the real run leaves them out at
    // its lock commit, and the preview told the reader to `lock prune` by hand
    // what the prune was about to drop (E2E pass 25).
    { withSeed, deferLockWrite: !args.dryRun, deferOrphanWarning: args.dryRun === true && args.prune === true },
  );
  const { source, content, nonPublicSeedValues } = loaded;
  let bundle = loaded.bundle;
  let lockCommitted = false;
  // Set once the destination resolves: an ephemeral reached as `tenant:<handle>`
  // is named as one in a new lock's adopt pointer.
  let resolvedTo: string | undefined;
  // Set once the plan is read: it only creates and meets no conflict, so the
  // destination held nothing to adopt and a new lock's adopt pointer is noise.
  let nothingToAdopt = false;
  const commitLock = (opts?: { pruned?: ReadonlySet<string> }): void => {
    if (lockCommitted) return;
    lockCommitted = true;
    loaded.commitLock?.({
      ...opts,
      ...(resolvedTo === undefined ? {} : { to: resolvedTo }),
      ...(nothingToAdopt ? { nothingToAdopt } : {}),
    });
  };
  // The backend secret files the compile just read, kept out of git as a plain
  // `deploy` keeps them. Not on a dry run, which writes nothing here either.
  if (!args.dryRun && args.file !== undefined) {
    const { ignoreBackendSecretFilesRead } = await import("./deploy-command.js");
    await ignoreBackendSecretFilesRead(args);
  }

  // Before anything is UPLOADED. `deploy` has always run this scan and `release`
  // never did, which only became reachable once release started carrying seed
  // rows: a value from a column the schema marks non-public must not be baked
  // into a public static bundle.
  if (args.static !== undefined) {
    const { assertNoSeedLeaks } = await import("./deploy-command.js");
    await assertNoSeedLeaks(args.static, nonPublicSeedValues);
  }

  // The derived-artifact hooks: after the compile, before the destination is
  // read or written, so a check that does not pass refuses this merge exactly
  // as it refuses every other deploy. A `--dry-run` writes nothing, so its
  // hooks run as a verification (`frozen`): they compare and report.
  {
    const { runBundleHooks } = await import("./toolchain-hooks.js");
    const { readVersion } = await import("./cli.js");
    await runBundleHooks(
      toolchain.loaded,
      {
        bundle: loaded.bundleObject ?? (JSON.parse(bundle) as Bundle),
        // Absent on the `--bundle <path>` branch: the project did not compile it.
        entry: args.file,
        cwd: process.cwd(),
        command: "deploy",
        frozen: args.frozenLock === true || args.dryRun === true,
        sdkVersion: readVersion(),
      },
      args.dryRun === true ? "" : "; nothing was deployed",
    );
  }

  // The workspace the CREDENTIAL is bound to — no override. A release can only
  // ever touch that one workspace.
  //
  // Read straight off the resolved credential rather than re-derived from
  // /api:meta/auth/me: every arm already pins it (`login` at consent, a `token`
  // record explicitly, the refresh-grant arm by resolving it once), and the
  // re-derivation only works for an OAuth token. A meta API credential has no
  // scoped guid and no membership list, so resolving it there failed with
  // "0 membership workspaces" — on the one command that most needs to know
  // exactly which workspace it is about to write to.
  // The destination, resolved once. Every route below APPENDS to `dest.base`
  // rather than resolving against it — a tenant without its own domain is served
  // under a path prefix that `new URL(path, base)` silently discards.
  // Defaults to the workspace the credential is bound to, which is what this
  // command has always written to and what a caller passing nothing means.
  const { base: destBase, workspaceId, label: destLabel } = dest ?? {
    base: auth.instance,
    workspaceId: auth.workspaceId,
  };
  const resolvedDest: MergeDest = { base: destBase, workspaceId, label: destLabel };
  // How the refusals and prompts below name the destination. A tenant's
  // internal workspace is always #1, which names nothing the reader chose.
  const destTenantLabel = dest?.kind === "tenant" ? destLabel : undefined;
  const destNoun = destTenantLabel ?? `workspace #${workspaceId}`;
  // The label with the display name beside the name: it is what people call
  // the tenant. A caller that built its label with it already (deploy's) is
  // left alone.
  const destShownLabel =
    destLabel !== undefined &&
    dest?.display !== undefined &&
    dest.display !== dest.name &&
    !destLabel.includes(`(${JSON.stringify(dest.display)})`)
      ? `${destLabel} (${JSON.stringify(dest.display)})`
      : destLabel;
  // Every refusal document's shared half, and how its prose names the target:
  // a tenant as the headline names it, never as its internal `workspace #1`.
  const refusalFrame: RefusalFrame = {
    workspaceId,
    noun: destTenantLabel !== undefined ? (destShownLabel ?? destTenantLabel) : destNoun,
    tenant: dest?.kind === "tenant",
    destination: destinationPayload(resolvedDest, dest, auth),
    mode: req.mode,
    prune: req.prune === true,
    dryRun: args.dryRun === true,
    adopt: adoptRemedy(args, dest),
    lockRename: lockRenameRemedy(args),
    pinnedInCode: codePinnedGuid(args),
  };
  // Where the landing record keeps this destination (see `lock/landed.ts`): a
  // tenant by its name, a workspace by its id — under the credential's
  // instance either way. A tenant the caller could not name has no key, so it
  // owns nothing a prune could delete and records nothing.
  const landingDest: LandingDestination | undefined =
    dest?.kind === "tenant"
      ? dest.name !== undefined && dest.name !== ""
        ? { kind: dest.type === "ephemeral" ? "ephemeral" : "tenant", name: dest.name }
        : undefined
      : { kind: "workspace", workspaceId };
  const landingKey = landingDest === undefined ? undefined : destinationKey(auth.instance, landingDest);

  // A tenant's workspace carries the name the platform gave it, not one this
  // project chose — `workspace("…")` names the project's own workspace, and a
  // merge onto a tenant that renamed it would be a change nobody asked for and
  // no author can "fix" by editing code. So the archive is sent under the
  // tenant's current name, read before it is encoded, and the rename warning
  // never fires there. The read is reused below as the loss report's input:
  // a tenant has no branches, so it is the same read that would follow.
  let tenantLive: ExportedBundle | undefined;
  let tenantRead: LiveRead | undefined;
  if (dest?.kind === "tenant") {
    tenantRead = await readLive(auth, { base: destBase, workspaceId, label: destLabel });
    tenantLive = tenantRead.live;
    bundle = keepWorkspaceName(bundle, tenantLive);
  }
  // A BRANCH landing leaves the workspace's own settings alone — they are shared
  // by every branch, so writing them from a branch would change production under
  // a flag that says it does not (see `withholdWorkspaceSettings`). Read before
  // the archive is encoded, and reused below as the loss report's input: a new
  // branch starts as a clone of live, so live is what that read would ask for.
  let branchLive: { read: ExportedBundle | undefined; failure?: unknown } | undefined;
  let withheldSettings: string[] = [];
  if (req.branch !== undefined && dest?.kind !== "tenant") {
    const branchRead = await readLive(auth, resolvedDest);
    branchLive = { read: branchRead.live, failure: branchRead.failure };
    const withheld = withholdWorkspaceSettings(bundle, branchLive.read);
    bundle = withheld.bundle;
    withheldSettings = withheld.withheld;
  }
  const archive = encodeWorkspaceArchive(bundle, [...content, ...loaded.files]);

  // `--seed` with nothing to seed is a no-op the user believes worked. Say so
  // rather than reporting success over an empty write.
  if (req.records === true && content.length === 0) {
    warn("`--seed` was passed, but no table in this project declares seed rows — no rows will be written.", "seed.none-declared");
  }

  const target = {
    baseUrl: destBase,
    archive,
    workspaceId,
    ...req,
    ...(opts.stateCheck !== undefined ? { stateCheck: opts.stateCheck } : {}),
  };

  // The branch inventory answers three questions and is read once for all of
  // them: is the requested label free, which branch is live (the source a
  // `--backup-branch` clones, and the rollback target named in its report), and
  // — under `--replace` — which branches the clear is about to destroy.
  //
  // `--replace` must not skip this read: it is the mode with the largest branch
  // blast radius, and without the list the command cannot name what it is
  // deleting. A failed
  // read is not evidence that there are no branches, so it is carried as a
  // failure rather than flattened to `[]`.
  // Branches belong to a workspace. A tenant has none — the same reason
  // `--branch`, `--set-live` and `--backup-branch` are refused for one — so
  // reading the inventory there would ask a question the destination cannot
  // answer, and refusing on the failed read would make a tenant replace
  // impossible without a flag about branches it does not have.
  const destHasBranches = dest?.kind !== "tenant";
  let branchReadError: unknown;
  let listing: BranchListing = { branches: [], unaddressable: [] };
  if (
    req.branch !== undefined ||
    args.backupBranch !== undefined ||
    (req.mode === "replace" && destHasBranches)
  ) {
    try {
      // The full listing rather than `listBranches`, which keeps only the rows
      // that can be NAMED. A replace destroys the unaddressable ones too, and
      // they are the ones nobody can see coming.
      listing = await listBranchListing(auth, { baseUrl: destBase, workspaceId });
    } catch (err) {
      if (req.mode !== "replace") throw err;
      branchReadError = err;
    }
  }
  const branches = listing.branches;

  // Before the plan and before any write, including a dry run: a preview that
  // did not refuse would imply the apply behind it would go through.
  if (destHasBranches) {
    assertBranchDeletionAcknowledged(args, req, listing, branchReadError, workspaceId);
  }
  // Before the plan: a taken label is a refusal that costs one list call, and
  // paying for a dry run first would only delay it.
  if (req.branch !== undefined) assertBranchAbsent(branches, req.branch);
  // The snapshot's label, checked here on a dry run as on a real one: a preview
  // that passed would promise a backup the real run then refuses.
  const plannedBackup = args.backupBranch !== undefined && destHasBranches ? plannedBackupLabel(args.backupBranch, branches) : undefined;

  // A `--static-host` other than `default`, checked while nothing is written:
  // a replace deletes it (the publish re-creates only `default`), and a merge
  // needs it to exist already. Found out after the import, the replace had
  // already taken the old frontend down for a publish that could not land.
  if (args.static !== undefined && !args.dryRun) {
    refuseStaticHostAReplaceClears(args, req.mode === "replace", dest === undefined ? "release" : "deploy");
    await assertStaticHostExists(args, auth, { baseUrl: destBase, workspaceId });
  }

  // The write-target disclosure, inside the step line rather than on a detail
  // line beneath it: this step spends its width on a source path and a mode,
  // which leaves room, and one line that reads as a sentence beats two that have
  // to be correlated. It names the instance, not only the workspace number —
  // the same number exists in every account someone is logged into.
  // `describeWriteTarget` is the one renderer, so this and
  // `deploy`'s detail line can never describe the same backend two ways.
  step(
    `${args.dryRun ? "Planning" : "Deploying"} ${source} → ${describeWriteTarget({
      base: destBase,
      // A tenant by the workspace it lives under, as its `destination` names
      // it — its own internal workspace is always #1 (E2E pass 36).
      workspaceId: dest?.kind === "tenant" ? auth.workspaceId : workspaceId,
      label: destShownLabel,
    })}` +
      (req.branch !== undefined ? ` branch "${req.branch}"` : "") +
      (req.mode === "replace" ? " (full replace)" : " (merge)"),
  );

  // ALWAYS preview a merge, destructive or not. An unflagged merge cannot delete
  // or truncate, but it can still create a duplicate of every object in the
  // workspace — that is what promoting into a workspace this project has never
  // released to does, and only the plan reveals it. Gating the preview on
  // destructiveness made the one warning that case needs unreachable from the
  // one invocation that reaches it.
  //
  // `--yes` waives the PROMPT, never the preview: the prompt is only meaningful
  // because the plan was printed above it, and a CI run still deserves the record.
  // The public URL slugs this project PINS. They ride the import request, so the
  // instance serves them or refuses.
  //
  // `args.file` is an entry file this run just compiled; `--bundle` is a file
  // someone exported earlier. Only the first can be sure an unlocked slug came
  // from the code.
  const pinned = codePinnedCanonicals(
    bundle,
    releaseCanonicalLock(args, loaded.classifiedLock),
    args.file !== undefined,
  );

  // The preview is the same call the apply will be, with `dry_run` flipped —
  // which is what makes it a truthful preview rather than a second
  // implementation of the same decision.
  //
  // The branch the archive lands on needs no separate check here: the route
  // echoes the branch it planned against, and `xanosdkImport` has already
  // refused any disagreement with the request by the time this returns.
  const preview = await xanosdkImport(auth, {
    ...target,
    dryRun: true,
    pinned: pinned.map((p) => p.guid).filter((g): g is string => g !== undefined),
  }).catch(async (err: unknown) => {
    // Another import running on the instance: transient, nothing written — exit 8 and the same command.
    if (err instanceof XanoSdkImportRefusal && err.retryable) {
      const { importInProgressError } = await import("./keep-data-merge.js");
      const { retryCommand, withheldNote } = await import("./retry-command.js");
      const retry = retryCommand(args);
      throw importInProgressError(
        describeWriteTarget({ base: destBase, workspaceId, label: destShownLabel }),
        { command: retry.command, note: withheldNote(retry.withheld) },
        err,
      );
    }
    // No answer at all: nothing was written — the unreachable contract, exit 8
    // with this command as the rerun.
    if (isUnansweredLookup(err)) {
      const head = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim().replace(/[.:]$/, "");
      const failed = new LookupFailedError(
        `${head}. ${unansweredCause(err)} — nothing was written`,
        "unreachable",
        dest?.kind === "tenant" ? (dest.type === "ephemeral" ? "ephemeral" : "tenant") : "workspace",
      );
      failed.cause = err;
      throw failed;
    }
    throw withSignatureHint(err, args.bundle);
  });
  const destIsTenant = dest?.kind === "tenant";
  // What the plan's prose calls the target — its ACTUAL type, so an ephemeral
  // reached as `tenant:<name>` is not "the tenant" under a headline naming it.
  const destKindNoun: TargetNoun = destIsTenant ? (dest?.type ?? "tenant") : "workspace";
  if (destKindNoun === "ephemeral" && args.to?.startsWith("tenant:") === true) {
    resolvedTo = `ephemeral:${args.to.slice("tenant:".length)}`;
  }
  // How many other branches a replace would clear, when the inventory was read.
  const otherBranches =
    req.mode === "replace" && destHasBranches && branchReadError === undefined
      ? doomedBranches(listing).total
      : undefined;
  const plan = planFromRoute(preview, destIsTenant, otherBranches);
  // The settings row is an `update` whenever the settings differ, on a first
  // landing too: it says nothing about adoptable objects (E2E pass 29).
  nothingToAdopt =
    preview.conflicts.length === 0 &&
    plan.operations.every((op) => op.action === "create" || IDENTITY_EXEMPT_TYPES.has(op.type));

  // Before the plan is rendered and before the prune scope is checked: a taken
  // identity makes the rest of the preview a description of an import that is
  // not going to happen.
  // With a conflict the destination itself holds, whether adopting it would
  // change anything decides whether that remedy is offered — read here, only
  // on the way to a refusal (a tenant's read is already in hand).
  // A name an agent asks for may be held by an MCP server (one name space):
  // the target read names the holder's kind, so the remedy does not offer the
  // guid pin that would convert it. Best effort — without it, the line is as before.
  const heldHere = preview.conflicts.filter((c) => ownerIsDestination(c.owner, refusalFrame));
  const toolsetHeld = heldHere.some((c) => c.kind === "toolset" || c.kind === "agent" || c.kind === "mcpServer");
  const conflictLive =
    heldHere.length === 0
      ? undefined
      : dest?.kind === "tenant"
        ? tenantLive
        : refusalFrame.adopt !== undefined
          ? await readLiveWorkspace(auth, resolvedDest)
          : toolsetHeld
            ? await readLiveWorkspace(auth, resolvedDest).catch(() => undefined)
            : undefined;
  const conflictFrame: RefusalFrame =
    refusalFrame.adopt !== undefined && heldHere.length > 0
      ? { ...refusalFrame, adoptAddsNothing: adoptionAddsNothing(args, conflictLive) }
      : refusalFrame;
  assertNoImportConflicts(preview, conflictFrame, {
    bundle: parsedOrUndefined(bundle),
    live: conflictLive,
    tenant: destIsTenant,
    noun: destKindNoun,
  });
  // Read the target once: the plan's prose needs to know whether it is empty,
  // and the loss report needs its schemas and env. Two reads for one question
  // each would double the cost of both.
  //
  // Scoped to the branch the archive will land on — which is the live branch
  // whenever the target branch does not exist yet, i.e. always today. See
  // `collisionBranch`.
  const scopeBranch = collisionBranch(branches, req.branch);
  const liveRead: LiveRead =
    dest?.kind === "tenant"
      ? (tenantRead ?? { live: undefined })
      : branchLive !== undefined && scopeBranch === undefined
        ? { live: branchLive.read, failure: branchLive.failure }
        : await readLive(auth, resolvedDest, scopeBranch);
  const live = liveRead.live;
  const liveKind: SourceKind =
    dest?.kind === "tenant" ? (dest.type === "ephemeral" ? "ephemeral" : "tenant") : "workspace";
  // A merge matches on guid, and an agent and an MCP server of one name share
  // one (both derive from `toolset:<name>`) — so merging one onto the other
  // converts it in place, and the plan calls that a routine update. Refused
  // like any other identity already taken by something else. Before the plan,
  // and on a dry run too: a preview that did not refuse would promise an apply.
  if (req.mode === "merge") {
    const lockPath = args.lockPath ?? (args.file !== undefined ? resolveLockPath(args, args.file) : undefined);
    const lockFile = releaseCanonicalLock(args);
    assertNoKindSwap(parsedOrUndefined(bundle), live, refusalFrame, preview.branch,
      lockPath !== undefined && lockFile !== undefined ? { file: lockFile, path: lockPath } : undefined);
  }
  // Answered BEFORE the plan is rendered: a converged release must not print
  // "update: 6" and then not send them. The server counts identities that
  // matched, which for an unchanged project is every object it has.
  const converged = await convergedWithLive(live, req, bundle, pinned);
  // The plan as it is SHOWN: objects named by SDK kind, queries by verb and
  // group, and the route's sentences in the SDK's words (see
  // `plan-presentation.ts`). Read against the bundle and the target, so a
  // delete is named from the object that is there.
  // The replace's ROW LOSS sentence names what comes back: a compiled entry is
  // "this project", a `--bundle` or fetched backend is not, and an archive with
  // no rows brings every table back empty.
  const planContext: PlanContext = {
    bundle: parsedOrUndefined(bundle),
    live,
    tenant: destIsTenant,
    noun: destKindNoun,
    rows: { source: args.file !== undefined ? "project" : "bundle", carried: plan.hasRecords },
    ...(req.prune === true ? { provenance: pruneProvenance(args, landingKey, live) } : {}),
  };
  // A plan that is not converged as a whole can still hold objects that are:
  // each is shown as `unchanged`, not as the route's matched-identity `update`.
  const presented = markUnchanged(
    presentOperations(plan.operations, planContext),
    converged ? undefined : await unchangedWithLive(live, req, bundle, pinned),
    destKindNoun,
  );
  // A `--seed` merge writes each row by its id: which live rows it overwrites
  // is read now, so the plan and the confirmation name them. Not under
  // `--reset-data`, which empties the tables first.
  const seeded =
    req.mode === "merge" && req.records === true && req.truncate !== true && plan.hasRecords
      ? await seedWrites(auth, target.archive, parsedOrUndefined(bundle), { base: destBase, workspaceId })
      : [];
  renderPlan(
    plan,
    req,
    workspaceId,
    targetIsEmpty(live),
    converged,
    listing,
    branchReadError !== undefined,
    destTenantLabel,
    presented,
    destKindNoun,
    sameNamedCreates(plan, presented, live),
    envCarriedBy(parsedOrUndefined(bundle), live),
    args.dryRun === true,
    tableRenames(parsedOrUndefined(bundle), live),
    seeded,
  );

  // The same facts the plan just rendered, in the shape a tool reads them.
  const branchDeletion = branchDeletionReport(
    req,
    listing,
    branchReadError !== undefined,
    destHasBranches,
  );

  // What the server's object-granularity plan cannot say. Runs before the prune
  // refusal so a user who is about to be refused still sees the whole picture.
  // An ephemeral's record knows its tables' column storage (see `LandedEntry.columns`).
  const priorStored =
    landingDest?.kind === "ephemeral" && landingKey !== undefined ? storedColumnsOf(ephemeralLandedOn(process.cwd(), landingKey)) : undefined;
  const losses = await warnAboutLiveLosses(
    live,
    req,
    bundle,
    dest?.kind === "tenant" ? `tenant:${dest.name ?? "<name>"}` : "workspace",
    args.bundle !== undefined,
    await replaceCommandHint(args),
    destKindNoun,
    liveRead.failure,
    priorStored,
  );
  if (req.branch !== undefined) reportWithheldSettings(req.branch, withheldSettings);

  // Beside the other things the server's plan cannot say. Reported for a dry
  // run too — it is a fact about the project, not about this particular
  // instance, and the preview is where someone is deciding whether to go ahead.
  const unnamedPublicUrls = warnAboutUnnamedPublicUrls(
    bundle,
    releaseCanonicalLock(args, loaded.classifiedLock) !== undefined,
  );

  // The gate that makes `--branch` honest: tables and microservices are shared by
  // every branch, so these changes reach production whichever branch is targeted.
  // After the plan is rendered, so a refused user has seen the whole picture.
  const sharedChanges =
    req.branch === undefined
      ? ([] as readonly SharedSchemaChange[])
      : assertSharedSchemaAcknowledged(args, live, bundle, req.branch);

  // `--prune` is scoped HERE, because it cannot be scoped on the wire. Refusing
  // before the import is the whole protection: the plan and the execution match
  // exactly, so a collateral delete previewed is a collateral delete performed.
  const pruned =
    req.prune === true
      ? assertPruneStaysInScope(args, plan, { key: landingKey, noun: destNoun }, planContext, presented, {
          frame: refusalFrame,
          branch: preview.branch,
        })
      : {};
  loaded.warnLockOrphans?.(new Set(Object.keys(pruned)));
  // A table renamed in code the lock was not told about: the merge would
  // create the new name empty beside the old one (or, under `--prune`, drop
  // the old one with its rows) — refused as `--keep-data` refuses it.
  if (req.mode === "merge") {
    const pending = await unrecordedTableRenames(args, bundle, live, plan, loaded.classifiedLock);
    if (pending.length > 0) throw await pendingRenameRefusal(refusalFrame, pending, req.prune === true, preview.branch);
  }

  // The same verdict the real run reaches below (see `upToDate` there).
  const dryRunUpToDate = req.branch === undefined && (plan.operations.length === 0 || converged);

  // A merge into a tenant-hosted target that holds a table trigger fails
  // part-way there (a workspace merges fine): refused before anything is sent,
  // and on a dry run too — a preview that passed would promise an apply. A
  // converged run sends no import, so there is nothing to refuse.
  if (req.mode === "merge" && destIsTenant && live !== undefined && !dryRunUpToDate) {
    const { liveTableTriggers, tableTriggerMergeError } = await import("./keep-data-merge.js");
    const triggers = liveTableTriggers(live);
    if (triggers.length > 0) {
      const { retryCommand, withheldNote } = await import("./retry-command.js");
      // No `--yes`: the replace's own plan and confirmation show its row loss.
      const replace = retryCommand(args, { add: ["--replace"], drop: ["--prune", "--yes", "-y"] });
      throw tableTriggerMergeError(destNoun, triggers, {
        command: replace.command,
        note: withheldNote(replace.withheld),
      });
    }
  }

  // A merge that switches a table holding rows to the other storage mode
  // erases its values or stops partway: refused before anything is sent, and
  // on a dry run too, as above.
  if (req.mode === "merge" && live !== undefined && !dryRunUpToDate && losses.storageChanges.length > 0) {
    const { retryCommand, withheldNote } = await import("./retry-command.js");
    const replace = retryCommand(args, { add: ["--replace"], drop: ["--prune", "--yes", "-y"] });
    await assertStorageModesKept(losses.storageChanges, tableRowCounter(auth, { workspaceId, base: destBase }), {
      target: destNoun,
      subject: "the deploy",
      remedy: `rebuild the ${destKindNoun} with \`${replace.command}\` (that replaces every table's rows).${withheldNote(replace.withheld)}`,
    });
  }

  // A replace clears every static host on the target, whatever the flags — so
  // the frontends serving there, read from the platform, are part of the plan.
  // Only when an import will be sent: a converged run sends none.
  const staticRead =
    req.mode === "replace" && !dryRunUpToDate
      ? await readStaticTeardown(auth, { baseUrl: destBase, workspaceId }, undefined)
      : undefined;
  // Ending on its blank line, as every block of the plan does.
  if (
    staticRead !== undefined &&
    warnStaticTeardown(staticRead, destNoun, {
      publishing: args.static !== undefined,
      keepHint: "drop `--replace` to merge, which leaves it serving",
    })
  ) {
    blank();
  }

  // The public URLs this landing moves — said before it is confirmed, on the
  // real run as on a dry run. A branch serves its own slugs, so a staged
  // branch moves them only once it is live.
  const canonicalMoves = plannedCanonicalMoves(preview.canonicals, planContext);
  const movesWhen = req.branch === undefined || args.setLive ? undefined : "once the branch is made live";
  if (args.dryRun) {
    // The slugs the instance would keep or substitute, said here as the real
    // run says them after it: the JSON carried them and the text was silent.
    reportCanonicalDifferences(canonicalDifferences(preview.canonicals), planContext, true);
    reportPlannedCanonicalMoves(canonicalMoves, "would", movesWhen);
    // The archive IS sent to plan against — saying "nothing was sent" would be
    // false, and someone deciding whether a preview is safe against production
    // deserves to know what left the machine.
    if (plannedBackup !== undefined) {
      info(`A real run snapshots the live branch as "${plannedBackup}" before importing.`);
    }
    info("Dry run — the archive was sent for planning only, and nothing was written.");
    if (isMachineOutput(args)) {
      writeJson({
        landed: false,
        dryRun: true,
        declined: false,
        // Always present; a dry run records nothing — what it would land is
        // not landed, and the record is what a prune deletes by.
        landingRecord: null,
        syncBaseline: null,
        workspaceId,
        destination: destinationPayload(resolvedDest, dest, auth),
        // The verdict the real run would reach, said up front: a wrapper
        // deciding whether a deploy is needed reads one key.
        upToDate: dryRunUpToDate,
        // The real run's keys, so a wrapper reads one document shape either
        // way. `records` is whether the real run writes rows — the plan's
        // answer, which the "rows would be written" warning states too.
        mode: req.mode,
        prune: req.prune === true,
        records: !dryRunUpToDate && plan.hasRecords,
        ...(seeded.length > 0 ? { seedRows: seeded } : {}),
        truncate: req.truncate === true,
        operations: dryRunUpToDate ? 0 : plan.operations.length,
        plan: planForOutput(plan, presented, destIsTenant, converged, destKindNoun),
        // A tenant has no branches, so it is planned against none — the route's
        // echo of its internal default describes nothing the reader chose.
        branch: destIsTenant ? null : (preview.branch ?? null),
        conflicts: conflictsForOutput(preview.conflicts, planContext),
        canonicals: plannedCanonicalsForOutput(preview.canonicals, planContext),
        ...(branchDeletion !== undefined ? { branchDeletion } : {}),
        // What the plan cannot say, under the keys the real run's summary uses:
        // the text dry run warns about each, and this is where a wrapper decides.
        ...landingTableFields(losses),
        unchangedEnv: losses.unchangedEnv,
        droppedEnv: losses.droppedEnv,
        unappliedDocumentation: losses.unappliedDocumentation,
        workspaceRename: losses.workspaceRename ?? null,
        workspaceSettingsNotApplied: withheldSettings,
        // The real run's key: how many shared-schema changes a branch landing
        // carries (`null` when they could not be read) — above zero without
        // `--allow-shared-schema-changes`, the real run refuses.
        ...(req.branch !== undefined ? { sharedSchemaChanges: sharedChanges?.length ?? null } : {}),
        ...(unnamedPublicUrls.length > 0 ? { unnamedPublicUrls: [...unnamedPublicUrls] } : {}),
        ...staticRemovedField(staticRead?.teardown, undefined),
      });
    }
    return;
  }

  /** Set when a `--backup-branch` clone actually landed — the rollback target. */
  let backupLabel: string | undefined;
  /** What the route reported for the import it actually ran, when one ran. */
  let applyResponse: XanoSdkImportResponse | undefined;
  /** Whether the `--set-live` promote actually happened, as opposed to being asked for. */
  let promoted = args.setLive;
  let liveRestored: string | undefined;
  // Two ways to be a no-op, and the server can only see one of them: an empty
  // plan means the server itself found nothing to do, and convergence means
  // every object the bundle carries is already there byte-for-byte.
  //
  // Either way the run is NOT over. `--static` is a separate upload that an
  // unchanged backend says nothing about, and a CI wrapper parsing stdout still
  // needs its summary. Only the import is short-circuited.
  //
  // NEVER for a branch release. Both signals compare against the LIVE branch,
  // and the target branch does not exist yet — "already up to date" is a
  // statement about somewhere else. Short-circuiting on it would skip the
  // import, so the branch is never created, `--set-live` promotes nothing, and
  // the run reports a branch it did not make.
  const upToDate = dryRunUpToDate;

  if (upToDate) {
    // Nothing is sent, but the run succeeded: the compile's lock is the one
    // that describes the destination now.
    commitLock();
    // Named as the destination was chosen: a tenant's internal workspace is
    // always #1, which names nothing the reader typed.
    success(`${destNoun.charAt(0).toUpperCase()}${destNoun.slice(1)} is already up to date — no import sent.`);
  } else {
    // Before the confirmation, and only on the path that writes: a dry run has
    // already reported which checks could not be made, and refusing it would
    // leave a reader with no way to look at all.
    assertLiveWorkspaceWasRead(live, destNoun, scopeBranch, liveRead.failure, liveKind);

    // Said before any confirmation or refusal: the question names the moves,
    // and the list it points at is printed above it.
    reportPlannedCanonicalMoves(canonicalMoves, "will", movesWhen);

    // The cutover below is confirmed AFTER the import lands the branch, and with
    // no terminal to ask that confirmation can only refuse — leaving behind the
    // branch it was about to promote. So the one case it would refuse is
    // refused here, before anything is written.
    if (req.branch !== undefined && args.setLive && !args.yes && process.stdin.isTTY !== true) {
      const { yesRerun } = await import("./retry-command.js");
      const { rerun, note } = yesRerun(args, "deploy");
      throw needsConfirmation(
        `Make "${req.branch}" the live branch?${movesClause(canonicalMoves)} (or drop --set-live to stage it)`,
        { details: { landed: false, setLive: false, branch: req.branch }, rerun, note },
        `Nothing was written: the \`--set-live\` cutover asks after landing, and stdin is not a terminal.`,
      );
    }

    // `isDestructive` reads the FLAGS, and a column drop is destructive without
    // one: it rides in on an ordinary release whose plan calls it an in-place
    // update. Gating on the flags alone let the most easily-made destructive
    // change through with no prompt at all.
    // A dropped ENV VAR is destructive on the same terms as a dropped column:
    // it rides in on a plan that calls it a routine workspace update, and the
    // value is not recoverable from anything this project holds — by
    // definition, since the project never declared it.
    // An ephemeral never asks, as a plain deploy's replace of one never does
    // (guides/cli.md; E2E pass 24: `--to tenant:<ephemeral> --seed` asked).

    if (
      (isDestructive(req) ||
        losses.droppedColumns.length > 0 ||
        losses.retypedColumns.length > 0 ||
        losses.narrowedEnums.length > 0 ||
        losses.droppedEnv.length > 0 ||
        // A public URL this run moves — not a staged branch's, which moves
        // only at its set-live, and that asks then.
        (movesWhen === undefined && canonicalMoves.length > 0)) &&
      !args.yes &&
      destKindNoun !== "ephemeral"
    ) {
      // What was planned and not sent: the decline's document, and the
      // details of the refusal a run with no terminal gets (E2E pass 27: that
      // was a bare `{ ok: false, error }`, no plan, no `landed`, where the
      // prune-scope refusal carries the whole frame).
      const unsent = (): Record<string, unknown> => ({
        landed: false,
        dryRun: false,
        declined: false,
        workspaceId,
        destination: destinationPayload(resolvedDest, dest, auth),
        upToDate: false,
        mode: req.mode,
        prune: req.prune === true,
        records: false,
        truncate: req.truncate === true,
        // The PLANNED count, as the dry run's document gives it for the same
        // plan (E2E pass 29: 0 here, 7 there); `landed: false` says none went.
        operations: plan.operations.length,
        plan: planForOutput(plan, presented, destIsTenant, converged, destKindNoun),
        branch: destIsTenant ? null : (preview.branch ?? null),
        conflicts: conflictsForOutput(preview.conflicts, planContext),
        canonicals: plannedCanonicalsForOutput(preview.canonicals, planContext),
        ...(branchDeletion !== undefined ? { branchDeletion } : {}),
        ...landingTableFields(losses),
        unchangedEnv: losses.unchangedEnv,
        droppedEnv: losses.droppedEnv,
        unappliedDocumentation: losses.unappliedDocumentation,
        workspaceRename: losses.workspaceRename ?? null,
        workspaceSettingsNotApplied: withheldSettings,
        landingRecord: null,
        syncBaseline: null,
        ...(seeded.length > 0 ? { seedRows: seeded } : {}),
      });
      // Off a terminal, the refusal every landing carries, with this run and
      // `--yes` as the command that answers it (E2E pass 30: a generic
      // "Re-run with --yes").
      const { yesRerun } = await import("./retry-command.js");
      const { rerun, note } = yesRerun(args, "deploy");
      const ok = await confirm(`Apply this plan to ${destNoun}?${seedOverwriteClause(seeded)}${movesClause(canonicalMoves, movesWhen === undefined ? "It" : "Once live, it")}`, {
        flag: "--yes",
        refusal: { details: unsent(), rerun, note },
      });
      if (!ok) {
        info("Deploy cancelled — nothing was written.");
        // A decline answers `--json` too: the caller asked a question and is
        // owed a document saying the answer was no, not an empty stdout. The
        // dry run's shape, with `declined: true` — what was planned, and that
        // none of it was sent.
        if (isMachineOutput(args)) writeJson({ ...unsent(), declined: true });
        return;
      }
    }

    // Every refusal is behind us and the first write is next: the lock lands
    // now, before the identities it records are shipped. An entry the confirmed
    // prune deletes matches no exported object because it was deleted on
    // purpose — no "renamed?" fix-up for it (E2E pass 17).
    commitLock({ pruned: new Set(Object.keys(pruned)) });

    // AFTER the confirmation and BEFORE the import: late enough that a cancelled
    // or refused release leaves no stray branch behind, early enough to precede
    // the write it exists to protect. A failed clone stops the release — a backup
    // that silently did not happen is worse than none, because the release then
    // proceeds under a belief that is false.
    if (args.backupBranch !== undefined) {
      const sourceLabel = liveBranchLabel(branches);
      const label = plannedBackup ?? plannedBackupLabel(args.backupBranch, branches);

      step(`Snapshotting the live branch as "${label}" before importing…`);
      try {
        await createBranch(auth, {
          baseUrl: destBase,
          workspaceId,
          label,
          ...(sourceLabel !== undefined ? { sourceBranch: sourceLabel } : {}),
          description: `Pre-deploy snapshot taken by xanosdk from ${source}`,
        });
      } catch (err) {
        throw new Error(
          `The pre-deploy backup branch could not be created, so the deploy was not sent.\n` +
            `Nothing has changed in workspace #${workspaceId}.\n` +
            `Retry, or drop \`--backup-branch\` to deploy without one.`,
          { cause: err },
        );
      }
      backupLabel = label;
      success(`Live branch snapshotted as "${label}".`);
    }

    try {
      // A signal while the write is on the wire names it; `stateCheck` says how to check it.
      applyResponse = await describeWrite(
        { what: `the ${req.mode === "replace" ? "replace" : "merge"} into ${destShownLabel ?? `workspace #${workspaceId}`}` },
        () =>
          xanosdkImport(auth, {
            ...target,
            dryRun: false,
            pinned: pinned.map((p) => p.guid).filter((g): g is string => g !== undefined),
          }),
      );
    } catch (err) {
      // A REFUSAL is not a failed import: the instance ran its checks inside the
      // write and declined before writing anything. It gets its own report,
      // which must not print the rollback instruction below.
      if (err instanceof XanoSdkImportRefusal) {
        const { retryCommand, withheldNote } = await import("./retry-command.js");
        const retry = retryCommand(args);
        reportApplyRefusal(
          err,
          refusalFrame,
          preview.branch,
          backupLabel,
          { command: retry.command, note: withheldNote(retry.withheld) },
          losses.indexChanges,
          req.records === true ? seededUniqueIndexes(bundle, content) : [],
        );
      }
      // The moment the rollback instruction is actually needed — printing it only
      // on success would put it exactly where nobody is looking for it.
      if (backupLabel !== undefined) {
        blank();
        warn(
          `The import failed. Your pre-deploy snapshot is on branch "${backupLabel}".`,
          "deploy.import-failed-backup",
          [
            `Restore it with \`xanosdk workspace branch set-live ${backupLabel}${pipedYes(args)}${contextFlags()}\` — that restores logic, ` +
              `not tables: every branch shares them, so whatever the import did to tables and rows stays.`,
          ],
        );
      }
      throw err;
    }
    // The branch the instance says it landed on, never the one that was asked
    // for: the route echoes it, and reporting the request back would be the SDK
    // asserting something only the instance can know.
    // Except after a replace: the route echoes the branch it planned against,
    // which the clear then deleted unless it was the default. The archive lands
    // on the default branch, the only one the clear keeps.
    const landed = req.mode === "replace" ? DEFAULT_BRANCH_LABEL : (applyResponse?.branch ?? req.branch);
    success(
      req.branch !== undefined
        ? `Deployed to workspace #${workspaceId} on branch "${landed}"`
        : destTenantLabel !== undefined
          ? `Deployed to ${destTenantLabel}`
          : // Named even without `--branch`: a merge lands on whichever branch
            // is live, and when that is not the default this is where a reader
            // learns it.
            `Deployed to instance workspace #${workspaceId}${landed === undefined ? "" : ` on branch "${landed}"`}`,
    );

    if (req.branch !== undefined) {
      if (args.setLive) {
        const previous = liveBranchLabel(branches);
        // A cutover is confirmed on its own, even when the IMPORT needed no
        // prompt. The import was non-destructive precisely because it landed on
        // a branch nothing serves; promoting it is the step that puts it in
        // front of traffic, and `workspace branch set-live` asks for exactly
        // this. Skipping it here would make the flag the quiet way to do the
        // loud thing.
        blank();
        // Worded for what is served before and after, as `workspace branch
        // set-live` words it: with nothing live, nothing is cut over from.
        if (previous !== undefined) {
          warn(
            `Promoting "${req.branch}" is a production cutover for workspace #${workspaceId}.`,
            "branch.production-cutover",
            [`The runtime stops serving "${previous}" and starts serving "${req.branch}".`],
          );
        } else {
          warn(
            `No branch is live in workspace #${workspaceId} — promoting "${req.branch}" makes it the branch the runtime serves.`,
            "branch.none-live",
          );
        }

        // Off a terminal the deploy has already landed on the branch, so the
        // rerun that answers is the set-live alone, not this deploy again.
        if (!args.yes && !(await confirm(`Make "${req.branch}" the live branch?${movesClause(canonicalMoves)}`, {
          flag: "--yes",
          refusal: {
            details: { landed: true, setLive: false, branch: req.branch },
            rerun: `xanosdk workspace branch set-live ${shellWord(req.branch)} --yes${contextFlags(args)}`,
          },
        }))) {
          info(`Set-live cancelled — nothing was switched: the deploy is staged on "${req.branch}" and nothing serves it yet.`);
          detail(`Promote it later with \`xanosdk workspace branch set-live ${req.branch}${pipedYes(args)}${contextFlags()}\`.`);
          promoted = false;
        } else {
          await setLiveBranch(auth, { baseUrl: destBase, workspaceId, label: req.branch });
          success(`Branch "${req.branch}" is now live.`);
          if (previous !== undefined) {
            detail(setLiveRollback(previous, args));
          }
        }
      }
      reportBranchCaveats(
        req.branch,
        promoted,
        sharedChanges?.length,
        ungatedSchemaChanges(sharedSchemaChanges(JSON.parse(bundle) as unknown, live, { prune: args.prune })),
        pipedYes(args),
      );
    } else if (backupLabel !== undefined) {
      blank();
      // A branch restores logic, not tables: every branch shares one copy of
      // them (E2E pass 36: the line read as a full undo).
      detail(
        `Roll back this deploy's logic with \`xanosdk workspace branch set-live ${backupLabel}${pipedYes(args)}${contextFlags()}\` — ` +
          `it restores logic, not tables: every branch shares them, so what this deploy did to tables and rows stays.`,
      );
    }
    if (req.mode === "replace" && destHasBranches) {
      liveRestored = await restoreLiveAfterReplace(auth, { baseUrl: destBase, workspaceId }, DEFAULT_BRANCH_LABEL);
    }
  }

  // What this project now has on the destination — recorded only here, after
  // the write answered (or a converged run found the destination already
  // holding exactly this project's objects). A replace holds exactly what it
  // sent; a merge adds it; a prune removes what it deleted. A `--bundle`
  // someone exported is a FOREIGN landing, as a fetched backend's copy is: it
  // is this project's only when every identity it carries matches the lock,
  // and a replace by one that does not clears the record — the destination
  // now holds another source's objects, and the old record would let a later
  // `--prune` delete them as this project's. An explicit `--lock` says which
  // project the bundle is, and is taken at its word.
  const landingMode = req.mode === "replace" ? "replace" : "merge";
  // The column storage after this landing, for an ephemeral's record: a
  // replace recreates every table as declared, a merge keeps each column's.
  const storedAfter =
    priorStored === undefined
      ? undefined
      : storedColumnsAfter(
          parsedOrUndefined(bundle),
          req.mode === "replace" ? undefined : live,
          priorStored,
          req.mode === "replace" ? "rebuild" : "merge",
        );
  // A bundle sent with no lock named is checked against the project it runs
  // in; an entry file's lock is the one beside it.
  const sentForeign = args.file === undefined && args.lockPath === undefined;
  const landingLock = sentForeign ? landingLockPath(args) : landingLockPath(args, { entryFile: args.file, fromProject: false });
  const landingRecord =
    landingDest === undefined
      ? null
      : sentForeign
        ? recordForeignLanding({
            lockPath: landingLock,
            instance: auth.instance,
            dest: landingDest,
            bundle: parsedOrUndefined(bundle),
            mode: landingMode,
            removed: pruned,
            ...(storedAfter !== undefined ? { stored: storedAfter } : {}),
          })
        : recordLanding({
            lockPath: landingLock,
            instance: auth.instance,
            dest: landingDest,
            update: {
              mode: landingMode,
              identities: withStoredColumns(landedIdentities(parsedOrUndefined(bundle)), storedAfter),
              removed: pruned,
            },
          });

  // The sync baseline for the branch this landed on (see
  // `deploy/sync-baseline.ts`): what that branch holds now that it matches
  // this project. Recorded on an up-to-date run too, which writes nothing:
  // that is still a moment the two sides agree.
  const syncBaseline = landingDest?.kind !== "workspace" ? null : await recordDeploySync();

  /**
   * Digested from the branch AS STORED, the way a verified promote records it:
   * a field the engine stores differently from the compile, and that the
   * comparison does not normalize, then reads as "changed here" on the next
   * diff (deploy again, harmless) rather than "changed there" (pull first,
   * which a guard would refuse the deploy over). An up-to-date run already
   * holds that read; a run that wrote reads the branch back once. Only the
   * objects this deploy sent are the project's; the rest of the branch is
   * kept apart, so one showing up in `unexpected` later is not something this
   * project deleted.
   *
   * When the read-back fails, what was sent stands in for the project's
   * objects and the read before the write for the rest (a new branch is a
   * clone of live; a replace leaves nothing else).
   */
  async function recordDeploySync(): Promise<SyncReport | null> {
    // No lock, no baseline: and no read-back for one.
    if (landingDest?.kind !== "workspace" || landingLock === undefined || !existsSync(landingLock)) return null;
    const sent = parsedOrUndefined(bundle);
    const branch = req.mode === "replace" ? DEFAULT_BRANCH_LABEL : (applyResponse?.branch ?? preview.branch);
    // A replace keeps only the default branch, so it is the live one; a merge
    // without `--branch` landed on live.
    const stored = upToDate ? live : (await readLive(auth, resolvedDest, req.branch !== undefined ? branch : undefined)).live;
    const digests =
      stored !== undefined
        ? syncDigests({ held: [stored], heldLabels: new Set(Object.keys(objectDigests(sent, "carried"))) })
        : syncDigests({ held: [sent], others: req.mode === "replace" ? [] : [live] });
    return recordSync({
      lockPath: landingLock,
      target: { instance: auth.instance, workspaceId: landingDest.workspaceId, branch },
      digests,
      by: "deploy",
      complete: stored !== undefined || req.mode === "replace" || live !== undefined,
    });
  }

  // What the instance SERVES, reported whether or not an import ran.
  //
  // Deliberately outside the branch above: a converged release sends nothing and
  // is still entitled to know that a slug it compiled is not the one answering,
  // because convergence does not compare public URLs (it cannot — the archive's
  // value is a request and the workspace's is an outcome; see
  // `deploy/live-diff.ts`). Read from the applied response when there is one and
  // from the preview otherwise: what HAPPENED, not what was asked for.
  const servedDifferences = canonicalDifferences((applyResponse ?? preview).canonicals);
  reportCanonicalDifferences(servedDifferences, planContext);

  if (!args.dryRun) opts.afterLanding?.(parsedOrUndefined(bundle));

  link(destBase);

  // With release, the static frontend goes to the SAME instance workspace.
  const summary: {
    landed: boolean;
    /** Always false here; the dry run's document carries the same keys with `true`. */
    dryRun: boolean;
    /** The destination's internal workspace id (a tenant's is 1). */
    workspaceId: number;
    /** The plan this release was confirmed against, as the dry run reports it. */
    plan: ReturnType<typeof planForOutput>;
    conflicts: XanoSdkImportConflict[];
    mode: ImportMode;
    prune: boolean;
    records: boolean;
    truncate: boolean;
    /**
     * Where this release wrote, in the one shape every writing command uses —
     * the same two facts the step line disclosed, for the caller who reads only
     * this document. Replaces the flat `workspaceId` + `instance` pair: one
     * destination, named once, so a wrapper comparing a deploy summary with a
     * release summary reads the same key in both.
     */
    destination: ReturnType<typeof destinationPayload>;
    operations: number;
    upToDate: boolean;
    /** Tables a merge renames, matched by identity, keeping their rows. */
    renamedTables: { from: string; to: string }[];
    /** Columns destroyed by an in-place table update the plan calls routine, as `table.column`. */
    droppedColumns: string[];
    /** Columns made nullable whose NOT NULL the merge keeps, as `table.column`. */
    notNullKept: string[];
    /** Columns kept under another type, `{ table, column, from, to }`: a value that does not read as the new type reads null. */
    retypedColumns: RetypedColumn[];
    /** Enum columns kept with values removed: a row holding one reads null. */
    narrowedEnums: NarrowedEnum[];
    /** Table references pointed at another table; the ids rows hold are kept. */
    retargetedRefs: RetargetedRef[];
    /** Indexes added or dropped. */
    indexChanges: IndexChange[];
    /** Columns made non-nullable: a row holding null reads the type's empty value. */
    notNullTightened: TightenedColumn[];
    /** Tables switched to the other storage mode, `{ table, from, to }` as `useXdo` before and after. */
    storageChanges: import("./plan-disclosure.js").StorageChangePayload[];
    /** Env keys a merge declined to update because they already exist. */
    unchangedEnv: string[];
    /** Env vars a `--replace` drops because the project does not declare them. */
    droppedEnv: string[];
    /** Members of the workspace `documentation` block a merge will not write. */
    unappliedDocumentation: string[];
    /** The workspace's own name change, or `null` when this release keeps it. */
    workspaceRename: { from: string; to: string } | null;
    /**
     * Workspace settings a `--branch` landing did not apply, as dotted paths
     * (`name`, `preferences.track_performance`): shared by every branch, so a
     * branch landing leaves them as they are. Empty when there are none.
     */
    workspaceSettingsNotApplied: string[];
    /**
     * Objects whose public URL this project leaves to the instance, as
     * `payloadKey:name`. Present only when there are any — a wrapper reading
     * the key cannot mistake "none" for "not checked".
     */
    unnamedPublicUrls?: string[];
    /**
     * The branch this release planned against or landed on, as the dry run
     * reports it — the live one's label without `--branch`; `null` for a tenant.
     */
    branch: string | null;
    /** Whether `--set-live` promoted that branch. */
    setLive?: boolean;
    /** The pre-release snapshot `--backup-branch` took, when one landed. */
    backupBranch?: string;
    /** Shared-schema changes that reached EVERY branch, including live. */
    sharedSchemaChanges?: number;
    /**
     * What the instance served for every public URL slug in the archive. The one
     * place a wrapper can see that a compiled slug is not the one answering — an
     * outcome no other field carries, and the reason a per-target record of
     * served slugs is worth building later.
     */
    canonicals: XanoSdkCanonicalReport[];
    static?: StaticPublishSummary;
    /** Always false here; a declined run writes its own document with `true`. */
    declined: boolean;
    /** What this landing recorded in the lock for `--prune` (see `lock/landed.ts`), or `null`. */
    landingRecord: LandingReport | null;
    /** The sync baseline recorded for the branch this landed on (see `deploy/sync-baseline.ts`), or `null`. */
    syncBaseline: SyncReport | null;
    /** The frontends a `--replace` took down (see `static-teardown.ts`), less one `--static` served again. */
    staticRemoved?: StaticTeardown;
  } = {
    // `landed: false` with `upToDate: true` is a SUCCESS, not a failure — the
    // workspace already matches. A wrapper gating on `landed` alone would read
    // a converged release as a broken one, so both fields are always present.
    landed: !upToDate,
    // The dry run's keys, so a wrapper reads one document shape either way.
    dryRun: false,
    declined: false,
    landingRecord,
    syncBaseline,
    workspaceId,
    plan: planForOutput(plan, presented, destIsTenant, converged),
    conflicts: conflictsForOutput((applyResponse ?? preview).conflicts, planContext),
    upToDate,
    mode: req.mode,
    prune: req.prune === true,
    // What HAPPENED, not the flag that was asked for. This is the one field
    // someone checks to confirm a seed landed, and echoing the input into it
    // reported success over a write that never occurred. Rows go
    // out only when the archive actually carried some AND the import ran —
    // which covers both ways rows get written: `--seed` on a merge, and a
    // replace, where the rows ride along with no flag at all. `content` is only
    // ever populated when one of those asked for it (see `withSeed` above), so
    // a merge without `--seed` still reports false, and so does a replace of a
    // project that declares no seed rows.
    records: content.length > 0 && !upToDate,
    truncate: req.truncate === true,
    destination: destinationPayload(resolvedDest, dest, auth),
    // What this release will DO, not what the plan enumerated: a converged
    // release sends nothing, and reporting the server's matched-identity count
    // beside `upToDate: true` would contradict it.
    operations: upToDate ? 0 : plan.operations.length,
    ...landingTableFields(losses),
    unchangedEnv: losses.unchangedEnv,
    droppedEnv: losses.droppedEnv,
    unappliedDocumentation: losses.unappliedDocumentation,
    // Always present, `null` when nothing is renamed — the dry run's key too,
    // so a wrapper reads one field on both.
    workspaceRename: losses.workspaceRename ?? null,
    workspaceSettingsNotApplied: withheldSettings,
    ...(unnamedPublicUrls.length > 0 ? { unnamedPublicUrls: [...unnamedPublicUrls] } : {}),
    // The label the instance says it planned or landed against — the same rule
    // as the success line above, and the dry run's `branch`, so a converged
    // run carries it too. `assertXanoSdkBranchHonored` has already refused any
    // disagreement, so this can only ever restate it.
    branch: destIsTenant ? null : (applyResponse?.branch ?? preview.branch ?? null),
    // Present only with `--branch`: a plain release promotes nothing.
    ...(req.branch !== undefined
      ? {
          setLive: promoted,
          sharedSchemaChanges: sharedChanges?.length,
        }
      : {}),
    ...(backupLabel !== undefined ? { backupBranch: backupLabel } : {}),
    // Present only when the replace left nothing live and this run set it.
    ...(liveRestored !== undefined ? { liveRestored } : {}),
    // Reported on the APPLY as well as the dry run: a tool reconciling what a
    // release actually did needs the loss in the same shape it was shown the
    // loss it authorized.
    ...(branchDeletion !== undefined ? { branchDeletion } : {}),
    // What the instance actually served: the applied response when an import
    // ran, and the preview's own read when the release was already converged.
    canonicals: canonicalsForOutput((applyResponse ?? preview).canonicals, planContext),
  };

  if (args.static !== undefined) {
    // Before the upload, and after the summary is built: a wrapper that gets no
    // published frontend still gets the document explaining which URLs moved.
    if (servedDifferences.length > 0) {
      if (isMachineOutput(args)) writeJson(summary);
      assertStaticMatchesServedUrls(servedDifferences, planContext);
    }
    const { buildStaticEnv, deployStaticTo } = await import("./deploy-command.js");
    const env = buildStaticEnv(destBase, args.staticEnv);
    const explicit = Object.keys(args.staticEnv).length > 0;
    const to =
      dest?.kind === "tenant" ? `${dest.type === "ephemeral" ? "ephemeral" : "tenant"}:${dest.name ?? ""}` : "workspace";
    // An interrupt during the upload says the backend landed before it.
    const { noteLanded } = await import("../util/sent-writes.js");
    const backendLabel = destNoun;
    noteLanded({ said: upToDate ? `The backend on ${backendLabel} was already up to date.` : `Deployed to ${backendLabel}.` });
    try {
      summary.static = await deployStaticTo(
        args.static,
        auth,
        // Named as the step line named the destination: a tenant's internal
        // workspace is #1, which names nothing the reader typed.
        { baseUrl: destBase, workspaceId, label: destTenantLabel },
        env,
        explicit,
        args.staticHost,
        args.skipLiveness,
        args.staticRouting,
        undefined,
        { rerun: staticRetryCommand(args.static, to, args, undefined) },
      );
    } catch (err) {
      // The backend has landed by now, so this is plain `deploy --static`'s
      // failure and is reported as that one is: the summary still written
      // (landed, staticRemoved), the reason under `static.error`, a retry
      // that publishes alone, exit 3. Uncaught, it exited 8 with a bare
      // `{ok:false}` after the replace had already taken the old frontend down.
      // A sent upload whose answer was lost is 9 and says so, as there.
      const unknown = err instanceof Error && statesOutcomeUnknown(err.message);
      const message = unknownStaticOutcome(err instanceof Error ? err.message : String(err), unknown);
      summary.static = {
        url: undefined,
        error: message,
        retry: staticRetryCommand(args.static, to, args, err),
        completed: unknown ? "unknown" : "no",
      };
      warn(
        `The static-host upload failed — the backend ${upToDate ? "is unchanged" : "deploy stands"}:`,
        "static.upload-failed",
        [message],
      );
      if (!upToDate) noteStaticTakenDown(staticRead?.teardown, unknown);
      detail(staticRetryHint(args.static, to, args, err));
      process.exitCode = unknown ? EXIT_OUTCOME_UNKNOWN : EXIT_STATIC_FAILED;
    } finally {
      noteLanded(undefined);
    }
  }
  // Only when the replace was sent: a converged run imported nothing.
  if (!upToDate) Object.assign(summary, staticRemovedField(staticRead?.teardown, summary.static?.url));

  if (isMachineOutput(args)) writeJson(summary);
}

/**
 * The line after a set-live that switched away from `previous`: the command
 * that switches back, as it runs from where this one was typed.
 */
export function setLiveRollback(previous: string, args: ParsedArgs): string {
  return `Roll back with \`xanosdk workspace branch set-live ${shellWord(previous)}${pipedYes(args)}${contextFlags(args)}\`.`;
}

/** What {@link assertReleaseIdentitiesFree} found when it let a landing through. */
export type ReleaseIdentityCheck =
  | {
      readonly checked: true;
      /** The guids whose public URL slug the project pins in code — what the landing must serve. */
      readonly pinned: readonly string[];
      /** The instance's per-object slug report for the planned landing. */
      readonly canonicals: readonly XanoSdkCanonicalReport[];
    }
  | { readonly checked: false; readonly reason: string };

/**
 * The identity check `deploy --to workspace` runs before it writes, for a
 * release archive the caller already holds — what `promote` lands.
 *
 * The platform's own release landing settles a taken name by adding a suffixed
 * second object, and a taken public URL slug by minting another, and answers
 * success either way. So the archive is first planned through the import route
 * with `dry_run` on, against the branch it will land on, with the slugs the
 * project's lock records as written in code passed as pins: a pin the instance
 * cannot serve, or a name another object holds, refuses here with the same
 * `SDK_IDENTITY_CONFLICT` (or `SDK_KIND_CONFLICT`) refusal `--to` prints, its
 * prose opened by `subject` and closed by `remedySuffix`.
 *
 * `checked: false` when the instance has no import route to plan through.
 */
export async function assertReleaseIdentitiesFree(
  args: ParsedArgs,
  auth: ResolvedAuth,
  opts: {
    /** The release archive, typed as a workspace (see `asWorkspaceArchive`). */
    readonly archive: Uint8Array;
    /** The same archive, decoded. */
    readonly bundle: unknown;
    /** The branch label the landing will create; omitted for a tenant, which has none. */
    readonly branch?: string;
    /**
     * A tenant or an ephemeral to plan against instead of the credential's
     * workspace — `tenant deploy`'s destination, named as the refusal names it.
     */
    readonly tenant?: {
      readonly base: string;
      readonly workspaceId: number;
      readonly type: "tenant" | "ephemeral";
      readonly name: string;
      readonly display?: string;
    };
    /** The running command, as a conflict line names what it carries: `promote`, `tenant deploy`. */
    readonly verb: string;
    /** The project's lock, when there is one: it classifies which slugs are pinned. */
    readonly lockPath: string | undefined;
    /** The destination's live export, when it was read: names a holder's kind. */
    readonly live: ExportedBundle | undefined;
    /** How the refusal names the landing: `promote "v1"`. */
    readonly subject: string;
    /** A sentence appended to every refusal. */
    readonly remedySuffix: string;
  },
): Promise<ReleaseIdentityCheck> {
  const tenant = opts.tenant;
  const target =
    tenant === undefined
      ? { baseUrl: auth.instance, workspaceId: auth.workspaceId }
      : { baseUrl: tenant.base, workspaceId: tenant.workspaceId };
  const { detectXanoSdkImportRoute } = await import("../deploy/xanosdk-import.js");
  let capable: boolean;
  try {
    capable = await detectXanoSdkImportRoute(auth, target);
  } catch (err) {
    // 501: the backend does not implement the route — as absent as a 404.
    if ((err as { status?: unknown } | null)?.status === 501) capable = false;
    else {
      // No answer (a network failure or a 5xx): exit 8 with this run as the
      // rerun, as `deploy --keep-data`'s probe says it — nothing was sent.
      const { unreachableProbeError } = await import("./keep-data-merge.js");
      const retry = retryCommand(args, {
        add: pipedYes(args) === "" ? [] : ["--yes"],
        command: [opts.verb, ...args.positionals.map(shellWord)].join(" "),
      });
      throw await unreachableProbeError(err, {
        label: tenant === undefined ? `workspace #${auth.workspaceId}` : `${tenant.type} "${tenant.name}"`,
        kind: tenant === undefined ? "workspace" : tenant.type,
        rerun: { command: retry.command, note: withheldNote(retry.withheld) },
      });
    }
  }
  if (!capable) {
    return { checked: false, reason: "this instance has no route to plan the landing through" };
  }
  const lockArgs = { ...args, ...(opts.lockPath === undefined ? {} : { lockPath: opts.lockPath }) } as ParsedArgs;
  const lock = opts.lockPath !== undefined && existsSync(opts.lockPath) ? readLockFile(opts.lockPath) : undefined;
  const pinned = pinnedCanonicalGuids(JSON.stringify(opts.bundle), lock, false);
  const res = await xanosdkImport(auth, {
    ...target,
    archive: opts.archive,
    dryRun: true,
    mode: "merge",
    records: false,
    ...(opts.branch === undefined ? {} : { branch: opts.branch }),
    pinned,
  });
  const resolved: MergeDest = { base: target.baseUrl, workspaceId: target.workspaceId };
  const dest: MergeDest | undefined =
    tenant === undefined
      ? undefined
      : {
          ...resolved,
          kind: "tenant",
          type: tenant.type,
          name: tenant.name,
          ...(tenant.display === undefined ? {} : { display: tenant.display }),
        };
  const frame: RefusalFrame = {
    workspaceId: target.workspaceId,
    noun:
      tenant === undefined
        ? `workspace #${auth.workspaceId}`
        : `${tenant.type} "${tenant.name}"${tenant.display === undefined ? "" : ` ("${tenant.display}")`}`,
    tenant: tenant !== undefined,
    verb: opts.verb,
    destination: destinationPayload(resolved, dest, auth),
    mode: "merge",
    prune: false,
    dryRun: false,
    adopt: adoptRemedy(lockArgs, dest),
    lockRename: lockRenameRemedy(lockArgs),
    pinnedInCode: codePinnedGuid(lockArgs),
  };
  try {
    const heldHere = res.conflicts.some((c) => ownerIsDestination(c.owner, frame));
    assertNoImportConflicts(
      res,
      heldHere ? { ...frame, adoptAddsNothing: adoptionAddsNothing(lockArgs, opts.live) } : frame,
      { bundle: opts.bundle, live: opts.live, tenant: tenant !== undefined, noun: tenant === undefined ? "workspace" : tenant.type },
    );
    assertNoKindSwap(
      opts.bundle,
      opts.live,
      frame,
      res.branch,
      lock === undefined || opts.lockPath === undefined ? undefined : { file: lock, path: opts.lockPath },
    );
  } catch (err) {
    if (err instanceof CliError) {
      err.message = `${err.message.replace(/^Refusing to deploy into /, `Refusing to ${opts.subject} into `)}\n${opts.remedySuffix}`;
    }
    throw err;
  }
  return { checked: true, pinned, canonicals: res.canonicals };
}
