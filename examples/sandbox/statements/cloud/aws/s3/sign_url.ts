/**
 * `s.cloud.aws.s3.sign_url` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAwsS3SignUrl = defineFunction({
  name: "ex_cloud_aws_s3_sign_url",
  stack: [
    s.cloud.aws.s3.sign_url({ as: "result", bucket: c.text("example"), region: c.text("example"), key: c.text("••••"), secret: c.text("••••"), file_key: c.text("••••") }),
  ],
  response: ref("result"),
});
