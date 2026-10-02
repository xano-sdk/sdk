/**
 * `s.security.jwe_decode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, env, inp, input, ref, s } from "@xano/sdk";

export const securityJweDecode = defineFunction({
  name: "ex_security_jwe_decode",
  input: { token: input.text({ required: true }) },
  stack: [
    s.security.jwe_decode({
      as: "result",
      token: inp("token"),
      key: env("JWE_KEY"),
      key_algorithm: "A128KW",
      content_algorithm: "A128GCM",
    }),
  ],
  response: ref("result"),
});
