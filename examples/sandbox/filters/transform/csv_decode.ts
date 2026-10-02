/**
 * `fl.csv_decode` filter (group: transform).
 * Decodes the value represented in the CSV format and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCsvDecode = defineFunction({
  name: "ex_filter_csv_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["csv_decode"](c.text("x"), c.text("x"), c.text("x"))))],
  response: ref("out"),
});
