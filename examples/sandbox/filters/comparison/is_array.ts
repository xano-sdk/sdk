/**
 * `fl.is_array` filter (group: comparison).
 * Returns whether or not the value is a numerical indexed array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsArray = defineFunction({
  name: "ex_filter_is_array",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_array"]()))],
  response: ref("out"),
});
