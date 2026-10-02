/**
 * `fl.epochms_date` filter (group: timestamp).
 * Converts a timestamp into a human readable formatted date based on
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEpochmsDate = defineFunction({
  name: "ex_filter_epochms_date",
  stack: [s.set_var("out", withFilters(c.int(1700000000000), fl["epochms_date"](c.text("x"))))],
  response: ref("out"),
});
