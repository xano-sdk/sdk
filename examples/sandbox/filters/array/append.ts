/**
 * `fl.append` filter (group: array).
 * Push an element on to the end of an array within an object and return the updated object
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterAppend = defineFunction({
  name: "ex_filter_append",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["append"](c.text("x"), c.text("field"))))],
  response: ref("out"),
});
