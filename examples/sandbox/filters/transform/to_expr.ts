/**
 * `fl.to_expr` filter (group: transform).
 * Converts text into an expression, processes it, and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToExpr = defineFunction({
  name: "ex_filter_to_expr",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_expr"]()))],
  response: ref("out"),
});
