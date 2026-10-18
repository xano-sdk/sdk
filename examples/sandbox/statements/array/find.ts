/**
 * `s.array.find` — the first item matching the condition (`3`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayFind = defineFunction({
  name: "ex_array_find",
  stack: [
    s.array.find({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
