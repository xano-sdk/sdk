/**
 * `fl.min` filter (group: math).
 * Returns the min of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMin = defineFunction({
  name: "ex_filter_min",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["min"]()))],
  response: ref("out"),
});
