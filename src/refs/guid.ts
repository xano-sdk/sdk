/**
 * Cross-object reference resolution (the call family's foundation).
 *
 * Xano statements that invoke another workspace object (the call family —
 * `function.run`/`function.call`/`api.call`/…) store a reference to the target.
 * In a `packageExport` bundle that reference is the target's **guid** (the
 * engine converts a local numeric id → the object's
 * guid on export, and remaps it back on import). Engine object guids are
 * 32-char lowercase hex strings (e.g. `276ca71d0ecb26851107a4383daff23b`).
 *
 * xanosdk authors objects without engine ids, so it assigns its own
 * **deterministic** guids: `md5(type:name)`. Determinism is the whole trick —
 * the target object emits `deriveGuid(type, name)` as its payload `guid`, and a
 * call referencing it computes the identical guid from the same `(type, name)`,
 * so the two sides agree with no shared mutable registry. The engine remaps
 * these guids to fresh local ids on import; they only need to be unique within
 * the bundle and consistent between reference and target, which md5(type:name)
 * guarantees (names are unique per type, and the type prefix avoids cross-type
 * collisions).
 */
import { md5Hex } from "../util/hash.js";
import { getLockedGuid } from "../lock/store.js";
import { describeEntry } from "../statements/args.js";

/**
 * Object kinds (by kind `name`) that carry a deterministic `guid` at export.
 *
 * The guid is the engine's **identity anchor**: on a partial/sync import the
 * engine matches an incoming object to an existing one by `(workspace, branch,
 * guid)` and UPDATES it in place — no guid match means a brand-new row. So a
 * *stable* guid per logical object is what makes repeated syncs idempotent
 * (same code → same guids → updates, never duplicates). Because the SDK is the
 * source of truth, we derive a stable guid from `(type, name)` by default — no
 * need to capture Xano's random guids. A def may also set an explicit `guid`
 * (used verbatim) to pin identity across a rename, or to match an object in an
 * existing Xano workspace being adopted into code.
 *
 * Every top-level object the engine tracks by guid belongs here. The guid's
 * *type* prefix is the kind's `payloadKey` (the engine's migrate type):
 * function/query/tool/task/trigger/middleware/addon map name-for-name;
 * `table` → `dbo`, `api_group` → `app`, and `mcp_server`/`agent` → `toolset`
 * (both AI primitives share the toolset migrate type). A reference (call/db
 * statement, a trigger's toolset binding, or a
 * query's `app` binding) resolves its target with that same migrate type, so
 * both sides agree.
 */
export const REFERENCEABLE_KIND_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  function: "function",
  query: "query",
  tool: "tool",
  // The two other primitives an MCP server exposes. An `mcpServer()`'s
  // `prompts`/`resources` entries resolve them by this guid, exactly as its
  // `tools` entries resolve a tool.
  prompt: "prompt",
  resource: "resource",
  // MCP servers and agents are distinct kinds that both persist as
  // obj_type=toolset — they share the "toolset" migrate type, so both derive
  // md5("toolset:"+name) and a same-name pair correctly collides. A trigger
  // binds either by resolving against this same "toolset" migrate type.
  mcp_server: "toolset",
  agent: "toolset",
  task: "task",
  trigger: "trigger",
  middleware: "middleware",
  addon: "addon",
  table: "dbo",
  api_group: "app",
  // Realtime: `realtime_server` -> `channel` -> `message`. Kind names match the
  // engine's object types (the authoring factories carry the `realtime` prefix
  // instead). Channel and message names are NOT workspace-unique, so their
  // seeds are composed — see {@link realtimeChannelSeedName}.
  realtime_server: "realtime_server",
  channel: "channel",
  message: "message",
  // A container workload. Nothing in a stack resolves it by guid — `s.microservice.request`
  // addresses one by NAME — but it is listed here because it is a top-level
  // guid-tracked object, and the codegen index only places objects it recognises.
  microservice: "microservice",
  // An end-to-end test: a named stack of runs plus `expect` assertions. Kind
  // name and migrate type are the same string, so the mapping is identity.
  // Membership here is load-bearing twice over: `s.workflow_test.call` already
  // resolves its target through this map, and `Xano#encodeOne` stamps a guid
  // only for kinds in `REFERENCEABLE_KINDS` — and the engine REFUSES to export a
  // workflow test that has none ("Missing workflow test guid."), a failure that
  // surfaces only against a live instance.
  workflow_test: "workflow_test",
  // Knowledge is listed here for IDENTITY, not for referencing — nothing in a
  // stack resolves a knowledge item. Membership is what stamps its guid in
  // `Xano#encodeOne` and what makes `knowledge:<name>` a valid lock key, and
  // BOTH are load-bearing: the engine re-mints guids on every replace import
  // while a merge import upserts BY guid, so without a locked identity the
  // second promote inserts `<name>_01` beside the item it should have
  // updated. Measured, not theorised.
  knowledge: "knowledge",
};

export const REFERENCEABLE_KINDS = new Set(Object.keys(REFERENCEABLE_KIND_PAYLOAD_KEYS));

/**
 * Separator joining the components of a composite guid seed. Chosen because the
 * engine's own charset rules exclude it from both a channel path
 * (`alphaOk digitOk ok("/_-{}")`) and a message name (`alphaOk digitOk ok("_-")`),
 * so a seed can never be ambiguous between its parts. A realtime server name is
 * free-form text, so it is the one component that must be checked.
 */
const SEED_SEP = "|";

function seedPart(kind: string, label: string, value: string): string {
  if (!value) {
    throw new Error(`realtime ${kind} identity: \`${label}\` is required to derive a stable guid.`);
  }
  if (value.includes(SEED_SEP)) {
    throw new Error(
      `realtime ${kind} identity: \`${label}\` must not contain "${SEED_SEP}" (got "${value}") — ` +
        `it separates the components of the guid seed, so a name carrying it could collide with a different object.`,
    );
  }
  return value;
}

/**
 * The seed *name* for a channel's guid: `<server>|<path>`.
 *
 * A channel path is unique only within its server, so the server has to be part
 * of the identity — otherwise two servers each owning a `rooms` channel would
 * derive one guid and the engine (which upserts by guid) would collapse them
 * onto a single row. Pass the result to `deriveGuid("channel", …)`.
 */
export function realtimeChannelSeedName(server: string, path: string): string {
  return [seedPart("channel", "server", server), seedPart("channel", "path", path)].join(SEED_SEP);
}

/**
 * The seed *name* for a message's guid: `<server>|<channelPath>|<name>`.
 *
 * A message name is unique only within its channel, and its channel only within
 * its server — so all three components are load-bearing. Pass the result to
 * `deriveGuid("message", …)`.
 */
export function realtimeMessageSeedName(
  server: string,
  channelPath: string,
  name: string,
): string {
  return [
    seedPart("message", "server", server),
    seedPart("message", "channel", channelPath),
    seedPart("message", "name", name),
  ].join(SEED_SEP);
}

/**
 * The seed *name* for a query's guid: `<apiGroup>|<verb>|<name>`.
 *
 * A query name is the endpoint PATH within its group, and the engine's own
 * uniqueness for a query is (api group, verb, name) — `GET items` and
 * `POST items` are distinct endpoints in one group, and `items` repeats freely
 * across groups (a v1/v2 pair). Deriving from the name alone made every one of
 * those standard REST layouts collide on one guid, so all three components are
 * load-bearing, exactly as a channel's server is. Pass the result to
 * `deriveGuid("query", …)`.
 *
 * The GROUP component is the group's name (`#<id>` for a raw numeric
 * `apiGroupId`, `""` for a query bound to no group) — matching the realtime
 * convention of composing with the referenced object's NAME. Rebinding a query
 * to a different group therefore changes its identity, which is what the move
 * means (its URL changes wholesale); a lock rename carries it across when that
 * is not wanted.
 */
export function querySeedName(group: string, verb: string, name: string): string {
  // The query/verb charsets exclude `|` by the engine's own rules; a GROUP name
  // is free-form text, so it is the one component that must be checked.
  return [
    group === "" ? "" : seedPart("query", "apiGroup", group),
    seedPart("query", "verb", verb),
    seedPart("query", "name", name),
  ].join(SEED_SEP);
}

/**
 * The guid for a query, from its composed identity — with the LEGACY lock
 * fallback that keeps pre-composition locks working.
 *
 * Lock files written before query identity was composed key queries as
 * `query:<name>`. Those entries must keep pinning their objects or every
 * locked workspace would re-derive fresh query guids on upgrade and duplicate
 * every endpoint at the next release. Lookup order: the composed seed, then the
 * legacy bare-name seed, then the raw derivation of the composed seed. A legacy
 * lock predates verb pairs (the old derivation refused them at export), so the
 * bare-name entry is unambiguous whenever it exists; if two queries sharing a
 * name BOTH fall through to one legacy entry, they pin one guid and
 * `assertUniqueGuids` refuses the bundle, naming the entry to rename.
 */
export function deriveQueryGuid(group: string, verb: string, name: string): string {
  const seed = `query:${querySeedName(group, verb, name)}`;
  const guid = getLockedGuid(seed) ?? getLockedGuid(`query:${name}`) ?? rawDeriveGuid(seed);
  SEEN_SEEDS.set(guid, seed);
  return guid;
}

/** The fields of a query def/handle that its composed identity reads. */
export interface QueryIdentityRef {
  name: string;
  guid?: string;
  verb?: string;
  apiGroup?: string | { name: string };
  apiGroupId?: number;
}

/**
 * The GROUP component of a query's composed identity. Mirrors the binding
 * precedence of the encoder: a raw numeric `apiGroupId` wins when given
 * (spelled `#<id>`, since a number is not a name), else the bound group's
 * name, else `""` for a query bound to no group.
 */
export function queryGroupComponent(ref: Pick<QueryIdentityRef, "apiGroup" | "apiGroupId">): string {
  if (ref.apiGroupId !== undefined) return `#${ref.apiGroupId}`;
  const group = ref.apiGroup;
  if (group === undefined) return "";
  return typeof group === "string" ? group : group.name;
}

/**
 * Resolve a QUERY reference to its guid — `resolveRef`'s query-aware sibling.
 *
 * A query's identity is composed from `(apiGroup, verb, name)`, so a bare
 * name cannot resolve one: `"items"` says nothing about which verb or group,
 * and hashing it would produce a guid no emitted query carries — a reference
 * that exports clean and resolves to nothing. Both bare-string targets and
 * handle-less `{ name }` objects are therefore refused with the fix (pass the
 * `query()` def handle, which carries all three components, or a `{ name,
 * guid }` pair for an object addressed by explicit identity — the shape a
 * pulled workspace round-trips through).
 */
export function resolveQueryRef(target: ObjectRef | QueryIdentityRef, where?: string): string {
  const t = target as unknown;
  // Not a name and not a handle at all — a number, a boolean, an array, an
  // object with no name. There is no reference in it to quote, so say what
  // arrived rather than `Cannot resolve query reference "?"`.
  const named =
    typeof t === "string" ||
    (typeof t === "object" && t !== null && !Array.isArray(t) &&
      (typeof (t as { name?: unknown }).name === "string" || typeof (t as { guid?: unknown }).guid === "string"));
  if (!named) {
    throw new Error(
      `${where ?? "Cannot resolve query reference"}${where ? " must be" : ": pass"} the query() def handle, or a { name, guid } pair ` +
        `for an object addressed by explicit identity — got ${describeEntry(t)}.`,
    );
  }
  if (typeof target !== "string" && target.guid) {
    if (target.name) SEEN_SEEDS.set(target.guid, `query:${target.name}`);
    return target.guid;
  }
  const handle = typeof target === "string" ? undefined : (target as QueryIdentityRef);
  if (handle?.verb !== undefined && handle.name) {
    return deriveQueryGuid(queryGroupComponent(handle), handle.verb, handle.name);
  }
  const label = typeof target === "string" ? `"${target}"` : `"${handle?.name ?? "?"}"`;
  throw new Error(
    `${where ? `${where}: cannot resolve` : "Cannot resolve"} query reference ${label}: a query's identity is composed from its api ` +
      `group, verb, and name, so a bare name cannot identify one. Pass the query() def ` +
      `handle (it carries all three), or a { name, guid } pair to address an object by ` +
      `explicit identity.`,
  );
}

/**
 * A reference to another workspace object: its def handle, or a bare name.
 *
 * A def may carry an explicit `guid` (its Xano identity). When present it's used
 * verbatim; otherwise the guid is derived from `name`. Pass def handles (which
 * carry the `guid`) rather than bare names when an object sets an explicit guid,
 * so the reference and the target agree on the *same* guid.
 */
export type ObjectRef = string | { name: string; guid?: string };

/**
 * The pure name-derivation: md5 of the `type:name` seed (== the lock key),
 * with NO lock consultation. The single home of the identity formula — the
 * lock module compares against it to recognize "this guid is just the
 * derivation" (rename fix-ups, seeding-contract checks).
 */
export function rawDeriveGuid(seed: string): string {
  return md5Hex(seed);
}

/**
 * Whether `guid` has the SHAPE {@link rawDeriveGuid} produces: 32 lowercase hex.
 *
 * A shape test, not provenance — it cannot tell this project's derivation from
 * any other 32-hex string, and a guid an engine assigned is base64url and so
 * never matches. Lives here because the shape is a property of the formula
 * above, and a copy of the pattern elsewhere drifts from what produces it.
 *
 * Used to tell a reader WHY a guid matched nothing: a 32-hex one is a value this
 * project derives and pins in `xano.lock`, which a full-replace import never
 * stored, so it has never matched any backend — a different cause from a guid an
 * environment really had and a redeploy re-minted.
 */
export function isDerivedGuidShape(guid: string): boolean {
  return /^[0-9a-f]{32}$/.test(guid);
}

/**
 * The guid for a `(type, name)` pair. A seeded `xano.lock` override wins (the
 * lock freezes identity across renames — see lock/store.ts); otherwise the
 * deterministic 32-char hex derivation. Every reference and every emitted
 * target flows through here, so a lock override propagates everywhere by
 * construction — including guids embedded inside strings at authoring time.
 */
export function deriveGuid(type: string, name: string): string {
  const seed = `${type}:${name}`;
  const guid = getLockedGuid(seed) ?? rawDeriveGuid(seed);
  SEEN_SEEDS.set(guid, seed);
  return guid;
}

/**
 * What each guid this process derived was derived FROM (`"<type>:<name>"`).
 *
 * A **diagnostic hint only**. A guid is the identity — nothing resolves a stored
 * name back to an object, and this map is not a registry: it holds only the
 * seeds this process happened to hash, and a guid pinned by a lock or authored
 * verbatim has no entry unless something also derived it. It exists because an
 * unresolved-reference error otherwise hands the author the one thing they
 * cannot map back to their typo — an opaque guid.
 */
const SEEN_SEEDS = new Map<string, string>();

/**
 * The `"<type>:<name>"` a guid was derived from this process, if anything
 * derived it. See {@link SEEN_SEEDS} — a hint for error text, never resolution.
 */
export function guidSeedHint(guid: string): string | undefined {
  return SEEN_SEEDS.get(guid);
}

/** Guids this process resolved from a bare NAME string, and from a def handle. Hints only. */
const BARE_NAME_GUIDS = new Set<string>();
const HANDLE_GUIDS = new Set<string>();

/**
 * How a reference to `guid` was written this process: `"name"` when any
 * reference to it was a bare name string, `"handle"` when every one was a def
 * handle, `undefined` when nothing here resolved it. A hint for error text,
 * like {@link guidSeedHint}.
 */
export function refSpelling(guid: string): "name" | "handle" | undefined {
  if (BARE_NAME_GUIDS.has(guid)) return "name";
  if (HANDLE_GUIDS.has(guid)) return "handle";
  return undefined;
}

/** Record that a reference to `guid` was written as a def handle — for a resolver outside {@link resolveRef}. */
export function noteHandleRef(guid: string): void {
  HANDLE_GUIDS.add(guid);
}

/**
 * The SDK word for a reference type an author reads — the stored type names
 * (`dbo`, `query`) appear nowhere in authored code.
 */
const REF_KIND: Readonly<Record<string, string>> = {
  dbo: "table",
  query: "API endpoint",
  function: "function",
  addon: "addon",
  task: "task",
  tool: "tool",
  prompt: "prompt",
  resource: "resource",
  trigger: "trigger",
  middleware: "middleware",
  workflow_test: "workflowTest",
};

/**
 * Resolve a reference target (def handle or name) to the referenced object's guid.
 *
 * `where` names the argument for the failure (`Statement "s.db.get": argument
 * "table"`); without it the message still names the reference by its SDK kind.
 * `kindLabel` overrides that kind where one stored type serves two — an agent is
 * stored as a `toolset`, a word the author never typed.
 */
export function resolveRef(type: string, target: ObjectRef, where?: string, kindLabel?: string): string {
  const t = target as unknown;
  if (typeof t === "object" && t !== null && typeof (t as { guid?: unknown }).guid === "string" && (t as { guid: string }).guid) {
    const handle = t as { guid: string; name?: string };
    if (handle.name) SEEN_SEEDS.set(handle.guid, `${type}:${handle.name}`);
    HANDLE_GUIDS.add(handle.guid);
    return handle.guid;
  }
  const name =
    typeof t === "string" ? t : typeof t === "object" && t !== null ? (t as { name?: unknown }).name : undefined;
  if (typeof name === "string" && name !== "") {
    // How the author spelled it, for the unresolved-reference message: a bare
    // name can be a typo, a handle cannot — it can only be unregistered.
    const guid = deriveGuid(type, name);
    (typeof t === "string" ? BARE_NAME_GUIDS : HANDLE_GUIDS).add(guid);
    return guid;
  }
  const kind = kindLabel ?? REF_KIND[type] ?? type;
  const got =
    t === null ? "null" : Array.isArray(t) ? `an array (${t.length} item${t.length === 1 ? "" : "s"})` : typeof t === "object" ? "an object with neither a name nor a guid" : typeof t === "string" ? "an empty name" : `${typeof t} ${String(t)}`;
  throw new Error(
    `${where === undefined ? "Cannot resolve a" : `${where}: cannot resolve the`} ${kind} reference — pass the ${kind}'s def handle or its name; got ${got}.`,
  );
}
