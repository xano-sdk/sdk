/**
 * `s.foreach({ as, list, body })` — iterate a list, binding each item to `as`.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const foreachLoop = defineFunction({
  name: "ex_foreach",
  stack: [
    s.set_var("total", c.int(0)),
    s.foreach({
      as: "item",
      list: c.array([1, 2, 3, 4]),
      body: [s.math.add({ name: "total", value: ref("item") })],
    }),
  ],
  response: ref("total"),
});
