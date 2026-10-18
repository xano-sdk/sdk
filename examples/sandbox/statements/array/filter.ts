/**
 * `s.array.filter` — every item matching the condition (`[3, 4]`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayFilter = defineFunction({
  name: "ex_array_filter",
  stack: [
    s.array.filter({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
