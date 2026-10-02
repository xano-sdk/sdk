/**
 * Authoring guard for enum-constrained statement fields.
 *
 * The engine constrains ~36 statement inputs to a closed set of literal values.
 * Before this, nothing in the SDK carried that fact, so a plausible-but-wrong
 * spelling (`"streaming"` where the engine accepts `"sse"` and `"stream"`)
 * type-checked, encoded, deployed, and only failed at runtime. The constraint
 * rides the spec ({@link ./enums.ts}), the generated signature narrows to it,
 * and this is the runtime half: it accepts the bare-literal shorthand and
 * refuses a constant that provably cannot work.
 *
 * DELIBERATELY NARROW. It fires only where the authored value is statically
 * decidable, which keeps it from becoming a false-positive nuisance and keeps
 * every dynamic form authorable:
 *
 *  - a non-constant tag (`inp`/`ref`/`env`/`setting`/…) resolves at runtime —
 *    the SDK cannot know what it holds, so it is never checked;
 *  - a filter chain can rewrite the value arbitrarily before the engine reads
 *    it, so a filtered value is never checked either;
 *  - the empty value is the editor's UNCONFIGURED box, which is what a pulled
 *    workspace legitimately stores and what codegen emits back. Rejecting it
 *    would make a real workspace's own emitted source throw on re-encode.
 *
 * ENCODE-SIDE ONLY. Decoding a stored workspace never routes through here — an
 * out-of-enum value that already exists upstream must always come back out.
 */
import { c, isTaggedValue } from "../../values/value.js";
import type { Value } from "../../values/value.js";
import { suggest } from "../../util/suggest.js";

/**
 * The one tag whose `value` is a literal the engine reads as-is. Every other
 * constant tag is either a different primitive type (`const:int`, `const:bool`)
 * — which no text enum field takes — or an EXPRESSION the engine evaluates
 * (`const:expr`, `const:expr2`), whose source text is not the resulting value
 * and must never be membership-checked.
 */
const CHECKABLE_TAGS = new Set(["const"]);

/** `a`, `b`, `c` → `"a" | "b" | "c"`, matching how the field's type reads. */
function renderSet(values: readonly string[]): string {
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

function reject(statement: string, field: string, got: string, values: readonly string[]): never {
  const near = suggest(got, values);
  throw new Error(
    `Statement "${statement.replace(/^mvp:/, "")}": argument "${field}" accepts only ${renderSet(values)} — got ${JSON.stringify(got)}. ` +
      (near === undefined ? "" : `Did you mean ${JSON.stringify(near)}? `) +
      `Pass one of those (as a bare literal or via c.text), or a dynamic value ` +
      `(inp/ref/env/…) if it has to be computed at runtime.`,
  );
}

/**
 * Resolve an authored enum field to its {@link Value}, rejecting a provably-wrong
 * constant. A bare literal is validated and coerced — the same bytes the
 * explicit `c.text(...)` spelling produces, so the two are interchangeable.
 */
export function resolveEnumValue(
  statement: string,
  field: string,
  values: readonly string[],
  provided: unknown,
): Value {
  if (typeof provided === "string") {
    if (!values.includes(provided)) reject(statement, field, provided, values);
    return c.text(provided);
  }
  if (isTaggedValue(provided)) {
    const checkable =
      CHECKABLE_TAGS.has(provided.tag) &&
      provided.filters.length === 0 &&
      // The unconfigured box — always allowed, see the header note.
      provided.value !== "";
    if (checkable && !values.includes(provided.value)) {
      reject(statement, field, provided.value, values);
    }
  }
  // Anything else (a non-Value the caller passed from untyped JS) is left to the
  // existing encoding path, which owns that error.
  return provided as Value;
}
