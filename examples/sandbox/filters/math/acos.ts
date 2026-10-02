/**
 * `fl.acos` filter (group: math).
 * Calculates the arc cosine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAcos = defineFunction({
  name: "ex_filter_acos",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["acos"]()))],
  response: ref("out"),
});
