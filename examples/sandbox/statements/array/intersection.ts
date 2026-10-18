/**
 * `s.array.intersection` — items in both lists (`[2, 3]`).
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const arrayIntersection = defineFunction({
  name: "ex_array_intersection",
  stack: [
    s.array.intersection({ as: "result", expr: c.array([1, 2, 3, 4]), value: c.array([2, 3, 9]) }),
  ],
  response: ref("result"),
});
