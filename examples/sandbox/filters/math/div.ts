/**
 * `fl.div` filter (group: math).
 * Divides 2 values together and returns the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDiv = defineFunction({
  name: "ex_filter_div",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["div"](c.decimal(2))))],
  response: ref("out"),
});
