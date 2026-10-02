/**
 * `fl.tan` filter (group: math).
 * Calculates the tangent of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterTan = defineFunction({
  name: "ex_filter_tan",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["tan"]()))],
  response: ref("out"),
});
