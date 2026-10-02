/**
 * `fl.array_shuffle` filter (group: array).
 * Shuffles the order of the entries in the array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayShuffle = defineFunction({
  name: "ex_filter_array_shuffle",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_shuffle"]()))],
  response: ref("out"),
});
