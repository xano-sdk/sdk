/**
 * `s.util.get_all_input` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const utilGetAllInput = defineFunction({
  name: "ex_util_get_all_input",
  stack: [
    s.util.get_all_input({ as: "result" }),
  ],
  response: ref("result"),
});
