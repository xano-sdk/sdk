/**
 * `s.cloud.azure.storage.delete_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAzureStorageDeleteFile = defineFunction({
  name: "ex_cloud_azure_storage_delete_file",
  stack: [
    s.cloud.azure.storage.delete_file({ as: "result", account_name: c.text("example"), account_key: c.text("••••"), container_name: c.text("example"), filePath: c.text("example") }),
  ],
  response: ref("result"),
});
