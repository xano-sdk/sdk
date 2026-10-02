/**
 * `fl.pick` filter (group: array).
 * Pick keys from the object to create a new object of just those keys.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterPick = defineFunction({
  name: "ex_filter_pick",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["pick"](c.text("field"))))],
  response: ref("out"),
});
