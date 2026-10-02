/**
 * `s.text.append` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const textAppend = defineFunction({
  name: "ex_text_append",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.append({ name: "acc", value: c.text("example") }),
  ],
});
