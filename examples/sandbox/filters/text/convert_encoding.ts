/**
 * `fl.convert_encoding` filter (group: text).
 * Convert the character encoding of the supplied text
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterConvertEncoding = defineFunction({
  name: "ex_filter_convert_encoding",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["convert_encoding"](c.text("x"), c.text("x"))))],
  response: ref("out"),
});
