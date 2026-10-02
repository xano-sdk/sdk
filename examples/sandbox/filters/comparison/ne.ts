/**
 * `fl.ne` filter (group: comparison).
 * Returns a boolean if both values are not equal
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterNe = defineFunction({
  name: "ex_filter_ne",
  stack: [s.set_var("out", withFilters(c.int(5), fl["ne"](c.text("x"))))],
  response: ref("out"),
});
