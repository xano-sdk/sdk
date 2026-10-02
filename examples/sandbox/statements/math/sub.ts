/**
 * `s.math.sub` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathSub = defineFunction({
  name: "ex_math_sub",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.sub({ name: "acc", value: c.int(1) }),
  ],
});
