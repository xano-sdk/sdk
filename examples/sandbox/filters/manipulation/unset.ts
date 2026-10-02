/**
 * `fl.unset` filter (group: manipulation).
 * Removes a value at the path within the object and returns the updated object
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUnset = defineFunction({
  name: "ex_filter_unset",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["unset"](c.text("field"))))],
  response: ref("out"),
});
