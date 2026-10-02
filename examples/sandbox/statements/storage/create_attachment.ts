/**
 * `s.storage.create_attachment` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const storageCreateAttachment = defineFunction({
  name: "ex_storage_create_attachment",
  stack: [
    s.storage.create_attachment({ as: "result", value: c.text("example"), access: "private" }), // an attachment is usually user-scoped, so keep it private
  ],
  response: ref("result"),
});
