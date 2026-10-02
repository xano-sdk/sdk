/**
 * `fl.asin` filter (group: math).
 * Calculates the arc sine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAsin = defineFunction({
  name: "ex_filter_asin",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["asin"]()))],
  response: ref("out"),
});
