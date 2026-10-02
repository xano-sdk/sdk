/**
 * `fl.decbin` filter (group: transform).
 * Converts a decimal value into its binary string (i.e. 01010) equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDecbin = defineFunction({
  name: "ex_filter_decbin",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["decbin"]()))],
  response: ref("out"),
});
