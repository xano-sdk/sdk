/**
 * `s.cloud.google.storage.delete_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudGoogleStorageDeleteFile = defineFunction({
  name: "ex_cloud_google_storage_delete_file",
  stack: [
    s.cloud.google.storage.delete_file({ as: "result", service_account: c.text("example"), bucket: c.text("example"), filePath: c.text("example") }),
  ],
  response: ref("result"),
});
