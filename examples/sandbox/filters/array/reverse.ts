/**
 * `fl.reverse` filter (group: array).
 * Returns values of an array in reverse order
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterReverse = defineFunction({
  name: "ex_filter_reverse",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["reverse"]()))],
  response: ref("out"),
});
