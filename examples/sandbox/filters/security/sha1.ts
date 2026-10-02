/**
 * `fl.sha1` filter (group: security).
 * Returns a SHA1 signature representation of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSha1 = defineFunction({
  name: "ex_filter_sha1",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sha1"]()))],
  response: ref("out"),
});
