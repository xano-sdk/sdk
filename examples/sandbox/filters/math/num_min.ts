/**
 * `fl.num_min` filter (group: math).
 * Returns the min both values
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterNumMin = defineFunction({
  name: "ex_filter_num_min",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["num_min"](c.text("x"))))],
  response: ref("out"),
});
