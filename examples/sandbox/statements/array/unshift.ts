/**
 * `s.array.unshift` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const arrayUnshift = defineFunction({
  name: "ex_array_unshift",
  stack: [
    s.set_var("acc", c.array([1, 2, 3])),
    s.array.unshift({ name: "acc", value: c.text("example") }),
  ],
});
