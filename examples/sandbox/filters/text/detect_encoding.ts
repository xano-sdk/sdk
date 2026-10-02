/**
 * `fl.detect_encoding` filter (group: text).
 * Detect the character encoding of the supplied text
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDetectEncoding = defineFunction({
  name: "ex_filter_detect_encoding",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["detect_encoding"]()))],
  response: ref("out"),
});
