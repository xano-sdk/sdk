/**
 * `fl.product` filter (group: math).
 * Returns the product of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterProduct = defineFunction({
  name: "ex_filter_product",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["product"]()))],
  response: ref("out"),
});
