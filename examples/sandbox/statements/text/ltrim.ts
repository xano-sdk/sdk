/**
 * `s.text.ltrim` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const textLtrim = defineFunction({
  name: "ex_text_ltrim",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.ltrim({ name: "acc", value: c.text("example") }),
  ],
});
