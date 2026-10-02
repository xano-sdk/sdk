/**
 * `fl.add` filter (group: math).
 * Add 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAdd = defineFunction({
  name: "ex_filter_add",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["add"](c.decimal(2))))],
  response: ref("out"),
});
