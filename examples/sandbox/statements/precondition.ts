/**
 * `s.precondition` — assert a condition, and raise a **status-bearing** error
 * when it fails. Prefer this over `s.throw`, which returns HTTP 200 with an
 * error body: a client checking `res.ok` reads that as success.
 *
 * `error` is a VALUE: `c.text("…")` for a fixed message, or any computed
 * `Value`. A bare string is dropped by the engine (the client gets "Precondition
 * failed."), and export warns `stack.precondition-bare-error`.
 */
import { defineFunction, s, c, inp, expr, input, ref } from "@xano/sdk";

export const precondition = defineFunction({
  name: "ex_precondition",
  input: { qty: input.int({ required: true }) },
  stack: [
    s.precondition({
      expr: expr(inp("qty"), ">", c.int(0)),
      error_type: "badrequest", // → HTTP 400, detectable via `res.ok`
      error: c.text("qty must be greater than zero"),
    }),
    s.set_var("accepted", inp("qty")),
  ],
  response: ref("accepted"),
});
