/**
 * `fl.filter_empty` filter (group: array).
 * Returns a new array with only entries that are not empty ("", null, 0, "0", false, [], {})
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterEmpty = defineFunction({
  name: "ex_filter_filter_empty",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_empty"](c.text("field"))))],
  response: ref("out"),
});
