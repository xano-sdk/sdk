/**
 * `s.array.find_index` — the index of the first match (`2`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayFindIndex = defineFunction({
  name: "ex_array_find_index",
  stack: [
    s.array.find_index({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
