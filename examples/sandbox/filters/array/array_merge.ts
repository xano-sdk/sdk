/**
 * `fl.array_merge` filter (group: array).
 * Merge the first level of elements of both arrays together and
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayMerge = defineFunction({
  name: "ex_filter_array_merge",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_merge"](c.array([1, 2]))))],
  response: ref("out"),
});
