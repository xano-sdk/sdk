/**
 * `fl.uid` filter (group: security).
 * Returns a unique 64bit unsigned int value seeded off the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUid = defineFunction({
  name: "ex_filter_uid",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["uid"]()))],
  response: ref("out"),
});
