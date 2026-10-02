/**
 * `fl.findIndex` filter (group: array).
 * Finds the index of the first element in the array that passes the test implemented by the provided function.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFindIndex = defineFunction({
  name: "ex_filter_findIndex",
  stack: [
    s.set_var(
      "out",
      // 2 — the position of the first element over 2, not the element itself.
      withFilters(
        c.array([1, 2, 3, 4]),
        fl.findIndex(({ $this, $index }) => $this > 2 && $index >= 0),
      ),
    ),
  ],
  response: ref("out"),
});
