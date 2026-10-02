/**
 * `s.foreach_continue()` — skip to the next iteration of the enclosing `foreach`.
 */
import { defineFunction, s, c, ref, expr } from "@xano/sdk";

export const foreachContinue = defineFunction({
  name: "ex_foreach_continue",
  stack: [
    s.set_var("sum_odds", c.int(0)),
    s.foreach({
      as: "n",
      list: c.array([1, 2, 3, 4, 5]),
      body: [
        s.conditional({
          when: expr(ref("n"), "=", c.int(2)),
          then: [s.foreach_continue()],
        }),
        s.math.add({ name: "sum_odds", value: ref("n") }),
      ],
    }),
  ],
  response: ref("sum_odds"),
});
