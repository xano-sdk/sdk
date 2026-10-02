/**
 * `rawValue()` — the value-level escape hatch codegen emits for a stored value it
 * cannot express through `c.*` / `ref` / `inp` / `withFilters`.
 *
 * `Value` is structurally just `{value, tag, filters}`, so an annotated literal
 * is already byte-exact; this wrapper exists for two reasons a bare literal does
 * not cover. It types the `tag` as a real `Tag` so the literal also checks out in
 * a widening position (a `const` declaration in a shared file, not only a
 * contextually-typed argument), and it makes every non-idiomatic value in a
 * generated tree greppable by one name.
 *
 * Reached via `@xano/sdk/codegen`, alongside `raw()` — same reasoning:
 * a passthrough should not sit in tab-completion next to `c.text`.
 */
import type { FilterXdo, Tag, TaggedValue } from "../types/xdo.js";
import { describeEntry } from "../statements/args.js";

/**
 * A stored value as it appears in a bundle. `filters` defaults to none.
 *
 * `value` admits the NATIVE scalar spellings as well as the string one, because
 * the engine stores both and this type describes what a bundle holds rather than
 * what the SDK writes. The corpus is genuinely mixed — the same tag appears with
 * a quoted and an unquoted value in one workspace — and codegen echoes whichever
 * it found. Declaring it `string` alone made a pulled tree fail its own
 * type-check, which broke every npm script in the scaffold, since
 * each one runs `tsc --noEmit` first.
 *
 * Coercing to the string form at emit would be the other repair. It is the wrong
 * one for `null`: `normalize()` reconciles a numeric or boolean `value` with its
 * string spelling, so those compare equal either way, but it does NOT do that for
 * `null` — so emitting `"null"` for a stored `null` would change the bytes and
 * fail the round trip.
 */
export interface RawValueInput {
  readonly value: string | number | boolean | null;
  readonly tag: Tag;
  readonly filters?: readonly FilterXdo[];
}

/**
 * Carry a stored tagged value through verbatim.
 *
 * The cast is the point of the escape hatch: `TaggedValue.value` is declared
 * `string` because that is what every `c.*` constructor writes, while a bundle
 * may hold a native scalar under the same key. Preserving the stored spelling is
 * what keeps the round trip exact, so the runtime value is passed through
 * untouched rather than being coerced to satisfy the declaration.
 */
export function rawValue(v: RawValueInput): TaggedValue {
  // Through `any`, `rawValue(null)` read `.value` off nothing.
  if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { tag?: unknown }).tag !== "string") {
    throw new Error(
      `rawValue() takes a stored tagged value — { value, tag, filters? } — got ${describeEntry(v)}.`,
    );
  }
  if (v.filters !== undefined && v.filters !== null && !Array.isArray(v.filters)) {
    throw new Error(`rawValue(): \`filters\` must be a list of stored filters — got ${describeEntry(v.filters)}.`);
  }
  return { value: v.value as string, tag: v.tag, filters: [...(v.filters ?? [])] };
}
