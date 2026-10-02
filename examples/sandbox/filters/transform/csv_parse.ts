/**
 * `fl.csv_parse` filter (group: transform).
 * Parse the contents of a CSV file and convert it into an array of objects.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCsvParse = defineFunction({
  name: "ex_filter_csv_parse",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["csv_parse"](c.text("x"), c.text("x"), c.text("x"))))],
  response: ref("out"),
});
