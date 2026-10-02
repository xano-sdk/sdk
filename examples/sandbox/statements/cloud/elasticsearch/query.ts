/**
 * `s.cloud.elasticsearch.query` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `key_id`, `access_key`, `base_url`, `index` and `payload` are REQUIRED — the
 * engine class declares each with no default, and an absent one is filled with
 * an empty value rather than rejected, so the query runs against nothing.
 *
 * `size`, `from`, `sort`, `included_fields` and `expression` stay OPTIONAL on
 * purpose. The class declares `size?=null` and then `from` bare — two halves of
 * one paging pair — and the list fields' absent state is the empty list. Those
 * are upstream shape, not requirements.
 *
 * `expression` and `sort` are stored LAST, after `return_type`, which is what
 * the editor writes even though the class declares them mid-schema. The input
 * list is positional, so that order is load-bearing.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const cloudElasticsearchQuery = defineFunction({
  name: "ex_cloud_elasticsearch_query",
  stack: [
    s.cloud.elasticsearch.query({
      as: "result",
      auth_type: "API Key",
      key_id: env("ELASTIC_KEY_ID"),
      access_key: env("ELASTIC_API_KEY"),
      base_url: c.text("https://my-deployment.es.us-east-1.aws.found.io"),
      index: c.text("products"),
      payload: obj({ query: { match_all: {} } }),
      size: c.int(20),
      return_type: "search",
    }),
  ],
  response: ref("result"),
});
