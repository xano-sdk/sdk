/**
 * `s.array.partition` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayPartition = defineFunction({
  name: "ex_array_partition",
  stack: [
    s.array.partition({ as: "result" }),
  ],
  response: ref("result"),
});
