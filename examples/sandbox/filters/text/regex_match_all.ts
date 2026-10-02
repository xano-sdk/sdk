/**
 * `fl.regex_match_all` filter (group: text).
 * Return all matches performed by a regular expression on the Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRegexMatchAll = defineFunction({
  name: "ex_filter_regex_match_all",
  stack: [s.set_var("out", withFilters(c.regex("Hello"), fl["regex_match_all"](c.text("x"))))],
  response: ref("out"),
});
