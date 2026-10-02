/**
 * `fl.every` filter (group: array).
 * Checks if all elements in the array pass the test implemented by the provided function.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEvery = defineFunction({
  name: "ex_filter_every",
  stack: [
    s.set_var(
      "out",
      // true — every element is positive.
      withFilters(c.array([1, 2, 3, 4]), fl.every(({ $this }) => $this > 0)),
    ),
  ],
  response: ref("out"),
});
