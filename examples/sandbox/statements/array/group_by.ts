/**
 * `s.array.group_by` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayGroupBy = defineFunction({
  name: "ex_array_group_by",
  stack: [
    s.array.group_by({ as: "result" }),
  ],
  response: ref("result"),
});
