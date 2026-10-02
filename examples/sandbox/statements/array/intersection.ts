/**
 * `s.array.intersection` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayIntersection = defineFunction({
  name: "ex_array_intersection",
  stack: [
    s.array.intersection({ as: "result" }),
  ],
  response: ref("result"),
});
