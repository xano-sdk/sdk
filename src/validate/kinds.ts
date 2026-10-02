/**
 * Registry of authored kinds the `xanosdk preflight` round-trip can read back,
 * plus the identity + matching helpers the loop uses to pair a compiled object
 * with the one the engine persisted.
 *
 * A kind being *registered* here means "attempt a round-trip". Whether the
 * export actually surfaces it as a populated top-level array is decided at run
 * time by the loop: an empty fetched array demotes the whole kind to
 * `unchecked` rather than emitting a false per-object `missing` — this is
 * how nested/attached kinds like `tool` (persisted under `toolset`) stay honest.
 *
 * The registry is read by INTERSECTING it with the bundle payload, so a kind
 * absent from BOTH this list and {@link EXCLUDED_PAYLOAD_KEYS} is not merely
 * unchecked — it is invisible: never round-tripped and never counted, so a real
 * divergence reports a clean run. `test/validate/kinds.test.ts` holds the guard
 * that every kind registered in `src/kinds/` appears in one of the two lists.
 *
 * The residual `unchecked` set stays an allowlist of registered kinds, never
 * "any payload key not listed" — the payload also carries deploy-target and
 * server blobs that were never authored (see {@link EXCLUDED_PAYLOAD_KEYS}).
 */

import { appNamesByGuid, lockNameForObject } from "../lock/lock.js";

/** One round-trippable kind: its payload array key + the corpus/capture dir. */
export interface RoundTripKind {
  /** Payload array key in the bundle (e.g. "dbo", "function"). */
  key: string;
  /**
   * Capture/fixture subdirectory, aligned to the ACTUAL `test/fixtures/` layout,
   * not a blind `<key>s`. Notably `function` goldens live under
   * `statements/`, and `tool` shares `toolset/`. The realtime family shares
   * `realtime/`. A kind whose corpus dir does not exist yet (`app`) captures to
   * the subdir named here, which the maintainer creates on first promotion.
   */
  fixtureDir: string;
  /**
   * Invocable via the meta `function/run` route (what `--runtime` smoke-runs).
   * Only `function` today; kept as kind metadata here so the `--runtime` gate
   * reads the registry instead of hardcoding a kind string elsewhere.
   */
  runnable?: boolean;
}

export const ROUND_TRIP_KINDS: RoundTripKind[] = [
  { key: "dbo", fixtureDir: "tables" },
  { key: "function", fixtureDir: "statements", runnable: true },
  { key: "query", fixtureDir: "query" },
  { key: "trigger", fixtureDir: "triggers" },
  { key: "task", fixtureDir: "task" },
  { key: "toolset", fixtureDir: "toolset" },
  { key: "tool", fixtureDir: "toolset" },
  // The other two MCP primitives an MCP server lists; their goldens share `mcp/`.
  { key: "prompt", fixtureDir: "mcp" },
  { key: "resource", fixtureDir: "mcp" },
  { key: "middleware", fixtureDir: "middleware" },
  { key: "addon", fixtureDir: "addon" },
  { key: "workflow_test", fixtureDir: "workflow-test" },
  { key: "knowledge", fixtureDir: "knowledge" },
  // The realtime family: a server parents channels, a channel parents messages.
  // All three are authored kinds carrying their own goldens under `realtime/`.
  { key: "realtime_server", fixtureDir: "realtime" },
  { key: "channel", fixtureDir: "realtime" },
  { key: "message", fixtureDir: "realtime" },
  { key: "microservice", fixtureDir: "microservice" },
  // `app` is the API GROUP payload key — an authored container, not a deploy
  // target. Its corpus dir does not exist yet; capture creates it on first
  // promotion.
  { key: "app", fixtureDir: "api-group" },
];

/**
 * Payload keys deliberately NOT round-tripped, each for a stated reason. Paired
 * with {@link ROUND_TRIP_KINDS} by the registry-coverage guard, so excluding a
 * kind is a recorded decision rather than an omission.
 *
 * - `workspace`: the workspace singleton's own config row. Authored, but the
 *   persisted object is dominated by server-assigned fields, so diffing it
 *   would report noise rather than encoder divergence.
 * - the rest: deploy targets and server blobs that are never authored objects.
 */
export const EXCLUDED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "workspace",
  "branch",
  "market_item",
  "vault",
  "env",
  "service",
  "run_install",
]);

const FIXTURE_DIR_BY_KIND = new Map(ROUND_TRIP_KINDS.map((k) => [k.key, k.fixtureDir]));
const RUNNABLE_KINDS = new Set(ROUND_TRIP_KINDS.filter((k) => k.runnable).map((k) => k.key));

/** The capture subdir for a kind, or undefined when the kind is not registered. */
export function fixtureDirForKind(key: string): string | undefined {
  return FIXTURE_DIR_BY_KIND.get(key);
}

/** Whether a kind is invocable via the function/run route (`--runtime` smoke-run). */
export function kindIsRunnable(key: string): boolean {
  return RUNNABLE_KINDS.has(key);
}

/** Read a string field, treating "" and non-strings as absent. */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The key a kind's name fallback matches on — what makes one object of that kind
 * distinct within a workspace, once `guid` can no longer say (the engine
 * re-mints every guid on import).
 */
export type IdentityKey = (obj: Record<string, unknown>) => string | undefined;

const nameKey: IdentityKey = (obj) => strField(obj, "name");

/**
 * The identity key for `kind`, reading any cross-object reference it needs out
 * of `payload` — the payload the keyed objects belong to, so the compiled and
 * exported sides each resolve against their own.
 *
 * A query is `(api group, verb, name)`, the same rule its lock key follows
 * ({@link lockNameForObject}): `GET /items` and `POST /items` are two objects,
 * and so is one path in two groups. The compiled side binds the group by guid,
 * the exported side by local id, so an id is first translated to its group's
 * guid and both sides resolve to the group's name. Every other kind keys on
 * `name`.
 */
export function identityKeyFor(kind: string, payload: Record<string, unknown>): IdentityKey {
  if (kind !== "query") return nameKey;
  const groupNames = appNamesByGuid(payload.app);
  const guidById = new Map<unknown, string>();
  for (const group of Array.isArray(payload.app) ? payload.app : []) {
    if (group === null || typeof group !== "object") continue;
    const guid = strField(group as Record<string, unknown>, "guid");
    const id = (group as Record<string, unknown>).id;
    if (guid !== undefined && id !== undefined) guidById.set(id, guid);
  }
  return (obj) => {
    const name = nameKey(obj);
    if (name === undefined) return undefined;
    const ref = (obj.app as { id?: unknown } | null | undefined)?.id;
    const guid = guidById.get(ref);
    const app = guid !== undefined ? { id: guid } : obj.app;
    return lockNameForObject("query", { name, verb: obj.verb, app }, groupNames);
  };
}

/**
 * An index of fetched objects for one kind, keyed by both `guid` and its
 * {@link IdentityKey}, so a compiled object can be matched guid-first with a
 * fallback. Read from the RAW objects — `normalize()` strips `guid`, so
 * matching must happen before normalization.
 */
export interface IdentityIndex {
  byGuid: Map<string, Record<string, unknown>>;
  byKey: Map<string, Record<string, unknown>>;
  duplicateGuids: Set<string>;
  duplicateKeys: Set<string>;
}

export function indexByIdentity(
  objects: Array<Record<string, unknown>>,
  keyOf: IdentityKey = nameKey,
): IdentityIndex {
  const byGuid = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, Record<string, unknown>>();
  const duplicateGuids = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const obj of objects) {
    const guid = strField(obj, "guid");
    if (guid !== undefined) {
      if (byGuid.has(guid)) duplicateGuids.add(guid);
      else byGuid.set(guid, obj);
    }
    const key = keyOf(obj);
    if (key !== undefined) {
      if (byKey.has(key)) duplicateKeys.add(key);
      else byKey.set(key, obj);
    }
  }
  return { byGuid, byKey, duplicateGuids, duplicateKeys };
}

/** How a compiled object resolved against a fetched index. */
export type MatchResolution =
  | { outcome: "found"; fetched: Record<string, unknown> }
  | { outcome: "missing" }
  | { outcome: "ambiguous" };

/**
 * Resolve one compiled object to its fetched counterpart. Prefer `guid` (the
 * engine's identity anchor); fall back to the kind's {@link IdentityKey} when
 * the compiled object carries no guid or its guid isn't present on the fetched
 * side. `keyOf` must be the compiled payload's key, built for the same kind as
 * the index. If the chosen key collides within the kind, report `ambiguous`
 * rather than guessing a match.
 */
export function resolveMatch(
  compiled: Record<string, unknown>,
  index: IdentityIndex,
  keyOf: IdentityKey = nameKey,
): MatchResolution {
  const guid = strField(compiled, "guid");
  if (guid !== undefined && index.byGuid.has(guid)) {
    if (index.duplicateGuids.has(guid)) return { outcome: "ambiguous" };
    return { outcome: "found", fetched: index.byGuid.get(guid)! };
  }
  const key = keyOf(compiled);
  if (key !== undefined && index.byKey.has(key)) {
    if (index.duplicateKeys.has(key)) return { outcome: "ambiguous" };
    return { outcome: "found", fetched: index.byKey.get(key)! };
  }
  return { outcome: "missing" };
}

/**
 * Match compiled objects of one kind against the objects the engine exported,
 * each side keyed by {@link identityKeyFor} against its own payload — built
 * together so the two keys can only ever describe the same kind.
 */
export function identityMatcher(
  kind: string,
  fetched: Array<Record<string, unknown>>,
  exportedPayload: Record<string, unknown>,
  compiledPayload: Record<string, unknown>,
): (compiled: Record<string, unknown>) => MatchResolution {
  const index = indexByIdentity(fetched, identityKeyFor(kind, exportedPayload));
  const compiledKey = identityKeyFor(kind, compiledPayload);
  return (compiled) => resolveMatch(compiled, index, compiledKey);
}
