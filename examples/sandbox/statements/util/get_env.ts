/**
 * `s.util.get_env` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const utilGetEnv = defineFunction({
  name: "ex_util_get_env",
  stack: [
    s.util.get_env({ as: "result" }),
  ],
  response: ref("result"),
});
