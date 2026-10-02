/**
 * `fl.log10` filter (group: math).
 * Returns the Base-10 logarithm
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLog10 = defineFunction({
  name: "ex_filter_log10",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["log10"]()))],
  response: ref("out"),
});
