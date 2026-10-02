/**
 * `fl.sum` filter (group: math).
 * Returns the sum of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSum = defineFunction({
  name: "ex_filter_sum",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["sum"]()))],
  response: ref("out"),
});
