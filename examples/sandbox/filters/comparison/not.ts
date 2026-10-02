/**
 * `fl.not` filter (group: comparison).
 * Returns the opposite of the existing value evaluated as a boolean
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterNot = defineFunction({
  name: "ex_filter_not",
  stack: [s.set_var("out", withFilters(c.int(5), fl["not"]()))],
  response: ref("out"),
});
