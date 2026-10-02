/**
 * `s.math.bitwise.xor` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathBitwiseXor = defineFunction({
  name: "ex_math_bitwise_xor",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.bitwise.xor({ name: "acc", value: c.int(1) }),
  ],
});
