/**
 * The `xano.lock` identity lock file (feat: xano-lock).
 *
 * xanosdk derives object identity deterministically — `guid = md5(payloadKey:name)`
 * (see refs/guid.ts) — so a rename silently changes the guid and the engine
 * (which upserts by `(workspace, branch, guid)` on a partial import) treats the
 * rename as delete+create. Api groups and toolsets additionally carry a
 * `canonical` (the public URL token) that the engine randomizes at creation
 * when the bundle leaves it empty, so fresh imports of the same code land on
 * different URLs.
 *
 * The lock file freezes both: every auto-derived guid and every minted
 * canonical is recorded here at export — along with WHICH of the two a
 * canonical is (`canonical_source`, see {@link CanonicalSource}), the one fact
 * about a public URL an exported archive cannot carry — keyed by the same
 * `payloadKey:name` seed the derivation uses (`dbo:users`, `app:public`, `function:sayHello`).
 * The workspace's own canonical lives under a fixed key (`workspace`) — NOT
 * keyed by the renameable workspace name.
 * Precedence at emit is: explicit in-code value > lock entry > derivation.
 * The lock records explicit values too, so later removing an explicit `guid`
 * from code resolves through the lock to the same value instead of silently
 * reverting to `md5(name)` (a delete+create on next sync).
 *
 * This module owns the lock model end to end: the file format (parse, strict
 * validation, serialize, atomic write), the export-side participation helpers
 * (`LockExportContext`, `recordObserved`, `mergeObserved` — used by
 * `Xano.export({ lock })` and the CLI), and the pure maintenance transforms
 * behind the `xanosdk lock` subcommands (`renameLockEntry`, `adoptFromBundle`).
 * What it does NOT know about is emission itself — no imports from the
 * workspace/emit layers. Validation is deliberately hard-line: an
 * unparseable file, unknown version, duplicate raw-text keys (a botched git
 * merge survives `JSON.parse` silently — parse keeps the last duplicate), or
 * duplicate guid/canonical values is an error. A broken lock must never
 * degrade to a silent unlocked export.
 *
 * The file is human-editable JSON; keys are sorted on write for stable diffs,
 * and hand-editing an entry is a supported fix-up path alongside the
 * `xanosdk lock` subcommands.
 */
import { shellQuote } from "../util/shell-quote.js";
import { article, withArticle } from "../util/article.js";
import { randomBytes } from "../util/hash.js";
import { rawDeriveGuid, REFERENCEABLE_KIND_PAYLOAD_KEYS } from "../refs/guid.js";
import { getLockedGuid } from "./store.js";
import { isPrivateLibraryRow } from "../fields/hosted-file.js";
import { PAYLOAD_KEY_BY_SDK_KIND, sdkKindName as sdkKindNameFor } from "../util/sdk-kind.js";

/** The only lock format version this build reads or writes. */
export const LOCK_VERSION = 1;

/** Fixed key for the workspace's own `canonical` (never keyed by workspace name). */
export const WORKSPACE_KEY = "workspace";

/**
 * Lock keys this build no longer writes, kept only to give a stale lock a useful
 * error instead of a misleading one.
 *
 * `workspace:realtime` held the canonical of the legacy workspace-level realtime
 * block. That block is no longer modelled — it is carried verbatim and has no
 * identity this SDK mints — and the realtime primitives that replaced it
 * (`realtime_server`, `channel`, `message`) each lock under their own
 * `payloadKey:name` like any other object.
 */
const RETIRED_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "workspace:realtime",
    "the legacy workspace-level realtime block is no longer modelled; realtime servers and channels lock under their own keys",
  ],
]);

/**
 * Payload keys whose objects carry an engine-tracked guid and are authorable
 * in Xano SDK — the valid `<payloadKey>:` prefixes for lock object keys. Derived
 * from the identity table in refs/guid.ts (the single source), so a kind added
 * there participates in locking automatically. Marketplace/install sections
 * (`vault`, `market_item`, …) are out of scope by design.
 */
export const LOCK_PAYLOAD_KEYS = new Set(Object.values(REFERENCEABLE_KIND_PAYLOAD_KEYS));

/**
 * Payload keys whose objects carry a mintable `canonical` (the public URL
 * token) — api groups, toolsets, and realtime servers. Workspace canonicals
 * live under the fixed keys instead. Entries for any other kind must not carry
 * a canonical. A channel and a message are addressed *through* their server's
 * canonical, so neither carries one of its own.
 */
export const CANONICAL_PAYLOAD_KEYS = new Set(["app", "toolset", "realtime_server"]);


/**
 * The SDK kind name a lock payload key is printed as (`dbo` → `table`). The lock
 * FILE keeps the stored spelling (`dbo:users`) and its format does not change;
 * this is what the CLI prints and accepts, so a remedy reads in the vocabulary
 * of the code it is about. See `util/sdk-kind.ts`.
 */
export function sdkKindName(payloadKey: string): string {
  return sdkKindNameFor(payloadKey);
}

/**
 * The kind names a lock command lists as accepted — SDK spellings. `toolset`
 * holds two authored kinds, so it is listed as both (`mcpServer`, `agent`);
 * either addresses the same entry.
 */
export function acceptedLockKinds(): string[] {
  return [
    ...new Set([...LOCK_PAYLOAD_KEYS].flatMap((key) => (key === "toolset" ? ["mcpServer", "agent"] : [sdkKindName(key)]))),
  ];
}

/**
 * Which authored kind each `toolset` name is (`agent` or `mcpServer`), read
 * from a bundle's payload — the one place the two are told apart. For
 * {@link displayLockKey}.
 */
export function toolsetKindsFromPayload(
  payload: unknown,
  lock?: Readonly<Record<string, LockEntry>>,
): Map<string, string> {
  // The lock answers for a name the payload no longer carries — an orphan,
  // above all, which is exactly the entry a message names — from the `type`
  // an export recorded for it. The payload wins where both know the name.
  const kinds = lock === undefined ? new Map<string, string>() : toolsetKindsFromLock(lock);
  const rows = (payload as { toolset?: unknown } | null | undefined)?.toolset;
  if (!Array.isArray(rows)) return kinds;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { name, type } = row as { name?: unknown; type?: unknown };
    if (typeof name === "string") kinds.set(name, type === "agent" ? "agent" : "mcpServer");
  }
  return kinds;
}

/**
 * Which toolset entries the lock records as agents (`"type": "agent"`, written
 * by an export or an import that saw the object). An entry without it is an MCP
 * server — or an agent locked before the hint existed, until its next export.
 */
export function toolsetKindsFromLock(objects: Readonly<Record<string, LockEntry>>): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const [key, entry] of Object.entries(objects)) {
    if (key.startsWith("toolset:")) kinds.set(key.slice("toolset:".length), entry.type === "agent" ? "agent" : "mcpServer");
  }
  return kinds;
}

/**
 * A lock key as the CLI PRINTS it — in the SDK's words (`dbo:notes` →
 * `table:notes`, `app:notes` → `apiGroup:notes`, `workflow_test:x` →
 * `workflowTest:x`, `query:notes|POST|create` unchanged). The lock FILE keeps
 * the stored spelling; every command accepts both, so a printed key pastes back
 * in as typed. The one formatter for every message and `--json` field that
 * names a key.
 *
 * A `toolset` entry is an MCP server or an agent, which the key alone cannot
 * say: `toolsetKinds` (see {@link toolsetKindsFromPayload}) answers when the
 * caller has the workspace, and `mcpServer` stands in otherwise — input
 * resolves either spelling to the same entry.
 */
export function displayLockKey(key: string, toolsetKinds?: ReadonlyMap<string, string>): string {
  const colon = key.indexOf(":");
  if (colon <= 0) return key;
  const payloadKey = key.slice(0, colon);
  if (!LOCK_PAYLOAD_KEYS.has(payloadKey)) return key;
  const name = key.slice(colon + 1);
  const kind = payloadKey === "toolset" ? (toolsetKinds?.get(name) ?? "mcpServer") : sdkKindName(payloadKey);
  return `${kind}:${name}`;
}

/**
 * How the lock FILE spells the kinds among `keys` whose printed (SDK) name it
 * does not use — ` (xano.lock spells table as "dbo:")` — or "" when every one
 * reads the same in both. For a message that prints keys in the SDK's words to
 * someone who may go looking for them in the file (E2E pass 24).
 */
export function fileSpellingNote(keys: readonly string[]): string {
  const pairs = new Map<string, string>();
  for (const key of keys) {
    const colon = key.indexOf(":");
    if (colon <= 0) continue;
    const payloadKey = key.slice(0, colon);
    if (!LOCK_PAYLOAD_KEYS.has(payloadKey)) continue;
    const sdk = payloadKey === "toolset" ? "agent/mcpServer" : sdkKindName(payloadKey);
    if (sdk !== payloadKey) pairs.set(sdk, payloadKey);
  }
  if (pairs.size === 0) return "";
  return ` (xano.lock spells ${[...pairs].map(([sdk, file]) => `${sdk} as "${file}:"`).join(", ")})`;
}

/**
 * Resolve a user-facing kind name to the lock's payloadKey. The SDK spelling
 * (`table`, `apiGroup`, `workflowTest`), the snake-case kind (`api_group`) and
 * the stored payload key (`dbo`) all resolve, so a key copied out of the lock
 * file works as well as the name the code uses.
 */
export function resolvePayloadKey(kindOrPayloadKey: string): string {
  if (LOCK_PAYLOAD_KEYS.has(kindOrPayloadKey)) return kindOrPayloadKey;
  const key = (Object.hasOwn(PAYLOAD_KEY_BY_SDK_KIND, kindOrPayloadKey) ? PAYLOAD_KEY_BY_SDK_KIND[kindOrPayloadKey] : undefined) ?? (Object.hasOwn(REFERENCEABLE_KIND_PAYLOAD_KEYS, kindOrPayloadKey) ? REFERENCEABLE_KIND_PAYLOAD_KEYS[kindOrPayloadKey] : undefined);
  if (key === undefined) {
    throw new UnknownLockKindError(
      `Unknown object kind "${kindOrPayloadKey}". Expected one of: ${acceptedLockKinds().join(", ")}.`,
    );
  }
  return key;
}

/** A kind name no lock key uses — fixed by retyping it, so the CLI reports it as a usage error. */
export class UnknownLockKindError extends Error {}

/**
 * A lock entry the command named that the lock does not carry: the not-found
 * failure (exit 8, like every other named thing that is not there).
 */
export class LockEntryNotFoundError extends Error {
  override readonly name = "LockEntryNotFoundError";
  /** A named thing that is not there, like every other: `SDK_ERROR`, exit 8. */
  readonly code = "SDK_ERROR";
  readonly exitCode = 8;
  /** The key the reader most likely meant, when one is near — the `--json` failure's `suggestion`. */
  readonly suggestion: string | undefined;
  constructor(message: string, opts: { suggestion?: string } = {}) {
    super(message);
    this.suggestion = opts.suggestion;
  }
}

/**
 * `lock rename` onto a name whose entry pins a real identity of its own (exit
 * 2): one of the two identities has to go first, and only the author knows
 * which. The command words the remedy, with the flags that reach this lock.
 */
export class LockRenameConflictError extends Error {
  override readonly name = "LockRenameConflictError";
  readonly exitCode = 2;
  constructor(
    message: string,
    readonly keys: { shownOld: string; shownNew: string },
  ) {
    super(message);
  }
}

/**
 * `lock import` ran and the bundle disagrees with the lock (exit 2): adopting
 * it would give one identity to two entries. Re-running changes nothing; the
 * message names the entry to move first.
 */
export class LockImportConflictError extends Error {
  override readonly name = "LockImportConflictError";
  readonly exitCode = 2;
  /**
   * The same-kind guid clash behind this refusal, when it is one: which name the
   * bundle carries the guid under and which the lock pins it to. Only the
   * workspace source can say which side renamed, so the command that has the
   * source words the remedy from this.
   */
  readonly clash: ImportClash | undefined;

  constructor(message: string, opts: { clash?: ImportClash } = {}) {
    super(message);
    this.clash = opts.clash;
  }
}

/** A guid the bundle holds under one name and the lock pins to another, same kind. */
export interface ImportClash {
  guid: string;
  /** Lock-file kind (`dbo`, `function`, `toolset`, …). */
  kind: string;
  /** The kind as the SDK spells it (`table`, `agent`, …). */
  kindWord: string;
  /** The name the bundle (the live workspace) carries. */
  workspaceName: string;
  /** The name the lock pins the guid to. */
  lockName: string;
  /** The live and pinned keys as displayed. */
  workspaceKey: string;
  lockKey: string;
}

/**
 * A lock key as the user typed it, in the lock file's own spelling: the kind
 * half may be an SDK kind name (`table:users` → `dbo:users`). A key whose kind
 * half resolves to nothing is returned as typed, for the caller's not-found
 * message to name.
 */
export function normalizeLockKey(key: string): string {
  const colon = key.indexOf(":");
  if (colon <= 0) return key;
  const kind = key.slice(0, colon);
  if (LOCK_PAYLOAD_KEYS.has(kind)) return key;
  const payloadKey = (Object.hasOwn(PAYLOAD_KEY_BY_SDK_KIND, kind) ? PAYLOAD_KEY_BY_SDK_KIND[kind] : undefined) ?? (Object.hasOwn(REFERENCEABLE_KIND_PAYLOAD_KEYS, kind) ? REFERENCEABLE_KIND_PAYLOAD_KEYS[kind] : undefined);
  return payloadKey === undefined ? key : `${payloadKey}${key.slice(colon)}`;
}

/** Build the lock key for an object — the same seed `deriveGuid` hashes. */
export function lockKey(payloadKey: string, name: string): string {
  return `${payloadKey}:${name}`;
}

/** A table whose def pins its own `guid:` — see {@link codePinnedTables}. */
export interface CodePinnedTable {
  /** The guid the def pins. */
  guid: string;
  /**
   * The guids the def's replaces: the one the lock held under this table's key
   * when it differs, and every one an earlier export recorded as `replaced`.
   */
  replaces?: string[];
}

/**
 * The tables in `bundle` whose def pins a `guid:` of its own. Such a table's
 * identity comes from the code, so no lock entry moved onto it survives the
 * next export.
 *
 * `lock` is the lock as read, before this build; `classified` is the lock this
 * build merged, whose `guid_source` says which guids are a def's — the
 * authoritative answer when the caller has it. Without it, the entry's own
 * `guid_source` answers, and an entry that carries none (written before the
 * field existed) counts as code-pinned only when its guid is neither the one
 * the lock holds nor the one the name derives.
 */
export function codePinnedTables(bundle: unknown, lock: LockFile, classified?: LockFile): Map<string, CodePinnedTable> {
  const out = new Map<string, CodePinnedTable>();
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  const rows = payload !== null && typeof payload === "object" ? (payload as { dbo?: unknown }).dbo : undefined;
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = r as { guid?: unknown; name?: unknown } | null;
    if (typeof row?.name !== "string" || typeof row.guid !== "string" || row.guid === "") continue;
    const key = lockKey("dbo", row.name);
    const entry = lock.objects[key];
    const merged = classified?.objects[key];
    const held = entry?.guid;
    const source = merged ?? entry;
    const marked = source?.guid_source === "code" && source.guid === row.guid;
    if (!marked && row.guid === (held ?? rawDeriveGuid(key))) continue;
    const replaces = [
      ...new Set([...(held !== undefined && held !== row.guid ? [held] : []), ...(entry?.replaced ?? []), ...(merged?.replaced ?? [])]),
    ].filter((g) => g !== row.guid);
    out.set(row.name, { guid: row.guid, ...(replaces.length > 0 ? { replaces } : {}) });
  }
  return out;
}

/**
 * The lock NAME for one emitted/stored object — the display name for most
 * kinds, and the composed `<group>|<verb>|<name>` identity for a query.
 *
 * A query's engine uniqueness is (api group, verb, name): `GET items` and
 * `POST items` coexist in one group, and `items` repeats across groups. The
 * lock key has to carry the same components as the guid seed or a locked
 * export could not represent both halves of a verb pair (`recordObserved`
 * refuses two guids under one key). The group component is resolved from the
 * bundle's own `app` section (`appNameByGuid`); a raw numeric binding is
 * spelled `#<id>` and an unbound query contributes `""` — mirroring
 * `querySeedName`, so key == seed holds for queries.
 *
 * Legacy locks key queries as `query:<name>`; the derivation's fallback keeps
 * those entries pinning until an export rewrites them composed (the old entry
 * is then reported as an orphan for `lock prune`).
 */
export function lockNameForObject(
  payloadKey: string,
  obj: { name: string; verb?: unknown; app?: unknown; server?: unknown; channel?: unknown },
  appNameByGuid: ReadonlyMap<string, string>,
): string {
  // A realtime channel is unique per server and a message per channel (the
  // engine's unique indexes), so their keys compose like the guid seed:
  // `<server>|<path>` and `<server>|<channel path>|<name>`, the parents
  // resolved through the map `identityNamesByGuid` fills.
  if (payloadKey === "channel" || payloadKey === "message") {
    const parts = [parentName(obj.server, appNameByGuid)];
    if (payloadKey === "message") parts.push(parentName(obj.channel, appNameByGuid));
    return [...parts, obj.name].join("|");
  }
  if (payloadKey !== "query") return obj.name;
  const verb = typeof obj.verb === "string" ? obj.verb : "";
  const appId = (obj.app as { id?: unknown } | undefined)?.id;
  let group = "";
  if (typeof appId === "string" && appId !== "") {
    group = appNameByGuid.get(appId) ?? appId;
  } else if (typeof appId === "number" && appId !== 0) {
    group = `#${appId}`;
  }
  return [group, verb, obj.name].join("|");
}

/** A parent binding `{ id }` as its name — the guid when unresolved, `#<id>` for a raw numeric id. */
function parentName(ref: unknown, names: ReadonlyMap<string, string>): string {
  const id = (ref as { id?: unknown } | null | undefined)?.id;
  if (typeof id === "string" && id !== "") return names.get(id) ?? id;
  return typeof id === "number" && id !== 0 ? `#${id}` : "";
}

/**
 * Every name a lock name composes from, as guid → name: api groups (queries),
 * realtime servers (channels, messages) and channels (messages). Guids are
 * kind-seeded, so one map holds all three. For {@link lockNameForObject}.
 */
export function identityNamesByGuid(sections: Record<string, unknown>): Map<string, string> {
  const map = appNamesByGuid(sections["app"]);
  for (const key of ["realtime_server", "channel"]) {
    for (const [guid, name] of appNamesByGuid(sections[key])) map.set(guid, name);
  }
  return map;
}

/** The bundle's `app` section as guid → group name, for {@link lockNameForObject}. */
export function appNamesByGuid(appSection: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(appSection)) return map;
  for (const row of appSection) {
    if (!row || typeof row !== "object") continue;
    const { name, guid } = row as { name?: unknown; guid?: unknown };
    if (typeof name === "string" && typeof guid === "string" && guid !== "") {
      map.set(guid, name);
    }
  }
  return map;
}

/**
 * Where a locked `canonical` came from — the one fact about a public URL slug
 * that the exported archive cannot carry.
 *
 * `"code"` — the project wrote the slug itself (`canonical: "blog"`). It is a
 * contract with whatever frontend was built from it, so a release requires the
 * workspace to serve it and refuses when it cannot.
 *
 * `"minted"` — nobody asked for this value. The SDK generated it so a FRESH
 * import would land on a stable URL, and the lock remembers it only so the next
 * export asks for the same one. Treating it as a contract would re-slug a live
 * API the moment a project adopts an existing workspace (`xanosdk lock import`
 * cannot see slugs at all — a configuration-only export strips them), so it is
 * a preference: honored where free, and whatever the workspace already serves
 * is accepted otherwise.
 *
 * `"adopted"` — `xanosdk lock import` took it from a live backend: the slug
 * that backend serves, which the project's code does not set. A preference,
 * as a minted one is — nothing here promised it — but named for where it came
 * from, and kept through every export that fills it from the lock. Code that
 * writes the slug makes it `"code"`.
 *
 * Absent is NOT another class — it is "unknown", which every lock written
 * before this field carries, and it is read as not-pinned. Re-exporting
 * classifies it.
 */
export type CanonicalSource = "code" | "minted" | "adopted";

/** The values {@link CanonicalSource} admits, for validation messages. */
const CANONICAL_SOURCES: ReadonlySet<string> = new Set(["code", "minted", "adopted"]);

/** One locked identity. At least one of `guid`/`canonical` is present. */
export interface LockEntry {
  guid?: string;
  canonical?: string;
  /**
   * Classification of `canonical` (see {@link CanonicalSource}). Only ever set
   * alongside a `canonical`, and only for the kinds that carry one.
   */
  canonical_source?: CanonicalSource;
  /**
   * `"agent"` on a `toolset:` entry that is an agent. Agents and MCP servers
   * share the `toolset` key, and a message naming an entry whose object is gone
   * (an orphan) has no bundle left to ask which it was — this is that answer.
   * Absent means an MCP server. Carries no identity; never sent anywhere.
   */
  type?: "agent";
  /**
   * `true` on an entry `lock import` added: the identity came from a live
   * backend's export, not from this project's source. Cleared the moment an
   * export of this project writes the key (the project declares it now). Read
   * only to word a prune: "this project no longer declares it" is said of what
   * the project once declared, never of what it only adopted. Carries no
   * identity; never sent anywhere.
   */
  adopted?: true;
  /**
   * `true` on an entry whose guid `lock import` took from a live backend's
   * export and this project declares — written when an export clears
   * {@link adopted}, and by an import that overwrites or confirms an entry the
   * lock already had. Unlike `adopted` it outlives the project declaring the key:
   * the guid is still the live object's, so the entry is never a rename's
   * target — neither offered as an orphan's new name nor replaced by `lock
   * rename` as a fresh name-derived newcomer, even when the live backend was
   * itself deployed from code and the guid is the one the name derives.
   * Dropped when the entry's guid changes. Carries no identity; never sent
   * anywhere.
   */
  imported?: true;
  /**
   * `"code"` when the guid is a def's own `guid:` — written by every export
   * that emits the def's pin, cleared by one that does not. Absent means the
   * lock holds the guid (derived, moved by `lock rename`, or adopted) — or, on
   * a lock no export of this build has written yet, unknown. A code-sourced
   * entry is never a `lock rename` target: the next export re-pins it to the
   * def's guid. Carries no identity; never sent anywhere.
   */
  guid_source?: "code";
  /**
   * The guids this table entry pinned before its def's `guid:` replaced them,
   * oldest first. An environment may still hold a table under one of them,
   * with rows, so a keep-data merge refuses to drop it as an unannounced
   * rename rather than dropping it silently. Dropped with the entry
   * (`lock prune --identity-only`), and per guid when a def pins it again.
   * Carries no identity; never sent anywhere.
   */
  replaced?: string[];
}

/**
 * One identity this project LANDED on a destination: the guid the object was
 * written under, and — for a `toolset:` key — whether it was an agent. The key
 * it sits under is the lock key (`function:double`, `query:<group>|<VERB>|<name>`).
 */
export interface LandedEntry {
  guid: string;
  /** `"agent"` on a `toolset:` key that landed an agent; absent means an MCP server. */
  type?: "agent";
  /**
   * On a `dbo:` key, column → the type its values are stored as, for each
   * column whose storage is known: a merge retype rewrites the definition
   * only, so a column keeps the type it was created with. Kept in an
   * ephemeral's record only — the lock does not write it.
   */
  columns?: Record<string, string>;
}

/**
 * Per destination, the identities this project has actually written there —
 * the ONLY thing `deploy --to … --prune` may delete. Keyed by a destination key
 * (see `landed.ts`): `<instance host>/workspace/<id>` or
 * `<instance host>/tenant/<name>`. Written by the commands that land objects
 * (deploy, promote, tenant deploy), never by an export — so it is carried
 * through every export untouched and never makes `--frozen-lock` or
 * `export --check` report drift.
 */
export type LandedRecord = Record<string, Record<string, LandedEntry>>;

/** The command that recorded a {@link SyncBaseline}. */
export type SyncSource = "deploy" | "promote" | "pull" | "init";

/** The commands that record a baseline, as the lock spells them. */
const SYNC_SOURCES: ReadonlySet<string> = new Set<SyncSource>(["deploy", "promote", "pull", "init"]);

/**
 * One workspace branch's sync baseline: a content digest of each object the
 * branch held the last time this project and the branch matched (see
 * `deploy/sync-baseline.ts`). `workspace diff` reads it to say which side
 * changed since.
 */
export interface SyncBaseline {
  /** When the baseline last changed, ISO-8601. A sync that changed nothing keeps the old time. */
  at: string;
  /** The command that recorded it. */
  by: SyncSource;
  /**
   * The digest scheme the digests were taken under. A baseline taken under
   * another scheme is not compared: its digests would differ from today's for
   * an object nobody changed.
   */
  scheme: number;
  /**
   * Whether {@link objects} names EVERY object the branch held, not only this
   * project's. Only then does an object the baseline does not name mean it was
   * added in Xano since.
   */
  complete: boolean;
  /** The project's objects there: `<sdkKind>:<name>`, as `workspace diff` labels it → content digest. */
  objects: Record<string, string>;
  /**
   * The rest of what the branch held, the same way: objects another source
   * put there, and sections a decode does not write into the tree. Absent
   * when there were none.
   */
  others?: Record<string, string>;
}

/**
 * Per workspace destination (the {@link LandedRecord} key), per branch label,
 * the baseline last recorded there. Written by deploy, promote, pull and
 * `init --from`, after their write succeeded. Like `landed`, it is carried
 * through every export untouched.
 */
export type SyncedRecord = Record<string, Record<string, SyncBaseline>>;

export interface LockFile {
  version: typeof LOCK_VERSION;
  objects: Record<string, LockEntry>;
  /** Absent (or empty) until this project lands something. See {@link LandedRecord}. */
  landed?: LandedRecord;
  /** Absent (or empty) until this project syncs with a workspace branch. See {@link SyncedRecord}. */
  synced?: SyncedRecord;
}

/**
 * `base` with the sync baselines of `lock` carried across. Every rebuild of a
 * lock goes through this: a baseline dropped by an identity transform would
 * make every object read as changed on the next diff.
 */
export function withSyncedOf<T extends LockFile>(base: T, lock: Pick<LockFile, "synced">): T {
  return lock.synced !== undefined && Object.keys(lock.synced).length > 0 ? { ...base, synced: lock.synced } : base;
}

/**
 * A destination key as the lock records it: `<instance host>/workspace/<id>`
 * or `<instance host>/tenant/<name>` (a standard tenant).
 */
export const DESTINATION_KEY = /^[^/\s]+\/(?:workspace\/[1-9]\d*|tenant\/[^/\s]+)$/;

/**
 * An ephemeral's destination key, `<instance host>/ephemeral/<name>`. Its record
 * lives in uncommitted local state, never the lock, so one found in a lock is
 * dropped on load rather than refused.
 */
const EPHEMERAL_DESTINATION_KEY = /^[^/\s]+\/ephemeral\/[^/\s]+$/;

/** A fresh, empty lock model. */
export function emptyLock(): LockFile {
  return { version: LOCK_VERSION, objects: {} };
}

/**
 * The same lock with a new `objects` map — and its landing record carried
 * across untouched. Every transform of the identities (export merge, rename,
 * prune, import) goes through this, because none of them lands anything: a
 * record dropped here would silently disown every object this project put on
 * every destination.
 */
export function withObjects(lock: LockFile, objects: Record<string, LockEntry>): LockFile {
  return withSyncedOf(
    lock.landed !== undefined && Object.keys(lock.landed).length > 0
      ? { version: lock.version, objects, landed: lock.landed }
      : { version: lock.version, objects },
    lock,
  );
}

/**
 * Scan raw JSON text for duplicate keys within a single object scope.
 *
 * `JSON.parse` silently keeps the LAST duplicate — exactly what a botched git
 * merge produces (`"function:a": {…}` twice) — so the raw text is scanned
 * before parsing. Tracks string/escape state and a stack of per-object key
 * sets; a string is a key when the container is an object and the next
 * non-whitespace char is `:`.
 */
function findDuplicateRawKey(text: string): string | undefined {
  const stack: Array<Set<string> | null> = []; // Set for objects, null for arrays
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(new Set());
      i++;
    } else if (ch === "[") {
      stack.push(null);
      i++;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
    } else if (ch === '"') {
      // Consume the string literal.
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          value += text[j]! + (text[j + 1] ?? "");
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      j++; // past closing quote
      // A key iff the next non-ws char is `:` and the container is an object.
      let k = j;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] === ":") {
        const scope = stack[stack.length - 1];
        if (scope) {
          // Compare the DECODED key, not the raw escaped text — `"a"` and
          // `"a"` are the same key to JSON.parse, so an escape-variant
          // duplicate must not slip past the scan.
          let decoded = value;
          try {
            decoded = JSON.parse(`"${value}"`) as string;
          } catch {
            // Malformed escape — keep the raw form; JSON.parse of the whole
            // text will reject the file anyway.
          }
          if (scope.has(decoded)) return decoded;
          scope.add(decoded);
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return undefined;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid lock file ${path}: ${message}`);
}

/**
 * Parse + strictly validate lock file text. Every failure is a hard error
 * — the caller must never fall back to an unlocked export when a lock
 * file exists but is broken.
 */
export function parseLock(text: string, path = "xano.lock"): LockFile {
  return parseLockReport(text, path).lock;
}

/**
 * {@link parseLock}, plus what the load DROPPED: the ephemeral landing records
 * (`<host>/ephemeral/<name>`) a lock written before that record moved to local
 * state still carries. Dropping them is right; saying nothing is not — the file
 * on disk still holds them, so a caller comparing "before" against "after" has to
 * count them as a change, or `export --check` passes a lock a plain export then
 * silently rewrites.
 */
export function parseLockReport(
  text: string,
  path = "xano.lock",
  opts: ValidateOptions = {},
): { lock: LockFile; droppedLandings: string[] } {
  const droppedLandings: string[] = [];
  // Before anything else reads it: conflict markers also make duplicate keys
  // and unparseable JSON, and either of those reports the symptom.
  if (/^(?:<{7}|>{7})(?: |$)|^={7}$/m.test(text)) {
    fail(
      path,
      `it holds unresolved merge-conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Resolve it as the union ` +
        `of both sides: keep every entry under \`objects\` (and \`landed\`) from each, delete the markers, and fix ` +
        `the commas. Under \`synced\`, keep either side's baseline for a branch, or delete it: a missing baseline ` +
        `only means \`workspace diff\` cannot say which side changed until the next deploy or pull. Where both sides renamed one object, two keys then share a guid — keep the one your code ` +
        `exports and remove the other with \`xanosdk lock prune --identity-only --yes <key>\`.`,
    );
  }
  const dup = findDuplicateRawKey(text);
  if (dup !== undefined) {
    fail(
      path,
      `duplicate key "${dup}" in the raw text (likely a bad merge — ` +
        `JSON keeps only the last one silently). Resolve the duplicate and re-run.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(path, `unparseable JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(path, "expected a top-level object.");
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== LOCK_VERSION) {
    fail(
      path,
      `unknown version ${JSON.stringify(obj.version)} (this Xano SDK reads version ${LOCK_VERSION}). ` +
        `Upgrade Xano SDK to a release that understands this lock format.`,
    );
  }
  if (!obj.objects || typeof obj.objects !== "object" || Array.isArray(obj.objects)) {
    fail(path, "expected an `objects` map.");
  }
  const objects = validateLockObjects(obj.objects, path, opts);
  const landed = obj.landed === undefined ? undefined : validateLanded(obj.landed, path, droppedLandings);
  const synced = obj.synced === undefined ? undefined : validateSynced(obj.synced);
  return {
    lock: {
      version: LOCK_VERSION,
      objects,
      ...(landed !== undefined && Object.keys(landed).length > 0 ? { landed } : {}),
      ...(synced !== undefined && Object.keys(synced).length > 0 ? { synced } : {}),
    },
    droppedLandings,
  };
}

/**
 * Validate the `landed` map: destination key → lock key → `{ guid, type? }`.
 * As hard-line as the rest of the file — a landing record is what a prune
 * deletes by, so a malformed one must never read as "nothing landed" or, worse,
 * as something it does not say.
 */
function validateLanded(raw: unknown, path: string, dropped: string[]): LandedRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(path, "`landed` must be an object of destination → landed identities.");
  }
  const out: LandedRecord = {};
  for (const [dest, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (EPHEMERAL_DESTINATION_KEY.test(dest)) {
      dropped.push(dest);
      continue;
    }
    if (!DESTINATION_KEY.test(dest)) {
      fail(
        path,
        `\`landed\` destination "${dest}" is not \`<instance host>/workspace/<id>\` or ` +
          `\`<instance host>/tenant/<name>\`.`,
      );
    }
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      fail(path, `\`landed\` destination "${dest}" must map lock keys to \`{ "guid": … }\`.`);
    }
    const record: Record<string, LandedEntry> = {};
    for (const [key, entryRaw] of Object.entries(entries as Record<string, unknown>)) {
      if (key === WORKSPACE_KEY) fail(path, `\`landed\` under "${dest}" names "${key}", which is not an object a deploy lands.`);
      validateKey(key, path);
      const { guid, type } = (entryRaw ?? {}) as Record<string, unknown>;
      if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw) || typeof guid !== "string" || guid === "") {
        fail(path, `\`landed\` entry "${key}" under "${dest}" must be \`{ "guid": "<guid>" }\`.`);
      }
      if (type !== undefined && (type !== "agent" || !key.startsWith("toolset:"))) {
        fail(path, `\`landed\` entry "${key}" under "${dest}" has \`type\` ${JSON.stringify(type)} — only an agent's toolset entry carries one, and it is "agent".`);
      }
      record[key] = type === "agent" ? { guid, type: "agent" } : { guid };
    }
    if (Object.keys(record).length > 0) out[dest] = record;
  }
  return out;
}

/** Sorted by label, so the committed lock diffs by object rather than by write order. */
function sortedDigests(digests: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A workspace destination key: baselines are kept only for what `workspace diff` can read. */
const WORKSPACE_DESTINATION_KEY = /^[^/\s]+\/workspace\/[1-9]\d*$/;

/**
 * Read the `synced` map: workspace destination → branch label → baseline.
 *
 * Lenient where `landed` is hard-line, because a baseline is advisory. A prune
 * deletes by the landing record, so a misread one is dangerous; a baseline only
 * says which side changed, and without one `workspace diff` says
 * `baseline: null`. A baseline this build cannot read (a newer build's `by`, a
 * hand edit) is dropped rather than failing every command that reads the lock.
 */
function validateSynced(raw: unknown): SyncedRecord {
  const out: SyncedRecord = {};
  if (!isPlainRecord(raw)) return out;
  for (const [dest, branches] of Object.entries(raw)) {
    if (!WORKSPACE_DESTINATION_KEY.test(dest) || !isPlainRecord(branches)) continue;
    const record: Record<string, SyncBaseline> = {};
    for (const [branch, entry] of Object.entries(branches)) {
      const baseline = readBaseline(entry);
      if (branch.trim() !== "" && baseline !== undefined) record[branch] = baseline;
    }
    if (Object.keys(record).length > 0) out[dest] = record;
  }
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A digest map, or `undefined` when any entry is not a non-empty string. */
function readDigests(raw: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [label, digest] of Object.entries(raw)) {
    if (typeof digest !== "string" || digest === "") return undefined;
    out[label] = digest;
  }
  return out;
}

function readBaseline(raw: unknown): SyncBaseline | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const { at, by, complete, scheme } = raw;
  const objects = readDigests(raw.objects);
  const others = raw.others === undefined ? {} : readDigests(raw.others);
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  if (typeof by !== "string" || !SYNC_SOURCES.has(by) || typeof complete !== "boolean") return undefined;
  if (typeof scheme !== "number" || !Number.isInteger(scheme) || scheme < 1) return undefined;
  if (objects === undefined || others === undefined) return undefined;
  return { at, by: by as SyncSource, scheme, complete, objects, ...(Object.keys(others).length > 0 ? { others } : {}) };
}

/**
 * Re-run the model-level invariants (key shape, entry shape, duplicate
 * guid/canonical values) on an in-memory lock. The CLI calls this on the
 * merged lock BEFORE writing it, so an export can never persist a lock that
 * the next run's `parseLock` would reject (e.g. two api groups given the same
 * explicit `canonical` in code).
 */
export function validateLockModel(
  lock: LockFile,
  label: string,
  /**
   * What this export emitted (`LockExportContext.observed`). A duplicate the
   * export itself produced is refused as the SOURCE error it is, naming both
   * defs — not as an invalid lock file, which may not even exist yet.
   */
  observed?: Record<string, LockEntry>,
): void {
  if (observed !== undefined) {
    assertEmittedCanonicalsUnique(observed, label);
    assertNoCrossKindGuid(lock, observed, label);
  }
  validateLockObjects(lock.objects, label);
}

/**
 * Refuse a def whose `guid:` is one the lock holds for an object of ANOTHER
 * kind. A guid never moves between kinds, so it is not a rename (E2E pass 20:
 * a table pinning a removed query's guid was reported as "the rename kept its
 * identity", and the query's entry moved to the table).
 */
function assertNoCrossKindGuid(lock: LockFile, observed: Record<string, LockEntry>, lockLabel: string): void {
  const held = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock.objects)) {
    if (entry.guid !== undefined && !(key in observed)) held.set(entry.guid, key);
  }
  for (const [key, entry] of Object.entries(observed)) {
    const other = entry.guid === undefined ? undefined : held.get(entry.guid);
    if (other === undefined || splitKey(other)[0] === splitKey(key)[0]) continue;
    const [pin, holder] = [displayLockKey(key), displayLockKey(other)];
    throw new Error(
      `${pin} pins guid ${entry.guid} in code (\`guid:\` on the def), but ${lockLabel} holds it for ${holder}. ` +
        `A guid never moves between kinds, so this is not a rename: remove that \`guid:\` and ${pin} takes ` +
        `its own identity. Nothing was written.`,
    );
  }
}

/**
 * Refuse two emitted objects of one kind carrying the same canonical — the
 * lock-file wording ("Invalid lock file …: entries … share the same canonical")
 * blamed a file that held no duplicate, or did not exist (E2E pass 17). A
 * canonical `canonical_source: "code"` marks is pinned on the def; one without
 * it was carried from `lockLabel`, and the message says which.
 */
function assertEmittedCanonicalsUnique(observed: Record<string, LockEntry>, lockLabel: string): void {
  const owners = new Map<string, string>();
  for (const key of Object.keys(observed).sort()) {
    const canonical = observed[key]!.canonical;
    if (typeof canonical !== "string" || key === WORKSPACE_KEY) continue;
    const scoped = `${key.slice(0, key.indexOf(":"))}\u0000${canonical}`;
    const prior = owners.get(scoped);
    if (prior === undefined) {
      owners.set(scoped, key);
      continue;
    }
    const pinned = (k: string): boolean => observed[k]!.canonical_source === "code";
    // Both carried from the lock: the lock itself holds the duplicate, and its
    // own validation below says so.
    if (!pinned(prior) && !pinned(key)) continue;
    const [a, b] = [displayLockKey(prior), displayLockKey(key)];
    const where = (k: string, shown: string): string =>
      pinned(k) ? `${shown} pins it in code` : `${shown} carries it from ${lockLabel}`;
    const fix =
      pinned(prior) && pinned(key)
        ? `change or drop the \`canonical\` on one of them`
        : `change the \`canonical\` ${pinned(prior) ? a : b} pins`;
    throw new Error(
      `Two definitions in this project have the same canonical "${canonical}": ${where(prior, a)}, and ` +
        `${where(key, b)}. A canonical is the object's public URL slug, unique per kind — ${fix}.`,
    );
  }
}

/**
 * Validate an `objects` map — key shape, entry shape, and identity-value
 * uniqueness — returning the cleaned model. Shared by `parseLock` (on-disk
 * files) and `adoptFromBundle` (a merged model built from an engine bundle).
 */
export interface ValidateOptions {
  /**
   * Accept two entries sharing a guid or canonical. Only for the lock
   * commands that REMOVE or move one entry (`lock prune --identity-only`,
   * `lock rename`): the way out of a duplicate a merge left behind has to be
   * able to read the file it fixes.
   */
  readonly tolerateDuplicates?: boolean;
  /** The lock file on disk, when there is one: the duplicate's remedy names it. */
  readonly lockFile?: string;
}

/**
 * The remedy for two entries sharing one identity — what a merge that kept
 * both sides of two renames of one object leaves: keep the key the code
 * exports, prune the other.
 */
function duplicateRemedy(keys: readonly string[], lockFile: string | undefined): string {
  if (lockFile === undefined) return "";
  const prune = (key: string): string =>
    `\`xanosdk lock prune --identity-only --yes ${shellQuote(displayLockKey(key))} --lock=${shellQuote(lockFile)}\``;
  return keys.length === 2
    ? ` If a merge kept both sides of a rename, keep the one your code exports and remove the other: ` +
        `${prune(keys[0]!)} or ${prune(keys[1]!)}.`
    : ` Keep the one your code exports and remove each of the others: ${keys.map(prune).join(", ")}.`;
}

/** `"a" and "b"` / `"a", "b" and "c"` — the keys sharing one identity. */
function quotedKeys(keys: readonly string[]): string {
  const q = keys.map((k) => `"${k}"`);
  return q.length === 1 ? q[0]! : `${q.slice(0, -1).join(", ")} and ${q.at(-1)!}`;
}

/**
 * Every identity two or more entries share, refused at once: one refusal per
 * run would send a lock holding several through a fix-and-rerun loop.
 */
function failDuplicates(
  path: string,
  shared: ReadonlyArray<{ what: string; keys: readonly string[] }>,
  lockFile: string | undefined,
): void {
  if (shared.length === 0) return;
  const line = (d: { what: string; keys: readonly string[] }): string =>
    `entries ${quotedKeys(d.keys)} share the same ${d.what}.${duplicateRemedy(d.keys, lockFile)}`;
  if (shared.length === 1) fail(path, line(shared[0]!));
  fail(
    path,
    `${shared.length} identities are each held by more than one entry — fix all of them:\n` +
      shared.map((d) => `  - ${line(d)}`).join("\n"),
  );
}

function validateLockObjects(raw: object, path: string, opts: ValidateOptions = {}): Record<string, LockEntry> {
  const objects: Record<string, LockEntry> = {};
  const guidOwners = new Map<string, string>();
  // Guids are one global identity space; canonicals are NOT — a canonical is
  // unique per KIND, not across kinds. Each canonical-bearing kind addresses a
  // namespace of its own (`/api:<c>/…` for an api group, `/x2/mcp/<c>/<token>/stream`
  // for a toolset, `/ws/<c>` for a realtime server) and is always resolved with
  // the kind already known, so one token on an api group AND a realtime server
  // is legal — it names two different objects at two different URLs. Only a
  // duplicate WITHIN one prefix is a conflict, so key the owners by prefix.
  const canonicalOwners = new Map<string, Map<string, string>>();
  /** Every shared identity, keyed by what is shared — reported together after the walk. */
  const shared = new Map<string, { what: string; keys: string[] }>();
  const share = (id: string, what: string, owner: string, key: string): void => {
    const seen = shared.get(id);
    if (seen === undefined) shared.set(id, { what, keys: [owner, key] });
    else seen.keys.push(key);
  };
  for (const [key, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    validateKey(key, path);
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      fail(path, `entry "${key}" must be an object.`);
    }
    // Tolerate unknown extra fields within version 1 (forward compatibility);
    // only `guid`/`canonical` are read.
    const { guid, canonical, canonical_source: canonicalSource, type, adopted, imported, guid_source: guidSource, replaced } =
      entryRaw as Record<string, unknown>;
    if (guidSource !== undefined && (guidSource !== "code" || guid === undefined)) {
      fail(
        path,
        `entry "${key}" has \`guid_source\` ${JSON.stringify(guidSource)} — it is either \`"code"\` (the guid is a ` +
          `def's own \`guid:\`) beside a \`guid\`, or absent. Remove the field; the next export writes it.`,
      );
    }
    if (
      replaced !== undefined &&
      (!Array.isArray(replaced) || replaced.some((g) => typeof g !== "string" || g === "") || !key.startsWith("dbo:"))
    ) {
      fail(
        path,
        `entry "${key}" has \`replaced\` ${JSON.stringify(replaced)} — only a table entry carries one, as a list of ` +
          `the guids its def's \`guid:\` replaced. Remove the field to stop guarding those tables.`,
      );
    }
    if (adopted !== undefined && adopted !== true) {
      fail(
        path,
        `entry "${key}" has \`adopted\` ${JSON.stringify(adopted)} — it is either \`true\` (added by \`lock import\`) ` +
          `or absent. Remove the field; the next export clears it for anything the project declares.`,
      );
    }
    if (imported !== undefined && imported !== true) {
      fail(
        path,
        `entry "${key}" has \`imported\` ${JSON.stringify(imported)} — it is either \`true\` (a guid \`lock import\` ` +
          `took from a live backend) or absent. Remove the field.`,
      );
    }
    if (type !== undefined && (type !== "agent" || !key.startsWith("toolset:"))) {
      fail(
        path,
        `entry "${key}" has \`type\` ${JSON.stringify(type)} — only an agent's toolset entry carries one, ` +
          `and it is "agent". Remove the field; the next export writes it where it belongs.`,
      );
    }
    if (guid !== undefined && (typeof guid !== "string" || guid === "")) {
      fail(path, `entry "${key}" has a non-string or empty \`guid\`.`);
    }
    if (canonical !== undefined && (typeof canonical !== "string" || canonical === "")) {
      fail(path, `entry "${key}" has a non-string or empty \`canonical\`.`);
    }
    if (guid === undefined && canonical === undefined) {
      fail(path, `entry "${key}" carries neither \`guid\` nor \`canonical\`.`);
    }
    // `canonical_source` is a closed set, checked here rather than normalized:
    // an unrecognised value would otherwise read as "unknown" and quietly
    // demote a slug the author meant as a contract to a preference, which is
    // exactly the silent re-slug this field exists to prevent. Absence is
    // legal — every lock written before this field lacks it — and means
    // "unknown, not pinned" until the next export classifies it.
    if (canonicalSource !== undefined) {
      if (typeof canonicalSource !== "string" || !CANONICAL_SOURCES.has(canonicalSource)) {
        fail(
          path,
          `entry "${key}" has an unknown \`canonical_source\` ${JSON.stringify(canonicalSource)} — ` +
            `expected ${[...CANONICAL_SOURCES].map((s) => `"${s}"`).join(", ")}, or omit it. ` +
            `Re-export to have it written for you.`,
        );
      }
      if (canonical === undefined) {
        fail(
          path,
          `entry "${key}" has a \`canonical_source\` but no \`canonical\` to classify. ` +
            `Remove the field.`,
        );
      }
    }
    // Identity values only make sense on the kinds that carry them: the
    // workspace key is canonical-only, and only api groups / toolsets mint
    // canonicals.
    // A misplaced value is almost certainly a hand-edit mistake that would
    // otherwise sit silently unused.
    const isWorkspaceKey = key === WORKSPACE_KEY;
    if (isWorkspaceKey && guid !== undefined) {
      fail(path, `entry "${key}" cannot carry a \`guid\` (workspace identities are canonical-only).`);
    }
    if (!isWorkspaceKey && canonical !== undefined) {
      const prefix = key.slice(0, key.indexOf(":"));
      if (!CANONICAL_PAYLOAD_KEYS.has(prefix)) {
        fail(
          path,
          `entry "${key}" cannot carry a \`canonical\` — only ` +
            `${[...CANONICAL_PAYLOAD_KEYS].join("/")} objects and the workspace key have one.`,
        );
      }
    }
    // A guid (or canonical) is an identity — two entries sharing one would
    // make the engine upsert two objects onto one row (or, for a canonical
    // duplicated within one kind, serve two objects from one URL token).
    // Refuse the file outright.
    if (typeof guid === "string") {
      const owner = guidOwners.get(guid);
      if (owner !== undefined && opts.tolerateDuplicates !== true) share(`guid\0${guid}`, `guid (${guid})`, owner, key);
      else guidOwners.set(guid, key);
    }
    if (typeof canonical === "string") {
      const scope = isWorkspaceKey ? WORKSPACE_KEY : key.slice(0, key.indexOf(":"));
      let owners = canonicalOwners.get(scope);
      if (owners === undefined) canonicalOwners.set(scope, (owners = new Map()));
      const owner = owners.get(canonical);
      if (owner !== undefined && opts.tolerateDuplicates !== true) {
        share(`canonical\0${scope}\0${canonical}`, `canonical (${canonical})`, owner, key);
      } else owners.set(canonical, key);
    }
    const entry: LockEntry = {};
    if (typeof guid === "string") entry.guid = guid;
    if (typeof canonical === "string") entry.canonical = canonical;
    if (typeof canonicalSource === "string") {
      entry.canonical_source = canonicalSource as CanonicalSource;
    }
    if (type === "agent") entry.type = "agent";
    if (adopted === true) entry.adopted = true;
    if (imported === true) entry.imported = true;
    if (guidSource === "code") entry.guid_source = "code";
    if (Array.isArray(replaced) && replaced.length > 0) entry.replaced = [...(replaced as string[])];
    objects[key] = entry;
  }
  failDuplicates(path, [...shared.values()], opts.lockFile);
  return objects;
}

/**
 * Keys are either the fixed workspace key or `<payloadKey>:<name>`. A
 * `workspace:<anything-else>` key is REJECTED (not normalized): the workspace
 * section has exactly one lockable identity, and a stray `workspace:my-app`-style
 * key is almost certainly a hand-edit mistake that would otherwise sit silently
 * unused. A key this build *used* to write says so specifically — see
 * {@link RETIRED_KEYS} — so a stale lock gets told what to delete rather than
 * being accused of a typo.
 */
function validateKey(key: string, path: string): void {
  if (key === WORKSPACE_KEY) return;
  const retired = RETIRED_KEYS.get(key);
  if (retired !== undefined) {
    fail(path, `key "${key}" is retired — ${retired}. Remove the entry.`);
  }
  const idx = key.indexOf(":");
  const prefix = idx === -1 ? key : key.slice(0, idx);
  const name = idx === -1 ? "" : key.slice(idx + 1);
  if (prefix === "workspace") {
    fail(
      path,
      `key "${key}" is not a lockable workspace identity ` +
        `(only "${WORKSPACE_KEY}" exists).`,
    );
  }
  if (idx === -1 || name === "" || !LOCK_PAYLOAD_KEYS.has(prefix)) {
    fail(
      path,
      `key "${key}" is not \`<payloadKey>:<name>\` with a known payload key ` +
        `(${[...LOCK_PAYLOAD_KEYS].join(", ")}).`,
    );
  }
}

/** Serialize with sorted keys (stable diffs) and a trailing newline. */
export function serializeLock(lock: LockFile): string {
  const objects: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.objects).sort()) {
    const src = lock.objects[key]!;
    // Field order inside an entry is fixed too (guid, canonical, canonical_source).
    const entry: LockEntry = {};
    if (src.guid !== undefined) entry.guid = src.guid;
    if (src.canonical !== undefined) entry.canonical = src.canonical;
    // Never write the classification without the value it classifies — the
    // pair is what `parseLock` accepts.
    if (src.canonical !== undefined && src.canonical_source !== undefined) {
      entry.canonical_source = src.canonical_source;
    }
    if (src.type === "agent" && key.startsWith("toolset:")) entry.type = "agent";
    if (src.adopted === true) entry.adopted = true;
    if (src.imported === true) entry.imported = true;
    if (src.guid_source === "code" && src.guid !== undefined) entry.guid_source = "code";
    if (src.replaced !== undefined && src.replaced.length > 0 && key.startsWith("dbo:")) entry.replaced = [...src.replaced];
    objects[key] = entry;
  }
  // The landing record, sorted at both levels so two deploys that land the same
  // set write the same bytes. Omitted when empty — a lock that never landed
  // anything is byte-identical to one written before the record existed.
  const landed: LandedRecord = {};
  for (const dest of Object.keys(lock.landed ?? {}).sort()) {
    const src = lock.landed![dest]!;
    const keys = Object.keys(src).sort();
    if (keys.length === 0) continue;
    const record: Record<string, LandedEntry> = {};
    for (const key of keys) {
      const e = src[key]!;
      record[key] = e.type === "agent" && key.startsWith("toolset:") ? { guid: e.guid, type: "agent" } : { guid: e.guid };
    }
    landed[dest] = record;
  }
  // The sync baselines, sorted at every level for the same reason. Omitted
  // when empty, so a lock that never synced is byte-identical to one written
  // before the section existed.
  const synced: SyncedRecord = {};
  for (const dest of Object.keys(lock.synced ?? {}).sort()) {
    const src = lock.synced![dest]!;
    const record: Record<string, SyncBaseline> = {};
    for (const branch of Object.keys(src).sort()) {
      const b = src[branch]!;
      const others = b.others === undefined ? {} : sortedDigests(b.others);
      record[branch] = {
        at: b.at,
        by: b.by,
        scheme: b.scheme,
        complete: b.complete,
        objects: sortedDigests(b.objects),
        ...(Object.keys(others).length > 0 ? { others } : {}),
      };
    }
    if (Object.keys(record).length > 0) synced[dest] = record;
  }
  return (
    JSON.stringify(
      {
        version: lock.version,
        objects,
        ...(Object.keys(landed).length > 0 ? { landed } : {}),
        ...(Object.keys(synced).length > 0 ? { synced } : {}),
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Mint a canonical: 8 chars of websafe base64 from crypto randomness, the
 * engine's canonical format. Random (NOT name-derived — a
 * canonical is a public URL token; deriving it from names would make API paths
 * guessable). This is the repo's only intentional randomness; determinism is
 * preserved because a minted value is immediately frozen in the lock.
 */
export function mintCanonical(): string {
  // 6 random bytes → exactly 8 base64 chars, no padding.
  let bin = "";
  for (const b of randomBytes(6)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------------------------------------------------------------------------
// Export-side lock participation (used by `Xano.export({ lock })` and the CLI)
// ---------------------------------------------------------------------------

/**
 * The channel between the CLI (or a programmatic caller) and `Xano.export()`.
 * The caller creates it from the validated on-disk lock; `export()` MUTATES it,
 * filling `observed` with every identity the bundle actually emitted. The
 * caller then merges `observed` back into the lock via {@link mergeObserved}.
 *
 * `observed` (not the global override store) is the write-back source so a
 * process exporting multiple workspaces cannot leak one workspace's entries
 * into another's lock file.
 */
export interface LockExportContext {
  /** The validated lock the export runs against (empty for a first lock). */
  lock: LockFile;
  /** Filled by `export()`: lock key → identity actually emitted in the bundle. */
  observed: Record<string, LockEntry>;
  /**
   * Filled by `export()`: entries whose def pins an explicit `guid` other than
   * the one the lock recorded. The def wins — the merged lock records its guid —
   * and the caller says so, since a committed file changes under it.
   */
  repinned?: { key: string; from: string; to: string }[];
}

/** Create the context `Xano.export({ lock })` fills. */
export function createLockContext(lock: LockFile = emptyLock()): LockExportContext {
  return { lock, observed: {}, repinned: [] };
}

/**
 * Record one emitted identity into `ctx.observed`, hard-erroring on an
 * explicit-vs-lock guid split: within one bundle every reference resolves
 * through the seeded lock, so an object whose payload guid disagrees with its
 * lock entry would ship a bundle where references point at a guid the target
 * no longer carries — never emit that silently.
 */
export function recordObserved(
  ctx: LockExportContext,
  key: string,
  identity: LockEntry,
): void {
  // Two exported objects collapsing onto one lock key can only happen with
  // DISTINCT guids (identical ones die in assertUniqueGuids): same-identity
  // objects each pinning an explicit guid. (Query and realtime keys carry their
  // composed identity, so a verb pair or one message name on two channels
  // records as two entries and never reaches this.) The lock cannot represent two guids
  // under one key — silently recording last-wins would wedge the NEXT export
  // on an explicit-vs-lock conflict, so refuse at the first locked export
  // instead. `export()` warns about the same pair unlocked, where a rename is
  // still cheap.
  const prior = ctx.observed[key];
  if (
    prior?.guid !== undefined &&
    identity.guid !== undefined &&
    prior.guid !== identity.guid
  ) {
    throw new Error(
      `Two exported objects collapse onto lock key "${displayLockKey(key)}" with different guids ` +
        `(${prior.guid} vs ${identity.guid}) — two same-kind objects sharing one identity behind ` +
        `explicit guids. The lock cannot track both under one key; rename one of the objects.`,
    );
  }
  const entry = ctx.lock.objects[key];
  if (identity.guid !== undefined && entry?.guid !== undefined && identity.guid !== entry.guid) {
    // The overrides WERE seeded from this lock — every derivation of this key
    // returned the lock's guid — so a different one can only be a `guid:` the
    // def pins. That pin is the author's explicit choice (the conflict remedy
    // tells them to make it), so it wins and the lock follows it. A reference
    // that resolved this key by name carries the lock's old guid, and the
    // bundle's reference check refuses that as a dangling guid rather than
    // shipping the split.
    if (getLockedGuid(key) === entry.guid) {
      (ctx.repinned ??= []).push({ key, from: entry.guid, to: identity.guid });
      ctx.observed[key] = { ...ctx.observed[key], ...identity };
      return;
    }
    if (identity.guid === rawDeriveGuid(key)) {
      // The payload carries the plain name-derivation while the lock pins a
      // different value — the overrides were never seeded, so references baked
      // at authoring time disagree with the lock.
      throw new Error(
        `"${displayLockKey(key)}" emitted its name-derived guid (${identity.guid}) but xano.lock pins ` +
          `${entry.guid}. The lock overrides were not seeded before the workspace module ` +
          `loaded — programmatic exports must call seedLockOverrides(lock) before importing ` +
          `any def module (the CLI does this automatically). With them seeded, a \`guid:\` the ` +
          `def pins wins over the lock entry.`,
      );
    }
    throw new Error(
      `"${displayLockKey(key)}" has an explicit guid (${identity.guid}) that differs from its xano.lock ` +
        `entry (${entry.guid}), so references resolved through the lock would split from ` +
        `the object itself. Update the xano.lock entry to the explicit guid, or remove ` +
        `the explicit guid from code, then re-export.`,
    );
  }
  ctx.observed[key] = { ...ctx.observed[key], ...identity };
}

/** Result of `renameLockEntry`. */
export interface RenameResult {
  lock: LockFile;
  /** A fresh name-derived entry the export already appended for the new name, replaced by the move. */
  discardedNewcomer?: LockEntry;
  /**
   * Entries whose key leads with the renamed name, moved with it: an api group's
   * queries (`query:A|GET|x` → `query:B|GET|x`), a realtime server's channels
   * and messages, a channel's messages. `kind` is each one's lock payload key.
   */
  movedChildren: { kind: string; from: string; to: string }[];
}

/**
 * Move a lock entry to a new name keeping its identity values, so the
 * next export emits the ORIGINAL guid under the new name and the engine
 * renames in place.
 *
 * The normal sequence is rename-in-code → export (which warns about the
 * orphan and appends a fresh entry for the new name) → `lock rename`. So an
 * existing entry under the new key is expected — but ONLY when it is the
 * fresh name-derivation the export just appended. That newcomer is replaced
 * (its guid was never the object's real identity; a canonical minted for it is
 * discarded and reported). Any OTHER entry under the new key is a real pinned
 * identity and the rename refuses to clobber it.
 *
 * A name-derived guid under the new key does NOT on its own prove it is that
 * newcomer: every entry of a project that was never adopted from a live
 * workspace is name-derived, so a live object registered under the new name
 * looks identical. Only the source tells them apart — the renamed object's OLD
 * name is no longer exported, a live pair still exports both. So replacing a
 * name-derived entry needs `observed` (the lock keys the workspace exports) and
 * refuses without it; with it, an old key the source still exports refuses too.
 */
/** A composed query lock name: `<group>|<VERB>|<name>` (the group may be empty). */
const COMPOSED_QUERY_NAME = /^[^|]*\|[A-Z]+\|[^|]+$/;

/**
 * Refuse a `lock rename` target no export could ever write, so the moved entry
 * would never match anything and the identity would be lost at the next export.
 *
 * A query is keyed by its composed `<group>|<VERB>|<name>` identity, never by
 * its bare name (a bare `query:<name>` is the legacy form an export rewrites),
 * and no other kind is: a composed name under any other kind is a query key
 * typed under the wrong kind. For a query renamed to a bare name the error
 * spells the composed form the old entry implies, which is almost always the
 * one meant.
 */
export function checkRenameTarget(payloadKey: string, oldName: string, newName: string): void {
  if (oldName === newName) {
    throw new Error(`The old and new names are both "${newName}" — there is nothing to move. Name the entry's new name.`);
  }
  if (payloadKey === "query") {
    if (COMPOSED_QUERY_NAME.test(newName)) return;
    const oldParts = oldName.split("|");
    const suggestion =
      oldParts.length === 3 && !newName.includes("|") ? ` — e.g. "${oldParts[0]}|${oldParts[1]}|${newName}"` : "";
    throw new Error(
      `"${newName}" is not a query lock name. A query is locked by its composed identity ` +
        `"<group>|<VERB>|<name>"${suggestion}; an entry under any other name matches nothing an ` +
        `export writes.`,
    );
  }
  // A realtime channel is keyed `<server>|<path>`, a message
  // `<server>|<channel path>|<name>` — every part non-empty.
  const realtimeParts = payloadKey === "channel" ? 2 : payloadKey === "message" ? 3 : 0;
  if (realtimeParts > 0) {
    // Both names are checked: a bare OLD name matches no entry either, and
    // naming only the new one sent the reader back to fail on the other
    // (E2E pass 21). Each bad name gets its composed form — the other name's
    // prefix when that one is composed, the shape's placeholders otherwise.
    const composed = (name: string): boolean => {
      const parts = name.split("|");
      return parts.length === realtimeParts && parts.every((p) => p !== "");
    };
    const bad = [oldName, newName].filter((n) => !composed(n));
    if (bad.length === 0) return;
    const shape = payloadKey === "channel" ? "<server>|<path>" : "<server>|<channel path>|<name>";
    const placeholder = shape.split("|").slice(0, -1);
    const composedFor = (name: string): string | undefined => {
      if (name.includes("|")) return undefined;
      const other = name === oldName ? newName : oldName;
      return [...(composed(other) ? other.split("|").slice(0, -1) : placeholder), name].join("|");
    };
    const examples = bad.map(composedFor).filter((s): s is string => s !== undefined);
    const kindName = sdkKindName(payloadKey);
    throw new Error(
      (bad.length === 1
        ? `"${bad[0]}" is not a ${kindName} lock name.`
        : `Neither "${oldName}" nor "${newName}" is a ${kindName} lock name.`) +
        ` It is locked by its composed identity "${shape}"` +
        (examples.length === 0 ? "" : ` — e.g. ${examples.map((e) => `"${e}"`).join(" and ")}`) +
        `; an entry under any other name matches nothing an export writes.`,
    );
  }
  if (COMPOSED_QUERY_NAME.test(newName)) {
    throw new Error(
      `"${newName}" is a query lock name ("<group>|<VERB>|<name>"), not ${withArticle(sdkKindName(payloadKey))} name. ` +
        `${article(sdkKindName(payloadKey)) === "an" ? "An" : "A"} ${sdkKindName(payloadKey)} entry is keyed by the object's own name; to move a query entry, use ` +
        `\`lock rename query\`.`,
    );
  }
}

export function renameLockEntry(
  lock: LockFile,
  payloadKey: string,
  oldName: string,
  newName: string,
  observed?: ReadonlySet<string>,
  /** The kind as messages name it — the SDK spelling, or the one typed for a toolset. */
  shownKind: string = payloadKey === "toolset" ? "mcpServer" : sdkKindName(payloadKey),
): RenameResult {
  const oldKey = lockKey(payloadKey, oldName);
  const newKey = lockKey(payloadKey, newName);
  const shownOld = `${shownKind}:${oldName}`;
  const shownNew = `${shownKind}:${newName}`;
  const entry = lock.objects[oldKey];
  if (entry === undefined) {
    throw new LockEntryNotFoundError(
      `No lock entry "${shownOld}". \`lock rename\` moves an existing entry — check the kind and ` +
        `old name (kinds: ${acceptedLockKinds().join(", ")}).`,
    );
  }
  const objects = { ...lock.objects };
  let discardedNewcomer: LockEntry | undefined;
  const existing = objects[newKey];
  // The same guid under both names is one identity twice — what a merge of two
  // renames of one object leaves — so moving onto it loses nothing.
  const sameIdentity = existing?.guid !== undefined && existing.guid === entry.guid;
  if (existing !== undefined && !sameIdentity) {
    // A guid `lock import` took from a live backend is that object's, even
    // when it is the one the name derives (a backend deployed from code): it
    // is never a newcomer an export appended, so moving onto it replaces a
    // live identity (E2E pass 30).
    // A guid the def pins in code is re-pinned by the next export whatever
    // the lock holds, even the one its name derives.
    if (
      existing.guid !== rawDeriveGuid(newKey) ||
      existing.imported === true ||
      existing.adopted === true ||
      existing.guid_source === "code"
    ) {
      throw new LockRenameConflictError(
        `Lock entry "${shownNew}" already pins an identity of its own (${existing.guid ?? `canonical ${existing.canonical}`}), ` +
          `so moving "${shownOld}" onto it would lose one of the two. Nothing was written.`,
        { shownOld, shownNew },
      );
    }
    if (observed === undefined) {
      throw new Error(
        `Lock entry "${shownNew}" already exists, and its name-derived guid cannot tell the fresh ` +
          `entry an export appends after a rename from a live object registered as "${newName}". ` +
          `Pass --entry=<path> so the workspace source can say which one it is.`,
      );
    }
    if (observed.has(oldKey)) {
      throw new Error(
        `"${shownOld}" is still exported by the workspace, so "${shownNew}" is a separate live object, ` +
          `not the renamed one. Moving the entry would give "${newName}" the identity of ` +
          `"${oldName}" and the next deploy would swap or recreate both. Rename the object in code ` +
          `first, then re-run \`lock rename\`.`,
      );
    }
    discardedNewcomer = existing;
  }
  delete objects[oldKey];
  // A canonical the code pins on the renamed object wins at emit over anything
  // the lock holds, so the moved entry carries it (and says so) — otherwise the
  // next export rewrites the lock and a frozen check fails on a finished rename.
  // The moved guid is the lock's now, under a name whose def does not pin it.
  const { guid_source: _source, ...moved } = entry;
  objects[newKey] =
    existing?.canonical_source === "code" && existing.canonical !== undefined
      ? { ...moved, canonical: existing.canonical, canonical_source: "code" }
      : { ...moved };
  // A query's key composes its group's name, so an api group's queries move
  // with it (E2E pass 20): left behind, each one conflicts on the next release.
  // Realtime keys compose the same way: a server's channels and messages lead
  // with its name, and a channel's messages with `<server>|<path>`.
  const movedChildren: { kind: string; from: string; to: string }[] = [];
  const children =
    payloadKey === "app" ? ["query"] : payloadKey === "realtime_server" ? ["channel", "message"] : payloadKey === "channel" ? ["message"] : [];
  for (const child of children) {
    for (const key of Object.keys(lock.objects).filter((k) => k.startsWith(`${child}:${oldName}|`))) {
      const to = `${child}:${newName}|${key.slice(`${child}:${oldName}|`.length)}`;
      const there = objects[to];
      if (there !== undefined && there.guid !== rawDeriveGuid(to)) {
        throw new LockRenameConflictError(
          `Lock entry "${to}" already pins an identity of its own (${there.guid ?? `canonical ${there.canonical}`}), ` +
            `so moving "${key}" with its group onto it would lose one of the two. Nothing was written.`,
          { shownOld: key, shownNew: to },
        );
      }
      objects[to] = { ...objects[key]! };
      delete objects[key];
      movedChildren.push({ kind: child, from: key, to });
    }
  }
  return { lock: withObjects(lock, objects), discardedNewcomer, movedChildren };
}

/** One entry-level change `adoptFromBundle` would apply. */
export interface AdoptChange {
  key: string;
  before: LockEntry;
  after: LockEntry;
}

/** Result of `adoptFromBundle`. */
export interface AdoptResult {
  lock: LockFile;
  /** Keys newly added to the lock. */
  added: string[];
  /** Existing entries whose values the bundle overwrites. */
  changed: AdoptChange[];
  /** True when at least one adopted object carried a canonical. */
  canonicalsSeen: boolean;
  /** Number of `vault` (file library) payload entries in the source bundle. */
  vaultCount: number;
  /** How many of those are not public — the ones to keep out of a commit. */
  privateVaultCount: number;
  /** Every key the bundle carried an identity for (added, changed, or already matching). */
  seen: string[];
  /**
   * Entries left as they were because their def pins its own guid in code
   * (`guid_source: "code"`), which wins over the lock: adopting the bundle's
   * guid there would be undone by the next export. `live` is the bundle's.
   */
  codePinned: { key: string; guid: string; live: string }[];
}

/**
 * Seed/update the lock from a live engine `packageExport` bundle —
 * capturing the workspace's random guids and canonicals by `(type, name)` so
 * an existing workspace can be adopted into code without a delete+create sync.
 *
 * Adopted values win over existing lock values field-by-field; a lock-held
 * canonical is KEPT when the bundle has none for that object (the engine's
 * standard partial export strips canonicals — erasing ours would lose minted
 * values). Two same-named objects in one section (e.g. a GET/POST query verb
 * pair) are a hard error: the lock keys by `(type, name)` and silently keeping
 * one of the two would weld the wrong identity onto both.
 */
export function adoptFromBundle(lock: LockFile, bundle: unknown, bundlePath: string): AdoptResult {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new NotABundleError(`${bundlePath} is not a Xano bundle (expected a JSON object with a \`payload\`).`);
  }
  const payload = (bundle as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new NotABundleError(`${bundlePath} has no \`payload\` — it is not a Xano bundle.`);
  }
  const sections = payload as Record<string, unknown>;
  const objects = { ...lock.objects };
  for (const key of Object.keys(objects)) objects[key] = { ...objects[key]! };
  const added: string[] = [];
  const changed: AdoptChange[] = [];
  let canonicalsSeen = false;

  const imported = new Set<string>();
  const codePinned: AdoptResult["codePinned"] = [];
  const applyEntry = (key: string, incoming: LockEntry): void => {
    const before = objects[key];
    if (
      before?.guid_source === "code" &&
      before.guid !== undefined &&
      incoming.guid !== undefined &&
      incoming.guid !== before.guid
    ) {
      codePinned.push({ key, guid: before.guid, live: incoming.guid });
      return;
    }
    imported.add(key);
    const after: LockEntry = { ...before, ...incoming };
    // Adoption takes the slug the WORKSPACE serves, which is not in general a
    // promise the project made — so a slug that CHANGES drops its
    // classification rather than carrying a stale `"code"` across, which would
    // make the next release refuse over a value the author never pinned.
    //
    // A slug that is UNCHANGED keeps it. Nothing about the pin has moved, and
    // dropping it there loses a real fact for no reason: `--replace` reconciles
    // the lock against a workspace it has just built FROM this project, so
    // every slug comes back identical and the whole file would be declassified
    // in one step. Within a release that self-heals — the compile re-stamps the
    // lock before the pinned set is read — but a `--bundle` release does not
    // compile, so it would send no pins at all and a contract would silently
    // become a preference.
    // It is recorded as adopted — the workspace key's slug is the engine's own
    // and carries no classification.
    if (incoming.canonical !== undefined && incoming.canonical !== before?.canonical) {
      if (key === WORKSPACE_KEY) delete after.canonical_source;
      else after.canonical_source = "adopted";
    }
    // A guid taken from the backend is the lock's, not a def's — unless it is
    // the one the entry already held, whose source nothing here changed.
    if (before?.guid !== after.guid) delete after.guid_source;
    // A guid a def replaced is never the entry's own.
    if (after.replaced !== undefined && after.guid !== undefined && after.replaced.includes(after.guid)) {
      const rest = after.replaced.filter((g) => g !== after.guid);
      if (rest.length > 0) after.replaced = rest;
      else delete after.replaced;
    }
    if (before === undefined) {
      objects[key] = after;
      added.push(key);
    } else if (before.guid !== after.guid || before.canonical !== after.canonical) {
      changed.push({ key, before, after });
      objects[key] = after;
    } else if (before.canonical_source !== after.canonical_source || before.type !== after.type) {
      // Not a `changed` entry: no identity moved, so there is nothing for the
      // `--yes` prompt to describe and nothing a reader could act on.
      objects[key] = after;
    }
  };

  const appNames = identityNamesByGuid(sections);
  for (const payloadKey of LOCK_PAYLOAD_KEYS) {
    const arr = sections[payloadKey];
    if (!Array.isArray(arr)) continue;
    const namesSeen = new Set<string>();
    for (const obj of arr) {
      if (!obj || typeof obj !== "object") continue;
      const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown };
      if (typeof o.name !== "string" || typeof o.guid !== "string" || o.guid === "") continue;
      // A query's lock name is its composed (group, verb, name) identity, so an
      // engine-side GET/POST pair adopts as two entries. What still aborts is a
      // TRUE duplicate — two rows composing the same identity — which the lock
      // cannot represent for any kind.
      const lockName = lockNameForObject(payloadKey, o as { name: string }, appNames);
      if (namesSeen.has(lockName)) {
        throw new Error(
          `${bundlePath} contains two "${payloadKey}" objects with the identity "${lockName}" — ` +
            `the lock keys identity per kind and cannot represent both. Adoption aborted; ` +
            `rename one of them engine-side, then re-export and re-adopt.`,
        );
      }
      namesSeen.add(lockName);
      const incoming: LockEntry = { guid: o.guid };
      if (typeof o.canonical === "string" && o.canonical !== "") {
        incoming.canonical = o.canonical;
        canonicalsSeen = true;
      }
      if (payloadKey === "toolset" && (o as { type?: unknown }).type === "agent") incoming.type = "agent";
      applyEntry(lockKey(payloadKey, lockName), incoming);
    }
  }

  // The workspace canonical lands under its fixed key.
  const ws = sections["workspace"];
  if (ws && typeof ws === "object" && !Array.isArray(ws)) {
    const w = ws as { canonical?: unknown };
    if (typeof w.canonical === "string" && w.canonical !== "") {
      canonicalsSeen = true;
      applyEntry(WORKSPACE_KEY, { canonical: w.canonical });
    }
  }

  const vault = sections["vault"];
  const vaultCount = Array.isArray(vault) ? vault.length : 0;
  const privateVaultCount = Array.isArray(vault) ? vault.filter(isPrivateLibraryRow).length : 0;

  refuseImportedGuidClash(objects, imported, bundlePath, toolsetKindsFromPayload(payload, lock.objects));
  // Re-validate the merged model (duplicate canonical values, key shape) —
  // engine bundles are outside our control and a broken lock must never land.
  let validated: Record<string, LockEntry>;
  try {
    validated = validateLockObjects(objects, bundlePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^Invalid lock file [^:]*: /, "") : String(err);
    throw new LockImportConflictError(
      `Adopting ${bundlePath} would leave an invalid lock — ${detail} ` +
        `Fix the entry named in xano.lock (\`xanosdk lock rename\` or \`xanosdk lock prune --identity-only\`), ` +
        `then re-run the import.`,
    );
  }
  const merged: LockFile = withObjects(lock, validated);
  return {
    lock: merged,
    added: added.sort(),
    changed,
    canonicalsSeen,
    vaultCount,
    privateVaultCount,
    seen: [...imported].sort(),
    codePinned,
  };
}

/** A file `lock import` was pointed at that is not a Xano bundle — fixed by pointing at one. */
export class NotABundleError extends Error {
  override readonly name = "NotABundleError";
}

/**
 * Refuse an import that would give one guid to two lock entries, naming which
 * is which. The usual cause is a rename made in the workspace: the bundle holds
 * the object's guid under its new name while the lock still keeps it under the
 * old one — which the lock's own validation reported as a bare duplicate.
 */
function refuseImportedGuidClash(
  objects: Readonly<Record<string, LockEntry>>,
  imported: ReadonlySet<string>,
  bundlePath: string,
  kinds: ReadonlyMap<string, string>,
): void {
  const owners = new Map<string, string>();
  for (const [key, entry] of Object.entries(objects)) {
    if (entry.guid === undefined) continue;
    const other = owners.get(entry.guid);
    if (other === undefined) {
      owners.set(entry.guid, key);
      continue;
    }
    const live = imported.has(key) ? key : other;
    const stale = live === key ? other : key;
    const [liveKind, liveName] = splitKey(live);
    const [staleKind, staleName] = splitKey(stale);
    // A toolset is named by what the bundle says it is (the stale name is not
    // in it, so it takes the live object's kind — a rename keeps the kind).
    const kindWord = staleKind === "toolset" ? (kinds.get(liveName) ?? "mcpServer") : sdkKindName(staleKind);
    const sameKindRename = !imported.has(stale) && liveKind === staleKind;
    // Which side renamed is not knowable from the bundle and the lock alone, so
    // both readings are named here; `lock import`, which can evaluate the
    // workspace source, narrows this to the one that applies.
    const remedy =
      imported.has(stale)
        ? `The bundle itself carries that guid twice; export the workspace again and re-import.`
        : sameKindRename
          ? `One side renamed it. If the workspace did, rename it in code to "${liveName}" too, then ` +
            `\`xanosdk lock rename ${kindWord} ${staleName} ${liveName}\` and re-run the import. If your ` +
            `source did, the lock already follows it: deploy the rename, then export the workspace again and re-import.`
          : `Drop the stale entry first — \`xanosdk lock prune --identity-only ${displayLockKey(stale, kinds)} --yes\` — ` +
            `then re-run the import.`;
    const head =
      `${bundlePath} holds guid ${entry.guid} under "${displayLockKey(live, kinds)}", but the lock ` +
      `already pins it to "${displayLockKey(stale, kinds)}".`;
    throw new LockImportConflictError(`${head} ${remedy}`, {
      ...(sameKindRename
        ? {
            clash: {
              guid: entry.guid,
              kind: staleKind,
              kindWord,
              workspaceName: liveName,
              lockName: staleName,
              workspaceKey: displayLockKey(live, kinds),
              lockKey: displayLockKey(stale, kinds),
            },
          }
        : {}),
    });
  }
}

function splitKey(key: string): [string, string] {
  const colon = key.indexOf(":");
  return colon <= 0 ? [key, ""] : [key.slice(0, colon), key.slice(colon + 1)];
}

/**
 * The lock without its `guid_source` notes — for a gate that compares
 * identities (`--frozen-lock`, `export --check`): an export of this build
 * writing the note onto a lock written before it is not an identity change.
 */
export function withoutGuidSources(lock: LockFile): LockFile {
  const objects: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(lock.objects)) {
    const { guid_source: _source, ...rest } = entry;
    objects[key] = rest;
  }
  return withObjects(lock, objects);
}

/** Result of folding an export's observed identities back into the lock. */
export interface MergeResult {
  lock: LockFile;
  /** Lock keys no exported object matched — candidates for `lock rename`/`prune`. */
  orphans: string[];
  /** Orphans dropped because their GUID re-appeared under a live key. */
  dropped: string[];
  /** Orphans kept, but whose canonical was ceded to a live entry that now emits it. */
  cededCanonicals: string[];
}

/**
 * Merge observed identities into the lock (pure — returns a new model).
 *
 * Observed values win field-by-field (an explicit in-code value updates the
 * recorded one). Entries nothing matched are kept as orphans and
 * reported — renames are never guessed — with one exception: an orphan
 * whose GUID now belongs to a LIVE entry OF ITS KIND is dropped. That happens when a
 * rename is reverted after a `lock rename` fix-up (the old name re-derives the
 * pinned guid): keeping the orphan would wedge the lock on its own
 * duplicate-identity validation forever.
 *
 * A canonical-only match is NOT grounds for dropping: the orphan's guid may be
 * a real adopted engine identity, and deleting it would delete+create the
 * server object on the next rename fix-up. Instead the orphan stays (with its
 * guid) and only its canonical is ceded to the live entry that now emits it —
 * which also keeps the merged lock free of duplicate canonical values.
 */
export function mergeObserved(
  lock: LockFile,
  observed: Record<string, LockEntry>,
  /**
   * Keep `adopted` on the keys this export declares. Only a gate that compares
   * and never writes (`--frozen-lock`, `export --check`) passes it: clearing a
   * provenance note is not an identity change, and must not read as drift.
   */
  opts: {
    keepAdopted?: boolean;
    /**
     * Every guid a landing record holds (the lock's and this machine's local
     * ones). A def's earlier `guid:` that a re-pin replaced is kept as
     * `replaced` only when it landed somewhere; a guid the lock held for any
     * other reason (derived, moved by `lock rename`, adopted) always is.
     */
    landedGuids?: ReadonlySet<string>;
  } = {},
): MergeResult {
  const objects: Record<string, LockEntry> = {};
  for (const [key, identity] of Object.entries(observed)) {
    const prior = lock.objects[key];
    const entry: LockEntry = { ...prior, ...identity };
    // The kind hint and the guid's source are what this export saw, not what
    // the lock remembered.
    if (identity.type === undefined) delete entry.type;
    if (identity.guid_source === undefined) delete entry.guid_source;
    // A def's `guid:` re-pinned this table: an environment may still hold it
    // under the guid the lock had, so that guid is kept for the keep-data
    // merge to refuse dropping instead of dropping silently.
    if (key.startsWith("dbo:") && prior?.guid !== undefined && entry.guid !== undefined && prior.guid !== entry.guid) {
      const mayHoldRows = prior.guid_source !== "code" || opts.landedGuids?.has(prior.guid) === true;
      if (mayHoldRows) entry.replaced = [...(prior.replaced ?? []), prior.guid];
    }
    // The project's source declares it now, so it is no longer only adopted —
    // but its guid is still the live object's, which `imported` keeps saying.
    if (opts.keepAdopted !== true && entry.adopted === true) {
      delete entry.adopted;
      entry.imported = true;
    }
    // Unless the code now pins another guid: then it is no longer that object's.
    if (lock.objects[key]?.guid !== entry.guid) delete entry.imported;
    objects[key] = entry;
  }
  // guid → the payload key that now carries it. Only a SAME-kind carrier is a
  // rename that kept its identity; a guid never moves between kinds, so a
  // cross-kind match keeps the orphan and `validateLockModel` refuses the pin.
  const liveGuids = new Map(
    Object.entries(objects).flatMap(([k, e]) => (e.guid === undefined ? [] : [[e.guid, splitKey(k)[0]] as const])),
  );
  const liveCanonicals = new Set(
    Object.values(objects).map((e) => e.canonical).filter(Boolean),
  );
  const orphans: string[] = [];
  const dropped: string[] = [];
  const cededCanonicals: string[] = [];
  for (const [key, entry] of Object.entries(lock.objects)) {
    if (key in objects) continue;
    if (entry.guid !== undefined && liveGuids.get(entry.guid) === splitKey(key)[0]) {
      dropped.push(key);
      continue;
    }
    if (entry.canonical !== undefined && liveCanonicals.has(entry.canonical)) {
      const kept: LockEntry = { ...entry };
      delete kept.canonical;
      // The classification goes with the value it classified — an entry left
      // holding a bare `canonical_source` is not a lock this build would parse.
      delete kept.canonical_source;
      if (kept.guid === undefined) {
        // Canonical-only entry (a workspace key) fully claimed by a live one.
        dropped.push(key);
        continue;
      }
      objects[key] = kept;
      orphans.push(key);
      cededCanonicals.push(key);
      continue;
    }
    objects[key] = entry;
    orphans.push(key);
  }
  // A replaced guid that is an identity again — the def pins it once more, or
  // another entry holds it — is no longer a table to guard.
  const held = new Set(Object.values(objects).flatMap((e) => (e.guid === undefined ? [] : [e.guid])));
  for (const [key, entry] of Object.entries(objects)) {
    if (entry.replaced === undefined) continue;
    const kept = [...new Set(entry.replaced)].filter((g) => !held.has(g));
    if (kept.length === entry.replaced.length) continue;
    const next: LockEntry = { ...entry };
    if (kept.length > 0) next.replaced = kept;
    else delete next.replaced;
    objects[key] = next;
  }
  return {
    lock: withObjects(lock, objects),
    orphans: orphans.sort(),
    dropped: dropped.sort(),
    cededCanonicals: cededCanonicals.sort(),
  };
}
