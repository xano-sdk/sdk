/**
 * `s.cloud.azure.storage.get_file_info` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAzureStorageGetFileInfo = defineFunction({
  name: "ex_cloud_azure_storage_get_file_info",
  stack: [
    s.cloud.azure.storage.get_file_info({ as: "result", account_name: c.text("example"), account_key: c.text("••••"), container_name: c.text("example"), filePath: c.text("example") }),
  ],
  response: ref("result"),
});
