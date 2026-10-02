/**
 * `s.storage.sign_private_url` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const storageSignPrivateUrl = defineFunction({
  name: "ex_storage_sign_private_url",
  stack: [
    s.storage.sign_private_url({ as: "result", pathname: c.text("example") }),
  ],
  response: ref("result"),
});
