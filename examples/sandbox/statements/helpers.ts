/**
 * `statements(...)` — factoring a repeated statement sequence into a helper
 * WITHOUT losing the response type.
 *
 * `InferResponse` traces the variable a `response` names by walking the stack's
 * TUPLE type. A helper that emits more than one statement has to return an
 * array, and an array typed `Statement[]` widens the caller's stack when it is
 * spread in — from that point NOTHING in the stack is traceable, including
 * bindings declared after the spread. The response then types as
 * `StackTupleWidened`, which says so by name.
 *
 * `statements(...)` is a const-generic identity: it returns its arguments
 * verbatim (no encoder involvement) while keeping the tuple, so the spread is
 * transparent to the trace.
 *
 * FIXED ARITY only — a helper that builds its array in a loop cannot be a tuple.
 * Declare `responseShape` on the calling def in that case.
 */
import { defineFunction, statements, s, c, expr, ref } from "@xano/sdk";

/** A shared guard: compute a flag, then refuse the request when it is false. */
function assertPositive(varName: string, label: string) {
  return statements(
    s.set_var(`${varName}_ok`, c.bool(true)),
    s.precondition({
      expr: expr(ref(`${varName}_ok`), "==", c.bool(true)),
      error_type: "badrequest",
      error: `${label} must be positive`,
    }),
  );
}

export const helperSpread = defineFunction({
  name: "ex_statements_helper",
  stack: [
    s.set_var("total", c.int(41)),
    // Spread transparently — `total` below is still traced.
    ...assertPositive("total", "total"),
    s.math.add({ name: "total", value: c.int(1) }),
  ],
  response: ref("total"),
});
