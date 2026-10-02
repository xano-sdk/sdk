/**
 * `fl.strip_accents` filter (group: text).
 * Removes accents from characters
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStripAccents = defineFunction({
  name: "ex_filter_strip_accents",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["strip_accents"]()))],
  response: ref("out"),
});
