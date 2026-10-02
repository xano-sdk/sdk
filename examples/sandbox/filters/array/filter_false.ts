/**
 * `fl.filter_false` filter (group: array).
 * Returns a new array with only entries that are not false
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterFalse = defineFunction({
  name: "ex_filter_filter_false",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_false"](c.text("field"))))],
  response: ref("out"),
});
