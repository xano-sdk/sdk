/**
 * `fl.sort` filter.
 * Sort an array of elements with an optional path inside the element
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSort = defineFunction({
  name: "ex_filter_sort",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["sort"]()))],
  response: ref("out"),
});
