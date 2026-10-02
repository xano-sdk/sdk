/**
 * `s.cloud.elasticsearch.document` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudElasticsearchDocument = defineFunction({
  name: "ex_cloud_elasticsearch_document",
  stack: [
    s.cloud.elasticsearch.document({ as: "result", auth_type: "API Key", key_id: c.text("••••"), access_key: c.text("••••"), base_url: c.text("example"), index: c.text("example"), method: "GET", doc_id: c.text("example"), doc: c.obj({}) }),
  ],
  response: ref("result"),
});
