/**
 * Where a fetched engine LIVES on this machine, and what proves it is still the
 * thing that was fetched.
 *
 * One cache entry is a directory holding two files: the executable, and the
 * record of where it came from and what its bytes hashed to when they arrived.
 * The record is the whole point. Once the bytes are on disk, "identical to what
 * was fetched" is a claim this side CAN keep, and it is the one that matters:
 * anything able to write the cache path would otherwise get execution on every
 * later deploy, silently.
 *
 * Entries live in two namespaces under `bin/`: `v<semver>/` for a published
 * release, which is a hit by version alone, and `src-<hash>/` for an override
 * the operator named on the flag. Only {@link engineEntryDirName} builds those
 * names, so no caller-supplied string ever becomes a path segment. A directory
 * of any other shape — including the old URL-hash layout — is not an entry.
 *
 * So the digest is re-checked immediately before every spawn rather than only
 * at download ({@link verifiedEngineExecutable}), and the directory holding the
 * executable is the control ({@link assertSafeCacheDir}) — a path anything on
 * the machine can write is a path the digest check cannot save, because whoever
 * rewrote the executable could rewrite the record beside it.
 *
 * Nothing here knows anything about where engines are published. A URL is an
 * opaque identifier here, never interpreted.
 *
 * Node-only, reached by a lazy import from the command layer; never from the
 * browser-safe authoring bundle.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { sha256Hex } from "../util/sha256.js";
import { localEngineBinDir, localEngineHome } from "./local-engine-config.js";

/** The executable inside a cache entry. Named by US, not by the archive. */
export const ENGINE_EXECUTABLE_FILE = "engine";

/** The record beside it: where it came from and the digest of its bytes. */
export const ENGINE_RECORD_FILE = "engine.json";

/** Which namespace an entry lives in: a published release, or an operator-named override. */
export type EngineEntrySource = "release" | "override";

/**
 * How an entry is looked up: a release by its version (`v0.1.5`), an override
 * by the source the operator named (a URL, or a resolved archive path).
 */
export type EngineEntryKey = { readonly version: string } | { readonly source: string };

/**
 * One cached engine: an executable, and the facts that identify it.
 *
 * `url` and `digest` together are what a deploy records as the engine's
 * identity, so a later run can say which engine a backend was stood up on.
 */
export interface EngineCacheEntry {
  /** The entry's own directory under the bin directory. */
  dir: string;
  /** Absolute path of the executable. Never spawn this without {@link verifiedEngineExecutable}. */
  executable: string;
  /** Which namespace it lives in. */
  source: EngineEntrySource;
  /** The release version (`v0.1.5`), on a release entry only. */
  version?: string;
  /** Where the bytes came from, verbatim: the release's download URL, or the override source. */
  url: string;
  /** SHA-256 of the executable's bytes, as recorded at fetch time. */
  digest: string;
  /**
   * SHA-256 of the ARCHIVE the executable came out of, when one was recorded.
   *
   * Surfaced rather than kept private because it is what answers "is the source
   * still the same engine" for a source whose CONTENTS can change under a
   * stable identity — a local archive path. A URL is not re-read, so this stays
   * a fact about provenance there. Absent on an entry staged before it was
   * recorded, which is not "unchanged": it is "nothing to compare".
   */
  archiveDigest?: string;
  /** Epoch ms the entry was staged. Orders {@link listOverrideEntries}. */
  fetchedAt: number;
}

/**
 * A canonical release version, `vMAJOR.MINOR.PATCH` — the shape the pin stores, a
 * record names, and a release directory is called. The only version shape a path
 * is ever built from.
 */
export const RELEASE_VERSION = /^v\d+\.\d+\.\d+$/;

/** An override directory name: a fixed prefix and a truncated hex digest. */
const OVERRIDE_DIR = /^src-[0-9a-f]{16}$/;

/**
 * The directory name for an entry — `v<semver>` for a release, `src-<hash>`
 * for an override, and nothing else, ever.
 *
 * A version is checked against the exact shape BEFORE it is used, and refused
 * otherwise, because it is the one key that is spelled into the path as given:
 * `../x` or `v1/2` would otherwise address somewhere outside the cache. Callers
 * normalize first (`0.1.5` → `v0.1.5`); this does not, so a spelling that
 * slipped past normalization is a refusal rather than a second entry.
 *
 * An override is a digest of its source rather than any part of it: the path
 * lands in error text, in `ls`, and in a support paste, and none of those
 * should spell where the engine came from. Truncated because this is a cache
 * key, not a security claim — the entry's own record holds the full source.
 */
export function engineEntryDirName(key: EngineEntryKey): string {
  if ("version" in key) {
    if (!RELEASE_VERSION.test(key.version)) {
      throw new Error(
        `"${key.version}" is not an engine version — they are written vMAJOR.MINOR.PATCH, like ` +
          `v0.1.5 — so no cache path was built from it.`,
      );
    }
    return key.version;
  }
  return `src-${sha256Hex(key.source).slice(0, 16)}`;
}

/** Where the entry for `key` is cached. */
export function engineEntryDir(key: EngineEntryKey, env: NodeJS.ProcessEnv = process.env): string {
  return join(localEngineBinDir(env), engineEntryDirName(key));
}

function ownerUid(): number | undefined {
  // Absent on Windows — which has no engine build, so this never runs there.
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Refuse a cache path anything but this user can write into, or that a symlink
 * redirects.
 *
 * Checked on the cache root and EVERY component beneath it down to `dir`,
 * because the weakest component is the one that decides: a 0700 entry directory
 * inside a world-writable `bin/` can be replaced wholesale by anyone.
 *
 * It stops at the root — including a root the override names — rather than
 * walking up to `/`. Above the root the path is the machine's own business
 * (`/home` is not ours to audit, and `/tmp` is world-writable BY DESIGN with a
 * sticky bit this check cannot read as safe), and a refusal there would name a
 * cause the user cannot act on.
 *
 * A component that does not exist yet passes: it will be created 0700 by the
 * staging below, and the creation is what makes it ours.
 */
export function assertSafeCacheDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = localEngineHome(env);
  // The root may itself be a symlink (a relocated cache is an ordinary thing to
  // do), so it is resolved once and the components BELOW it are then checked as
  // links — where a symlink is a redirect past every check above it.
  let base: string;
  try {
    base = realpathSync(home);
  } catch {
    return; // Nothing exists yet: the first mkdir creates it, 0700, ours.
  }
  const rel = relative(home, dir);
  // A path outside the root is checked on its own rather than walked: the walk
  // only means anything for the components this feature owns.
  const tail = rel === "" || rel.startsWith("..") || isAbsolute(rel) ? [] : rel.split(sep);
  let current = base;
  for (const part of [undefined, ...tail]) {
    if (part !== undefined) current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return; // Not created yet, and neither is anything below it.
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `The Xano Engine cache path is a symlink, and a symlink points somewhere these ` +
          `checks never looked: ${current}\n` +
          `Replace it with a real directory, or point the cache elsewhere with ` +
          `XANOSDK_ENGINE_HOME.`,
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(
        `The Xano Engine cache is writable by other users on this machine: ${current}\n` +
          `Anything that can write there can replace the engine executable, and an executable ` +
          `this SDK spawns is not a file to leave open. Run \`chmod go-w\` on it, or point the ` +
          `cache somewhere private with XANOSDK_ENGINE_HOME.`,
      );
    }
    const uid = ownerUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(
        `The Xano Engine cache is owned by another user: ${current}\n` +
          `An executable this SDK spawns has to be one only you can replace. Take ownership of ` +
          `it, or point the cache somewhere you own with XANOSDK_ENGINE_HOME.`,
      );
    }
  }
}

interface EngineRecord {
  source: EngineEntrySource;
  /** Present on a release record, and equal to its directory's name. */
  version?: string;
  url: string;
  digest: string;
  fetchedAt: number;
  /**
   * The digest of the ARCHIVE the executable came out of.
   *
   * It is what a published checksum was compared against at fetch time, so
   * keeping it means a later question about which artifact this entry came from
   * has an answer — and it is what a LOCAL archive path is re-checked against,
   * since the file under a path can be replaced while the path stays the same.
   * The executable's own digest is still what guards the spawn.
   */
  archiveDigest?: string;
}

function readRecord(dir: string): EngineRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ENGINE_RECORD_FILE), "utf8")) as Partial<EngineRecord>;
    if (typeof raw.url !== "string" || typeof raw.digest !== "string") return undefined;
    if (raw.source !== "release" && raw.source !== "override") return undefined;
    if (raw.source === "release" && typeof raw.version !== "string") return undefined;
    return {
      source: raw.source,
      ...(raw.source === "release" ? { version: raw.version! } : {}),
      url: raw.url,
      digest: raw.digest,
      fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0,
      ...(typeof raw.archiveDigest === "string" ? { archiveDigest: raw.archiveDigest } : {}),
    };
  } catch {
    // A half-written or hand-edited record is not an entry. Treated as absent
    // so the run re-fetches rather than refusing on a file nobody meant to keep.
    return undefined;
  }
}

/**
 * The entry in `dir`, when the directory's NAME and its record agree about
 * what it is.
 *
 * A release directory must hold a release record for that same version, and an
 * override directory an override record. Anything else — a record copied
 * between directories, a hand-edited version, the old layout's bare hash — is
 * not an entry, so a lookup by version can only ever return that version.
 */
function entryAt(dir: string, name: string): EngineCacheEntry | undefined {
  const record = readRecord(dir);
  if (record === undefined) return undefined;
  if (RELEASE_VERSION.test(name)) {
    if (record.source !== "release" || record.version !== name) return undefined;
  } else if (OVERRIDE_DIR.test(name)) {
    if (record.source !== "override") return undefined;
  } else {
    return undefined;
  }
  const executable = join(dir, ENGINE_EXECUTABLE_FILE);
  try {
    if (!statSync(executable).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return {
    dir,
    executable,
    source: record.source,
    ...(record.version !== undefined ? { version: record.version } : {}),
    url: record.url,
    digest: record.digest,
    fetchedAt: record.fetchedAt,
    ...(record.archiveDigest !== undefined ? { archiveDigest: record.archiveDigest } : {}),
  };
}

/**
 * The engine cached for `key`, or `undefined` when there is none to run.
 *
 * Absent covers both "never fetched" and "the entry is not usable as one" — a
 * missing executable, an unreadable record. Whether the bytes still MATCH is a
 * separate question with a separate answer, because a mismatch is a refusal
 * rather than a cache miss: see {@link verifiedEngineExecutable}. A version
 * that is not `v<semver>` is a refusal too, before any path is built.
 */
export function readEngineEntry(
  key: EngineEntryKey,
  env: NodeJS.ProcessEnv = process.env,
): EngineCacheEntry | undefined {
  const name = engineEntryDirName(key);
  return entryAt(join(localEngineBinDir(env), name), name);
}

/** Every usable entry under `bin/` whose directory name `pattern` accepts. */
function entriesMatching(pattern: RegExp, env: NodeJS.ProcessEnv): EngineCacheEntry[] {
  const bin = localEngineBinDir(env);
  let names: string[];
  try {
    names = readdirSync(bin, { withFileTypes: true })
      .filter((e) => e.isDirectory() && pattern.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.flatMap((name) => entryAt(join(bin, name), name) ?? []);
}

/** `v1.2.3` as three numbers, for ordering. Only ever called on a name {@link RELEASE_VERSION} accepted. */
function semverParts(version: string): number[] {
  return version.slice(1).split(".").map(Number);
}

/**
 * Every cached release, newest VERSION first.
 *
 * By semver rather than fetch time or spelling: `v0.1.10` is newer than
 * `v0.1.9`, and pulling an older pin onto a machine does not make it the
 * newest engine it has.
 */
export function listReleaseEntries(env: NodeJS.ProcessEnv = process.env): EngineCacheEntry[] {
  return entriesMatching(RELEASE_VERSION, env).sort((a, b) => {
    const pa = semverParts(a.version!);
    const pb = semverParts(b.version!);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
    return 0;
  });
}

/**
 * Every cached override, most recently fetched first.
 *
 * Overrides have no version to order by, so the last one staged is the one
 * that leads.
 */
export function listOverrideEntries(env: NodeJS.ProcessEnv = process.env): EngineCacheEntry[] {
  return entriesMatching(OVERRIDE_DIR, env).sort((a, b) => b.fetchedAt - a.fetchedAt);
}

/** An old-layout directory name: a bare truncated hex hash of the engine's URL. */
const LEGACY_DIR = /^[0-9a-f]{16}$/;

/**
 * Every old-layout directory under `bin/`, by absolute path and sorted by name.
 *
 * Never an entry — nothing runs from one — but still disk this cache holds, so
 * `cache list` shows them and `cache clear` removes them.
 */
export function listLegacyCacheDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const bin = localEngineBinDir(env);
  try {
    return readdirSync(bin, { withFileTypes: true })
      .filter((e) => e.isDirectory() && LEGACY_DIR.test(e.name))
      .map((e) => join(bin, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The path to spawn — re-hashed, right now, against the digest recorded when
 * the bytes were fetched.
 *
 * This is the check, and it belongs immediately before the spawn rather than
 * only at download. Verifying at download alone leaves a window in which
 * anything that can write the cache path gets execution on every later deploy,
 * which is exactly the window this feature would otherwise open.
 *
 * ~63MB of hashing per start, which is tens of milliseconds and is not worth
 * optimizing away with an mtime check: mtime is the one attribute the writer
 * also controls.
 */
export function verifiedEngineExecutable(
  entry: EngineCacheEntry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // The directory is half the control. A digest cannot save a path anything on
  // the machine can write, because whoever replaced the executable could
  // replace the record it is compared against — so both are checked on the one
  // call a spawn goes through, rather than leaving the caller to remember.
  assertSafeCacheDir(entry.dir, env);
  let bytes: Buffer;
  try {
    bytes = readFileSync(entry.executable);
  } catch {
    throw new Error(
      `The cached engine is gone from ${entry.dir}.\n` +
        `Re-run the same \`xanosdk deploy --local\` and it is fetched again.`,
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== entry.digest) {
    throw new Error(
      `The cached engine's bytes do not match the digest recorded when it was fetched, so it ` +
        `will not be run: ${entry.dir}\n` +
        `Something replaced it after it was downloaded. Delete that directory and re-run the ` +
        `same \`xanosdk deploy --local\` to get it again.`,
    );
  }
  return entry.executable;
}

/** What {@link stageEngine} is given: verified bytes, and what they came from. */
export interface StageEngineOptions {
  /**
   * Where the bytes came from, kept verbatim: the release's download URL, or the
   * source the operator named. Keys the entry when there is no `version`.
   */
  url: string;
  /**
   * The release version (`v0.1.5`). Present, the entry is a RELEASE staged
   * under `bin/<version>/`; absent, it is an OVERRIDE staged under
   * `bin/src-<hash of url>/`.
   */
  version?: string;
  /** The executable's bytes, already extracted and already checked. */
  executable: Uint8Array;
  /** SHA-256 of `executable`, computed by the caller before anything was written. */
  digest: string;
  /** SHA-256 of the archive those bytes came out of, when there was one. */
  archiveDigest?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: runs with the staging directory fully written and executable,
   * immediately before the rename that publishes it. Exists so the ordering
   * this function's whole shape depends on can be asserted rather than assumed.
   */
  beforeCommit?: (stagingDir: string) => void;
}

/**
 * Write an engine into the cache: stage, set the exec bit, then rename.
 *
 * The order is the point. A half-written executable at the entry path would be
 * spawned by a concurrent run, and a rename is the only step that publishes
 * atomically — so everything, including the exec bit, happens on a staging path
 * nobody looks for, and the entry either does not exist or is complete. A
 * concurrent run that published the same bytes first wins, and its entry is
 * returned: see {@link publishStaged}.
 *
 * The digest is the CALLER's, computed before any of this. Re-deriving it here
 * from the bytes being written would make the record agree with the file by
 * construction, which is the one thing the record must not do.
 */
export function stageEngine(opts: StageEngineOptions): EngineCacheEntry {
  const env = opts.env ?? process.env;
  // First, so a version that is not `v<semver>` is refused before anything —
  // even the bin directory — is created.
  const key: EngineEntryKey = opts.version !== undefined ? { version: opts.version } : { source: opts.url };
  const dir = engineEntryDir(key, env);
  const source: EngineEntrySource = opts.version !== undefined ? "release" : "override";
  const bin = localEngineBinDir(env);

  assertSafeCacheDir(bin, env);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  // Re-checked AFTER the mkdir: `recursive` is a no-op on a directory that
  // already exists, so the mode above is a claim about directories this call
  // created and about nothing else.
  assertSafeCacheDir(bin, env);

  const staging = mkdtempSync(join(bin, ".staging-"));
  try {
    const executable = join(staging, ENGINE_EXECUTABLE_FILE);
    writeFileSync(executable, opts.executable, { mode: 0o600 });
    const record: EngineRecord = {
      source,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      url: opts.url,
      digest: opts.digest,
      fetchedAt: Date.now(),
      ...(opts.archiveDigest !== undefined ? { archiveDigest: opts.archiveDigest } : {}),
    };
    atomicWrite(join(staging, ENGINE_RECORD_FILE), JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    // Last, and still on the staging path: nothing is executable at a path a
    // concurrent run would look in until the rename below.
    chmodSync(executable, 0o700);
    opts.beforeCommit?.(staging);
    const winner = publishStaged(staging, dir, opts.digest, bin);
    if (winner !== undefined) return winner;
    return {
      dir,
      executable: join(dir, ENGINE_EXECUTABLE_FILE),
      source,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      url: opts.url,
      digest: opts.digest,
      fetchedAt: record.fetchedAt,
      ...(opts.archiveDigest !== undefined ? { archiveDigest: opts.archiveDigest } : {}),
    };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** The codes a rename onto a non-empty directory fails with (Linux, and macOS). */
const ENTRY_TAKEN = new Set(["ENOTEMPTY", "EEXIST"]);

/**
 * Rename `staging` onto `dir` without ever deleting an entry a concurrent run
 * just published.
 *
 * Two first-time deploys of one version stage side by side, and both reach
 * this rename. Removing the entry first and renaming second — the obvious
 * shape — lets the loser delete the winner's entry out from under a run that
 * is about to verify and spawn it, or lose its own rename to the winner and
 * fail a deploy that had a good engine on disk. So the rename is tried FIRST,
 * and an entry already there is judged before anything touches it: the same
 * bytes are adopted (returned, with our staging discarded), and anything else
 * — a broken entry, or other bytes under the same key, like a local archive
 * rewritten in place — is moved aside by a rename, which only one run can win,
 * and deleted off the entry path.
 *
 * Returns the adopted entry, or `undefined` when ours was published.
 */
function publishStaged(
  staging: string,
  dir: string,
  digest: string,
  bin: string,
): EngineCacheEntry | undefined {
  const name = basename(dir);
  // Bounded: each pass either publishes, adopts, or clears one entry another
  // run put there, so only runs staging DIFFERENT bytes under one key at the
  // same instant can keep it going — and they get a refusal, not a spin.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(staging, dir);
      return undefined;
    } catch (err) {
      if (!ENTRY_TAKEN.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
    const existing = entryAt(dir, name);
    if (existing !== undefined && existing.digest === digest) {
      rmSync(staging, { recursive: true, force: true });
      return existing;
    }
    const retired = join(bin, `.retired-${randomBytes(8).toString("hex")}`);
    try {
      renameSync(dir, retired);
    } catch (err) {
      // Another run moved it first; the next pass renames into the gap.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    rmSync(retired, { recursive: true, force: true });
  }
  throw new Error(
    `Another run kept writing a different engine to ${dir} while this one staged, so this run ` +
      `stopped without publishing its own. Let the other deploy finish and re-run this one.`,
  );
}

/**
 * Bytes on disk under `path`: a file's size, or everything beneath a
 * directory, counted without following a symlink (a link is its own few bytes,
 * never what it points at — the cache owns only what is inside it).
 *
 * Zero for a path that is not there, so a caller sizing an entry that went away
 * between a listing and this call reads it as freeing nothing rather than
 * failing.
 */
export function diskBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of names) total += diskBytes(join(path, name));
  return total;
}
