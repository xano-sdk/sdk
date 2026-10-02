/**
 * `fl.icontains` filter (group: text).
 * Returns whether or not the case-insensitive expression is found Direction: the piped value is the subject text; the argument is the substring searched for.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIcontains = defineFunction({
  name: "ex_filter_icontains",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["icontains"](c.text("x"))))],
  response: ref("out"),
});
