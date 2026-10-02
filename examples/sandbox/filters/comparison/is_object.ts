/**
 * `fl.is_object` filter (group: comparison).
 * Returns whether or not the value is an object.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsObject = defineFunction({
  name: "ex_filter_is_object",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_object"]()))],
  response: ref("out"),
});
