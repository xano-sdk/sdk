/**
 * `fl.array_intersect` filter (group: array).
 * Return the entries from the first array that are also present in
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayIntersect = defineFunction({
  name: "ex_filter_array_intersect",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_intersect"](c.array([1, 2]))))],
  response: ref("out"),
});
