/**
 * `fl.acosh` filter (group: math).
 * Calculates the inverse hyperbolic cosine of the supplied value in radians
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAcosh = defineFunction({
  name: "ex_filter_acosh",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["acosh"]()))],
  response: ref("out"),
});
