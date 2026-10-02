/**
 * `fl.text_unescape` filter (group: text).
 * Convert escaped sequences into their raw form. Ex: \n becomes a newline, \t becomes a tab.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterTextUnescape = defineFunction({
  name: "ex_filter_text_unescape",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["text_unescape"]()))],
  response: ref("out"),
});
