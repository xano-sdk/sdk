/**
 * `fl.url_decode` filter (group: transform).
 * Decodes the value represented as a url encoded value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlDecode = defineFunction({
  name: "ex_filter_url_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["url_decode"]()))],
  response: ref("out"),
});
