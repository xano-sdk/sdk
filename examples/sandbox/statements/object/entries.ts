/**
 * `s.object.entries` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const objectEntries = defineFunction({
  name: "ex_object_entries",
  stack: [
    s.object.entries({ as: "result" }),
  ],
  response: ref("result"),
});
