/**
 * `fl.hexdec` filter (group: transform).
 * Converts a hex value into its decimal equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterHexdec = defineFunction({
  name: "ex_filter_hexdec",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["hexdec"]()))],
  response: ref("out"),
});
