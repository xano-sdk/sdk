/**
 * `s.cloud.algolia.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const cloudAlgoliaRequest = defineFunction({
  name: "ex_cloud_algolia_request",
  stack: [
    s.cloud.algolia.request({ as: "result", application_id: c.text("example"), api_key: c.text("••••"), url: c.text("example"), method: "POST", payload: c.obj({}) }),
  ],
  response: ref("result"),
});
