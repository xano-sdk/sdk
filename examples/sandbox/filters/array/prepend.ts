/**
 * `fl.prepend` filter (group: array).
 * Push an element on to the beginning of an array within an object and return the updated object
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterPrepend = defineFunction({
  name: "ex_filter_prepend",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["prepend"](c.text("x"), c.text("field"))))],
  response: ref("out"),
});
