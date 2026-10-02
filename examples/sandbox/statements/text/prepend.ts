/**
 * `s.text.prepend` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const textPrepend = defineFunction({
  name: "ex_text_prepend",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.prepend({ name: "acc", value: c.text("example") }),
  ],
});
