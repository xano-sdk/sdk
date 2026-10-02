/**
 * `s.debug.stop` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const debugStop = defineFunction({
  name: "ex_debug_stop",
  stack: [
    s.debug.stop({ value: c.text("example") }),
  ],
});
