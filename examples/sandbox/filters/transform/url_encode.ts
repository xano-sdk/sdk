/**
 * `fl.url_encode` filter (group: transform).
 * Encodes the value and returns the result as a url encoded value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlEncode = defineFunction({
  name: "ex_filter_url_encode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["url_encode"]()))],
  response: ref("out"),
});
