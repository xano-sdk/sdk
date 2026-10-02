/**
 * `s.stream.from_csv` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const streamFromCsv = defineFunction({
  name: "ex_stream_from_csv",
  stack: [
    s.stream.from_csv({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
