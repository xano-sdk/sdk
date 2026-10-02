/**
 * `fl.epochms_add_secs` filter (group: timestamp).
 * Add seconds to a timestamp. (negative values are ok)
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEpochmsAddSecs = defineFunction({
  name: "ex_filter_epochms_add_secs",
  stack: [s.set_var("out", withFilters(c.int(1700000000000), fl["epochms_add_secs"](c.int(2))))],
  response: ref("out"),
});
