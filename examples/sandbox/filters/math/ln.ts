/**
 * `fl.ln` filter (group: math).
 * Returns the natural logarithm
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLn = defineFunction({
  name: "ex_filter_ln",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["ln"]()))],
  response: ref("out"),
});
