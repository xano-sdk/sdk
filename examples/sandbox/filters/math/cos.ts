/**
 * `fl.cos` filter (group: math).
 * Calculates the cosine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCos = defineFunction({
  name: "ex_filter_cos",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["cos"]()))],
  response: ref("out"),
});
