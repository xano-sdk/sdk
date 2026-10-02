/**
 * `fl.yaml_decode` filter (group: transform).
 * Decodes the value represented as yaml and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterYamlDecode = defineFunction({
  name: "ex_filter_yaml_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["yaml_decode"]()))],
  response: ref("out"),
});
