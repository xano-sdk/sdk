/**
 * `fl.reduce` filter (group: array).
 * Reduces the array to a single value using the code block to combine each element of the array.
 *
 * Two things this example exists to say. The accumulator is
 * `$result` — the body's parameters ARE the bindings, so autocomplete offers it
 * and `$acc` does not compile. And `initial_value` is REQUIRED: it sits in front
 * of `code`, so omitting it would put the body in the initial-value slot.
 *
 * The surface is implied by the call site: written here, the body is a reduce
 * body, and nothing has to say so.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterReduce = defineFunction({
  name: "ex_filter_reduce",
  stack: [
    s.set_var(
      "out",
      withFilters(
        c.array([1, 2, 3, 4]),
        // [1,2,3,4] sums to 10.
        fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this }),
      ),
    ),
  ],
  response: ref("out"),
});
