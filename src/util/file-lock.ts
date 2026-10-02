/**
 * Node-only advisory lock files: an exclusive create (`wx`) holding the
 * owner's pid, host, a per-take token and the time it was taken. A lock whose
 * owner is no longer running on this machine, or that is older than its stale
 * age, is taken over — a run killed while holding one never wedges the
 * project. A lock naming this process's own pid is live only while this
 * process holds it: a pid is reused (containers start from the same pids, a
 * reboot restarts the count), so a leftover from an earlier process with the
 * same pid is stale. A lock taken on another host cannot have its owner
 * checked, so only its age frees it. Locks this process holds are removed on
 * exit and on SIGINT, SIGTERM and SIGHUP. The signal listeners stand only
 * while a lock is held, and never keep the process alive: having released,
 * each removes itself and raises the signal again, so the process ends the way
 * it would have without them — by its own handler when it has one, else by the
 * signal. Deferring to "another listener will end it" is not safe: a library
 * that also listens (one that re-raises only when its own listeners are the
 * last) defers right back, and neither ends the process.
 *
 * Two shapes: {@link tryLock} answers at once (a caller that refuses when
 * another run holds it), and {@link withFileLockSync} waits briefly for a
 * read-modify-write of a small file. The sync lock is re-entrant within one
 * process, so a write that calls another write under the same lock does not
 * wait on itself.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** Who holds a lock, as its file says. */
export interface LockHolder {
  pid: number;
  /** Epoch ms the lock was taken. */
  at: number;
  /** The machine it was taken on. */
  host?: string;
  /** Unique to one take of the lock. */
  token?: string;
}

export interface HeldLock {
  release(): void;
}

const held = new Map<string, number>();

/** The locks this process took with {@link tryLock} and has not released: path → token. */
const owned = new Map<string, string>();

const HOST = hostname();

function releaseAll(): void {
  for (const [path, token] of owned) {
    try {
      if (readHolder(path)?.token === token) rmSync(path, { force: true });
    } catch {
      /* best effort on the way out */
    }
  }
  owned.clear();
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function onSignal(signal: NodeJS.Signals): void {
  releaseAll();
  uninstallSignals();
  process.kill(process.pid, signal);
}

let exitInstalled = false;
let signalsInstalled = false;

function installCleanup(): void {
  if (!exitInstalled) {
    exitInstalled = true;
    process.on("exit", releaseAll);
  }
  if (!signalsInstalled) {
    signalsInstalled = true;
    for (const signal of SIGNALS) process.on(signal, onSignal);
  }
}

function uninstallSignals(): void {
  if (!signalsInstalled) return;
  signalsInstalled = false;
  for (const signal of SIGNALS) process.removeListener(signal, onSignal);
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid === "number" && typeof parsed.at === "number") {
      return {
        pid: parsed.pid,
        at: parsed.at,
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    }
  } catch {
    /* unreadable or half-written: judged by its age below */
  }
  return undefined;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the lock at `path` is abandoned: its owner is gone, or it outlived `staleMs`. */
function isStale(path: string, staleMs: number): boolean {
  const holder = readHolder(path);
  let age: number;
  try {
    age = Date.now() - (holder?.at ?? statSync(path).mtimeMs);
  } catch {
    return false; // gone already: the next create answers
  }
  if (age > staleMs) return true;
  if (holder === undefined) return false; // being written right now
  if (holder.host !== undefined && holder.host !== HOST) return false; // its owner cannot be checked from here
  if (holder.pid === process.pid) return holder.token === undefined || owned.get(path) !== holder.token;
  return !running(holder.pid);
}

/**
 * Take the lock at `path` now, or answer who holds it. A stale lock is
 * removed and taken.
 */
export function tryLock(path: string, opts: { staleMs: number }): HeldLock | { heldBy: LockHolder | undefined } {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = randomUUID();
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now(), host: HOST, token }), { flag: "wx" });
      owned.set(path, token);
      installCleanup();
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (owned.get(path) === token) owned.delete(path);
          if (readHolder(path)?.token === token) rmSync(path, { force: true });
          if (owned.size === 0) uninstallSignals();
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && isStale(path, opts.staleMs)) {
        rmSync(path, { force: true });
        continue;
      }
      return { heldBy: readHolder(path) };
    }
  }
  return { heldBy: readHolder(path) };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding the lock at `path`, waiting up to `waitMs` for another
 * process to let go. Throws, naming the lock file, when it never does.
 */
export function withFileLockSync<T>(path: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const depth = held.get(path) ?? 0;
  if (depth > 0) {
    held.set(path, depth + 1);
    try {
      return fn();
    } finally {
      held.set(path, depth);
    }
  }
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  const staleMs = opts.staleMs ?? 30_000;
  let lock = tryLock(path, { staleMs });
  while ("heldBy" in lock) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${path}: another xanosdk run is writing the file it guards. ` +
          `Wait for it to finish and run this again; if none is running, remove ${path}.`,
      );
    }
    sleepSync(25);
    lock = tryLock(path, { staleMs });
  }
  held.set(path, 1);
  try {
    return fn();
  } finally {
    held.delete(path);
    lock.release();
  }
}
