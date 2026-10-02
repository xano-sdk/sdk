/**
 * `rawResponse()` — the response-level verbatim passthrough.
 *
 * The fourth and last escape hatch, alongside `raw()` for statements,
 * `rawValue()` for values, and `rawField()` for fields. Together they mean a
 * pulled workspace never loses data on the way into TypeScript: whatever the
 * engine stored comes back out unchanged, whether or not this SDK models it.
 *
 * It is needed because `encodeResponse` writes `_xsid` and `disabled`
 * unconditionally at their defaults. No authoring surface reaches either, so a
 * stored `result[]` item that sets one differently cannot round-trip through the
 * `response:` field in any form. This carries the whole `result[]` array
 * instead.
 *
 * Reached via `@xano/sdk/codegen`, never from the discoverable authoring
 * namespace, for the same reason `raw()` stays off `s`.
 */
import type { ResultItemXdo } from "../types/xdo.js";
import type { ResponseDef } from "./response.js";

/** A stored `result[]` entry as it appears in a bundle. */
export type RawResponseEnvelope = Record<string, unknown>;

/** Marker for a response carried through verbatim. */
export const RAW_RESPONSE: unique symbol = Symbol.for("xanosdk.response.rawEnvelope") as never;

/** The keys a persisted result item carries, in stored order — ORDERING only. */
const CANONICAL_KEYS = ["filters", "name", "tag", "value", "_xsid", "disabled"] as const;

/** The internal shape `encodeResponse` unwraps. */
export interface RawResponseMarker {
  [RAW_RESPONSE]: ResultItemXdo[];
}

/**
 * Carry a stored `result[]` array through encoding unchanged.
 *
 * A key an item does not carry is **NOT** invented. Preservation is the whole
 * contract: only key ordering is normalized, and nothing is added.
 *
 * That absence rule is not incidental. `raw()` and `rawField()` both shipped
 * completing absent keys with their defaults, which silently broke their own
 * passthrough contract — the engine omits keys at their defaults, so filling
 * them in changes the bytes on the way back. This preserves absence from the
 * start rather than being fixed into it later.
 *
 * @param items Stored `result[]` entries. An empty array means "no response".
 */
export function rawResponse(items: readonly RawResponseEnvelope[]): ResponseDef {
  if (!Array.isArray(items)) {
    throw new Error(
      "rawResponse() expects an array of stored result[] entries, e.g. " +
        '`[{ name: "", tag: "input", value: "x", filters: [] }]` — but received ' +
        (items === null ? "null" : typeof items),
    );
  }

  const stored = items.map((item, i) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `rawResponse() item ${i} is not a stored result envelope object — received ` +
          (item === null ? "null" : Array.isArray(item) ? "an array" : typeof item),
      );
    }
    // Keys the item actually has, in canonical order — nothing is added.
    const out: Record<string, unknown> = {};
    for (const key of CANONICAL_KEYS) {
      if (Object.hasOwn(item, key)) out[key] = item[key];
    }
    // Anything outside the canonical set rides along rather than being dropped.
    for (const key of Object.keys(item)) {
      if (!Object.hasOwn(out, key)) out[key] = item[key];
    }
    return out as unknown as ResultItemXdo;
  });

  return { [RAW_RESPONSE]: stored } as unknown as ResponseDef;
}

/** The carried `result[]`, or `undefined` when this is a normal response. */
export function rawResponseItems(response: unknown): ResultItemXdo[] | undefined {
  if (response == null || typeof response !== "object") return undefined;
  return (response as Partial<RawResponseMarker>)[RAW_RESPONSE];
}
