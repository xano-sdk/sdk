/**
 * `fl.last` filter (group: array).
 * Get the last entry of an array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLast = defineFunction({
  name: "ex_filter_last",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["last"]()))],
  response: ref("out"),
});
