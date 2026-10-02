/**
 * `fl.first_notnull` filter (group: manipulation).
 * Returns the first value that is not null
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFirstNotnull = defineFunction({
  name: "ex_filter_first_notnull",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["first_notnull"](c.text("x"))))],
  response: ref("out"),
});
