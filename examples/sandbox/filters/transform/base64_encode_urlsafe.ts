/**
 * `fl.base64_encode_urlsafe` filter (group: transform).
 * Encodes the value and returns the result as base64 urlsafe text
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBase64EncodeUrlsafe = defineFunction({
  name: "ex_filter_base64_encode_urlsafe",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["base64_encode_urlsafe"]()))],
  response: ref("out"),
});
