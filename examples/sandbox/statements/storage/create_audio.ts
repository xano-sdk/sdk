/**
 * `s.storage.create_audio` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const storageCreateAudio = defineFunction({
  name: "ex_storage_create_audio",
  stack: [
    s.storage.create_audio({ as: "result", value: c.text("example"), access: "public" }), // stated rather than inherited — `access` defaults to public
  ],
  response: ref("result"),
});
