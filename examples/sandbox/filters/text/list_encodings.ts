/**
 * `fl.list_encodings` filter (group: text).
 * List support character encodings
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterListEncodings = defineFunction({
  name: "ex_filter_list_encodings",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["list_encodings"]()))],
  response: ref("out"),
});
