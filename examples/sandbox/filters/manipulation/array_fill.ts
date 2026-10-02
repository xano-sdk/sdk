/**
 * `fl.array_fill` filter (group: manipulation).
 * Create an array of a certain size with a default value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayFill = defineFunction({
  name: "ex_filter_array_fill",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_fill"](c.int(2), c.int(2))))],
  response: ref("out"),
});
