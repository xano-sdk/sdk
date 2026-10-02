/**
 * `fl.regex_quote` filter (group: text).
 * Update the supplied text value to be properly escaped for regular expressions.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRegexQuote = defineFunction({
  name: "ex_filter_regex_quote",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["regex_quote"]()))],
  response: ref("out"),
});
