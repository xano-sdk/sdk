/**
 * `fl.filter_zero` filter (group: array).
 * Returns a new array with only entries that are not zero
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterZero = defineFunction({
  name: "ex_filter_filter_zero",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_zero"](c.text("field"))))],
  response: ref("out"),
});
