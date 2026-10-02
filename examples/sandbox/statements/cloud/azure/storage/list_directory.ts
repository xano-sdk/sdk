/**
 * `s.cloud.azure.storage.list_directory` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAzureStorageListDirectory = defineFunction({
  name: "ex_cloud_azure_storage_list_directory",
  stack: [
    s.cloud.azure.storage.list_directory({ as: "result", account_name: c.text("example"), account_key: c.text("••••"), container_name: c.text("example"), path: c.text("example") }),
  ],
  response: ref("result"),
});
