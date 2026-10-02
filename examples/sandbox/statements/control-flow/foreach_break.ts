/**
 * `s.foreach_break()` — break out of the enclosing `foreach`. Only valid inside
 * a loop body, so it is shown wrapped in one.
 */
import { defineFunction, s, c, ref, expr } from "@xano/sdk";

export const foreachBreak = defineFunction({
  name: "ex_foreach_break",
  stack: [
    s.set_var("first_big", c.int(0)),
    s.foreach({
      as: "n",
      list: c.array([1, 5, 20, 100]),
      body: [
        s.conditional({
          when: expr(ref("n"), ">", c.int(10)),
          then: [s.update_var("first_big", ref("n")), s.foreach_break()],
        }),
      ],
    }),
  ],
  response: ref("first_big"),
});
