/**
 * `s.array.every` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const arrayEvery = defineFunction({
  name: "ex_array_every",
  stack: [
    s.array.every({ as: "result" }),
  ],
  response: ref("result"),
});
