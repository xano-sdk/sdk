/**
 * `fl.even` filter (group: comparison).
 * Returns whether or not the value is even
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEven = defineFunction({
  name: "ex_filter_even",
  stack: [s.set_var("out", withFilters(c.int(5), fl["even"]()))],
  response: ref("out"),
});
