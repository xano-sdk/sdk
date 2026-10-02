/**
 * `s.cloud.aws.s3.list_directory` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAwsS3ListDirectory = defineFunction({
  name: "ex_cloud_aws_s3_list_directory",
  stack: [
    s.cloud.aws.s3.list_directory({ as: "result", bucket: c.text("example"), region: c.text("example"), key: c.text("••••"), secret: c.text("••••"), prefix: c.text("example"), next_page_token: c.text("••••") }),
  ],
  response: ref("result"),
});
