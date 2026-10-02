/**
 * `s.security.decrypt` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `data`, `key` and `iv` are REQUIRED — the engine class declares all three with
 * no default.
 *
 * The IV comes back from wherever the ciphertext was stored, NOT from a fixed
 * setting: `s.security.encrypt` generates a fresh one per message, so decrypt
 * has to be handed the one that message was sealed with. Algorithm and key must
 * match that call too.
 *
 * See `s.security.encrypt` for why the key lives in `env()` and what that does
 * and does not keep out of an exported bundle.
 */
import { defineFunction, env, inp, input, ref, s } from "@xano/sdk";

export const securityDecrypt = defineFunction({
  name: "ex_security_decrypt",
  input: {
    ciphertext: input.text({ required: true }),
    iv: input.text({ required: true }),
  },
  stack: [
    s.security.decrypt({
      as: "result",
      data: inp("ciphertext"),
      algorithm: "aes-256-gcm",
      key: env("ENCRYPTION_KEY"),
      iv: inp("iv"),
    }),
  ],
  response: ref("result"),
});
