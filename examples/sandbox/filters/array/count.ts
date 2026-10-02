/**
 * `fl.count` filter (group: array).
 * Return the number of items in an object/array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCount = defineFunction({
  name: "ex_filter_count",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["count"]()))],
  response: ref("out"),
});
