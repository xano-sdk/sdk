/**
 * `fl.flatten` filter (group: array).
 * Flattens a multidimensional array into a single level array of values.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFlatten = defineFunction({
  name: "ex_filter_flatten",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["flatten"]()))],
  response: ref("out"),
});
