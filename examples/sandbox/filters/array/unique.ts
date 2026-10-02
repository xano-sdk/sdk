/**
 * `fl.unique` filter (group: array).
 * Returns unique values of an array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUnique = defineFunction({
  name: "ex_filter_unique",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["unique"](c.text("field"))))],
  response: ref("out"),
});
