/**
 * `s.security.create_secret_key` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityCreateSecretKey = defineFunction({
  name: "ex_security_create_secret_key",
  stack: [
    s.security.create_secret_key({ as: "result", format: "object" }),
  ],
  response: ref("result"),
});
