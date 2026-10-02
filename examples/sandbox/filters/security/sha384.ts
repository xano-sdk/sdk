/**
 * `fl.sha384` filter (group: security).
 * Returns a SHA384 signature representation of the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSha384 = defineFunction({
  name: "ex_filter_sha384",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sha384"]()))],
  response: ref("out"),
});
