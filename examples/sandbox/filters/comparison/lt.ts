/**
 * `fl.lt` filter (group: comparison).
 * Returns a boolean if the left value is less than the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLt = defineFunction({
  name: "ex_filter_lt",
  stack: [s.set_var("out", withFilters(c.int(5), fl["lt"](c.text("x"))))],
  response: ref("out"),
});
