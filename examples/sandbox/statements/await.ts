/**
 * `s.await` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const awaitStmt = defineFunction({
  name: "ex_await",
  stack: [
    s.await({ as: "result" }),
  ],
  response: ref("result"),
});
