/**
 * `fl.array_slice` filter (group: array).
 * Extract a section from an array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArraySlice = defineFunction({
  name: "ex_filter_array_slice",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_slice"](c.int(2))))],
  response: ref("out"),
});
