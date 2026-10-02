/**
 * `fl.base_convert` filter (group: transform).
 * Converts a value between two bases
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBaseConvert = defineFunction({
  name: "ex_filter_base_convert",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["base_convert"](c.text("x"), c.text("x"))))],
  response: ref("out"),
});
