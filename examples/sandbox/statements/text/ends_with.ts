/**
 * `s.text.ends_with` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const textEndsWith = defineFunction({
  name: "ex_text_ends_with",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.ends_with({ name: "acc", as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
