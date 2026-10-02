/**
 * `fl.array_pop` filter (group: array).
 * Pops the last element of the array off and returns it
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayPop = defineFunction({
  name: "ex_filter_array_pop",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_pop"]()))],
  response: ref("out"),
});
