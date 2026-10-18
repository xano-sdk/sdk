/**
 * `s.array.every` — whether every item matches (`false`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayEvery = defineFunction({
  name: "ex_array_every",
  stack: [
    s.array.every({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
