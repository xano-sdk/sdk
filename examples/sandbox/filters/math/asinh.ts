/**
 * `fl.asinh` filter (group: math).
 * Calculates the inverse hyperbolic sine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAsinh = defineFunction({
  name: "ex_filter_asinh",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["asinh"]()))],
  response: ref("out"),
});
