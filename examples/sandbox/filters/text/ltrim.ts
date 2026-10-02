/**
 * `fl.ltrim` filter (group: text).
 * Trim whitespace or other characters from the left side and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLtrim = defineFunction({
  name: "ex_filter_ltrim",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["ltrim"]()))],
  response: ref("out"),
});
