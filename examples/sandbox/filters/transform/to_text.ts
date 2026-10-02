/**
 * `fl.to_text` filter (group: transform).
 * Converts integer, decimal, or bool types to text and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToText = defineFunction({
  name: "ex_filter_to_text",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_text"]()))],
  response: ref("out"),
});
