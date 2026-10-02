/**
 * `fl.csv_encode` filter (group: transform).
 * Encodes the value and returns the result in CSV format.
 *
 * TWO THINGS BITE HERE, both engine-probed:
 *
 * 1. All three arguments read as optional, and the engine requires every one of
 *    them. `fl.csv_encode()` is refused at author time rather than failing on a
 *    deployed endpoint — pass the separator, enclosure, and escape explicitly.
 * 2. It writes NO header row. Each row contributes only its values, in THAT
 *    row's own key order, with no normalization across rows — so rows whose keys
 *    differ in order or count misalign columns silently. Reach for `csv_create`
 *    when you want a header.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCsvEncode = defineFunction({
  name: "ex_filter_csv_encode",
  stack: [
    s.set_var(
      "out",
      withFilters(
        // Uniform keys across every row — that is what keeps the columns lined
        // up, since nothing normalizes them for you.
        c.array([
          { name: "Ada", score: 10 },
          { name: "Grace", score: 20 },
        ]),
        fl.csv_encode(",", '"', "\\"),
      ),
    ),
  ],
  response: ref("out"),
});
