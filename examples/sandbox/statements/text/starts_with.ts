/**
 * `s.text.starts_with` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const textStartsWith = defineFunction({
  name: "ex_text_starts_with",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.starts_with({ name: "acc", as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
