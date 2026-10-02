/**
 * `fl.array_remove` filter (group: array).
 * Remove any elements from the array that match the supplied value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterArrayRemove = defineFunction({
  name: "ex_filter_array_remove",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_remove"](c.text("x"), c.text("field"))))],
  response: ref("out"),
});
