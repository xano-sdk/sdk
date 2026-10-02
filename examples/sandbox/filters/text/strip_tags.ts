/**
 * `fl.strip_tags` filter (group: text).
 * Removes HTML tags from a string
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterStripTags = defineFunction({
  name: "ex_filter_strip_tags",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["strip_tags"]()))],
  response: ref("out"),
});
