/**
 * `s.cloud.aws.opensearch.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `key_id`, `access_key`, `region`, `url` and `query` are REQUIRED — the engine
 * class declares all five with no default. An absent one is not rejected at run
 * time; it is filled with an empty value and the request goes out unsigned or
 * unaddressed.
 *
 * Credentials come from `env()`, which compiles to the variable NAME and
 * resolves on the instance at request time, so no secret appears in the
 * statement. `url` is the path within the domain, not a full URL — `base_url`
 * is a separate field on the query/document surfaces.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const cloudAwsOpensearchRequest = defineFunction({
  name: "ex_cloud_aws_opensearch_request",
  stack: [
    s.cloud.aws.opensearch.request({
      as: "result",
      auth_type: "IAM",
      key_id: env("AWS_ACCESS_KEY_ID"),
      access_key: env("AWS_SECRET_ACCESS_KEY"),
      region: c.text("us-east-1"),
      method: "GET",
      url: c.text("/_cluster/health"),
      query: obj({}),
    }),
  ],
  response: ref("result"),
});
