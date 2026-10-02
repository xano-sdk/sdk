/**
 * `fl.sqrt` filter (group: math).
 * Returns the square root of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSqrt = defineFunction({
  name: "ex_filter_sqrt",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["sqrt"]()))],
  response: ref("out"),
});
