/**
 * `fl.concat` filter (group: text).
 * Concatenates two values together
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterConcat = defineFunction({
  name: "ex_filter_concat",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["concat"](c.text("x"))))],
  response: ref("out"),
});
