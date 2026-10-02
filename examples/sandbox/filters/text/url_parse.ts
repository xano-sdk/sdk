/**
 * `fl.url_parse` filter (group: text).
 * Parses a URL into its individual components.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlParse = defineFunction({
  name: "ex_filter_url_parse",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["url_parse"]()))],
  response: ref("out"),
});
