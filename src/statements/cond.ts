/**
 * `cond.*` — the everyday predicates a runtime condition cannot spell directly.
 *
 * A runtime `when` (`s.conditional`, `s.while`, `s.precondition`, an
 * `array.*` `!compare`) evaluates through the engine's own comparison
 * evaluator, which knows exactly EIGHT operators: `= != === !== > < >= <=`
 * ({@link ./expression.js}). The wider {@link ./expression.js SearchOp} set —
 * `in`, `like`, `between`, `contains`, `overlaps`, `search` — compiles to SQL
 * and resolves only inside a database query's `where`. Writing `cmp(x, "in", …)`
 * in a conditional deploys clean and then fails at request time.
 *
 * The idiom that DOES work is to move the predicate into the value pipeline and
 * compare the boolean it yields: pipe through `fl.contains` / `fl.starts_with` /
 * `fl.in` / `fl.empty`, then test the result against `c.bool(true)`. That is
 * exactly what each helper here builds — one `withFilters` plus one `expr` — so
 * the pattern is discoverable instead of being something every author
 * re-derives.
 *
 * ```ts
 * s.conditional({ when: cond.in(inp("role"), ref("allowed_roles")), then: [ … ] })
 * // …instead of cmp(inp("role"), "in", ref("allowed_roles")), which is SQL-only.
 * ```
 *
 * Each helper returns a {@link Comparison} (or, for {@link cond.between}, an
 * AND {@link SearchGroup}), so the result drops into any `when` and composes
 * with `and()` / `or()` like any other node.
 *
 * **Operand direction matters and is easy to get backwards.** The engine's
 * `in` filter takes the ARRAY as the piped value and the needle as its argument,
 * while `contains`/`starts_with`/`ends_with` take the subject TEXT as the piped
 * value and the needle as the argument. `cond.in(value, list)` and
 * `cond.contains(text, needle)` both read subject-first in TypeScript; the
 * helpers emit whichever order the engine wants.
 */
import { c } from "../values/value.js";
import { withFilters } from "../values/value.js";
import { fl } from "../values/generated/filters.generated.js";
import { expr, and } from "./expression.js";
import type { Comparison, SearchGroup } from "./expression.js";
import type { Value } from "../values/value.js";
import type { FilterXdo } from "../types/xdo.js";

/** `<value> | <filter>` compared against a boolean — the shape every helper builds. */
function predicate(value: Value, f: FilterXdo, want: boolean): Comparison {
  // `=` rather than `===`: the filters below all yield a real PHP bool, so the
  // loose and strict readings agree, and `=` is the operator the editor writes
  // for the same condition — a pulled workspace and an authored one then hold
  // the same bytes.
  return expr(withFilters(value, f), "=", c.bool(want));
}

export const cond = {
  /**
   * `value` is one of `list`'s entries — the runtime answer to `cmp(x, "in", …)`.
   *
   * Compiles to `list | in: value`, because the engine's `in` filter pipes the
   * ARRAY and takes the needle as its argument. Pass the list as a `ref()` to a
   * stack array, an `inp()` of a list input, or `c.array([...])`.
   */
  in: (value: Value, list: Value): Comparison => predicate(list, fl.in(value), true),

  /** `value` is NOT one of `list`'s entries. */
  notIn: (value: Value, list: Value): Comparison => predicate(list, fl.in(value), false),

  /** `text` contains `needle` (case-sensitive). */
  contains: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.contains(needle), true),

  /** `text` contains `needle`, ignoring case. */
  icontains: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.icontains(needle), true),

  /** `text` does not contain `needle` (case-sensitive). */
  notContains: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.contains(needle), false),

  /** `text` begins with `needle` (case-sensitive). */
  startsWith: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.starts_with(needle), true),

  /** `text` begins with `needle`, ignoring case. */
  istartsWith: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.istarts_with(needle), true),

  /** `text` ends with `needle` (case-sensitive). */
  endsWith: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.ends_with(needle), true),

  /** `text` ends with `needle`, ignoring case. */
  iendsWith: (text: Value, needle: Value): Comparison =>
    predicate(text, fl.iends_with(needle), true),

  /**
   * `value` is EMPTY in the engine's sense — `""`, `null`, `0`, `"0"`, `false`,
   * `[]` or `{}`.
   *
   * That set is wider than "null" and wider than "no rows": a legitimate `0` and
   * a legitimate `false` both read as empty. When you mean specifically absent,
   * use {@link cond.isNull}; when you mean "the list came back with nothing",
   * this is the right test.
   */
  empty: (value: Value): Comparison => predicate(value, fl.empty(), true),

  /** `value` is not empty (see {@link cond.empty} for what "empty" covers). */
  notEmpty: (value: Value): Comparison => predicate(value, fl.empty(), false),

  /**
   * `value` is exactly `null`.
   *
   * A STRICT comparison against the null constant, deliberately: the loose form
   * would also match `0`, `""` and `false`, which is {@link cond.empty}'s job.
   * There is no runtime `is_null` filter — the name exists in the catalog but
   * does not resolve in a value pipeline — so this is the spelling that works.
   */
  isNull: (value: Value): Comparison => expr(value, "===", c.null()),

  /** `value` is anything other than `null` (strict — see {@link cond.isNull}). */
  notNull: (value: Value): Comparison => expr(value, "!==", c.null()),

  /**
   * `lo <= value <= hi`, INCLUSIVE at both ends.
   *
   * Two comparisons ANDed, not one `between`: the runtime `between` filter does
   * not resolve in a value pipeline (it is the SQL-side `between_filter`), and
   * `cmp(x, "between", …)` is database-only. `value` is encoded twice, so pass a
   * reference rather than something with a side effect.
   */
  between: (value: Value, lo: Value, hi: Value): SearchGroup =>
    and(expr(value, ">=", lo), expr(value, "<=", hi)),

  /**
   * The object at `value` has something at `path` — the engine's `has` filter,
   * whose argument is a dotted path (`"address.city"`), not a value.
   */
  has: (value: Value, path: Value): Comparison => predicate(value, fl.has(path), true),

  /**
   * `value` (an array or object) has exactly `n` entries.
   *
   * `fl.count` yields an int, so this is an ordinary `=` against it. For
   * "has anything at all", prefer {@link cond.notEmpty}.
   */
  count: (value: Value, n: Value): Comparison => expr(withFilters(value, fl.count()), "=", n),
} as const;
