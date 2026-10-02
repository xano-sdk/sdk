/**
 * `fl.url_encode_rfc3986` filter (group: transform).
 * Encodes the value and returns the result as a url encoded value using the RFC 3986 specification
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlEncodeRfc3986 = defineFunction({
  name: "ex_filter_url_encode_rfc3986",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["url_encode_rfc3986"]()))],
  response: ref("out"),
});
