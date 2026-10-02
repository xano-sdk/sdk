/**
 * `fl.octdec` filter (group: transform).
 * Converts an octal value into its decimal equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterOctdec = defineFunction({
  name: "ex_filter_octdec",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["octdec"]()))],
  response: ref("out"),
});
