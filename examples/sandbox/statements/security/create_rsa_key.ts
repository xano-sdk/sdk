/**
 * `s.security.create_rsa_key` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityCreateRsaKey = defineFunction({
  name: "ex_security_create_rsa_key",
  stack: [
    s.security.create_rsa_key({ as: "result", format: "object" }),
  ],
  response: ref("result"),
});
