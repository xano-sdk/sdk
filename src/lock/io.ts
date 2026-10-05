/**
 * Node-only lock-file I/O. Kept out of `lock.ts` (which stays browser-safe: the
 * pure lock model is reachable from the authoring surface) so importing a
 * workspace def in a frontend bundle never pulls in `node:fs`. Reachable only
 * through the `@xano/sdk/node` entry, the CLI, and lock-command tooling.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { parseLockReport, serializeLock, type LockFile, type SyncSource } from "./lock.js";
import { nextBaseline, syncedOn, withSyncBaseline, type SyncDigests } from "./synced.js";
import { applyLanding, withoutPrunedObjects, type LandingUpdate } from "./landed.js";
import { tagLockSource } from "./store.js";

/** Read + strictly validate a lock file from disk. The file must exist. */
export function readLockFile(path: string, opts: { tolerateDuplicates?: boolean } = {}): LockFile {
  return readLockFileReport(path, opts).lock;
}

/**
 * {@link readLockFile}, plus the legacy ephemeral landing records the load
 * dropped — see `parseLockReport`. A non-empty list means the file on disk
 * differs from the lock it loads as, so a writer must count it as a change.
 */
export function readLockFileReport(
  path: string,
  opts: { tolerateDuplicates?: boolean } = {},
): { lock: LockFile; droppedLandings: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read lock file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const report = parseLockReport(text, path, { ...opts, lockFile: path });
  tagLockSource(report.lock, resolve(path));
  return report;
}

/**
 * Atomic, idempotent write: unchanged bytes are not rewritten (mtime stays
 * put, watchers stay quiet); changed content lands via temp-file+rename so a
 * crash can never leave a half-written lock.
 *
 * Returns true when the file was (re)written.
 */
export function writeLockFile(path: string, lock: LockFile): boolean {
  const next = serializeLock(lock);
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === next) return false;
    } catch {
      // Unreadable existing file — fall through and replace it.
    }
  }
  atomicWrite(path, next);
  return true;
}

/**
 * Record a landing in the lock file at `path` (see `landed.ts`). Returns
 * `undefined` when there is no lock there — a landing record lives beside the
 * identities it names, and a project building without a lock has none — and
 * otherwise whether the file changed and how many identities the destination's
 * record now holds.
 */
export function recordLandingInLockFile(
  path: string,
  destKey: string,
  update: LandingUpdate,
): { changed: boolean; recorded: number; forgotten: string[] } | undefined {
  if (!existsSync(path)) return undefined;
  const lock = readLockFile(path);
  const next = applyLanding(lock, destKey, update);
  const changed = writeLockFile(path, next);
  return {
    changed,
    recorded: Object.keys(next.landed?.[destKey] ?? {}).length,
    forgotten: Object.keys(lock.objects).filter((key) => !(key in next.objects)),
  };
}

/**
 * Drop the identities a successful prune deleted from the lock's `objects` at
 * `path` — for a landing whose record is kept elsewhere (an ephemeral's). Returns
 * the keys that went; none when there is no lock or nothing to drop.
 */
export function forgetPrunedInLockFile(path: string, update: Pick<LandingUpdate, "identities" | "removed">): string[] {
  if (!existsSync(path)) return [];
  const lock = readLockFile(path);
  const objects = withoutPrunedObjects(lock.objects, update);
  if (objects === lock.objects) return [];
  writeLockFile(path, { ...lock, objects });
  return Object.keys(lock.objects).filter((key) => !(key in objects));
}

/**
 * Record a branch's sync baseline in the lock file at `path` (see
 * `deploy/sync-baseline.ts`, stored by `synced.ts`). `undefined` when there is no lock there, as for a
 * landing; otherwise whether the file changed. A sync that found the branch as
 * the baseline already describes it leaves the file alone.
 */
export function recordSyncInLockFile(
  path: string,
  destKey: string,
  branch: string,
  sync: { digests: SyncDigests; by: SyncSource; complete: boolean },
): { changed: boolean } | undefined {
  if (!existsSync(path)) return undefined;
  const lock = readLockFile(path);
  const baseline = nextBaseline(syncedOn(lock, destKey, branch), sync.digests, sync.by, sync.complete);
  return { changed: writeLockFile(path, withSyncBaseline(lock, destKey, branch, baseline)) };
}
