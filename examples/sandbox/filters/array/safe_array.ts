/**
 * `fl.safe_array` filter (group: array).
 * Always returns an array. Uses the existing value if it is an array or creates an array of one element.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSafeArray = defineFunction({
  name: "ex_filter_safe_array",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["safe_array"]()))],
  response: ref("out"),
});
