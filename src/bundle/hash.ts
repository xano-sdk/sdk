/**
 * A structural fingerprint for a compiled statement — the thing a diff, a cache
 * key or a "did this change" check wants, and the thing a byte comparison is
 * not.
 *
 * Two reductions run before the hash:
 *
 * 1. {@link normalize}, the same normalizer the SDK uses for fixture comparison
 *    and for the `xanosdk preflight` round-trip diff. It strips server-assigned
 *    identity (`_xsid`, `id`, timestamps, `market_item`) and canonicalizes the
 *    spellings the engine persists two ways.
 * 2. Engine-filled `input[]` slots — the entries carrying `ignore: true`.
 *
 * The second one is the whole reason this is not just `sha1(normalize(x))`. An
 * edit (`db.edit`, `db.add_or_edit`) persists one `input[]` entry per column of
 * the table it writes, and the ones the author did not set carry `ignore: true`.
 * Add a column to a table and every such statement gains an entry — so an
 * unfiltered diff reports that every one of them changed, when what changed was
 * the table. Filtered, the same diff reports the one object that actually
 * changed.
 *
 * A `db.add` is different, and its hash DOES change: an insert writes every
 * column, so the slot for a column the author did not set carries
 * `ignore: false` with the value the row gets (`null`, or the column's default).
 * That slot is a real write, not engine noise.
 *
 * The normalizer deliberately KEEPS `ignore: true` (it is meaningful bytes on a
 * system column, and the normalizer's job is byte fidelity — it must not drop
 * what it cannot prove inert). That is not a contradiction: byte fidelity and
 * structural identity are different questions, so they get different reductions.
 * If you need the byte-level answer, hash `normalize()` yourself.
 */

import { normalize } from "../validate/normalize.js";
import { sha1Bytes } from "../util/hash.js";
import type { StackItemXdo } from "../types/xdo.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Drop the `input[]` entries the engine fills, at every depth. */
function withoutIgnoredInputs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIgnoredInputs);
  if (!isRecord(value)) return value;
  // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
  // stored here, where assigning it on a plain `{}` sets a prototype instead.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, member] of Object.entries(value)) {
    if (key === "input" && Array.isArray(member)) {
      out[key] = member
        .filter((entry) => !(isRecord(entry) && entry.ignore === true))
        .map(withoutIgnoredInputs);
      continue;
    }
    out[key] = withoutIgnoredInputs(member);
  }
  return out;
}

/**
 * JSON with every object's keys sorted — so two statements that differ only in
 * the order the engine happened to serialize their members hash the same.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

const HEX = "0123456789abcdef";

/**
 * A stable hex fingerprint of a statement AND everything nested under it.
 *
 * Equal hashes mean the two statements do the same thing; different hashes mean
 * something an author wrote differs. The value is stable across SDK versions
 * only as far as the normalizer is — treat it as a comparison key computed in
 * one pass over both sides, not as a value to persist and compare next year.
 */
export function structuralHash(raw: StackItemXdo): string {
  const reduced = withoutIgnoredInputs(normalize(raw));
  const bytes = sha1Bytes(canonicalJson(reduced));
  let hex = "";
  for (const byte of bytes) hex += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  return hex;
}
