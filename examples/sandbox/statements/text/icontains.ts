/**
 * `s.text.icontains` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const textIcontains = defineFunction({
  name: "ex_text_icontains",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.icontains({ name: "acc", as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
