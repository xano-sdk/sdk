/**
 * `s.stream.from_jsonl` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const streamFromJsonl = defineFunction({
  name: "ex_stream_from_jsonl",
  stack: [
    s.stream.from_jsonl({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
