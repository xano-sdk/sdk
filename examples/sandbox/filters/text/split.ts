/**
 * `fl.split` filter (group: text).
 * Splits text into an array of text and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSplit = defineFunction({
  name: "ex_filter_split",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["split"](c.text("x"))))],
  response: ref("out"),
});
