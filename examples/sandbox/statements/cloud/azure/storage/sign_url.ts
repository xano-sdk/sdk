/**
 * `s.cloud.azure.storage.sign_url` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAzureStorageSignUrl = defineFunction({
  name: "ex_cloud_azure_storage_sign_url",
  stack: [
    s.cloud.azure.storage.sign_url({ as: "result", account_name: c.text("example"), account_key: c.text("••••"), container_name: c.text("example"), path: c.text("example"), ttl: c.int(1) }),
  ],
  response: ref("result"),
});
