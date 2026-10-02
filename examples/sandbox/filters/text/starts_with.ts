/**
 * `fl.starts_with` filter (group: text).
 * Returns whether or not the expression is present at the beginning Direction: the piped value is the subject text; the argument is the substring searched for.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStartsWith = defineFunction({
  name: "ex_filter_starts_with",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["starts_with"](c.text("x"))))],
  response: ref("out"),
});
