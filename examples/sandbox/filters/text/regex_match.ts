/**
 * `fl.regex_match` filter (group: text).
 * Return the first set of matches performed by a regular expression Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRegexMatch = defineFunction({
  name: "ex_filter_regex_match",
  stack: [s.set_var("out", withFilters(c.regex("Hello"), fl["regex_match"](c.text("x"))))],
  response: ref("out"),
});
