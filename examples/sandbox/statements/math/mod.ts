/**
 * `s.math.mod` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathMod = defineFunction({
  name: "ex_math_mod",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.mod({ name: "acc", value: c.int(1) }),
  ],
});
