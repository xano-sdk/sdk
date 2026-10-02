/**
 * `fl.gt` filter (group: comparison).
 * Returns a boolean if the left value is greater than the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterGt = defineFunction({
  name: "ex_filter_gt",
  stack: [s.set_var("out", withFilters(c.int(5), fl["gt"](c.text("x"))))],
  response: ref("out"),
});
