/**
 * `s.security.encrypt` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `data`, `key` and `iv` are REQUIRED — the engine class declares all three with
 * no default.
 *
 * The IV is generated PER CALL and returned beside the ciphertext. Under GCM a
 * nonce must never repeat for a given key: two messages sharing one nonce XOR to
 * the XOR of their plaintexts, and the reuse also exposes the authentication
 * subkey, which lets an attacker forge tags. An IV is not secret — it only has
 * to be unique — so store it with the ciphertext and read it back to decrypt.
 *
 * The KEY is the part to keep out of the stack. `env()` compiles to the variable
 * NAME and resolves on the instance at request time, so no key literal appears
 * in the statement. Note that a value set through `workspaceConfig({ env })` is
 * still written into the exported bundle, so source it from `process.env` and
 * treat a bundle carrying real values as secret material.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const securityEncrypt = defineFunction({
  name: "ex_security_encrypt",
  stack: [
    s.security.random_bytes({ as: "iv", length: c.int(12) }),
    s.security.encrypt({
      as: "ciphertext",
      data: c.text("card ending 4242"),
      algorithm: "aes-256-gcm",
      key: env("ENCRYPTION_KEY"),
      iv: ref("iv"),
    }),
  ],
  response: obj({ ciphertext: ref("ciphertext"), iv: ref("iv") }),
});
