/**
 * `fl.unpick` filter (group: array).
 * Remove keys from the object to create a new object of the remaining keys.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUnpick = defineFunction({
  name: "ex_filter_unpick",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["unpick"](c.text("field"))))],
  response: ref("out"),
});
