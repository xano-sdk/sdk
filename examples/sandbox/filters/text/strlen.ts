/**
 * `fl.strlen` filter (group: text).
 * Returns the number of characters
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStrlen = defineFunction({
  name: "ex_filter_strlen",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["strlen"]()))],
  response: ref("out"),
});
