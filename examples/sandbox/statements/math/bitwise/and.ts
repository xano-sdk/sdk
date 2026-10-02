/**
 * `s.math.bitwise.and` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathBitwiseAnd = defineFunction({
  name: "ex_math_bitwise_and",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.bitwise.and({ name: "acc", value: c.int(1) }),
  ],
});
