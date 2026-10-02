/**
 * `fl.array_diff_assoc` filter (group: array).
 * Return the entries from the first array that are not in the second
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayDiffAssoc = defineFunction({
  name: "ex_filter_array_diff_assoc",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_diff_assoc"](c.array([1, 2]))))],
  response: ref("out"),
});
