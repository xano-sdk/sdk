/**
 * `fl.get` filter (group: manipulation).
 * Returns the value of an object at the specified path
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterGet = defineFunction({
  name: "ex_filter_get",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["get"](c.text("field"))))],
  response: ref("out"),
});
