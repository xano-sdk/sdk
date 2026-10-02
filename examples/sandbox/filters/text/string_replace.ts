/**
 * `fl.string_replace` filter (group: text).
 * Replace a text phrase with another
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStringReplace = defineFunction({
  name: "ex_filter_string_replace",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["string_replace"](c.text("x"), c.text("x"))))],
  response: ref("out"),
});
