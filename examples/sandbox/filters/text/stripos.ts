/**
 * `fl.stripos` filter (group: text).
 * Returns the index of the case-insensitive expression or false if it
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStripos = defineFunction({
  name: "ex_filter_stripos",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["stripos"](c.text("x"))))],
  response: ref("out"),
});
