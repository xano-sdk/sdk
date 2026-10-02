/**
 * `fl.json_decode` filter (group: transform).
 * Decodes the value represented as json and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterJsonDecode = defineFunction({
  name: "ex_filter_json_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["json_decode"]()))],
  response: ref("out"),
});
