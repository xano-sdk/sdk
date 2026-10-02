/**
 * `fl.in` filter (group: comparison).
 * Returns whether or not the value is in the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIn = defineFunction({
  name: "ex_filter_in",
  stack: [s.set_var("out", withFilters(c.int(5), fl["in"](c.text("x"))))],
  response: ref("out"),
});
