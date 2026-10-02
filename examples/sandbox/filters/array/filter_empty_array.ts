/**
 * `fl.filter_empty_array` filter (group: array).
 * Returns a new array with only entries that are not an empty array `[]`
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterEmptyArray = defineFunction({
  name: "ex_filter_filter_empty_array",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_empty_array"](c.text("field"))))],
  response: ref("out"),
});
