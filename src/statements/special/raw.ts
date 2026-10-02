/**
 * `raw()` — the verbatim stored-statement passthrough (codegen escape hatch).
 *
 * Carries an already-persisted `StackItemXdo` envelope through compile
 * **unmodified**, so a bundle containing a statement this SDK's catalog cannot
 * model still round-trips byte-exactly. It exists for decode (`@xano/sdk/codegen`),
 * not for hand-authoring: it is deliberately absent from the `s` namespace so it
 * is never tab-completion-discoverable alongside the typed statement surface.
 *
 * `encodeStatement` normally rebuilds a fixed 12-key envelope, filters every
 * `input[]` entry to 7 keys, merges `output` over a default, and canonicalizes an
 * empty `settings_registry` to `null` — all of which would silently drop keys a
 * future Xano statement carries. A raw statement therefore carries a marker
 * (`RAW_ENVELOPE`) that short-circuits that rebuild entirely; canonical defaults
 * for a *lean* envelope are filled here instead.
 */
import type { StackItemXdo } from "../../types/xdo.js";
import type { Statement } from "../statement.js";
import { RAW_ENVELOPE } from "../statement.js";

/** A stored statement envelope as it appears in a Xano bundle's `run[]`. */
export type RawEnvelope = Record<string, unknown>;

/**
 * The 12 keys a persisted statement carries, in stored order — used for ORDERING
 * only. A raw envelope is emitted in this order (unknown extra keys appended) so
 * output is deterministic regardless of the input's key order.
 */
const CANONICAL_KEYS = [
  "as",
  "name",
  "_xsid",
  "addon",
  "input",
  "mocks",
  "output",
  "context",
  "runtime",
  "disabled",
  "description",
  "settings_registry",
] as const;

/**
 * Wrap a stored statement envelope so it compiles back to itself verbatim.
 *
 * Every key present on `envelope` — including keys this SDK does not model —
 * survives untouched, and a key the envelope does not carry is NOT invented: an
 * engine that omits a key at its default gets that exact shape back.
 *
 * @param envelope A stored `run[]` entry. Must be an object carrying a `name`.
 */
export function raw(envelope: RawEnvelope): Statement {
  if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(
      "raw() expects a stored statement envelope object — at minimum " +
        '`{ name: "mvp:…", context: {…} }` — but received ' +
        (envelope === null ? "null" : Array.isArray(envelope) ? "an array" : typeof envelope),
    );
  }
  const name = (envelope as { name?: unknown }).name;
  if (typeof name !== "string" || name === "") {
    throw new Error(
      'raw() envelope is missing a `name`. A stored statement envelope must carry its `mvp:` name, e.g. `{ name: "mvp:set_var", context: {…} }`.',
    );
  }

  // Keys the envelope actually has, in canonical order — nothing is added.
  // Completing an absent key with its default would make this NOT a passthrough:
  // the engine omits keys at their defaults, so filling them in changes the bytes
  // on the way back in. Confirmed on a real pulled workspace.
  const stored: Record<string, unknown> = {};
  for (const key of CANONICAL_KEYS) {
    if (key in envelope) stored[key] = envelope[key];
  }
  // Anything outside the canonical 12 — a statement shipped after this SDK
  // release — rides along untouched rather than being dropped.
  for (const key of Object.keys(envelope)) {
    if (!(key in stored)) stored[key] = envelope[key];
  }

  return {
    name,
    context: stored.context,
    [RAW_ENVELOPE]: stored as unknown as StackItemXdo,
  } as Statement;
}
