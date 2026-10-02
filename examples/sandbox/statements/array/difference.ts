/**
 * `s.array.difference` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayDifference = defineFunction({
  name: "ex_array_difference",
  stack: [
    s.array.difference({ as: "result" }),
  ],
  response: ref("result"),
});
