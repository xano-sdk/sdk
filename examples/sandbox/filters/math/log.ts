/**
 * `fl.log` filter (group: math).
 * Returns the logarithm with a custom base
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLog = defineFunction({
  name: "ex_filter_log",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["log"](c.text("x"))))],
  response: ref("out"),
});
