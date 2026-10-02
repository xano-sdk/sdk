/**
 * `s.while({ when, body })` — a condition-bounded loop.
 */
import { defineFunction, s, c, ref, expr } from "@xano/sdk";

export const whileLoop = defineFunction({
  name: "ex_while",
  stack: [
    s.set_var("n", c.int(0)),
    s.while({
      when: expr(ref("n"), "<", c.int(10)),
      body: [s.math.add({ name: "n", value: c.int(1) })],
    }),
  ],
  response: ref("n"),
});
