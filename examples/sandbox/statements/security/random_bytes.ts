/**
 * `s.security.random_bytes` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityRandomBytes = defineFunction({
  name: "ex_security_random_bytes",
  stack: [
    s.security.random_bytes({ as: "result" }),
  ],
  response: ref("result"),
});
