/**
 * `s.cloud.aws.s3.upload_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAwsS3UploadFile = defineFunction({
  name: "ex_cloud_aws_s3_upload_file",
  stack: [
    s.cloud.aws.s3.upload_file({ as: "result", bucket: c.text("example"), region: c.text("example"), key: c.text("••••"), secret: c.text("••••"), file: c.text("example"), metadata: c.obj({}), object_lock_mode: "compliance" }),
  ],
  response: ref("result"),
});
