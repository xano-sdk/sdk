/**
 * `fl.decoct` filter (group: transform).
 * Converts a decimal value into its octal equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDecoct = defineFunction({
  name: "ex_filter_decoct",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["decoct"]()))],
  response: ref("out"),
});
