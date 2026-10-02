/**
 * `fl.pow` filter (group: math).
 * Returns the value raised to the power of exp.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterPow = defineFunction({
  name: "ex_filter_pow",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["pow"](c.text("x"))))],
  response: ref("out"),
});
