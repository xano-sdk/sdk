/**
 * `fl.to_epochms` filter (group: transform).
 * Converts a text expression (now, next friday, Jan 1 2000) to
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToEpochms = defineFunction({
  name: "ex_filter_to_epochms",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_epochms"]()))],
  response: ref("out"),
});
