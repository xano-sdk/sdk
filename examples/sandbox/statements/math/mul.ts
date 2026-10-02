/**
 * `s.math.mul` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathMul = defineFunction({
  name: "ex_math_mul",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.mul({ name: "acc", value: c.int(1) }),
  ],
});
