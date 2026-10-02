/**
 * `fl.max` filter (group: math).
 * Returns the max of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMax = defineFunction({
  name: "ex_filter_max",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["max"]()))],
  response: ref("out"),
});
