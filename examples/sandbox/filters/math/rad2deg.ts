/**
 * `fl.rad2deg` filter (group: math).
 * Convert radians to degrees
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRad2deg = defineFunction({
  name: "ex_filter_rad2deg",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["rad2deg"]()))],
  response: ref("out"),
});
