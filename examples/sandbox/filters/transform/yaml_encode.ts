/**
 * `fl.yaml_encode` filter (group: transform).
 * Encodes the value and returns the result as yaml text
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterYamlEncode = defineFunction({
  name: "ex_filter_yaml_encode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["yaml_encode"]()))],
  response: ref("out"),
});
