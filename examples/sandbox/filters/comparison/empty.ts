/**
 * `fl.empty` filter (group: comparison).
 * Returns whether or not the value is empty ("", null, 0, "0", false, [], {})
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEmpty = defineFunction({
  name: "ex_filter_empty",
  stack: [s.set_var("out", withFilters(c.int(5), fl["empty"]()))],
  response: ref("out"),
});
