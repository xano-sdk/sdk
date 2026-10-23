/**
 * `s.security.create_rsa_key` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const securityCreateRsaKey = defineFunction({
  name: "ex_security_create_rsa_key",
  stack: [
    // Without `bits` the engine generates a 1024-bit key; 2048 is the safe floor.
    s.security.create_rsa_key({ as: "result", format: "object", bits: c.int(2048) }),
  ],
  response: ref("result"),
});
