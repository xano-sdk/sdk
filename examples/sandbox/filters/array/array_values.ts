/**
 * `fl.array_values` filter (group: array).
 * Get the property values of an object/array as a numerically indexed array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayValues = defineFunction({
  name: "ex_filter_array_values",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_values"]()))],
  response: ref("out"),
});
