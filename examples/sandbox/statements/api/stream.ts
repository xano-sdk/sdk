/**
 * `s.api.stream` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const apiStream = defineFunction({
  name: "ex_api_stream",
  stack: [
    s.api.stream({ value: c.text("example") }),
  ],
});
