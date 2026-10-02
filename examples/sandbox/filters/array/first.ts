/**
 * `fl.first` filter (group: array).
 * Get the first entry of an array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFirst = defineFunction({
  name: "ex_filter_first",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["first"]()))],
  response: ref("out"),
});
