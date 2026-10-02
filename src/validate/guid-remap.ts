/**
 * Guid remapping for the `xanosdk preflight` round-trip diff.
 *
 * The engine RE-MINTS every object guid on import: the SDK derives a
 * deterministic 32-hex guid from a name, the engine assigns its own
 * base64url-style id and rewrites every reference to it. Verified live against
 * an ephemeral — one imported auth table came back as `y5eTeh…`, and BOTH
 * references to it (`query.auth` and the `mvp:create_auth` `dbtable` input)
 * carried that same new value, so the deployed workspace resolves exactly as
 * authored.
 *
 * The DEFINING key is already handled — `guid` is in the normalizer's strip
 * list — and so is the common nested reference form `{ id: "<guid>" }`, because
 * `id` is stripped too. What was left was the BARE SCALAR form, which the diff
 * compared and which can therefore never match: every auth-gated query reported
 * `$.auth`, and every `create_auth_token` reported its table argument.
 *
 * Rather than teach the normalizer to blank each bare-guid slot one at a time —
 * which would also throw away the ability to notice a reference pointing at the
 * WRONG object — the round trip translates. Both sides of a matched pair are in
 * hand, so the compiled guid and the engine guid for the same object are known;
 * rewriting the compiled side into engine vocabulary before the diff makes a
 * correctly-remapped reference compare equal while a reference to some other
 * object still diverges. It is also slot-agnostic: a bare guid the SDK learns to
 * emit somewhere new is covered without a new rule.
 */
import { identityMatcher } from "./kinds.js";

/** A compiled-guid → engine-guid translation for one import. */
export type GuidRemap = ReadonlyMap<string, string>;

/** Read a string field, treating "" and non-strings as absent. */
function guidOf(obj: Record<string, unknown>): string | undefined {
  const v = obj["guid"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Coerce a payload array to records; tolerates a missing/non-array value. */
function asRecords(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => o !== null && typeof o === "object") : [];
}

/**
 * Pair every compiled object with its persisted twin and collect the guids that
 * changed. Matching reuses {@link identityMatcher}, whose guid-first lookup simply
 * misses here (an imported guid never equals the compiled one) and falls through
 * to the kind's identity key, which is what a remap needs.
 *
 * Deliberately keyed off the payload keys present on BOTH sides rather than the
 * round-trip registry: a reference can name an object of a kind the round trip
 * does not diff, and translating it costs nothing.
 */
export function payloadGuidRemap(
  compiledPayload: Record<string, unknown>,
  exportedPayload: Record<string, unknown>,
): GuidRemap {
  const remap = new Map<string, string>();
  for (const key of Object.keys(compiledPayload)) {
    const fetched = asRecords(exportedPayload[key]);
    if (fetched.length === 0) continue;
    const match = identityMatcher(key, fetched, exportedPayload, compiledPayload);
    for (const obj of asRecords(compiledPayload[key])) {
      const mine = guidOf(obj);
      if (mine === undefined) continue;
      const resolved = match(obj);
      if (resolved.outcome !== "found") continue;
      const theirs = guidOf(resolved.fetched);
      // Same guid on both sides: nothing to translate (and never map a guid to
      // itself, so an empty remap stays detectably empty).
      if (theirs === undefined || theirs === mine) continue;
      remap.set(mine, theirs);
    }
  }
  return remap;
}

/**
 * The two shapes that carry a table guid INSIDE a larger string rather than
 * bare. Both are re-minted by the engine exactly like the bare form, each
 * verified against a live ephemeral — the second contradicted the guess that it
 * was left untouched, so neither is assumed:
 *
 * - `dbo=<guid>` — the foreign key `f.tableRef` persists as an `@` method arg.
 * - `<guid>_mvpschema` — the stored TYPE of an `input.dbLink`.
 *
 * The same pair the dangling-reference guard resolves (`EMBEDDED_REF_RE` in
 * `src/workspace/guards.ts`). Nothing else is rewritten: a guid appearing inside
 * some OTHER string is left alone rather than substring-replaced, because a
 * format this has not verified is a guess.
 */
const EMBEDDED: ReadonlyArray<{ prefix: string; suffix: string }> = [
  { prefix: "dbo=", suffix: "" },
  { prefix: "", suffix: "_mvpschema" },
];

/**
 * Deep-copy `value`, replacing any string that IS a remapped compiled guid — or
 * one of the {@link EMBEDDED} forms wrapping one — with the engine's.
 *
 * Object KEYS are not translated — no persisted shape observed so far keys by
 * guid, and a key rewrite would reorder nothing but could silently merge two
 * entries.
 */
export function remapGuids<T>(value: T, remap: GuidRemap): T {
  if (remap.size === 0) return value;
  return walk(value, remap) as T;
}

function walk(value: unknown, remap: GuidRemap): unknown {
  if (typeof value === "string") return remapString(value, remap);
  if (Array.isArray(value)) return value.map((v) => walk(v, remap));
  if (value !== null && typeof value === "object") {
    // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
    // stored here, where assigning it on a plain `{}` sets a prototype instead.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, remap);
    return out;
  }
  return value;
}

/** One string, bare or embedded; unchanged when it names nothing re-minted. */
function remapString(value: string, remap: GuidRemap): string {
  const bare = remap.get(value);
  if (bare !== undefined) return bare;
  for (const { prefix, suffix } of EMBEDDED) {
    // `length` guards the degenerate overlap where the affixes consume the
    // whole string and `slice` would read backwards.
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) continue;
    if (value.length <= prefix.length + suffix.length) continue;
    const mapped = remap.get(value.slice(prefix.length, value.length - suffix.length));
    if (mapped !== undefined) return `${prefix}${mapped}${suffix}`;
  }
  return value;
}
