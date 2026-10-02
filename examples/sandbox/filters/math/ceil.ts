/**
 * `fl.ceil` filter (group: math).
 * Round a decimal up to its integer equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCeil = defineFunction({
  name: "ex_filter_ceil",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["ceil"]()))],
  response: ref("out"),
});
