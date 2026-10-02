/**
 * `s.util.template_engine` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const utilTemplateEngine = defineFunction({
  name: "ex_util_template_engine",
  stack: [
    s.util.template_engine({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
