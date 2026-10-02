/**
 * `fl.array_shift` filter (group: array).
 * Shifts the first element of the array off and returns it
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayShift = defineFunction({
  name: "ex_filter_array_shift",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_shift"]()))],
  response: ref("out"),
});
