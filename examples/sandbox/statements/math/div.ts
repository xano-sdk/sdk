/**
 * `s.math.div` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const mathDiv = defineFunction({
  name: "ex_math_div",
  stack: [
    s.set_var("acc", c.int(0)),
    s.math.div({ name: "acc", value: c.int(1) }),
  ],
});
