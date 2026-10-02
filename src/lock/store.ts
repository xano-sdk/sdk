/**
 * The cross-realm lock override store — how a `xano.lock` reaches `deriveGuid`.
 *
 * Reference guids are baked at AUTHORING time, not export time: statement
 * factories (`s.function.run`, `s.db.get`, …) and even field defs
 * (`f.tableRef`) call `resolveRef` → `deriveGuid` the moment the workspace
 * module is evaluated, and some embed the guid inside strings (`dbo=<guid>`
 * method args, auth-token const values). An export-time payload rewrite would
 * have to chase those string-embedded forms — overriding at the `deriveGuid`
 * choke point instead makes reference and target agree everywhere by
 * construction, with zero changes at call sites.
 *
 * That yields the seeding contract: **seed once per process, BEFORE any
 * def module is evaluated.** Node's module cache means seeding after defs have
 * loaded is a silent no-op for already-baked references. The CLI honors this
 * automatically (it seeds before importing the workspace entry); programmatic
 * users must call `seedLockOverrides` before importing their defs.
 * `resetLockOverrides` exists for tests (reset-then-seed per run).
 *
 * The store lives on `globalThis` under a `Symbol.for` key because the CLI and
 * the workspace entry can load xanosdk in different module realms (the
 * tsx-loader split — same reason `Xano.isXano` brands with `Symbol.for`). Every
 * accessor goes through a fresh `globalThis` lookup, never a module-local
 * reference, so both realms see one store.
 */
import type { LockEntry, LockFile } from "./lock.js";

const STORE_KEY = Symbol.for("xanosdk.lock.overrides");
/** The absolute path a {@link LockFile} was read from — non-enumerable, so it never serializes. */
const SOURCE_KEY = Symbol.for("xanosdk.lock.source");

interface OverrideStore {
  /** Lock entries keyed `payloadKey:name` (plus the fixed workspace keys). */
  entries: Map<string, LockEntry>;
  /** The file the seeded lock was read from, when it came from `readLockFile`. */
  source?: string;
}

function getStore(): OverrideStore | undefined {
  return (globalThis as Record<symbol, unknown>)[STORE_KEY] as OverrideStore | undefined;
}

/**
 * Seed the override store from a validated lock. Replaces any previous seed —
 * the contract is one workspace per process (see module doc), so the CLI does
 * reset-then-seed per run and multiple concurrent workspaces are out of scope.
 */
export function seedLockOverrides(lock: LockFile): void {
  const entries = new Map<string, LockEntry>();
  for (const [key, entry] of Object.entries(lock.objects)) {
    entries.set(key, { ...entry });
  }
  const source = (lock as unknown as Record<symbol, unknown>)[SOURCE_KEY];
  (globalThis as Record<symbol, unknown>)[STORE_KEY] = {
    entries,
    ...(typeof source === "string" ? { source } : {}),
  } satisfies OverrideStore;
}

/** Record the absolute path `lock` was read from (see {@link seededLockSource}). */
export function tagLockSource(lock: LockFile, path: string): void {
  Object.defineProperty(lock, SOURCE_KEY, { value: path, enumerable: false, configurable: true });
}

/** The file the seeded lock was read from, or `undefined` (not seeded, or seeded from an in-memory lock). */
export function seededLockSource(): string | undefined {
  return getStore()?.source;
}

/** Clear the store (tests; a process about to seed a different workspace). */
export function resetLockOverrides(): void {
  delete (globalThis as Record<symbol, unknown>)[STORE_KEY];
}

/** True when a lock has been seeded in this process. */
export function isLockSeeded(): boolean {
  return getStore() !== undefined;
}

/** The locked guid for a `payloadKey:name` key, if the lock pins one. */
export function getLockedGuid(key: string): string | undefined {
  return getStore()?.entries.get(key)?.guid;
}

/** The locked canonical for a lock key, if the lock pins one. */
export function getLockedCanonical(key: string): string | undefined {
  return getStore()?.entries.get(key)?.canonical;
}
