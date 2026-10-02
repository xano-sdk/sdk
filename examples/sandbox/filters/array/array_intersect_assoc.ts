/**
 * `fl.array_intersect_assoc` filter (group: array).
 * Return the entries from the first array that are also present in
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayIntersectAssoc = defineFunction({
  name: "ex_filter_array_intersect_assoc",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_intersect_assoc"](c.array([1, 2]))))],
  response: ref("out"),
});
