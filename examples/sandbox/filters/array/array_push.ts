/**
 * `fl.array_push` filter (group: array).
 * Push an element on to the end of an array and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayPush = defineFunction({
  name: "ex_filter_array_push",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_push"](c.text("x"))))],
  response: ref("out"),
});
