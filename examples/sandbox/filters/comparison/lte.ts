/**
 * `fl.lte` filter (group: comparison).
 * Returns a boolean if the left value is less than or equal to the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLte = defineFunction({
  name: "ex_filter_lte",
  stack: [s.set_var("out", withFilters(c.int(5), fl["lte"](c.text("x"))))],
  response: ref("out"),
});
