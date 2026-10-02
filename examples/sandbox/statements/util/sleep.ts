/**
 * `s.util.sleep` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const utilSleep = defineFunction({
  name: "ex_util_sleep",
  stack: [
    s.util.sleep({ value: c.text("example") }),
  ],
});
