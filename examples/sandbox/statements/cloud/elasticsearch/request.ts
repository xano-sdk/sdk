/**
 * `s.cloud.elasticsearch.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `key_id`, `access_key`, `url` and `payload` are REQUIRED — the engine class
 * declares all four with no default, and an absent one is silently filled
 * rather than rejected.
 *
 * Elasticsearch is not AWS and has no `region` — the OpenSearch sibling does.
 * That difference is real in the engine, not an oversight in the catalog.
 */
import { c, defineFunction, env, obj, ref, s } from "@xano/sdk";

export const cloudElasticsearchRequest = defineFunction({
  name: "ex_cloud_elasticsearch_request",
  stack: [
    s.cloud.elasticsearch.request({
      as: "result",
      auth_type: "API Key",
      key_id: env("ELASTIC_KEY_ID"),
      access_key: env("ELASTIC_API_KEY"),
      method: "POST",
      url: c.text("/my-index/_refresh"),
      payload: obj({}),
    }),
  ],
  response: ref("result"),
});
