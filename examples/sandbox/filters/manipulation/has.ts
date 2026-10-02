/**
 * `fl.has` filter (group: manipulation).
 * Returns the existence of whether or not something is present in the object at the specified path
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterHas = defineFunction({
  name: "ex_filter_has",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["has"](c.text("field"))))],
  response: ref("out"),
});
