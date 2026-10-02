/**
 * Typed refusal of `capture` on `s.lambda`.
 *
 * The grounding docs introduce an inline `code:` arrow and then, several
 * paragraphs later, `lam.fn(fn, { surface?, capture? })`. Nothing connected the
 * two, so `capture` read as a property of lambda bodies generally. The bare
 * "does not exist in type" error that produced implies the WRONG fix — drop the
 * field — when the right one is to move the body into `lam.fn`.
 *
 * Naming the field and pointing at `lam.fn` costs nothing at runtime: the
 * factory delegates unchanged, so the encoded statement is byte-identical.
 */
import type { Statement } from "../statement.js";
import { generated } from "../generated/factories.generated.js";

type LambdaArgs = Parameters<typeof generated.lambda>[0] & {
  /**
   * @deprecated Not a field of `s.lambda`. `capture` is an option of `lam.fn` —
   * move the body there: `code: lam.fn(fn, { capture: { … } })`.
   *
   * An inline `code:` arrow receives bindings only, so there is no slot here to
   * pass data through. Relocate the body; do not drop the field.
   */
  capture?: never;
};

/**
 * `lambda { … }` — run a JavaScript body (`mvp:lambda`).
 *
 * Delegates to the generated factory unchanged. The only addition is a typed
 * refusal of `capture`: the grounding docs introduce an inline
 * `code:` arrow and then `lam.fn(fn, { capture })` several paragraphs later, so
 * `capture` reads as a property of lambda bodies generally. The bare
 * "does not exist in type" error that produced implies the wrong fix — drop the
 * field — when the right one is to move the body into `lam.fn`. Naming it here
 * costs nothing at runtime and puts the answer in the error.
 */
export function lambda(a: LambdaArgs): Statement {
  if (a !== null && typeof a === "object" && (a as { capture?: unknown }).capture !== undefined) {
    throw new Error(
      'Statement "s.lambda": `capture` is not a field of s.lambda — it is an option of lam.fn: ' +
        "`code: lam.fn(fn, { capture: { … } })`.",
    );
  }
  return generated.lambda(a);
}
