/**
 * `s.array.difference` — items of the first list not in the second (`[1, 4]`).
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const arrayDifference = defineFunction({
  name: "ex_array_difference",
  stack: [
    s.array.difference({ as: "result", expr: c.array([1, 2, 3, 4]), value: c.array([2, 3]) }),
  ],
  response: ref("result"),
});
