/**
 * `s.math.add` — add a value to a numeric stack variable in place.
 *
 * The `math.*` family is the `argNameIsVar` shape: `name` is the stack variable
 * mutated in place (not an `as` output) and `value` is the operand.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const mathAdd = defineFunction({
  name: "ex_math_add",
  stack: [
    s.set_var("total", c.int(10)),
    s.math.add({ name: "total", value: c.int(5) }), // total = 15
  ],
  response: ref("total"),
});
