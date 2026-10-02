/**
 * `s.array.shift` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const arrayShift = defineFunction({
  name: "ex_array_shift",
  stack: [
    s.set_var("acc", c.array([1, 2, 3])),
    s.array.shift({ name: "acc", as: "result" }),
  ],
  response: ref("result"),
});
