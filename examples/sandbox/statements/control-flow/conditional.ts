/**
 * `s.conditional` — an `if (when) { then } [else if …] else { else }` branch.
 *
 * PARAM GATE: `elif`/`else` are optional; `when` is any condition
 * (`expr`/`cmp`/`and`/`or`). Each export shows one gate.
 */
import { defineFunction, s, c, ref, expr, cmp, and, or } from "@xano/sdk";

/** Gate 1 — `then` only (no else branch). */
export const conditionalThenOnly = defineFunction({
  name: "ex_conditional_then_only",
  stack: [
    s.set_var("n", c.int(3)),
    s.conditional({
      when: expr(ref("n"), ">", c.int(0)),
      then: [s.set_var("sign", c.text("positive"))],
    }),
  ],
  response: ref("sign"),
});

/** Gate 2 — `then` + `else`. */
export const conditionalThenElse = defineFunction({
  name: "ex_conditional_then_else",
  stack: [
    s.set_var("n", c.int(-3)),
    s.conditional({
      when: expr(ref("n"), ">=", c.int(0)),
      then: [s.set_var("sign", c.text("positive"))],
      else: [s.set_var("sign", c.text("negative"))],
    }),
  ],
  response: ref("sign"),
});

/** Gate 3 — `elif` chain: an ordered stack of else-if branches, then `else`. */
export const conditionalElifChain = defineFunction({
  name: "ex_conditional_elif_chain",
  stack: [
    s.set_var("score", c.int(72)),
    s.conditional({
      when: expr(ref("score"), ">=", c.int(90)),
      then: [s.set_var("grade", c.text("A"))],
      elif: [
        { when: expr(ref("score"), ">=", c.int(80)), then: [s.set_var("grade", c.text("B"))] },
        { when: expr(ref("score"), ">=", c.int(70)), then: [s.set_var("grade", c.text("C"))] },
      ],
      else: [s.set_var("grade", c.text("F"))],
    }),
  ],
  response: ref("grade"),
});

/**
 * Gate 4 — a grouped condition: `cmp` composed with `and`/`or`.
 *
 * ⚠ A condition is evaluated by the RUNTIME, which compares with
 * `= != === !== > >= < <=` only. The db-search operators `cmp` also accepts
 * (`in`, `like`, `between`, `contains`, …) are compiled into SQL for a
 * `db.query`/`bulk` `where` and have no runtime form — the SDK refuses them
 * here rather than let the request fail on the branch. Spell membership
 * out with `or(...)`, as below.
 */
export const conditionalGrouped = defineFunction({
  name: "ex_conditional_grouped",
  stack: [
    s.set_var("status", c.text("active")),
    s.set_var("n", c.int(5)),
    s.conditional({
      when: and(
        or(cmp(ref("status"), "===", c.text("active")), cmp(ref("status"), "===", c.text("trial"))),
        or(expr(ref("n"), ">", c.int(0)), expr(ref("n"), "<", c.int(-10))),
      ),
      then: [s.set_var("ok", c.text("yes"))],
      else: [s.set_var("ok", c.text("no"))],
    }),
  ],
  response: ref("ok"),
});
