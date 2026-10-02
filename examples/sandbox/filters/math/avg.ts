/**
 * `fl.avg` filter (group: math).
 * Returns the average of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAvg = defineFunction({
  name: "ex_filter_avg",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["avg"]()))],
  response: ref("out"),
});
