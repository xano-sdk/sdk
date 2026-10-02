/**
 * `s.for({ as, count, body })` — a count-bounded loop (`for i in 0..count`).
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const forLoop = defineFunction({
  name: "ex_for",
  stack: [
    s.set_var("sum", c.int(0)),
    s.for({
      as: "i",
      count: c.int(5),
      body: [s.math.add({ name: "sum", value: ref("i") })],
    }),
  ],
  response: ref("sum"),
});
