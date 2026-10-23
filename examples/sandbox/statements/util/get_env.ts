/**
 * `s.util.get_env` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

// `s.util.get_env` returns EVERY environment variable as one object — secrets
// included — so returning the whole binding would ship them all to the caller
// (the `stack.env-secret-in-response` guard). Pick off the one key you need and
// return that; for a single value, `env("GREETING")` is the more direct read.
export const utilGetEnv = defineFunction({
  name: "ex_util_get_env",
  stack: [
    s.util.get_env({ as: "result" }),
  ],
  response: ref("result.GREETING"),
});
