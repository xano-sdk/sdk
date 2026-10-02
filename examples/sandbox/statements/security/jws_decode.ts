/**
 * `s.security.jws_decode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, env, inp, input, ref, s } from "@xano/sdk";

export const securityJwsDecode = defineFunction({
  name: "ex_security_jws_decode",
  input: { token: input.text({ required: true }) },
  stack: [
    s.security.jws_decode({
      as: "result",
      token: inp("token"),
      key: env("JWS_KEY"),
      signature_algorithm: "PS256",
    }),
  ],
  response: ref("result"),
});
