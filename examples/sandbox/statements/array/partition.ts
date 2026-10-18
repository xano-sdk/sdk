/**
 * `s.array.partition` — splits the list into matching and non-matching items.
 */
import { c, defineFunction, expr, ref, s } from "@xano/sdk";

export const arrayPartition = defineFunction({
  name: "ex_array_partition",
  stack: [
    s.array.partition({ as: "result", expr: c.array([1, 2, 3, 4]), if: expr(c.expression("$this"), ">", c.int(2)) }),
  ],
  response: ref("result"),
});
