/**
 * `fl.bitwise_and` filter (group: math).
 * Bitwise AND 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBitwiseAnd = defineFunction({
  name: "ex_filter_bitwise_and",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["bitwise_and"](c.int(2))))],
  response: ref("out"),
});
