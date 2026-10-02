/**
 * `expr(left, op, right)` — a single binary comparison, used in `s.conditional`
 * `when`, `s.while`, and array predicate `if`s. Operators: = != > < >= <=
 * (also == === !==).
 */
import { defineFunction, s, c, ref, expr } from "@xano/sdk";

export const valueExpr = defineFunction({
  name: "ex_value_expr",
  stack: [
    s.set_var("n", c.int(7)),
    s.conditional({
      when: expr(ref("n"), ">=", c.int(5)),
      then: [s.set_var("big", c.bool(true))],
      else: [s.set_var("big", c.bool(false))],
    }),
  ],
  response: ref("big"),
});
