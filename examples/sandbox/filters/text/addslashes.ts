/**
 * `fl.addslashes` filter (group: text).
 * Adds a backslash to the following characters: single quote, double quote, backslash, and null character.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAddslashes = defineFunction({
  name: "ex_filter_addslashes",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["addslashes"]()))],
  response: ref("out"),
});
