/**
 * `s.util.set_header` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const utilSetHeader = defineFunction({
  name: "ex_util_set_header",
  stack: [
    // `duplicates` decides what happens when the header is already set:
    // `"replace"` (the default) overwrites it, `"append"` adds another value.
    s.util.set_header({ value: c.text("x-cache: HIT"), duplicates: "replace" }),
  ],
});
