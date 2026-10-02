/**
 * `fl.bindec` filter (group: transform).
 * Converts a binary string (i.e. 01010) into its decimal equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBindec = defineFunction({
  name: "ex_filter_bindec",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["bindec"]()))],
  response: ref("out"),
});
