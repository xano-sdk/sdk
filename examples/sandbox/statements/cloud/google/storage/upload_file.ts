/**
 * `s.cloud.google.storage.upload_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudGoogleStorageUploadFile = defineFunction({
  name: "ex_cloud_google_storage_upload_file",
  stack: [
    s.cloud.google.storage.upload_file({ as: "result", service_account: c.text("example"), bucket: c.text("example"), filePath: c.text("example"), file: c.text("example"), metadata: c.obj({}) }),
  ],
  response: ref("result"),
});
