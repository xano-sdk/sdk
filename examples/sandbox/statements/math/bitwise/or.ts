/**
 * `s.math.bitwise.or` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathBitwiseOr = defineFunction({
  name: "ex_math_bitwise_or",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.bitwise.or({ name: "acc", value: c.int(1) }),
  ],
});
