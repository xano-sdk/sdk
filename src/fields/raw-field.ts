/**
 * `rawField()` — the field-level verbatim passthrough.
 *
 * The third and last escape hatch, alongside `raw()` for statements and
 * `rawValue()` for values. Together they mean a pulled workspace never loses
 * data on the way into TypeScript: whatever the engine stored comes back out
 * unchanged, whether or not this SDK models it.
 *
 * It is needed because `encodeField` writes several keys unconditionally —
 * `merge`, `hidden`, `override`, `is_settings_registry`, and the context-derived
 * `customize` / `market_item`. No authoring option reaches any of them, so a
 * stored field that sets one differently cannot round-trip through `f.*`,
 * `input.*`, or even the explicit descriptor form. This carries the whole
 * envelope instead.
 *
 * Reached via `@xano/sdk/codegen`, never from the `f`/`input` catalogs, for
 * the same reason `raw()` stays off `s`.
 */
import type { FieldXdo } from "../types/xdo.js";
import type { FieldDescriptor } from "./catalog.js";
import { RAW_FIELD } from "./field.js";

/** A stored field envelope as it appears in a bundle's `schema[]` / `input[]`. */
export type RawFieldEnvelope = Record<string, unknown>;

/** The keys a persisted field carries, in stored order — used for ORDERING only. */
const CANONICAL_KEYS = [
  "name",
  "type",
  "_xsid",
  "description",
  "nullable",
  "default",
  "merge",
  "hidden",
  "override",
  "customize",
  "required",
  "values",
  "mode",
  "format",
  "sensitive",
  "list",
  "vector",
  "access",
  "style",
  "children",
  "methods",
  "market_item",
  "is_settings_registry",
] as const;

/**
 * Carry a stored field envelope through encoding unchanged.
 *
 * The envelope's own `name` and `type` win over the map key it is attached to,
 * and a key the envelope does not carry is NOT invented. Preservation is the
 * whole contract: nothing about the stored shape is rewritten to match its
 * surroundings, and nothing is added to it.
 *
 * @param envelope A stored `schema[]` / `input[]` entry. Must carry `name` and `type`.
 */
export function rawField(envelope: RawFieldEnvelope): FieldDescriptor {
  if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(
      "rawField() expects a stored field envelope object — at minimum " +
        '`{ name: "…", type: "text" }` — but received ' +
        (envelope === null ? "null" : Array.isArray(envelope) ? "an array" : typeof envelope),
    );
  }
  const { name, type } = envelope as { name?: unknown; type?: unknown };
  if (typeof name !== "string" || name === "") {
    throw new Error('rawField() envelope is missing a `name`, e.g. `{ name: "email", type: "email" }`.');
  }
  if (typeof type !== "string" || type === "") {
    throw new Error(`rawField() envelope for "${name}" is missing a \`type\`, e.g. "text" or "int".`);
  }

  // Keys the envelope actually has, in canonical order — nothing is added.
  // Filling an absent key with its default would make this NOT a passthrough:
  // the engine omits keys at their defaults, so completing them changes the
  // bytes on the way back in. Confirmed on a real pulled workspace, where a
  // `uuid` column stored no `default` and completion re-introduced `default: ""`.
  const stored: Record<string, unknown> = {};
  for (const key of CANONICAL_KEYS) {
    if (Object.hasOwn(envelope, key)) stored[key] = envelope[key];
  }
  // Anything outside the canonical set rides along rather than being dropped.
  for (const key of Object.keys(envelope)) {
    if (!Object.hasOwn(stored, key)) stored[key] = envelope[key];
  }

  return {
    type,
    options: { [RAW_FIELD]: stored as unknown as FieldXdo },
  } as FieldDescriptor;
}
