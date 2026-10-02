/**
 * `s.switch({ on, cases, default })` — a multi-way branch.
 *
 * PARAM GATE: each case's optional `break` controls fall-through, and the
 * engine's default is to FALL THROUGH. A case that omits `break: true` runs its
 * own body and then every LATER case body, and the `default` block as well — so
 * every case here sets it. `export()` warns on a break-less case that has
 * somewhere to fall into.
 */
import { defineFunction, s, c, ref, inp, input } from "@xano/sdk";

export const switchStmt = defineFunction({
  name: "ex_switch",
  input: { role: input.text({ required: true }) },
  stack: [
    s.set_var("label", c.text("")),
    s.switch({
      on: inp("role"),
      cases: [
        { when: c.text("admin"), break: true, body: [s.update_var("label", c.text("Administrator"))] },
        { when: c.text("member"), break: true, body: [s.update_var("label", c.text("Member"))] },
      ],
      default: [s.update_var("label", c.text("Unknown"))],
    }),
  ],
  response: ref("label"),
});
