/**
 * Author-time refusal of a value outside a field's CLOSED SET.
 *
 * A handful of def fields are typed as a string union — `verb`, `responseType`,
 * the CORS `mode`. The union is a COMPILE-TIME construct only, and the encoders
 * are reachable without it: a plain object built at runtime, a JS caller, a
 * `codegen` round-trip of a hand-edited bundle, or simply an author who runs
 * the CLI without a separate `tsc` pass. Anything that arrives that way must not
 * be copied straight onto the wire.
 *
 * That is the same failure shape `assertStoredName` exists for. The engine does
 * not reject the write: it stores an unrecognized value as NULL and then falls
 * back to whatever a null means for that field — for `verb`, null serves as
 * GET. So a lowercase `verb: "post"` exports clean, deploys clean, answers on
 * the wrong method, and surfaces only as `ERROR_CODE_NOT_FOUND — Unable to
 * locate request.` when POST is finally called. That reads as a routing or
 * api-group problem, not a one-character casing problem.
 *
 * These are ERRORS, not warnings, and the SDK REJECTS rather than normalizes.
 * There is no legitimate authoring reason to emit a value outside the set, and
 * no pulled-workspace round-trip to preserve — the engine cannot store one
 * either, so no real bundle carries one. Rejecting keeps exactly one shape on
 * the wire and puts the correct spelling in the author's error message, which
 * a silent `"post"` → `"POST"` normalization would not.
 */

/**
 * Throw unless `value` is one of `allowed`.
 *
 * `context` names the object the way the rest of the kind layer does
 * (`query "list_users"`), so the message points at the line the author wrote
 * rather than at a stage of export. `note` carries the per-field consequence —
 * what the engine does with the value it cannot store.
 *
 * An ABSENT value passes — `undefined` because an omitted optional field is the
 * encoder's default rather than a bad value, and `null` because that is what a
 * pulled workspace carries for a field the engine already blanked. Re-encoding
 * such a def emits the engine's own fallback (`responseType ?? "standard"`),
 * which is a normalization, not data loss. Callers that REQUIRE the field check
 * presence themselves, so a null there is still refused — by the presence check,
 * with the message that fits it.
 */
export function assertOneOf<T extends string>(
  context: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
  note: string,
): asserts value is T | null | undefined {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return;

  const list = allowed.map((v) => JSON.stringify(v)).join(", ");
  // The overwhelmingly common miss is casing (`"post"`, `"Post"`), so name the
  // exact spelling that was meant instead of leaving the author to diff the
  // list by eye. Guarded on the type because the untyped caller this module
  // exists for can hand us a number or an object, and `.toLowerCase()` on one
  // would replace the whole message with a bare TypeError.
  const cased =
    typeof value === "string"
      ? allowed.find((v) => v.toLowerCase() === value.toLowerCase())
      : undefined;
  const hint = cased
    ? ` Write it as ${JSON.stringify(cased)} — the casing is the whole difference.`
    : "";
  throw new Error(
    `${context}: \`${field}\` is ${JSON.stringify(value) ?? String(value)}, which is not one of ` +
      `${list}.${hint} ` +
      `${note}`,
  );
}
