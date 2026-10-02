/**
 * `fl.array_merge_recursive` filter (group: array).
 * Merge the elements from all levels of both arrays together and
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayMergeRecursive = defineFunction({
  name: "ex_filter_array_merge_recursive",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_merge_recursive"](c.array([1, 2]))))],
  response: ref("out"),
});
