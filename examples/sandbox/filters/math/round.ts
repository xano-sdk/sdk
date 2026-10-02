/**
 * `fl.round` filter (group: math).
 * Round a decimal with optional precision
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRound = defineFunction({
  name: "ex_filter_round",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["round"]()))],
  response: ref("out"),
});
