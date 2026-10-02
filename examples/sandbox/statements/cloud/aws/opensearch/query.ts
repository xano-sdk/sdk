/**
 * `s.cloud.aws.opensearch.query` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `key_id`, `access_key`, `region`, `base_url`, `index` and `payload` are
 * REQUIRED — the engine class declares each with no default, and an absent one
 * is filled with an empty value rather than rejected.
 *
 * `region` is the one field this surface has and the Elasticsearch sibling does
 * not: OpenSearch is AWS-hosted and its requests are SigV4-signed for a region.
 *
 * `size`, `from`, `sort`, `included_fields` and `expression` stay OPTIONAL —
 * see the Elasticsearch sibling for why.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const cloudAwsOpensearchQuery = defineFunction({
  name: "ex_cloud_aws_opensearch_query",
  stack: [
    s.cloud.aws.opensearch.query({
      as: "result",
      auth_type: "IAM",
      key_id: env("AWS_ACCESS_KEY_ID"),
      access_key: env("AWS_SECRET_ACCESS_KEY"),
      region: c.text("us-east-1"),
      base_url: c.text("https://search-my-domain.us-east-1.es.amazonaws.com"),
      index: c.text("products"),
      payload: obj({ query: { match_all: {} } }),
      size: c.int(20),
      return_type: "search",
    }),
  ],
  response: ref("result"),
});
