/**
 * `s.text.trim` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const textTrim = defineFunction({
  name: "ex_text_trim",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.trim({ name: "acc", value: c.text("example") }),
  ],
});
