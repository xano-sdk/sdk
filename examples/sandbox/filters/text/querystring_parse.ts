/**
 * `fl.querystring_parse` filter (group: text).
 * Parses a query string from a URL into its individual key-value pairs.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterQuerystringParse = defineFunction({
  name: "ex_filter_querystring_parse",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["querystring_parse"]()))],
  response: ref("out"),
});
