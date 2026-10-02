/**
 * `fl.bitwise_or` filter (group: math).
 * Bitwise OR 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBitwiseOr = defineFunction({
  name: "ex_filter_bitwise_or",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["bitwise_or"](c.int(2))))],
  response: ref("out"),
});
