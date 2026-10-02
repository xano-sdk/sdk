/**
 * `s.array.filter` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayFilter = defineFunction({
  name: "ex_array_filter",
  stack: [
    s.array.filter({ as: "result" }),
  ],
  response: ref("result"),
});
