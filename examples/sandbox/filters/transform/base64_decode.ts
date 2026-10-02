/**
 * `fl.base64_decode` filter (group: transform).
 * Decodes the value represented as base64 text and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterBase64Decode = defineFunction({
  name: "ex_filter_base64_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["base64_decode"]()))],
  response: ref("out"),
});
