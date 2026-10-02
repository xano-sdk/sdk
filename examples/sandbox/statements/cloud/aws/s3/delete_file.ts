/**
 * `s.cloud.aws.s3.delete_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAwsS3DeleteFile = defineFunction({
  name: "ex_cloud_aws_s3_delete_file",
  stack: [
    s.cloud.aws.s3.delete_file({ as: "result", bucket: c.text("example"), region: c.text("example"), key: c.text("••••"), secret: c.text("••••"), file_key: c.text("••••") }),
  ],
  response: ref("result"),
});
