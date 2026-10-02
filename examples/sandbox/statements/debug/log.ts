/**
 * `s.debug.log` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const debugLog = defineFunction({
  name: "ex_debug_log",
  stack: [
    s.debug.log({ value: c.text("example") }),
  ],
});
