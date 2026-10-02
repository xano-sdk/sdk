/**
 * `fl.is_text` filter (group: comparison).
 * Returns whether or not the value is text.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsText = defineFunction({
  name: "ex_filter_is_text",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_text"]()))],
  response: ref("out"),
});
