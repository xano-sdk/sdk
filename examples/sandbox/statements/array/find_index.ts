/**
 * `s.array.find_index` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayFindIndex = defineFunction({
  name: "ex_array_find_index",
  stack: [
    s.array.find_index({ as: "result" }),
  ],
  response: ref("result"),
});
