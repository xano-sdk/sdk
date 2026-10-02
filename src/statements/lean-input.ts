/**
 * The lean statement-input entry — `{name, tag, value, filters}` — shared by
 * every call site that emits the *lean* input form (no rich
 * `ignore`/`expand`/`children`):
 *
 * - addon `input[]` bindings ({@link ../statements/special/addon-encode.ts}),
 * - the lean db family (`db.add_or_edit` / the bulk ops in
 *   {@link ../statements/special/db.ts}),
 * - lean spec-driven statements ({@link ../statements/schema-dsl/interpret.ts}).
 *
 * One builder so the shape lives in exactly one place. (JSON key order is not
 * significant to the engine parser, which reads by field name.)
 */
import type { Value } from "../values/value.js";
import { describeArg, isTaggedArg } from "./args.js";

/** A lean input binding — `{name, tag, value, filters}`, no `ignore/expand/children`. */
export interface LeanInput {
  name: string;
  tag: string;
  value: string;
  filters: unknown[];
}

/**
 * Build a lean input entry from an authored {@link Value}.
 *
 * The `Value` check is not redundant with the types. A lean input
 * copies `tag`/`value`/`filters` straight off its argument, so anything that is
 * not a tagged value — a JS array of records, a bare object, a plain string —
 * copies `undefined` into all three and emits a slot the engine cannot read: it
 * looks up an input by the empty name and answers `500 Unable to locate input:`
 * on every request. That is a compile-clean, always-broken endpoint, and the
 * shape agents reach for on `db.bulk.add` (mirroring `db.add`'s `row: { … }`)
 * lands exactly there once the type error is silenced with `as never`.
 */
export function leanInput(name: string, v: Value): LeanInput {
  assertInputValue(name, v);
  return { name, tag: v.tag, value: v.value, filters: v.filters };
}

/**
 * Refuse an input binding that is not a tagged {@link Value}, for both the lean
 * entry above and the RICH entry (`{…, ignore, expand, children}`) the db family
 * builds — the two copy the same three keys and fail the same way.
 */
export function assertInputValue(name: string, v: unknown): asserts v is Value {
  // Structural, and deliberately looser than `isTaggedValue` on both keys: this
  // sits on the read path too, so a pulled statement must round-trip verbatim —
  // an unknown stored tag (`rawValue()`), and a `const:int` whose stored value
  // is a JSON number (`test/fixtures/statements/lambda.json`), both pass.
  if (isTaggedArg(v)) return;
  throw new Error(
    `input \`${name}\`: expected a tagged value (\`c.*\`/\`inp\`/\`ref\`/\`col\`/…), got ` +
      `${describeArg(v)}. An input stores \`{tag,value,filters}\` copied off this argument, ` +
      `so a plain JS value emits an empty slot that deploys clean and then fails every ` +
      `request with "Unable to locate input: ". Wrap it — an array of rows is ` +
      `\`c.array([{ … }])\` (plain JSON inside, no nested \`c.*\`), a record is \`c.obj({ … })\`.`,
  );
}
