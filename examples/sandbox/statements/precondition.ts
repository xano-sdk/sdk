/**
 * `s.precondition` — assert a condition, and raise a **status-bearing** error
 * when it fails. Prefer this over `s.throw`, which returns HTTP 200 with an
 * error body: a client checking `res.ok` reads that as success.
 *
 * `error` takes a plain string for a fixed message (the spelling the editor
 * writes) or a `Value` when the message has to be computed.
 */
import { defineFunction, s, c, inp, expr, input, ref } from "@xano/sdk";

export const precondition = defineFunction({
  name: "ex_precondition",
  input: { qty: input.int({ required: true }) },
  stack: [
    s.precondition({
      expr: expr(inp("qty"), ">", c.int(0)),
      error_type: "badrequest", // → HTTP 400, detectable via `res.ok`
      error: "qty must be greater than zero",
    }),
    s.set_var("accepted", inp("qty")),
  ],
  response: ref("accepted"),
});
