/**
 * `fl.ends_with` filter (group: text).
 * Returns whether or not the expression is present at the end Direction: the piped value is the subject text; the argument is the substring searched for.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEndsWith = defineFunction({
  name: "ex_filter_ends_with",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["ends_with"](c.text("x"))))],
  response: ref("out"),
});
