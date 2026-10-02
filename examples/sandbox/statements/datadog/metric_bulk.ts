/**
 * `s.datadog.metric_bulk` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const datadogMetricBulk = defineFunction({
  name: "ex_datadog_metric_bulk",
  stack: [
    s.datadog.metric_bulk({ entries: c.text("example") }),
  ],
});
