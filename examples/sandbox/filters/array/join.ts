/**
 * `fl.join` filter (group: array).
 * Joins an array into a text string via the separator and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterJoin = defineFunction({
  name: "ex_filter_join",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["join"](c.text("x"))))],
  response: ref("out"),
});
