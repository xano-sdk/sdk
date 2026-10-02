/**
 * `fl.to_decimal` filter (group: transform).
 * Converts text, integer, or bool types to a decimal and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToDecimal = defineFunction({
  name: "ex_filter_to_decimal",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_decimal"]()))],
  response: ref("out"),
});
