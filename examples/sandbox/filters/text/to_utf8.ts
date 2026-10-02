/**
 * `fl.to_utf8` filter (group: text).
 * Convert the supplied text from its binary form (ISO-8859-1) to UTF-8.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToUtf8 = defineFunction({
  name: "ex_filter_to_utf8",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["to_utf8"]()))],
  response: ref("out"),
});
