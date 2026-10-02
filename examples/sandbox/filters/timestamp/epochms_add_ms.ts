/**
 * `fl.epochms_add_ms` filter (group: timestamp).
 * Add milliseconds to a timestamp. (negative values are ok)
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEpochmsAddMs = defineFunction({
  name: "ex_filter_epochms_add_ms",
  stack: [s.set_var("out", withFilters(c.int(1700000000000), fl["epochms_add_ms"](c.int(2))))],
  response: ref("out"),
});
