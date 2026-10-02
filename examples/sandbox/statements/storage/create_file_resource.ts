/**
 * `s.storage.create_file_resource` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const storageCreateFileResource = defineFunction({
  name: "ex_storage_create_file_resource",
  stack: [
    s.storage.create_file_resource({ as: "result", filename: c.text("example"), filedata: c.text("example") }),
  ],
  response: ref("result"),
});
