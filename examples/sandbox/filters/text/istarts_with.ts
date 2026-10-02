/**
 * `fl.istarts_with` filter (group: text).
 * Returns whether or not the case-insensitive expression is present at the beginning Direction: the piped value is the subject text; the argument is the substring searched for.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIstartsWith = defineFunction({
  name: "ex_filter_istarts_with",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["istarts_with"](c.text("x"))))],
  response: ref("out"),
});
