/**
 * `fl.num_max` filter (group: math).
 * Returns the max both values
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterNumMax = defineFunction({
  name: "ex_filter_num_max",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["num_max"](c.text("x"))))],
  response: ref("out"),
});
