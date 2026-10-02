/**
 * `fl.abs` filter (group: math).
 * Returns the absolute value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAbs = defineFunction({
  name: "ex_filter_abs",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["abs"]()))],
  response: ref("out"),
});
