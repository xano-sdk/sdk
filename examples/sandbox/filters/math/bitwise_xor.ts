/**
 * `fl.bitwise_xor` filter (group: math).
 * Bitwise XOR 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBitwiseXor = defineFunction({
  name: "ex_filter_bitwise_xor",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["bitwise_xor"](c.int(2))))],
  response: ref("out"),
});
