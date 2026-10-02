/**
 * `fl.odd` filter (group: comparison).
 * Returns whether or not the value is odd
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterOdd = defineFunction({
  name: "ex_filter_odd",
  stack: [s.set_var("out", withFilters(c.int(5), fl["odd"]()))],
  response: ref("out"),
});
