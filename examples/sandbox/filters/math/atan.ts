/**
 * `fl.atan` filter (group: math).
 * Calculates the arc tangent of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAtan = defineFunction({
  name: "ex_filter_atan",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["atan"]()))],
  response: ref("out"),
});
