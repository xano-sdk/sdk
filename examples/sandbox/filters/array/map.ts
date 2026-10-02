/**
 * `fl.map` filter (group: array).
 * Creates a new array with the results of calling a provided function on every element in the calling array.
 *
 * An iterating filter binds `$this` (the element), `$index` (its position) and
 * `$parent` (the whole array). `$result` is reduce's alone and does not compile
 * here.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterMap = defineFunction({
  name: "ex_filter_map",
  stack: [
    s.set_var(
      "out",
      // [1,2,3] doubles to [2,4,6].
      withFilters(c.array([1, 2, 3]), fl.map(({ $this }) => $this * 2)),
    ),
  ],
  response: ref("out"),
});
