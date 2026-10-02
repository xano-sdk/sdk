/**
 * `fl.eq` filter (group: comparison).
 * Returns a boolean if both values are equal
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEq = defineFunction({
  name: "ex_filter_eq",
  stack: [s.set_var("out", withFilters(c.int(5), fl["eq"](c.text("x"))))],
  response: ref("out"),
});
