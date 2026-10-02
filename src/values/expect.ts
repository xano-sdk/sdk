/**
 * Unit-test ASSERTIONS — the `expect[]` list on a saved `test`.
 *
 * ## Not to be confused with `s.expect.*`
 *
 * Xano overloads the word, and so does this SDK, because both surfaces are
 * really called `expect` in the product:
 *
 * - `expect.*` (this module) builds a `{type, vars[]}` **assertion record**
 *   stored on a `tests` entry of a query/function/middleware. It is data, not a
 *   step, and it only ever appears inside `tests: [{ expect: [...] }]`.
 * - `s.expect.*` builds an assertion **statement** that runs inside a
 *   `workflowTest()` stack. It is a stack item like any other.
 *
 * They are not interchangeable and the type system enforces it: these return
 * {@link TestExpect}, those return `Statement`.
 *
 * ## The subject comes first
 *
 * Every matcher takes its subject as the first argument — almost always
 * {@link resp}. Argument ORDER is the assertion's meaning:
 * `expect.to_contain(resp("tags"), c.text("new"))` asserts the response's tags
 * contain `"new"`, not the reverse.
 */
import type { Value } from "./value.js";
import { c, resp } from "./value.js";

/** The stored matcher names, in the engine's own order. */
export const TEST_EXPECT_TYPES = [
  "to_be_defined",
  "to_be_empty",
  "to_be_false",
  "to_be_greater_than",
  "to_be_in_the_future",
  "to_be_in_the_past",
  "to_be_less_than",
  "to_be_null",
  "to_be_true",
  "to_be_within",
  "to_contain",
  "to_end_with",
  "to_equal",
  "to_match",
  "to_not_be_defined",
  "to_not_be_null",
  "to_not_equal",
  "to_start_with",
  "to_throw",
] as const;

/** One of the 19 stored matcher names. */
export type TestExpectType = (typeof TEST_EXPECT_TYPES)[number];

/** A stored assertion — `{type, vars[]}`, the `mvp_test_expect` shape. */
export interface TestExpect {
  type: TestExpectType;
  vars: Value[];
}

function mk(type: TestExpectType, ...vars: Value[]): TestExpect {
  return { type, vars };
}

/**
 * Unit-test assertions, for the `expect` list of a `tests` entry.
 *
 * See the module header for why this is NOT `s.expect.*`.
 *
 * ```ts
 * query({
 *   name: "score",
 *   verb: "POST",
 *   input: { score: input.int() },
 *   tests: [
 *     {
 *       name: "adds one",
 *       input: { score: c.int(1) },
 *       expect: [expect.to_equal(resp(), c.int(2))],
 *     },
 *   ],
 *   stack: [s.set_var("x1", c.expression("$input.score + 1"))],
 *   response: ref("x1"),
 * });
 * ```
 */
export const expect = {
  /** The subject is set (not undefined). */
  to_be_defined: (subject: Value): TestExpect => mk("to_be_defined", subject),
  /** The subject is undefined. */
  to_not_be_defined: (subject: Value): TestExpect => mk("to_not_be_defined", subject),
  /** The subject is empty — `""`, `[]`, `{}`, `0`, or null. */
  to_be_empty: (subject: Value): TestExpect => mk("to_be_empty", subject),
  /** The subject is `null`. */
  to_be_null: (subject: Value): TestExpect => mk("to_be_null", subject),
  /** The subject is not `null`. */
  to_not_be_null: (subject: Value): TestExpect => mk("to_not_be_null", subject),
  /** The subject is boolean true. */
  to_be_true: (subject: Value): TestExpect => mk("to_be_true", subject),
  /** The subject is boolean false. */
  to_be_false: (subject: Value): TestExpect => mk("to_be_false", subject),
  /** The subject is a timestamp later than now. */
  to_be_in_the_future: (subject: Value): TestExpect => mk("to_be_in_the_future", subject),
  /** The subject is a timestamp earlier than now. */
  to_be_in_the_past: (subject: Value): TestExpect => mk("to_be_in_the_past", subject),

  /** `subject === value`. */
  to_equal: (subject: Value, value: Value): TestExpect => mk("to_equal", subject, value),
  /** `subject !== value`. */
  to_not_equal: (subject: Value, value: Value): TestExpect => mk("to_not_equal", subject, value),
  /** `subject > value`, both read as numbers. */
  to_be_greater_than: (subject: Value, value: Value): TestExpect =>
    mk("to_be_greater_than", subject, value),
  /** `subject < value`, both read as numbers. */
  to_be_less_than: (subject: Value, value: Value): TestExpect =>
    mk("to_be_less_than", subject, value),
  /** A list subject contains the item; a text subject contains the substring. */
  to_contain: (subject: Value, item: Value): TestExpect => mk("to_contain", subject, item),
  /** The subject, as text, starts with `prefix`. */
  to_start_with: (subject: Value, prefix: Value): TestExpect =>
    mk("to_start_with", subject, prefix),
  /** The subject, as text, ends with `suffix`. */
  to_end_with: (subject: Value, suffix: Value): TestExpect => mk("to_end_with", subject, suffix),
  /**
   * The subject matches a regular expression. `pattern` is a PCRE pattern
   * INCLUDING its delimiters — build it with `c.regex(...)` rather than by hand;
   * a bare `"^a"` is not a runnable pattern and the engine's match silently
   * fails rather than erroring.
   */
  to_match: (subject: Value, pattern: Value): TestExpect => mk("to_match", subject, pattern),

  /**
   * `min < subject < max`, both bounds EXCLUSIVE and all three read as numbers.
   * A subject equal to either bound fails.
   */
  to_be_within: (subject: Value, min: Value, max: Value): TestExpect =>
    mk("to_be_within", subject, min, max),

  /**
   * The run raised an error. Pass `exception` to require that text to appear in
   * the error message (a case-insensitive substring, not an exact match);
   * omit it to accept ANY error.
   *
   * Unlike every other matcher this one takes no subject: the thing under
   * assertion is the run's failure, and the engine stores the response slot as
   * a fixed first var. That is what the editor writes, and it is preserved so
   * an authored test and a pulled one are the same bytes.
   */
  to_throw: (exception?: Value): TestExpect => mk("to_throw", resp(), exception ?? c.text("")),
} as const;
