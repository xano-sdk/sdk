/**
 * `fl.lower` filter (group: text).
 * Converts all characters to lower case and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLower = defineFunction({
  name: "ex_filter_lower",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["lower"]()))],
  response: ref("out"),
});
