/**
 * `s.util.get_vars` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const utilGetVars = defineFunction({
  name: "ex_util_get_vars",
  stack: [
    s.util.get_vars({ as: "result" }),
  ],
  response: ref("result"),
});
