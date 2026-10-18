/**
 * `s.array.filter_count` — how many items match (`2`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayFilterCount = defineFunction({
  name: "ex_array_filter_count",
  stack: [
    s.array.filter_count({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
