/**
 * `fl.set` filter (group: manipulation).
 * Sets a value at the path within the object and returns the updated object
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSet = defineFunction({
  name: "ex_filter_set",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["set"](c.text("field"), c.text("x"))))],
  response: ref("out"),
});
