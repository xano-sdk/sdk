/**
 * `s.security.check_password` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

export const securityCheckPassword = defineFunction({
  name: "ex_security_check_password",
  input: { password: input.text({ required: true }) },
  stack: [
    s.security.check_password({
      as: "result",
      text_password: inp("password"),
      hash_password: c.text("<stored bcrypt hash>"),
    }),
  ],
  response: ref("result"),
});
