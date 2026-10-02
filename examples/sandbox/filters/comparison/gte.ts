/**
 * `fl.gte` filter (group: comparison).
 * Returns a boolean if the left value is greater than or equal to the
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterGte = defineFunction({
  name: "ex_filter_gte",
  stack: [s.set_var("out", withFilters(c.int(5), fl["gte"](c.text("x"))))],
  response: ref("out"),
});
