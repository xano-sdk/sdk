/**
 * `s.cloud.google.storage.get_file_info` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudGoogleStorageGetFileInfo = defineFunction({
  name: "ex_cloud_google_storage_get_file_info",
  stack: [
    s.cloud.google.storage.get_file_info({ as: "result", service_account: c.text("example"), bucket: c.text("example"), filePath: c.text("example") }),
  ],
  response: ref("result"),
});
