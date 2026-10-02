/**
 * `s.object.keys` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const objectKeys = defineFunction({
  name: "ex_object_keys",
  stack: [
    s.object.keys({ as: "result" }),
  ],
  response: ref("result"),
});
