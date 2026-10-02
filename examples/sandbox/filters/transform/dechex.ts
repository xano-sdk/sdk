/**
 * `fl.dechex` filter (group: transform).
 * Converts a decimal value into its hex equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDechex = defineFunction({
  name: "ex_filter_dechex",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["dechex"]()))],
  response: ref("out"),
});
