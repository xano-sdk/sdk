/**
 * `fl.filter_null` filter (group: array).
 * Returns a new array with only entries that are not null
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFilterNull = defineFunction({
  name: "ex_filter_filter_null",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter_null"](c.text("field"))))],
  response: ref("out"),
});
