/**
 * `fl.regex_test` filter (group: text).
 * Tests if a regular expression matches the supplied subject text. Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRegexTest = defineFunction({
  name: "ex_filter_regex_test",
  stack: [s.set_var("out", withFilters(c.regex("Hello"), fl["regex_test"](c.text("x"))))],
  response: ref("out"),
});
