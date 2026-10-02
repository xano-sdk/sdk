/**
 * `fl.contains` filter (group: text).
 * Returns whether or not the expression is found Direction: the piped value is the subject text; the argument is the substring searched for.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterContains = defineFunction({
  name: "ex_filter_contains",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["contains"](c.text("x"))))],
  response: ref("out"),
});
