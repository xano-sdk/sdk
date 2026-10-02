/**
 * The landing record — which identities THIS project has written onto each
 * destination, the one thing `deploy --to … --prune` is allowed to delete.
 *
 * A lock entry does not answer that question. Guids are name-derived
 * (`md5(kind:name)`), and the lock records every identity a project has ever
 * EXPORTED — so every project that ever defined a `double` function "owned" the
 * `function:double` on every shared workspace, and a project that only ever ran
 * `xanosdk export` could prune another project's agent. The landing record is
 * written only by the commands that actually land objects, per destination, and
 * only after the write succeeded:
 *
 * - `deploy --to workspace|tenant:<x>` — a merge ADDS what it sent (a converged
 *   run too: the destination holds exactly this project's objects), a
 *   `--replace` records exactly what it sent, and a `--prune` removes what it
 *   deleted. A branch release counts for the whole workspace: a new branch is a
 *   copy of live, objects keep their guids across branches, and tables are
 *   shared by all of them.
 * - `deploy` to the project's ephemeral — always a full replace (a
 *   `--keep-data` merge deletes what the project no longer defines too).
 *
 * An EPHEMERAL's record is not kept here: ephemerals are throwaway, so a record
 * in the committed lock churned it on every new one and piled up entries for
 * deleted ones. It lives in the uncommitted local state (`.xano/ephemeral.json`,
 * see `deploy/ephemeral-state.ts`) under an `/ephemeral/` key, which is how a
 * lock tells one apart and drops it on load.
 * - `promote <release>` (adds) and `tenant deploy`/`deploy release:` (replace) —
 *   only when every identity the release carries matches this project's lock,
 *   the one sign available that it was cut from this project. A replace from a
 *   release that does not match clears the record: nothing there is known to be
 *   this project's any more.
 *
 * Pure and browser-safe, like `lock.ts`; the file I/O is in `io.ts`.
 */
import { LOCK_PAYLOAD_KEYS, lockKey, type LandedEntry, type LockFile } from "./lock.js";

/** A destination as the landing record addresses it. */
export type LandingDestination =
  | { kind: "workspace"; workspaceId: number }
  /** A standard tenant, by the name the routes take. Recorded in `xano.lock`. */
  | { kind: "tenant"; name: string }
  /** An ephemeral (a tenant on the wire). Recorded in local state, never the lock. */
  | { kind: "ephemeral"; name: string };

/**
 * The destination key: `<instance host>/workspace/<id>`,
 * `<instance host>/tenant/<name>` or `<instance host>/ephemeral/<name>` — the
 * kind is in the key, so a lock can tell an ephemeral's record it must not
 * hold from a tenant's. Credential-agnostic by construction — two
 * people with different tokens on one instance address the same key, and so do
 * two profiles — and stable across the tenant's own URL (a custom domain or a
 * path prefix), which is why the instance host is the one the credential names
 * rather than the destination's base.
 */
export function destinationKey(instance: string, dest: LandingDestination): string {
  let host: string;
  try {
    host = new URL(instance).host.toLowerCase();
  } catch {
    host = instance.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  }
  return dest.kind === "workspace" ? `${host}/workspace/${dest.workspaceId}` : `${host}/${dest.kind}/${dest.name}`;
}

/** Whether a destination key names an ephemeral — a record that belongs in local state, not the lock. */
export function isEphemeralDestinationKey(key: string): boolean {
  return /^[^/\s]+\/ephemeral\/[^/\s]+$/.test(key);
}

/**
 * A payload's api groups, realtime servers and channels by the reference their
 * children bind them with (guid or local id) → name — every parent a composed
 * lock name reads.
 */
export function groupNames(payload: Record<string, unknown>): Map<unknown, string> {
  const groups = new Map<unknown, string>();
  for (const section of ["app", "realtime_server", "channel"]) {
    const rows = payload[section];
    for (const g of Array.isArray(rows) ? rows : []) {
      if (g === null || typeof g !== "object") continue;
      const { name, guid, id } = g as { name?: unknown; guid?: unknown; id?: unknown };
      if (typeof name !== "string") continue;
      if (typeof guid === "string" && guid !== "") groups.set(guid, name);
      if (typeof id === "number" && id !== 0) groups.set(`${section}#${id}`, name);
    }
  }
  return groups;
}

/**
 * The lock key an object row is recorded under — the same key an export writes
 * and a prune checks: `<payloadKey>:<name>`, and for a query its composed
 * `<group>|<VERB>|<name>` identity, the group read from the same payload (a
 * realtime channel `<server>|<path>`, a message `<server>|<channel>|<name>`).
 */
export function landedKeyForRow(
  payloadKey: string,
  row: { name?: unknown; verb?: unknown; app?: unknown; server?: unknown; channel?: unknown },
  groups: ReadonlyMap<unknown, string>,
): string | undefined {
  if (typeof row.name !== "string" || row.name === "") return undefined;
  const parent = (ref: unknown, section: string): string => {
    const id = (ref as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string" && id !== "") return groups.get(id) ?? id;
    return typeof id === "number" && id !== 0 ? (groups.get(`${section}#${id}`) ?? `#${id}`) : "";
  };
  if (payloadKey === "channel") return lockKey(payloadKey, [parent(row.server, "realtime_server"), row.name].join("|"));
  if (payloadKey === "message") {
    return lockKey(payloadKey, [parent(row.server, "realtime_server"), parent(row.channel, "channel"), row.name].join("|"));
  }
  if (payloadKey !== "query") return lockKey(payloadKey, row.name);
  const verb = typeof row.verb === "string" ? row.verb : "";
  const appId = (row.app as { id?: unknown } | null | undefined)?.id;
  const group = appId === undefined || appId === null || appId === 0 || appId === "" ? "" : (groups.get(typeof appId === "number" ? `app#${appId}` : appId) ?? "");
  return lockKey("query", [group, verb, row.name].join("|"));
}

/**
 * Every identity a bundle (or a decoded release archive) carries, as the
 * landing record keys it. Rows without a guid carry no identity and are left
 * out — an object nothing can match is not one a prune could ever own.
 */
export function landedIdentities(bundle: unknown): Record<string, LandedEntry> {
  const payload = (bundle as { payload?: unknown } | null | undefined)?.payload;
  const out: Record<string, LandedEntry> = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return out;
  const sections = payload as Record<string, unknown>;
  const groups = groupNames(sections);
  for (const payloadKey of LOCK_PAYLOAD_KEYS) {
    const rows = sections[payloadKey];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const r = row as { name?: unknown; guid?: unknown; type?: unknown };
      if (typeof r.guid !== "string" || r.guid === "") continue;
      const key = landedKeyForRow(payloadKey, r, groups);
      if (key === undefined) continue;
      out[key] = payloadKey === "toolset" && r.type === "agent" ? { guid: r.guid, type: "agent" } : { guid: r.guid };
    }
  }
  return out;
}

/**
 * Whether every identity a release carries is one this project's lock pins,
 * under the same key and guid — the one sign available that the release was
 * cut from this project. An empty set matches nothing: there is no evidence.
 */
export function identitiesMatchLock(identities: Record<string, LandedEntry>, lock: LockFile): boolean {
  const keys = Object.keys(identities);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const entry = lock.objects[key];
    if (entry?.guid !== identities[key]!.guid) return false;
    // `agent` and `mcpServer` share a key and a guid; the lock says which.
    return !key.startsWith("toolset:") || (entry.type === "agent") === (identities[key]!.type === "agent");
  });
}

/** How a landing changes what the record holds for its destination. */
export interface LandingUpdate {
  /**
   * `replace`: the destination now holds exactly `identities` of this project's
   * (a full replace, or a merge that deleted everything else). `merge`: they are
   * added to what was recorded.
   */
  mode: "replace" | "merge";
  /**
   * What landed. A `dbo:` entry's `columns` is the table's storage AFTER this
   * landing (see `withStoredColumns`) and replaces what was recorded: an entry
   * without it records the storage as unknown, never as what it was.
   */
  identities: Record<string, LandedEntry>;
  /** What a prune deleted: dropped from the record after the merge. */
  removed?: Record<string, LandedEntry>;
}

/**
 * The lock with one destination's record updated (pure — returns a new model).
 *
 * A merge drops a recorded key whose guid now lands under another key — the
 * object was renamed in place, and its old key names nothing on the destination
 * any more. The same key under a different guid is replaced: the object there
 * now is the one this landing wrote.
 */
export function applyLanding(lock: LockFile, destKey: string, update: LandingUpdate): LockFile {
  const next = nextLandedRecord(lock.landed?.[destKey] ?? {}, update);
  const landed = { ...(lock.landed ?? {}) };
  if (Object.keys(next).length > 0) landed[destKey] = next;
  else delete landed[destKey];
  const objects = withoutPrunedObjects(lock.objects, update);
  return Object.keys(landed).length > 0
    ? { version: lock.version, objects, landed }
    : { version: lock.version, objects };
}

/**
 * The lock's `objects` without the identities a successful prune deleted (pure;
 * the same object back when nothing is dropped). A pruned object is one the
 * project no longer defines, so its entry is an orphan — left in, the next
 * export warns "renamed? / deleted?" and `export --check` fails on it. Only an
 * entry pinning the deleted guid goes, and never one this landing also sent.
 */
export function withoutPrunedObjects(
  objects: LockFile["objects"],
  update: Pick<LandingUpdate, "identities" | "removed">,
): LockFile["objects"] {
  const drop = Object.entries(update.removed ?? {}).filter(
    ([key, entry]) => objects[key]?.guid === entry.guid && update.identities[key] === undefined,
  );
  if (drop.length === 0) return objects;
  const kept = { ...objects };
  for (const [key] of drop) delete kept[key];
  return kept;
}

/**
 * One destination's record after a landing (pure) — the rule {@link applyLanding}
 * applies to the lock, shared with the local state an ephemeral's record lives in.
 */
export function nextLandedRecord(
  before: Readonly<Record<string, LandedEntry>>,
  update: LandingUpdate,
): Record<string, LandedEntry> {
  let next: Record<string, LandedEntry>;
  if (update.mode === "replace") {
    next = { ...update.identities };
  } else {
    const landingGuids = new Map(Object.entries(update.identities).map(([k, e]) => [e.guid, k]));
    next = {};
    for (const [key, entry] of Object.entries(before)) {
      const movedTo = landingGuids.get(entry.guid);
      if (movedTo !== undefined && movedTo !== key) continue;
      next[key] = entry;
    }
    Object.assign(next, update.identities);
  }
  for (const [key, entry] of Object.entries(update.removed ?? {})) {
    if (next[key]?.guid === entry.guid) delete next[key];
  }
  return next;
}

/** Per table guid, the column storage a landing record knows (see `LandedEntry.columns`). */
export function storedColumnsOf(record: Readonly<Record<string, LandedEntry>> | undefined): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [key, entry] of Object.entries(record ?? {})) {
    if (key.startsWith("dbo:") && entry.columns !== undefined) out.set(entry.guid, entry.columns);
  }
  return out;
}

/**
 * Landed identities with each table's column storage attached (pure). A table
 * `stored` has no storage for lands bare: a record holds only what is known.
 */
export function withStoredColumns(
  identities: Record<string, LandedEntry>,
  stored: ReadonlyMap<string, Readonly<Record<string, string>>> | undefined,
): Record<string, LandedEntry> {
  if (stored === undefined) return identities;
  const out: Record<string, LandedEntry> = {};
  for (const [key, entry] of Object.entries(identities)) {
    const columns = key.startsWith("dbo:") ? stored.get(entry.guid) : undefined;
    out[key] = columns === undefined ? entry : { ...entry, columns: { ...columns } };
  }
  return out;
}

/** The lock without one destination's record (pure). Unchanged when it has none. */
export function withoutLanding(lock: LockFile, destKey: string): LockFile {
  if (lock.landed?.[destKey] === undefined) return lock;
  const { [destKey]: _dropped, ...landed } = lock.landed;
  return Object.keys(landed).length > 0
    ? { version: lock.version, objects: lock.objects, landed }
    : { version: lock.version, objects: lock.objects };
}

/** One destination's record, or `undefined` when this project has landed nothing there. */
export function landedOn(lock: LockFile, destKey: string): Readonly<Record<string, LandedEntry>> | undefined {
  const record = lock.landed?.[destKey];
  return record === undefined || Object.keys(record).length === 0 ? undefined : record;
}
