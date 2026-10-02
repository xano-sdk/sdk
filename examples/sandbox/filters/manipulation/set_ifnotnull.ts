/**
 * `fl.set_ifnotnull` filter (group: manipulation).
 * Sets a value (if it is not null) at the path within the object and returns the updated object
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSetIfnotnull = defineFunction({
  name: "ex_filter_set_ifnotnull",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["set_ifnotnull"](c.text("field"), c.text("x"))))],
  response: ref("out"),
});
