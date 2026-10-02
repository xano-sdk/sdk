/**
 * `fl.filter_empty_object` filter (group: array).
 * Returns a new array with only entries that are not an empty object `{}`
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterEmptyObject = defineFunction({
  name: "ex_filter_filter_empty_object",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_empty_object"](c.text("field"))))],
  response: ref("out"),
});
