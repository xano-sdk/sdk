/**
 * The sync baseline as the lock stores it: reading one branch's baseline,
 * setting it, and deciding whether a new sync changes it. What a baseline
 * MEANS, and how a diff reads it, is `deploy/sync-baseline.ts`.
 *
 * Pure and browser-safe, like `landed.ts`; the file I/O is in `io.ts`.
 */
import { withSyncedOf, type LockFile, type SyncBaseline, type SyncSource } from "./lock.js";

/** The digests a sync records: the project's objects, and the branch's others. */
export interface SyncDigests {
  /** The digest scheme they were taken under (see `deploy/sync-baseline.ts`). */
  readonly scheme: number;
  readonly objects: Readonly<Record<string, string>>;
  readonly others: Readonly<Record<string, string>>;
}

/** The baseline recorded for one workspace branch, or `undefined`. */
export function syncedOn(lock: LockFile | undefined, destKey: string, branch: string): SyncBaseline | undefined {
  const record = lock?.synced?.[destKey];
  return record !== undefined && Object.hasOwn(record, branch) ? record[branch] : undefined;
}

/** The lock with one branch's baseline set (pure). */
export function withSyncBaseline(lock: LockFile, destKey: string, branch: string, baseline: SyncBaseline): LockFile {
  const synced = { ...(lock.synced ?? {}) };
  synced[destKey] = { ...(synced[destKey] ?? {}), [branch]: baseline };
  const { synced: _old, ...rest } = lock;
  return withSyncedOf(rest, { synced });
}

/**
 * The baseline to store after a sync, keeping `previous` (its `at` and `by`)
 * when the branch holds exactly what it already records, so a sync that
 * changed nothing does not churn the committed lock. The lock's writer sorts
 * the labels.
 */
export function nextBaseline(
  previous: SyncBaseline | undefined,
  digests: SyncDigests,
  by: SyncSource,
  complete: boolean,
  now: () => Date = () => new Date(),
): SyncBaseline {
  if (
    previous !== undefined &&
    previous.complete === complete &&
    previous.scheme === digests.scheme &&
    sameDigests(previous.objects, digests.objects) &&
    sameDigests(previous.others ?? {}, digests.others)
  ) {
    return previous;
  }
  return {
    at: now().toISOString(),
    by,
    scheme: digests.scheme,
    complete,
    objects: { ...digests.objects },
    ...(Object.keys(digests.others).length > 0 ? { others: { ...digests.others } } : {}),
  };
}

function sameDigests(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
