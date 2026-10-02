/**
 * `fl.capitalize` filter (group: text).
 * Converts the first letter of each word to a capital letter
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCapitalize = defineFunction({
  name: "ex_filter_capitalize",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["capitalize"]()))],
  response: ref("out"),
});
