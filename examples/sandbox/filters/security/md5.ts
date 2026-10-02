/**
 * `fl.md5` filter (group: security).
 * Returns a MD5 signature representation of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMd5 = defineFunction({
  name: "ex_filter_md5",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["md5"]()))],
  response: ref("out"),
});
