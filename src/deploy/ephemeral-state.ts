/**
 * Node-only local project state for the active ephemeral environment, so
 * `xanosdk deploy` can *refresh* the one you're iterating on instead of leaking
 * a fresh tenant every run. Stored at `./.xano/ephemeral.json`, keyed by
 * `"<profile>/<parent workspace id>"`, holding just the handle needed to find +
 * compare the env next time.
 *
 * The key is `"<profile>/<instance host>/<workspaceId>"`. The PROFILE half stops
 * a redeploy under a different credential from refreshing — or clobbering —
 * another tenant's environment. The INSTANCE half is not decoration: workspace
 * ids are small dense integers assigned per instance, so two accounts collide on
 * the same number and a profile-and-workspace key would hand one account's
 * lookup the other's tenant. The WORKSPACE half does the rest of the correctness
 * work, and survives a profile being renamed or deleted where a name would not.
 *
 * Deliberately separate from `xano.lock` (identity) and `.xano/auth.json`
 * (credentials): different lifecycle, different meaning, and it carries no
 * secrets. The write mirrors `src/lock/io.ts` / `src/auth/store.ts` (temp-file +
 * rename via `atomicWrite`, recursive mkdir, and a `.xano/` gitignore entry).
 *
 * State is a hint, never truth: a deploy always re-`GET`s the tenant and treats
 * a 404 / past expiry as "create a new one", so a stale or corrupt file can
 * never block a deploy — reads fall back to empty rather than throwing.
 *
 * It also holds an ephemeral's LANDING RECORD (`landed`, keyed
 * `<instance host>/ephemeral/<name>` as `lock/landed.ts` keys it) — the scope
 * of a `--prune` against it. Here, not in the committed `xano.lock`: an
 * ephemeral is throwaway, so recording it there churned the lock on every new
 * one and left entries behind for deleted ones. Deleting, expiring or
 * replacing the ephemeral clears its record. A malformed entry is dropped, never
 * trusted: an unrecorded object is one a prune refuses, the safe direction.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { withFileLockSync } from "../util/file-lock.js";
import { ensureGitignored } from "../auth/store.js";
import { DEFAULT_PROFILE } from "../auth/profile-select.js";
import { filledAt, withValidFilled, type FilledMarker } from "./keep-data.js";
import type { LandedEntry, LockFile } from "../lock/lock.js";
import { destinationKey, nextLandedRecord, type LandingUpdate } from "../lock/landed.js";
import { unreadableError } from "../emit/writable.js";

/** The tracked handle for one ephemeral env (never secrets). */
export interface EphemeralRecord {
  /**
   * The credential profile that created it, for display. Absent on a record
   * written before profiles, and on one adopted from such a file before the
   * next write materialises the adoption.
   */
  profile?: string;
  /**
   * The instance the tenant lives on. NOT load-bearing for lookup — the key
   * carries the instance host, which is what separates two accounts colliding
   * on one workspace number. This is here so a record read out of the file by a
   * person, or quoted in a bug report, names its origin instead of a bare
   * tenant id. Absent on a record written before the stamp existed.
   */
  instance?: string;
  /** Server-assigned tenant name — the stable handle used to GET/import/delete. */
  name: string;
  /** Human display name shown at create time. */
  display: string;
  /** The env's public base URL (`xano_domain`), compared run-to-run to flag URL changes. */
  url: string;
  /** Expiry as the API serializes it (`"2026-07-24 20:49:15+0000"`), or a unix-epoch number. */
  expires_at: string | number | undefined;
  /**
   * Set only once an import into this environment COMPLETED — see
   * {@link markEnvironmentFilled}. This record is written before the import, so
   * its existence alone does not mean the environment holds anything.
   */
  filled?: FilledMarker;
  /**
   * The frontend URL the last `--static` publish into this environment served
   * from. Read only to tell whether a new publish REPLACED a URL someone may
   * hold: a first publish has no previous one, and saying "the previous one no
   * longer serves" there describes a URL that never existed. Kept across a
   * replace that published none (the deploy warns the frontend went down), so
   * the next publish can still say its URL changed.
   */
  static_url?: string;
  /**
   * `static_url` no longer serves: a replace took it down and published none.
   * Keeps the warning to the deploy that did it. Cleared by the next publish.
   */
  static_down?: boolean;
  /**
   * A failed replace could not reach `static_url` to check whether its clear
   * took it down. Like `static_down`, it makes the next replace ask the URL
   * before warning it goes down. Cleared by the next publish.
   */
  static_unchecked?: boolean;
  /**
   * The entry file the last deploy from a local build compiled, relative to the
   * project directory (`./suites/alpha/xano/index.ts`). Read by a remedy that
   * redeploys this environment, so it names the backend that landed here
   * rather than whichever one the project's default is. Absent after a deploy
   * of a fetched backend or a `--bundle`, and on a record written before it
   * was kept.
   */
  entry?: string;
  /**
   * The release a `deploy release:<name>` last landed here — the server keeps
   * no release on an ephemeral an archive was imported into, so this is how
   * `release delete` knows the ephemeral runs it. Absent after any other deploy.
   */
  release?: string;
  /**
   * Where the credential that deployed it was read from: `shared` (this
   * machine's file), `local` (the project's `.xano/auth.json`), or the absolute
   * path `--config`/`XANO_CONFIG` named. Absent for an environment credential
   * and for a record written before it was kept. Read only to phrase the
   * "tracked under another profile" remedy: a profile that lives in another
   * file is reached with that file's flag too, or the re-run fails again.
   */
  credential_file?: string;
  /**
   * `"environment"` when an environment credential (the meta-token triple or
   * XANO_REFRESH_TOKEN) deployed it — such a record keys as `default` but no
   * profile reaches it, so a remedy names the variables, not `--profile`.
   * Stamped by {@link setEnvironment} from who is writing, like `profile`.
   */
  credential?: "environment";
}

/** The on-disk file: active ephemeral per `"<profile>/<instance host>/<parent workspace id>"`. */
export interface EphemeralState {
  version: 1;
  environments: Record<string, EphemeralRecord>;
  /** Per ephemeral destination key, what this project landed there. Absent when nothing is recorded. */
  landed?: Record<string, Record<string, LandedEntry>>;
}

/**
 * Whose environment this is. Structurally satisfied by `ResolvedAuth`, so every
 * caller passes the `auth` it already holds.
 */
export interface EnvScope {
  workspaceId: number | string;
  /** Instance origin the credential addresses. Part of the key — see the header. */
  instance: string;
  /**
   * `undefined` on the two environment-credential paths, which have no profile
   * map behind them. They key as `default`, which is where they landed before
   * profiles existed: an env credential and a stored `default` profile pointed
   * at the same `(instance, workspace)` ARE the same tenant target, so sharing
   * the key changes nothing and keeps every existing CI record findable.
   */
  profile?: { name: string };
}

/** The composite key for one scope. */
export function environmentKey(scope: EnvScope): string {
  return `${scope.profile?.name ?? DEFAULT_PROFILE}/${hostOf(scope.instance)}/${scope.workspaceId}`;
}

/** The instance's host, which is what distinguishes two accounts' workspace 1. */
function hostOf(instance: string): string {
  try {
    return new URL(instance).host;
  } catch {
    // Not a URL we can parse: use it verbatim rather than collapsing every
    // unparseable instance into one shared key.
    return instance.replace(/\//g, "_");
  }
}

/** `./.xano/ephemeral.json` resolved against a project directory. */
export function ephemeralStatePath(dir: string): string {
  return join(resolve(dir), ".xano", "ephemeral.json");
}

/**
 * The lock every read-modify-write of the state file holds, so two runs in one
 * project never write over each other's record: each re-reads the file inside
 * it.
 */
function stateLockPath(dir: string): string {
  return `${ephemeralStatePath(dir)}.lock`;
}

/**
 * Read the state file. A missing OR unparseable/invalid file yields empty state
 * (never a throw) — a bad state file must not block a deploy; it's recreated on
 * the next write. Writers read through {@link readStateForWrite}, which refuses
 * a file that exists but cannot be read.
 */
export function readEphemeralState(dir: string): EphemeralState {
  const path = ephemeralStatePath(dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { version: 1, environments: {} };
  }
  return parseState(text) ?? { version: 1, environments: {} };
}

/** Whether a read failed because there is no file — the only failure that means "no record". */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * {@link readEphemeralState} for a write that adds to the state: a file that
 * exists but cannot be read (permission denied) throws rather than reading as
 * empty, so the write never replaces records it could not see. A clear needs
 * no such read — an unreadable file holds nothing it would remove.
 */
function readStateForWrite(dir: string): EphemeralState {
  const path = ephemeralStatePath(dir);
  try {
    readFileSync(path);
  } catch (err) {
    if (!isAbsent(err) && (err as NodeJS.ErrnoException).code !== "EISDIR") throw unreadableError(path);
  }
  return readEphemeralState(dir);
}

/** The state a file's text holds, or `undefined` when it holds none: bad JSON, an empty file, a non-object. */
function parseState(text: string): EphemeralState | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const envs = (parsed as { environments?: unknown } | null)?.environments;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && envs !== null && typeof envs === "object" && !Array.isArray(envs)) {
      const landed = validLanded((parsed as { landed?: unknown }).landed);
      return { version: 1, environments: { ...(envs as EphemeralState["environments"]) }, ...(landed !== undefined ? { landed } : {}) };
    }
  } catch {
    /* no state */
  }
  return undefined;
}

/**
 * The state file's path when it exists but {@link readEphemeralState} reads it
 * as empty — bad JSON, an empty file, `[]`, a permission-denied read. The ephemeral it recorded may still
 * be alive, so a report must not call it gone. `undefined` when the file is
 * absent or readable.
 */
export function unreadableEphemeralState(dir: string): string | undefined {
  const path = ephemeralStatePath(dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return isAbsent(err) ? undefined : path;
  }
  return parseState(text) === undefined ? path : undefined;
}

/**
 * The tracked ephemeral for a scope, or `undefined`.
 *
 * A bare-numeric key from a file written before profiles is ADOPTED into the
 * active profile's namespace rather than ignored. Ignoring it would leak a live
 * tenant on the next deploy — precisely the cost this module exists to avoid —
 * so "state is a hint, never truth" does not settle this case. The adoption is
 * materialised by the next write.
 */
export function getEnvironment(state: EphemeralState, scope: EnvScope): EphemeralRecord | undefined {
  const record = state.environments[keyIn(state, scope)];
  // A malformed marker reads as "never filled" rather than being trusted.
  return record === undefined ? undefined : withValidFilled(record);
}

/**
 * The key this scope's record actually lives under: its own, or the legacy
 * bare-numeric one when only that is present.
 *
 * ONE place decides what "this scope's record" means, so the three accessors
 * below carry no legacy knowledge and a fourth cannot forget it.
 */
function keyIn(state: EphemeralState, scope: EnvScope): string {
  const key = environmentKey(scope);
  if (key in state.environments) return key;
  // The bare-numeric key every file written before profiles holds. It names no
  // instance, so adoption across instances on the same workspace NUMBER is
  // possible here and nowhere else — the deploy re-GETs the tenant and creates
  // a fresh one on a 404, so the cost is a leaked tenant, never a wrong write.
  const legacy = String(scope.workspaceId);
  return legacy in state.environments ? legacy : key;
}

/** Did this scope resolve TO the legacy key — i.e. is it the one adopting it? */
function adoptsLegacy(state: EphemeralState, scope: EnvScope): boolean {
  return keyIn(state, scope) === String(scope.workspaceId);
}

/** Upsert the tracked ephemeral for a scope and persist atomically. */
export function setEnvironment(dir: string, scope: EnvScope, record: EphemeralRecord): void {
  withFileLockSync(stateLockPath(dir), () => setEnvironmentLocked(dir, scope, record));
}

function setEnvironmentLocked(dir: string, scope: EnvScope, record: EphemeralRecord): void {
  const state = readStateForWrite(dir);
  // Materialise an adoption — but ONLY when this scope is the one adopting.
  // Deleting the legacy key unconditionally would let any profile's first write
  // untrack a record it never read, leaking the live tenant behind it.
  const adopting = adoptsLegacy(state, scope);
  // A NEW environment replacing the tracked one (the old expired or was
  // deleted): what this project landed on the old one says nothing about it.
  const replaced = state.environments[keyIn(state, scope)]?.name;
  if (replaced !== undefined && replaced !== record.name && state.landed !== undefined) {
    const { [ephemeralLandingKey(scope.instance, replaced)]: _gone, ...landed } = state.landed;
    state.landed = landed;
  }
  // The stamp is derived from WHO IS WRITING, never from what the caller
  // carried — an adopted legacy record arrives without one, and a record read
  // under one profile must not keep another's name when rewritten.
  const { credential: _carried, ...rest } = record;
  state.environments[environmentKey(scope)] = {
    ...rest,
    profile: scope.profile?.name ?? DEFAULT_PROFILE,
    instance: scope.instance,
    ...(scope.profile === undefined ? { credential: "environment" as const } : {}),
  };
  if (adopting) delete state.environments[String(scope.workspaceId)];
  writeState(dir, state);
}

/**
 * Record that an import into this scope's environment completed at `url`.
 *
 * The post-import write, separate from {@link setEnvironment} because that one
 * runs BEFORE the import. What it landed replaces what the record said landed
 * before: the release and the local entry are each set from `landed`, and
 * dropped when it names none — a failed import leaves both as they were.
 * No record, nothing to mark.
 */
export function markEnvironmentFilled(
  dir: string,
  scope: EnvScope,
  url: string,
  /** The release (`deploy release:<name>`) and the local entry this landing deployed. */
  landed: { release?: string; entry?: string } = {},
): void {
  withFileLockSync(stateLockPath(dir), () => markEnvironmentFilledLocked(dir, scope, url, landed));
}

function markEnvironmentFilledLocked(dir: string, scope: EnvScope, url: string, landed: { release?: string; entry?: string }): void {
  const record = getEnvironment(readEphemeralState(dir), scope);
  if (record === undefined) return;
  const { release: _release, entry: _entry, ...rest } = record;
  setEnvironment(dir, scope, {
    ...rest,
    filled: filledAt(url),
    ...(landed.release === undefined ? {} : { release: landed.release }),
    ...(landed.entry === undefined ? {} : { entry: landed.entry }),
  });
}

/** Record the frontend URL a `--static` publish just served from. No record, nothing to mark. */
export function recordStaticUrl(dir: string, scope: EnvScope, staticUrl: string): void {
  withFileLockSync(stateLockPath(dir), () => recordStaticUrlLocked(dir, scope, staticUrl));
}

function recordStaticUrlLocked(dir: string, scope: EnvScope, staticUrl: string): void {
  const record = getEnvironment(readEphemeralState(dir), scope);
  if (record === undefined) return;
  const { static_down: _down, static_unchecked: _unchecked, ...rest } = record;
  setEnvironment(dir, scope, { ...rest, static_url: staticUrl });
}

/** Remove the tracked ephemeral for a scope. Returns whether one was removed. */
export function clearEnvironment(dir: string, scope: EnvScope): boolean {
  return withFileLockSync(stateLockPath(dir), () => clearEnvironmentLocked(dir, scope));
}

function clearEnvironmentLocked(dir: string, scope: EnvScope): boolean {
  const state = readEphemeralState(dir);
  // The scope's own key, plus the legacy one ONLY when this scope is the one
  // reading it — clearing a bare-numeric record another profile is still
  // adopting would untrack that profile's live tenant.
  const keys = [environmentKey(scope), ...(adoptsLegacy(state, scope) ? [String(scope.workspaceId)] : [])].filter(
    (k) => k in state.environments,
  );
  if (keys.length === 0) return false;
  // Its landing record goes with it: the next environment is a new one, and
  // what this project landed on the old one says nothing about it.
  const landed = { ...(state.landed ?? {}) };
  for (const key of keys) {
    const name = state.environments[key]?.name;
    if (name !== undefined) delete landed[ephemeralLandingKey(scope.instance, name)];
    delete state.environments[key];
  }
  writeState(dir, { ...state, landed });
  return true;
}

/**
 * Remove every tracked record naming the ephemeral `name` on `instance`'s host,
 * under ANY profile — for a delete the platform confirmed. An ephemeral's name
 * is unique on its host, so a record another profile keeps for it (one whose
 * profile was since deleted, say) points at an environment that no longer
 * exists. Returns whether one was removed.
 */
export function clearEnvironmentsNamed(dir: string, instance: string, name: string): boolean {
  return withFileLockSync(stateLockPath(dir), () => clearEnvironmentsNamedLocked(dir, instance, name));
}

function clearEnvironmentsNamedLocked(dir: string, instance: string, name: string): boolean {
  const state = readEphemeralState(dir);
  const host = hostOf(instance);
  const keys = Object.entries(state.environments)
    .filter(
      ([key, record]) =>
        record.name === name &&
        (record.instance !== undefined ? hostOf(record.instance) === host : key.split("/")[1] === host),
    )
    .map(([key]) => key);
  if (keys.length === 0) return false;
  for (const key of keys) delete state.environments[key];
  const landed = { ...(state.landed ?? {}) };
  delete landed[ephemeralLandingKey(instance, name)];
  writeState(dir, { ...state, landed });
  return true;
}

// ── landing record ──────────────────────────────────────────────────────────

/** The ephemeral destination key `lock/landed.ts` addresses `name` on `instance` by. */
export function ephemeralLandingKey(instance: string, name: string): string {
  return destinationKey(instance, { kind: "ephemeral", name });
}

/** What this project landed on one ephemeral, or `undefined` when nothing is recorded. */
export function ephemeralLandedOn(dir: string, destKey: string): Readonly<Record<string, LandedEntry>> | undefined {
  const record = readEphemeralState(dir).landed?.[destKey];
  return record === undefined || Object.keys(record).length === 0 ? undefined : record;
}

/**
 * Every landing record this project keeps, by destination key: the lock's
 * (workspaces, tenants) and the local state's in `dir` (ephemerals). What
 * reads "is this identity live anywhere" reads both — an ephemeral's landing
 * is never in the lock.
 */
export function allLandings(dir: string, lock: LockFile): Array<[string, Readonly<Record<string, LandedEntry>>]> {
  return [...Object.entries(lock.landed ?? {}), ...Object.entries(readEphemeralState(dir).landed ?? {})];
}

/**
 * Apply a landing to one ephemeral's record (the rule the lock applies, see
 * `lock/landed.ts`) and persist it. Returns whether the file changed and how
 * many identities the record now holds.
 */
export function recordEphemeralLanding(
  dir: string,
  destKey: string,
  update: LandingUpdate,
): { changed: boolean; recorded: number } {
  return withFileLockSync(stateLockPath(dir), () => recordEphemeralLandingLocked(dir, destKey, update));
}

function recordEphemeralLandingLocked(
  dir: string,
  destKey: string,
  update: LandingUpdate,
): { changed: boolean; recorded: number } {
  const state = readStateForWrite(dir);
  const before = state.landed?.[destKey] ?? {};
  const next = nextLandedRecord(before, update);
  const changed = JSON.stringify(sortedRecord(before)) !== JSON.stringify(sortedRecord(next));
  if (changed) {
    const landed = { ...(state.landed ?? {}) };
    if (Object.keys(next).length > 0) landed[destKey] = next;
    else delete landed[destKey];
    writeState(dir, { ...state, landed });
  }
  return { changed, recorded: Object.keys(next).length };
}

/**
 * Forget what this project landed on the ephemeral `name` — it was deleted,
 * expired, or replaced by a new one. Returns whether a record was removed.
 */
export function clearEphemeralLanding(dir: string, instance: string, name: string): boolean {
  return withFileLockSync(stateLockPath(dir), () => clearEphemeralLandingLocked(dir, instance, name));
}

function clearEphemeralLandingLocked(dir: string, instance: string, name: string): boolean {
  const state = readEphemeralState(dir);
  const key = ephemeralLandingKey(instance, name);
  if (state.landed?.[key] === undefined) return false;
  const { [key]: _dropped, ...landed } = state.landed;
  writeState(dir, { ...state, landed });
  return true;
}

function sortedRecord(record: Readonly<Record<string, LandedEntry>>): Array<[string, string, string, string]> {
  const columns = (e: LandedEntry): string =>
    e.columns === undefined ? "" : JSON.stringify(Object.keys(e.columns).sort().map((c) => [c, e.columns![c]]));
  return Object.keys(record)
    .sort()
    .map((k) => [k, record[k]!.guid, record[k]!.type ?? "", columns(record[k]!)]);
}

/**
 * The `landed` map as read, keeping only entries of the exact shape a landing
 * writes. Anything else is dropped rather than trusted — see the header.
 */
function validLanded(raw: unknown): Record<string, Record<string, LandedEntry>> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, Record<string, LandedEntry>> = {};
  for (const [dest, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[^/\s]+\/ephemeral\/[^/\s]+$/.test(dest)) continue;
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    const record: Record<string, LandedEntry> = {};
    for (const [key, e] of Object.entries(entries as Record<string, unknown>)) {
      const { guid, type, columns } = (e ?? {}) as { guid?: unknown; type?: unknown; columns?: unknown };
      if (typeof guid !== "string" || guid === "" || !/^[a-z_]+:./i.test(key)) continue;
      record[key] = type === "agent" && key.startsWith("toolset:") ? { guid, type: "agent" } : { guid };
      const stored = key.startsWith("dbo:") ? validColumns(columns) : undefined;
      if (stored !== undefined) record[key]!.columns = stored;
    }
    if (Object.keys(record).length > 0) out[dest] = record;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A `dbo:` entry's `columns` as read: a column → type map of strings, else nothing. */
function validColumns(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [column, type] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof type === "string" && type !== "") out[column] = type;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The order a record's keys are written in; any other key follows, sorted. */
const RECORD_KEY_ORDER: readonly string[] = [
  "name",
  "display",
  "url",
  "expires_at",
  "profile",
  "instance",
  "credential",
  "credential_file",
  "filled",
  "static_url",
  "static_down",
  "static_unchecked",
  "entry",
  "release",
] satisfies readonly (keyof EphemeralRecord)[];

/**
 * `record` with its keys in one fixed order, whatever order the write that
 * made it spread them in — so a redeploy that changes one value changes one
 * line, not the file's layout (E2E pass 27: `filled` moved on every deploy).
 */
function inRecordOrder(record: EphemeralRecord): EphemeralRecord {
  const rank = (k: string) => {
    const i = RECORD_KEY_ORDER.indexOf(k);
    return i === -1 ? RECORD_KEY_ORDER.length : i;
  };
  const keys = Object.keys(record).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Object.fromEntries(keys.map((k) => [k, record[k as keyof EphemeralRecord]])) as unknown as EphemeralRecord;
}

function writeState(dir: string, state: EphemeralState): void {
  const path = ephemeralStatePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const landed: Record<string, Record<string, LandedEntry>> = {};
  for (const dest of Object.keys(state.landed ?? {}).sort()) {
    const src = state.landed![dest]!;
    if (Object.keys(src).length === 0) continue;
    landed[dest] = Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]!]));
  }
  const environments: Record<string, EphemeralRecord> = {};
  for (const key of Object.keys(state.environments)) environments[key] = inRecordOrder(state.environments[key]!);
  const body = Object.keys(landed).length > 0
    ? { version: 1, environments, landed }
    : { version: 1, environments };
  atomicWrite(path, JSON.stringify(body, null, 2) + "\n");
  ensureGitignored(path);
}
