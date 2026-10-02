/**
 * `fl.first_notempty` filter (group: manipulation).
 * Returns the first value that is not empty - i.e. not ("", null, 0, "0", false, [], {})
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFirstNotempty = defineFunction({
  name: "ex_filter_first_notempty",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["first_notempty"](c.text("x"))))],
  response: ref("out"),
});
