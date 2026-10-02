/**
 * `fl.is_int` filter (group: comparison).
 * Returns whether or not the value is an integer.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsInt = defineFunction({
  name: "ex_filter_is_int",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_int"]()))],
  response: ref("out"),
});
