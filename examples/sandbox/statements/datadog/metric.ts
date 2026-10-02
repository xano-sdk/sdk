/**
 * `s.datadog.metric` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `metric` names the series and is REQUIRED.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const datadogMetric = defineFunction({
  name: "ex_datadog_metric",
  stack: [
    s.datadog.metric({ metric: c.text("checkout.completed"), value: c.text("example"), type: "count" }),
  ],
});
