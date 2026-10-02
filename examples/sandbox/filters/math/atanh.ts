/**
 * `fl.atanh` filter (group: math).
 * Calculates the inverse hyperbolic tangent of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAtanh = defineFunction({
  name: "ex_filter_atanh",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["atanh"]()))],
  response: ref("out"),
});
