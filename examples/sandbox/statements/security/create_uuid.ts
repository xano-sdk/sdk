/**
 * `s.security.create_uuid` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityCreateUuid = defineFunction({
  name: "ex_security_create_uuid",
  stack: [
    s.security.create_uuid({ as: "result" }),
  ],
  response: ref("result"),
});
