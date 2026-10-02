/**
 * `s.security.create_password` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityCreatePassword = defineFunction({
  name: "ex_security_create_password",
  stack: [
    s.security.create_password({ as: "result" }),
  ],
  response: ref("result"),
});
