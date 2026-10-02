/**
 * `fl.substr` filter (group: text).
 * Extracts a section of text
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSubstr = defineFunction({
  name: "ex_filter_substr",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["substr"](c.int(2), c.int(2))))],
  response: ref("out"),
});
