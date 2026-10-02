/**
 * `fl.epochms_from_format` filter (group: timestamp).
 * Parse a timestamp from a flexible format.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEpochmsFromFormat = defineFunction({
  name: "ex_filter_epochms_from_format",
  stack: [s.set_var("out", withFilters(c.int(1700000000000), fl["epochms_from_format"](c.text("x"))))],
  response: ref("out"),
});
