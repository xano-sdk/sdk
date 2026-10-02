/**
 * `fl.rtrim` filter (group: text).
 * Trim whitespace or other characters from the right return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRtrim = defineFunction({
  name: "ex_filter_rtrim",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["rtrim"]()))],
  response: ref("out"),
});
