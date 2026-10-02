/**
 * `fl.array_entries` filter (group: array).
 * Get the property entries of an object/array as a numerically
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayEntries = defineFunction({
  name: "ex_filter_array_entries",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_entries"]()))],
  response: ref("out"),
});
