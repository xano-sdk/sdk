/**
 * `fl.sprintf` filter (group: text).
 * formats text with variable substitution
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSprintf = defineFunction({
  name: "ex_filter_sprintf",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sprintf"]()))],
  response: ref("out"),
});
