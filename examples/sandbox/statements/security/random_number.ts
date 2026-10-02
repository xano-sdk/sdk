/**
 * `s.security.random_number` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityRandomNumber = defineFunction({
  name: "ex_security_random_number",
  stack: [
    s.security.random_number({ as: "result" }),
  ],
  response: ref("result"),
});
