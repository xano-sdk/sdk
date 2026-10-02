/**
 * An input binding the engine SKIPS.
 *
 * A statement's `input[]` entry carries an `ignore` flag. When it is set the
 * engine records `"<name>:ignore"` and never binds the value at all, so the
 * parameter falls back to its declared default — which is NOT the same as
 * passing an empty value, and not the same as omitting the entry (the entry,
 * with its remembered value, is still stored).
 *
 * 1,766 real input entries carry it. The db row-write family already models it
 * as an `ignore` flag on a `data:` cell; this is the same state for the
 * spec-routed statements, whose fields are plain {@link Value}s with nowhere to
 * hang a flag.
 *
 * It applies to EVERY spec-routed statement, not only the handful whose stored
 * envelope spells the entry members out in full — the lean and full input forms
 * are two serializations of one entry model.
 *
 * The marker is carried on a non-enumerable property, so it never reaches
 * `JSON.stringify` and an ignored value serializes exactly like the value it
 * wraps — the flag is read only by the input encoder, which moves it onto the
 * entry.
 */
import type { Value } from "./value.js";

const IGNORED = Symbol.for("xanosdk.input.ignored");

/**
 * Mark an input binding as ignored — stored with its value, skipped at runtime.
 *
 * Recovery-oriented: `codegen` emits it for a stored `ignore: true` entry so a
 * pulled workspace reproduces its bytes. Authoring one by hand is legal and
 * means "keep this parameter's value on record, but do not send it".
 */
export function ignored(value: Value): Value {
  const marked = { ...value };
  Object.defineProperty(marked, IGNORED, { value: true, enumerable: false });
  return marked;
}

/** Is this value marked {@link ignored}? */
export function isIgnored(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[IGNORED] === true
  );
}
