/**
 * The command side of the landing record (see `lock/landed.ts`): where a
 * landing is written — `xano.lock` for a workspace or a tenant, the uncommitted
 * `.xano/ephemeral.json` for an ephemeral — and the one line that says so.
 *
 * Every landing command calls {@link recordLanding} AFTER its write succeeded,
 * never on a dry run and never on a decline. A record that cannot be written
 * does not fail the command — the objects are on the destination whatever the
 * record says — but it is said, because the next `--prune` will refuse them.
 */
import { resolve, dirname, join, basename } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ParsedArgs } from "./cli.js";
import { info, warn } from "./ui.js";
import { displayPath } from "../util/rel-path.js";
import { shellQuote } from "../util/shell-quote.js";
import { contextFlags } from "./context-flags.js";
import { forgetPrunedInLockFile, readLockFile, recordLandingInLockFile, writeLockFile } from "../lock/io.js";
import { displayLockKey, type LandedEntry, type LockFile } from "../lock/lock.js";
import {
  destinationKey,
  isEphemeralDestinationKey,
  landedIdentities,
  landedOn,
  type LandingDestination,
  type LandingUpdate,
  withoutLanding,
  withStoredColumns,
} from "../lock/landed.js";
import {
  clearEphemeralLanding,
  ephemeralLandedOn,
  ephemeralStatePath,
  recordEphemeralLanding,
} from "../deploy/ephemeral-state.js";
import { backendDirIn } from "./backend-dir.js";

/** What a landing wrote down, as `--json` reports it (`null` when nothing was recorded). */
export interface LandingReport {
  /** The destination key the record is kept under. */
  destination: string;
  /**
   * The file the record is kept in — the lock, or `.xano/ephemeral.json` for an
   * ephemeral — spelled from the directory the command was typed in.
   */
  file: string;
  /** How many identities the destination's record now holds. */
  recorded: number;
  /** Whether the file changed. */
  changed: boolean;
  /**
   * The destination now holds another source's objects — a release or a copy
   * that is not this project's replaced it — so its record was emptied.
   */
  cleared: boolean;
  /**
   * The lock entries a confirmed `--prune` dropped from the lock's `objects`
   * with the objects it deleted, in the SDK's spelling (`table:notes`) — what
   * stderr says as "Dropped the N entries the prune deleted" (E2E pass 22).
   * Empty when nothing was pruned.
   */
  lockDropped: string[];
  /**
   * For a landing read as another source's: every identity it carried that
   * this project's lock does not know — why it was not recorded, which the
   * text names capped (E2E pass 30: only the text had it). Empty otherwise.
   */
  unmatched: string[];
}

/**
 * The lock a landing is recorded in, or `undefined` when there is none to use.
 *
 * `--no-lock` builds without one, so there is nothing to record into. An
 * explicit `--lock` wins; an entry file has its lock beside it; with neither —
 * a `--bundle` build, or a command that names a release rather than a file —
 * the project the command runs in, when it has one. `fromProject: false` stops
 * at the entry file, for the one command (`deploy --to --bundle`) where a lock
 * found by walking would describe some other build than the bundle sent.
 */
export function landingLockPath(args: ParsedArgs, opts: { entryFile?: string; fromProject?: boolean } = {}): string | undefined {
  if (args.noLock) return undefined;
  if (args.lockPath !== undefined) return resolve(args.lockPath);
  if (opts.entryFile !== undefined) return join(dirname(resolve(opts.entryFile)), "xano.lock");
  if (opts.fromProject === false) return undefined;
  // The project's backend directory, as a bare `deploy` finds its entry.
  const lock = join(backendDirIn(process.cwd()), "xano.lock");
  return existsSync(lock) ? lock : undefined;
}

/**
 * One destination's record, for `--prune`: read from the ephemeral local state
 * for an `/ephemeral/` key, otherwise from the lock at `lockPath`. `file` is
 * where it is kept, as displayed; `local` says it is the uncommitted state.
 */
export function landedRecordFor(
  lockPath: string,
  destKey: string,
): { record: Readonly<Record<string, LandedEntry>> | undefined; file: string; local: boolean } {
  if (isEphemeralDestinationKey(destKey)) {
    const dir = process.cwd();
    return { record: ephemeralLandedOn(dir, destKey), file: displayPath(ephemeralStatePath(dir)), local: true };
  }
  return { record: landedOn(readLockFile(lockPath), destKey), file: displayPath(lockPath), local: false };
}

/**
 * The identities a landing carries that this project cannot vouch for, in the
 * SDK's spelling (`table:notes`). Empty means the landing is this project's.
 *
 * An identity is vouched for when the lock pins it under the same key and guid
 * — or, for a release this project cut before it changed (E2E pass 29: a table
 * pruned from code since read as another source's), when its guid is one this
 * project has held: under another key in the lock (renamed since), in any
 * landing record, or in the lock's committed history. At least one identity
 * must match the lock as it is: an archive nothing current matches is not
 * this project's, whatever its history.
 */
export function unvouchedIdentities(
  identities: Readonly<Record<string, LandedEntry>>,
  lock: LockFile | undefined,
  lockPath: string | undefined,
): string[] {
  const keys = Object.keys(identities);
  if (lock === undefined || keys.length === 0) return keys.map((k) => displayLockKey(k));
  const exact = (key: string): boolean => {
    const entry = lock.objects[key];
    if (entry?.guid !== identities[key]!.guid) return false;
    // `agent` and `mcpServer` share a key and a guid; the lock says which.
    return !key.startsWith("toolset:") || (entry.type === "agent") === (identities[key]!.type === "agent");
  };
  const matched = keys.filter(exact);
  if (matched.length === 0) return keys.map((k) => displayLockKey(k));
  const rest = keys.filter((k) => !exact(k));
  if (rest.length === 0) return [];
  const held = new Set<string>([
    ...Object.values(lock.objects).flatMap((e) => (e.guid === undefined ? [] : [e.guid])),
    ...Object.values(lock.landed ?? {}).flatMap((record) => Object.values(record).map((e) => e.guid)),
  ]);
  const inHistory = rest.length <= HISTORY_LOOKUPS && lockPath !== undefined ? guidInLockHistory(lockPath) : undefined;
  return rest
    .filter((k) => {
      const guid = identities[k]!.guid;
      return !held.has(guid) && inHistory?.(guid) !== true;
    })
    .map((k) => displayLockKey(k));
}

/** How many unmatched identities are looked up in the lock's history before it is not asked at all. */
const HISTORY_LOOKUPS = 25;

/**
 * Whether a guid appears in any committed version of the lock — `undefined`
 * when there is no usable history (no git, a shallow clone, an untracked lock).
 */
function guidInLockHistory(lockPath: string): ((guid: string) => boolean) | undefined {
  const git = (...argv: string[]): string =>
    execFileSync("git", argv, {
      cwd: dirname(resolve(lockPath)),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf8",
    }).trim();
  const file = `./${basename(lockPath)}`;
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") return undefined;
    if (git("log", "-1", "--format=%H", "--", file) === "") return undefined;
  } catch {
    return undefined;
  }
  return (guid) => {
    try {
      return git("log", "-1", "--format=%H", `-S${JSON.stringify(guid)}`, "--", file) !== "";
    } catch {
      return false;
    }
  };
}

/**
 * Record a landing whose objects were NOT compiled here — a release, or another
 * backend's copy. They are this project's when every identity they carry is one
 * this project can vouch for (see {@link unvouchedIdentities}) — the one sign
 * available that the release was cut from this project. When they are not, a
 * `replace` still has to CLEAR the destination's record — everything recorded
 * there was just replaced by something that is not known to be this project's —
 * and an additive landing records nothing. The clearing names the identities
 * that failed to match.
 */
export function recordForeignLanding(opts: {
  lockPath: string | undefined;
  instance: string;
  dest: LandingDestination;
  /** The decoded archive that landed. */
  bundle: unknown;
  mode: "replace" | "merge";
  /** What a `--prune` removed, recorded only when the landing is this project's. */
  removed?: LandingUpdate["removed"];
  /**
   * What a `--keep-data` merge deleted, by guid: each lock entry pinning one is
   * removed as {@link removed} is, when the landing is this project's.
   */
  removedGuids?: readonly string[];
  /** What deleted the removed objects, as the dropped-entries line names it. */
  removedBy?: "prune" | "merge";
  /** Per table guid, the column storage after the landing (see `LandedEntry.columns`). */
  stored?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** What landed could not be read back, so whose objects they are is unknown — said as that, not as another source's. */
  unreadable?: boolean;
}): LandingReport | null {
  let lock;
  if (opts.lockPath !== undefined && existsSync(opts.lockPath)) {
    try {
      lock = readLockFile(opts.lockPath);
    } catch {
      // The same unreadable lock the record would be written into; `recordLanding`
      // says so for the case that matters (a replace), so say nothing twice here.
      lock = undefined;
    }
  } else if (opts.dest.kind !== "ephemeral") {
    // No lock, no record to keep — except an ephemeral's, which lives in local state.
    return null;
  }
  const identities = landedIdentities(opts.bundle);
  const unvouched = unvouchedIdentities(identities, lock, opts.lockPath);
  const ours = lock !== undefined && Object.keys(identities).length > 0 && unvouched.length === 0;
  if (!ours && opts.mode === "merge") return null;
  const removed = ours ? { ...removedByGuid(lock, opts.removedGuids), ...(opts.removed ?? {}) } : {};
  return recordLanding({
    lockPath: opts.lockPath,
    instance: opts.instance,
    dest: opts.dest,
    update: {
      mode: opts.mode,
      identities: ours ? withStoredColumns(identities, opts.stored) : {},
      ...(Object.keys(removed).length > 0 ? { removed } : {}),
    },
    ...(opts.removedBy !== undefined ? { removedBy: opts.removedBy } : {}),
    foreign: !ours,
    ...(ours ? {} : { unmatched: unvouched }),
    ...(opts.unreadable === true ? { unreadable: true } : {}),
  });
}

/** The lock entries pinning any of `guids`, as a landing's `removed` names them. */
function removedByGuid(lock: LockFile | undefined, guids: readonly string[] | undefined): Record<string, LandedEntry> {
  if (lock === undefined || guids === undefined || guids.length === 0) return {};
  const gone = new Set(guids);
  const out: Record<string, LandedEntry> = {};
  for (const [key, entry] of Object.entries(lock.objects)) {
    if (entry.guid !== undefined && gone.has(entry.guid)) out[key] = { guid: entry.guid };
  }
  return out;
}

/**
 * Record what a successful write landed, and say so. Returns the report the
 * command's `--json` document carries, or `null` when nothing was recorded.
 *
 * An ephemeral's record goes to the local state in the working directory,
 * lock or not: it names what the bundle SENT carried, so it needs no lock to
 * describe it, and it is never committed. It is written silently, like the rest
 * of that state; a workspace's or a tenant's is said, because it changes a
 * committed file.
 */
export function recordLanding(opts: {
  lockPath: string | undefined;
  /** The credential's instance — the host half of the destination key. */
  instance: string;
  dest: LandingDestination;
  update: LandingUpdate;
  /** What landed is NOT this project's (a release or copy that does not match the lock). */
  foreign?: boolean;
  /** For a foreign landing: the identities that failed to match, named (capped) in what is said. */
  unmatched?: readonly string[];
  /** What deleted `update.removed`, as the dropped-entries line names it. */
  removedBy?: "prune" | "merge";
  /** For a foreign landing: what landed could not be read back, so it is not known to be another source's. */
  unreadable?: boolean;
}): LandingReport | null {
  const destination = destinationKey(opts.instance, opts.dest);
  const cleared = opts.foreign === true && opts.update.mode === "replace";
  const why = unmatchedPhrase(opts.unmatched);
  const serves =
    opts.unreadable === true
      ? `objects this project cannot confirm as its own (the release archive could not be read back)`
      : `another source's objects${why}`;
  const unmatched = opts.foreign === true ? [...(opts.unmatched ?? [])] : [];
  if (opts.dest.kind === "ephemeral") {
    const dir = process.cwd();
    const shown = displayPath(ephemeralStatePath(dir));
    try {
      const result = recordEphemeralLanding(dir, destination, opts.update);
      // A routine record stays silent, as the rest of that state does. A
      // CLEAR is said: it changes what a later `--prune` there may delete.
      if (cleared && result.changed) {
        // Worded by what an ephemeral's record governs: a bare `deploy --prune`
        // is refused, so "`--prune` there" named nothing runnable. Its record
        // scopes `--keep-data`'s removal lines and a `--to tenant:<it> --prune`.
        info(
          `Cleared this project's landing record for ${destination} in ${shown} — it now serves ${serves}. ` +
            `Until this project lands there again, a \`--keep-data\` deploy lists what it ` +
            `removes there as another source's, and \`xanosdk deploy --to tenant:${shellQuote(opts.dest.name)} --prune` +
            `${contextFlags()}\` refuses to delete any of it.`,
        );
      }
      // The record is local, but the lock's `objects` still pin what the prune
      // deleted: drop them, as a tenant's or a workspace's landing does.
      let lockDropped: string[] = [];
      if (opts.lockPath !== undefined && opts.update.removed !== undefined) {
        try {
          lockDropped = forgotPruned(displayPath(opts.lockPath), forgetPrunedInLockFile(opts.lockPath, opts.update), opts.removedBy);
        } catch (err) {
          unforgotten(displayPath(opts.lockPath), err);
        }
      }
      return { destination, file: shown, recorded: result.recorded, changed: result.changed, cleared, lockDropped, unmatched };
    } catch (err) {
      unrecorded(shown, err);
      return null;
    }
  }
  if (opts.lockPath === undefined) return null;
  let result;
  try {
    result = recordLandingInLockFile(opts.lockPath, destination, opts.update);
  } catch (err) {
    unrecorded(displayPath(opts.lockPath), err);
    return null;
  }
  if (result === undefined) return null;
  const shown = displayPath(opts.lockPath);
  // Worded by what happened. A replace by something that is not this project's
  // EMPTIES the record — "recorded what this project landed" there described a
  // record that had just been removed.
  if (result.changed) {
    info(
      cleared
        ? `Cleared this project's landing record for ${destination} in ${shown} — it now serves ${serves}, ` +
            `so \`--prune\` there deletes nothing until this project lands again. Commit it.`
        : `Recorded what this project landed on ${destination} in ${shown} — commit it: ` +
            `\`--prune\` deletes only what this record names.`,
    );
  } else if (cleared) {
    // Nothing to clear, but still not silent (E2E pass 28: `landingRecord`
    // said `cleared: true, recorded: 0` and the text said nothing): what landed
    // is not this project's, so no record is kept for it.
    info(
      `Recorded nothing for ${destination} in ${shown} — ` +
        (opts.unreadable === true
          ? `what landed could not be checked against this project's lock (the release archive could not be read back), so`
          : `what landed does not match this project's lock (another source's objects${why}), so`) +
        ` \`--prune\` from here deletes nothing there until this project lands again.`,
    );
  }
  const lockDropped = forgotPruned(shown, result.forgotten, opts.removedBy);
  return { destination, file: shown, recorded: result.recorded, changed: result.changed, cleared, lockDropped, unmatched };
}

/**
 * ` (3 identities this project's lock does not know: table:a, …)` — the reason
 * a landing read as another source's, capped — or "" when none were named.
 */
function unmatchedPhrase(unmatched: readonly string[] | undefined): string {
  if (unmatched === undefined || unmatched.length === 0) return "";
  const SHOWN = 5;
  const n = unmatched.length;
  const listed = unmatched.slice(0, SHOWN).join(", ") + (n > SHOWN ? `, and ${n - SHOWN} more` : "");
  return ` (${n === 1 ? "1 identity" : `${n} identities`} this project's lock does not know: ${listed})`;
}

/**
 * Whether this project holds a landing record for a backend — an ephemeral's in
 * the local state, a tenant's in the lock. A delete whose outcome is unknown
 * says it kept the record only when there was one to keep.
 */
export function holdsLanding(
  lockPath: string | undefined,
  instance: string,
  dest: { kind: "ephemeral" | "tenant"; name: string },
): boolean {
  try {
    const key = destinationKey(instance, dest);
    if (dest.kind === "ephemeral") return ephemeralLandedOn(process.cwd(), key) !== undefined;
    if (lockPath === undefined || !existsSync(lockPath)) return false;
    return landedOn(readLockFile(lockPath), key) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Forget what this project landed on a backend that was just deleted: an
 * ephemeral's record from the local state, a tenant's from the lock (said, since
 * it changes a committed file). Best effort — the delete stands either way.
 * Returns where a record was removed from, as displayed, or `undefined`.
 */
export function forgetLanding(
  lockPath: string | undefined,
  instance: string,
  dest: { kind: "ephemeral" | "tenant"; name: string },
): string | undefined {
  try {
    if (dest.kind === "ephemeral") {
      const dir = process.cwd();
      return clearEphemeralLanding(dir, instance, dest.name) ? displayPath(ephemeralStatePath(dir)) : undefined;
    }
    if (lockPath === undefined || !existsSync(lockPath)) return undefined;
    const lock = readLockFile(lockPath);
    const next = withoutLanding(lock, destinationKey(instance, dest));
    if (next === lock || !writeLockFile(lockPath, next)) return undefined;
    const shown = displayPath(lockPath);
    info(`Removed its landing record from ${shown} — commit it.`);
    return shown;
  } catch {
    return undefined;
  }
}

/**
 * Says the prune's deleted identities left the lock's `objects`, when any did,
 * and returns their keys as `--json` names them.
 */
function forgotPruned(shown: string, keys: readonly string[] | undefined, by: "prune" | "merge" = "prune"): string[] {
  const n = keys?.length ?? 0;
  if (n === 0) return [];
  info(
    `Dropped the ${n === 1 ? "entry" : `${n} entries`} the ${by} deleted from ${shown}'s objects, so the next ` +
      `export does not read ${n === 1 ? "it" : "them"} as renamed or deleted — commit it.`,
  );
  return keys!.map((key) => displayLockKey(key));
}

function unforgotten(shown: string, err: unknown): void {
  warn(
    `The prune landed, but ${shown} could not be updated: ${err instanceof Error ? err.message : String(err)}`,
    "landing.record-failed",
    ["The next export reads the deleted objects' entries as orphans; drop them with `xanosdk lock prune <entry-file>`."],
  );
}

function unrecorded(shown: string, err: unknown): void {
  warn(
    `The write landed, but it could not be recorded in ${shown}: ${err instanceof Error ? err.message : String(err)}`,
    "landing.record-failed",
    [
      "A later `--prune` here deletes only what that record names, so it will refuse these objects until a landing is recorded.",
    ],
  );
}
