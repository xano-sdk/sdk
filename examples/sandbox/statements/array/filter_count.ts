/**
 * `s.array.filter_count` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayFilterCount = defineFunction({
  name: "ex_array_filter_count",
  stack: [
    s.array.filter_count({ as: "result" }),
  ],
  response: ref("result"),
});
