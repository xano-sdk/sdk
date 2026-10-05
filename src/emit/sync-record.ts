/**
 * The command side of the sync baseline (see `deploy/sync-baseline.ts`): which
 * lock it lives in, how a command records one after it brought a workspace
 * branch and this project into agreement, and how `workspace diff` reads it.
 *
 * A baseline that cannot be written does not fail the command. The write it
 * follows already happened. It is said, because the next diff reads an older
 * baseline (or none) and may put a direction on the wrong side.
 */
import { existsSync } from "node:fs";
import { info, warn } from "./ui.js";
import { displayPath } from "../util/rel-path.js";
import { readLockFile, recordSyncInLockFile } from "../lock/io.js";
import { destinationKey } from "../lock/landed.js";
import { syncedOn, type SyncDigests } from "../lock/synced.js";
import type { SyncBaseline, SyncSource } from "../lock/lock.js";
import { findBranch, listBranches, liveBranchLabel, type BranchRecord } from "../deploy/branch.js";
import type { ResolvedAuth } from "../auth/token.js";

/** What a sync recorded, as a command's `--json` carries it (`null` when nothing was recorded). */
export interface SyncReport {
  /** The workspace destination key the baseline is kept under. */
  destination: string;
  /** The branch label the baseline describes. */
  branch: string;
  /** The lock it is kept in, as displayed. */
  file: string;
  /** How many of the project's objects the baseline names. */
  objects: number;
  /** Whether the lock changed. A sync that found the branch as recorded leaves it alone. */
  changed: boolean;
}

/** One workspace branch: the destination a baseline is recorded for. */
export interface SyncTarget {
  /** The credential's instance, the host half of the destination key. */
  instance: string;
  workspaceId: number;
  /** The branch label, as the instance stores it. */
  branch: string;
}

/**
 * The baseline recorded for a branch in the lock at `lockPath`, or `undefined`
 * when there is no lock, no baseline, or a lock that cannot be read. A diff
 * without a baseline still answers; it just cannot say which side moved.
 */
export function readSyncBaseline(lockPath: string | undefined, target: SyncTarget): SyncBaseline | undefined {
  if (lockPath === undefined || !existsSync(lockPath)) return undefined;
  try {
    const key = destinationKey(target.instance, { kind: "workspace", workspaceId: target.workspaceId });
    return syncedOn(readLockFile(lockPath), key, target.branch);
  } catch {
    return undefined;
  }
}

/**
 * Record what a branch holds now that it and this project agree, as
 * `syncDigests` describes it (see `deploy/sync-baseline.ts`).
 *
 * `complete` says the digests cover every object on the branch: a decode of
 * the whole branch, a replace, or a merge that read the branch first. Only
 * then does a later diff read an object the baseline does not name as added
 * in Xano.
 */
export function recordSync(opts: {
  lockPath: string | undefined;
  target: SyncTarget;
  digests: SyncDigests;
  by: SyncSource;
  complete: boolean;
}): SyncReport | null {
  if (opts.lockPath === undefined) return null;
  const destination = destinationKey(opts.target.instance, { kind: "workspace", workspaceId: opts.target.workspaceId });
  const shown = displayPath(opts.lockPath);
  let result;
  try {
    result = recordSyncInLockFile(opts.lockPath, destination, opts.target.branch, { digests: opts.digests, by: opts.by, complete: opts.complete });
  } catch (err) {
    warn(
      `The ${opts.by} succeeded, but its sync baseline could not be recorded in ${shown}: ${err instanceof Error ? err.message : String(err)}`,
      "sync.record-failed",
      ["`xanosdk workspace diff` reads the older baseline, so it may say the wrong side changed until the next deploy or pull records one."],
    );
    return null;
  }
  if (result === undefined) return null;
  if (result.changed) {
    info(`Recorded the sync baseline for branch "${opts.target.branch}" in ${shown}. Commit it: \`workspace diff\` reads it to say which side changed.`);
  }
  return { destination, branch: opts.target.branch, file: shown, objects: Object.keys(opts.digests.objects).length, changed: result.changed };
}

/**
 * The stored label of the branch a command read or wrote: the one `typed`
 * names, or the live one when it names none. `undefined` when the listing
 * cannot say. A baseline is keyed by label, so the label has to be the one the
 * instance stores, not the one a user typed.
 */
export function storedBranchLabel(branches: readonly BranchRecord[] | undefined, typed: string | undefined): string | undefined {
  if (typed !== undefined) return (branches === undefined ? undefined : findBranch(branches, typed)?.label) ?? typed.trim();
  return branches === undefined ? undefined : liveBranchLabel(branches);
}

/** {@link storedBranchLabel}, reading the listing. A listing that fails leaves the label unknown. */
export async function syncBranchLabel(auth: ResolvedAuth, typed: string | undefined): Promise<string | undefined> {
  const branches = await listBranches(auth, { baseUrl: auth.instance, workspaceId: auth.workspaceId }).catch(() => undefined);
  return storedBranchLabel(branches, typed);
}
