/**
 * `fl.array_unshift` filter (group: array).
 * Push an element to the beginning of an array and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayUnshift = defineFunction({
  name: "ex_filter_array_unshift",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_unshift"](c.text("x"))))],
  response: ref("out"),
});
