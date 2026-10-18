/**
 * `s.array.has` — whether any item matches (`true`).
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayHas = defineFunction({
  name: "ex_array_has",
  stack: [
    s.array.has({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
