/**
 * `fl.csv_create` filter (group: transform).
 * Creates a CSV format data stream from a list of column names and their
 * corresponding data rows.
 *
 * The header-writing counterpart to `csv_encode`. Direction matters: the PIPED
 * value is the list of column names (written as the header line), and the `rows`
 * argument carries the data. All four arguments are required by the engine even
 * though the spec reads otherwise.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCsvCreate = defineFunction({
  name: "ex_filter_csv_create",
  stack: [
    s.set_var(
      "out",
      withFilters(
        // Piped value = the header line.
        c.array(["name", "score"]),
        fl.csv_create(
          // `rows` = the data, each row a positional list matching the header.
          c.array([
            ["Ada", 10],
            ["Grace", 20],
          ]),
          ",",
          '"',
          "\\",
        ),
      ),
    ),
  ],
  response: ref("out"),
});
