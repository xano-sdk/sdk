/**
 * `fl.index_by` filter (group: array).
 * Groups the piped array into an OBJECT keyed by each item's path — every value is an ARRAY of the items sharing that key, even when only one item does. So a lookup reads `idx[key][0]`, not `idx[key]`; the singular spelling yields null rather than erroring. Items whose path is missing or non-scalar are dropped.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIndexBy = defineFunction({
  name: "ex_filter_index_by",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["index_by"](c.text("field"))))],
  response: ref("out"),
});
