/**
 * `s.stream.from_request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `url` is REQUIRED. This statement shares its argument declaration with
 * `s.api.request`, whose `url` the engine declares with no default — so an
 * absent one is not rejected at run time, it streams from nowhere.
 *
 * Same typed field surface as `s.api.request`, minus the description/output
 * envelope: the response is consumed as a stream rather than bound whole.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const streamFromRequest = defineFunction({
  name: "ex_stream_from_request",
  stack: [
    s.stream.from_request({
      as: "result",
      url: c.text("https://example.com/events"),
      method: "GET",
      timeout: c.int(30),
    }),
  ],
  response: ref("result"),
});
