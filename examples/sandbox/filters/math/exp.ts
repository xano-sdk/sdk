/**
 * `fl.exp` filter (group: math).
 * Returns the exponent of mathematical expression "e"
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterExp = defineFunction({
  name: "ex_filter_exp",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["exp"]()))],
  response: ref("out"),
});
