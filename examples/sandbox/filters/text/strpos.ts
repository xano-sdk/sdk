/**
 * `fl.strpos` filter (group: text).
 * Returns the index of the case-sensitive expression or false if it
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStrpos = defineFunction({
  name: "ex_filter_strpos",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["strpos"](c.text("x"))))],
  response: ref("out"),
});
