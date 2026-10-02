/**
 * `fl.from_utf8` filter (group: text).
 * Convert the supplied text from UTF-8 to its binary form (ISO-8859-1).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFromUtf8 = defineFunction({
  name: "ex_filter_from_utf8",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["from_utf8"]()))],
  response: ref("out"),
});
