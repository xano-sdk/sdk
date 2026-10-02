/**
 * `s.array.has` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayHas = defineFunction({
  name: "ex_array_has",
  stack: [
    s.array.has({ as: "result" }),
  ],
  response: ref("result"),
});
