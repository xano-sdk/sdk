/**
 * `fl.sha512` filter (group: security).
 * Returns a SHA512 signature representation of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSha512 = defineFunction({
  name: "ex_filter_sha512",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sha512"]()))],
  response: ref("out"),
});
