/**
 * `fl.is_decimal` filter (group: comparison).
 * Returns whether or not the value is a decimal value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsDecimal = defineFunction({
  name: "ex_filter_is_decimal",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_decimal"]()))],
  response: ref("out"),
});
