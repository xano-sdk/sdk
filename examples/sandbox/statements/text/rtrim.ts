/**
 * `s.text.rtrim` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const textRtrim = defineFunction({
  name: "ex_text_rtrim",
  stack: [
    s.set_var("acc", c.text("hello")),
    s.text.rtrim({ name: "acc", value: c.text("example") }),
  ],
});
