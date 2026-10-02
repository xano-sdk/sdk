/**
 * `fl.text_escape` filter (group: text).
 * Converts control characters into their escaped sequences. Ex: newlines as \n, tabs as \t
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterTextEscape = defineFunction({
  name: "ex_filter_text_escape",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["text_escape"]()))],
  response: ref("out"),
});
