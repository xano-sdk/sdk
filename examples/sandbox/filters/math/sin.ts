/**
 * `fl.sin` filter (group: math).
 * Calculates the sine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSin = defineFunction({
  name: "ex_filter_sin",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["sin"]()))],
  response: ref("out"),
});
