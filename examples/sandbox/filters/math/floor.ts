/**
 * `fl.floor` filter (group: math).
 * Round a decimal down to its integer equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFloor = defineFunction({
  name: "ex_filter_floor",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["floor"]()))],
  response: ref("out"),
});
