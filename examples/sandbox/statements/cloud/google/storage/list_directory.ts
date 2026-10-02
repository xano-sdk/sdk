/**
 * `s.cloud.google.storage.list_directory` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudGoogleStorageListDirectory = defineFunction({
  name: "ex_cloud_google_storage_list_directory",
  stack: [
    s.cloud.google.storage.list_directory({ as: "result", service_account: c.text("example"), bucket: c.text("example"), path: c.text("example") }),
  ],
  response: ref("result"),
});
