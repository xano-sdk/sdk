/**
 * `s.array.merge` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const arrayMerge = defineFunction({
  name: "ex_array_merge",
  stack: [
    s.set_var("acc", c.array([1, 2, 3])),
    s.array.merge({ name: "acc", value: c.text("example") }),
  ],
});
