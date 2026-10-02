/**
 * `fl.array_fill_keys` filter (group: manipulation).
 * Create an array of keys with a default value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayFillKeys = defineFunction({
  name: "ex_filter_array_fill_keys",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_fill_keys"](c.array([1, 2]))))],
  response: ref("out"),
});
