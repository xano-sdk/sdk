/**
 * `c.null(...)` — a constant null value (c.null → tagged constant).
 *
 * Bare `c.null()` is the plain `const:null`. `c.null("const:obj")` is the
 * OBJECT-TYPED null the engine writes into a `db.*` statement's `@meta` slot —
 * distinct stored bytes from the blank object `c.obj(null)` writes, though both
 * evaluate to null.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const constNull = defineFunction({
  name: "ex_value_const_null",
  stack: [s.set_var("v", c.null()), s.set_var("objNull", c.null("const:obj"))],
  response: ref("v"),
});
