/**
 * `s.array.find` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayFind = defineFunction({
  name: "ex_array_find",
  stack: [
    s.array.find({ as: "result" }),
  ],
  response: ref("result"),
});
