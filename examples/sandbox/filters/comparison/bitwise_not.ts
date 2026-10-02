/**
 * `fl.bitwise_not` filter (group: comparison).
 * Returns the existing value with its bits flipped
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBitwiseNot = defineFunction({
  name: "ex_filter_bitwise_not",
  stack: [s.set_var("out", withFilters(c.int(5), fl["bitwise_not"]()))],
  response: ref("out"),
});
