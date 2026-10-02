/**
 * `fl.is_bool` filter (group: comparison).
 * Returns whether or not the value is a boolean.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsBool = defineFunction({
  name: "ex_filter_is_bool",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_bool"]()))],
  response: ref("out"),
});
