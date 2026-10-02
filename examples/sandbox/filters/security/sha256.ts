/**
 * `fl.sha256` filter (group: security).
 * Returns a SHA256 signature representation of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSha256 = defineFunction({
  name: "ex_filter_sha256",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sha256"]()))],
  response: ref("out"),
});
