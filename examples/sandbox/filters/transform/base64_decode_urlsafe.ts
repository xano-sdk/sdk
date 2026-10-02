/**
 * `fl.base64_decode_urlsafe` filter (group: transform).
 * Decodes the value represented as base64 urlsafe text and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBase64DecodeUrlsafe = defineFunction({
  name: "ex_filter_base64_decode_urlsafe",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["base64_decode_urlsafe"]()))],
  response: ref("out"),
});
