/**
 * `s.datadog.log` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `message` is REQUIRED; every other field carries an engine default.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const datadogLog = defineFunction({
  name: "ex_datadog_log",
  stack: [
    s.datadog.log({ message: c.text("checkout completed"), status: "debug" }),
  ],
});
