/**
 * `fl.deg2rad` filter (group: math).
 * Convert degrees to radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDeg2rad = defineFunction({
  name: "ex_filter_deg2rad",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["deg2rad"]()))],
  response: ref("out"),
});
