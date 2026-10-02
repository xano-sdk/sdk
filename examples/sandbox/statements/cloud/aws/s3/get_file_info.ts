/**
 * `s.cloud.aws.s3.get_file_info` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAwsS3GetFileInfo = defineFunction({
  name: "ex_cloud_aws_s3_get_file_info",
  stack: [
    s.cloud.aws.s3.get_file_info({ as: "result", bucket: c.text("example"), region: c.text("example"), key: c.text("••••"), secret: c.text("••••"), file_key: c.text("••••") }),
  ],
  response: ref("result"),
});
