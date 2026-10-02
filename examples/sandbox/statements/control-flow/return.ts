/**
 * `s.return(value)` — terminate the stack and return a value.
 *
 * Two facts worth having in one place, both live-verified:
 *
 *  - `s.return` DOES carry its value out. A stack that ends in one answers with
 *    that value even when no `response` is declared.
 *  - Declaring `response` anyway is what makes the shape KNOWN — the stored
 *    response envelope is what `InferResponse`, a typed frontend, and codegen
 *    read, and a bare `s.return` leaves it empty.
 *
 * Where both exist, whichever executes wins: the early return below fires only
 * when its condition holds, and the declared response applies otherwise.
 */
import { defineFunction, s, c, ref, inp, input, expr } from "@xano/sdk";

export const returnStmt = defineFunction({
  name: "ex_return",
  input: { early: input.bool() },
  stack: [
    s.set_var("status", c.text("started")),
    // Fires only when `early` is true → the function answers "returned-early".
    s.conditional({
      when: expr(inp("early"), "=", c.bool(true)),
      then: [s.return(c.text("returned-early"))],
    }),
    s.set_var("status", c.text("ran-to-the-end")),
  ],
  // Reached when the early return does not fire → "ran-to-the-end".
  response: ref("status"),
});
