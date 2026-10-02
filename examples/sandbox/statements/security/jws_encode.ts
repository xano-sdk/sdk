/**
 * `s.security.jws_encode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const securityJwsEncode = defineFunction({
  name: "ex_security_jws_encode",
  stack: [
    s.security.jws_encode({
      as: "result",
      claims: obj({ sub: c.text("user-1") }),
      key: env("JWS_KEY"),
      signature_algorithm: "PS256",
    }),
  ],
  response: ref("result"),
});
