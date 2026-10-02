/**
 * `fl.trim` filter (group: text).
 * Trim whitespace or other characters from both sides and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterTrim = defineFunction({
  name: "ex_filter_trim",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["trim"]()))],
  response: ref("out"),
});
