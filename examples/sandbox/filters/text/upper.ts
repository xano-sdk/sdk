/**
 * `fl.upper` filter (group: text).
 * Converts all characters to upper case and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUpper = defineFunction({
  name: "ex_filter_upper",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["upper"]()))],
  response: ref("out"),
});
