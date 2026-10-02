/**
 * `s.text.contains` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const textContains = defineFunction({
  name: "ex_text_contains",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.contains({ name: "acc", as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
