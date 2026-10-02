/**
 * `fl.mod` filter (group: math).
 * Modulus 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMod = defineFunction({
  name: "ex_filter_mod",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["mod"](c.int(2))))],
  response: ref("out"),
});
