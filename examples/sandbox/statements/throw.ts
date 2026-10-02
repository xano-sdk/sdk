/**
 * `s.throw` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const throwStmt = defineFunction({
  name: "ex_throw",
  stack: [
    s.throw({ value: c.text("example") }),
  ],
});
