/**
 * `fl.epochms_transform` filter (group: timestamp).
 * Takes a timestamp and applies a relative transformation to it. Ex.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEpochmsTransform = defineFunction({
  name: "ex_filter_epochms_transform",
  stack: [s.set_var("out", withFilters(c.int(1700000000000), fl["epochms_transform"](c.text("x"))))],
  response: ref("out"),
});
