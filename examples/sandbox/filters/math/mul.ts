/**
 * `fl.mul` filter (group: math).
 * Multiplies 2 values together and returns the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMul = defineFunction({
  name: "ex_filter_mul",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["mul"](c.decimal(2))))],
  response: ref("out"),
});
