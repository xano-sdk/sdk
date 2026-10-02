/**
 * `s.security.jwe_encode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const securityJweEncode = defineFunction({
  name: "ex_security_jwe_encode",
  stack: [
    s.security.jwe_encode({
      as: "result",
      claims: obj({ sub: c.text("user-1") }),
      key: env("JWE_KEY"),
      key_algorithm: "A128KW",
      content_algorithm: "A128GCM",
    }),
  ],
  response: ref("result"),
});
