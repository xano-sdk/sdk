/**
 * `fl.null` filter (group: misc).
 * Returns a null value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterNull = defineFunction({
  name: "ex_filter_null",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["null"]()))],
  response: ref("out"),
});
