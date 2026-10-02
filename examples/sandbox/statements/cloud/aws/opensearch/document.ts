/**
 * `s.cloud.aws.opensearch.document` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `key_id`, `access_key`, `region`, `base_url`, `index`, `doc_id` and `doc` are
 * all REQUIRED — the engine class declares every one of them with no default.
 * This surface addresses a single document, so an absent field is not a
 * narrower query, it is an unaddressed write.
 *
 * `doc` is the document body. Wrap structure in `obj({...})`, which encodes any
 * depth as one constant; a tagged value nested inside a plain object throws at
 * encode.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const cloudAwsOpensearchDocument = defineFunction({
  name: "ex_cloud_aws_opensearch_document",
  stack: [
    s.cloud.aws.opensearch.document({
      as: "result",
      auth_type: "IAM",
      key_id: env("AWS_ACCESS_KEY_ID"),
      access_key: env("AWS_SECRET_ACCESS_KEY"),
      region: c.text("us-east-1"),
      base_url: c.text("https://search-my-domain.us-east-1.es.amazonaws.com"),
      method: "GET",
      index: c.text("products"),
      doc_id: c.text("sku-4242"),
      doc: obj({}),
    }),
  ],
  response: ref("result"),
});
