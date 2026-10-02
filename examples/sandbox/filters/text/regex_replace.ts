/**
 * `fl.regex_replace` filter (group: text).
 * Perform a regular expression search and replace on the supplied subject text. Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRegexReplace = defineFunction({
  name: "ex_filter_regex_replace",
  stack: [s.set_var("out", withFilters(c.regex("Hello"), fl["regex_replace"](c.text("x"), c.text("x"))))],
  response: ref("out"),
});
