/**
 * `s.datadog.log_bulk` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const datadogLogBulk = defineFunction({
  name: "ex_datadog_log_bulk",
  stack: [
    s.datadog.log_bulk({ entries: c.text("example") }),
  ],
});
