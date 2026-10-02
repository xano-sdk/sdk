/**
 * `s.object.values` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const objectValues = defineFunction({
  name: "ex_object_values",
  stack: [
    s.object.values({ as: "result" }),
  ],
  response: ref("result"),
});
