/**
 * `cond.*` — the everyday predicates a RUNTIME condition cannot spell.
 *
 * `s.conditional`/`s.while`/`s.precondition` evaluate through the engine's own
 * comparison evaluator, which knows eight operators: `= != === !== > < >= <=`.
 * The wider `cmp()` set — `in`, `like`, `between`, `contains` — compiles to SQL
 * and resolves only inside a database query's `where`, so writing one here
 * deploys clean and then fails the request.
 *
 * `cond.*` builds the form that does work (pipe through a filter, compare the
 * boolean it yields) and handles the operand direction, which is the part that
 * bites: the engine's `in` filter takes the ARRAY as its piped value and the
 * needle as its argument — the reverse of `contains`/`starts_with`.
 */
import { defineFunction, s, c, cond, inp, ref, input, obj } from "@xano/sdk";

export const valueCond = defineFunction({
  name: "ex_value_cond",
  input: { role: input.text(), title: input.text(), score: input.int() },
  stack: [
    s.set_var("allowed", c.array(["admin", "editor"])),
    // Membership. NOT `cmp(inp("role"), "in", ref("allowed"))` — that operator is
    // database-only and fails the request from a conditional.
    s.conditional({
      when: cond.in(inp("role"), ref("allowed")),
      then: [s.set_var("may_edit", c.bool(true))],
      else: [s.set_var("may_edit", c.bool(false))],
    }),
    s.conditional({
      when: cond.startsWith(inp("title"), c.text("DRAFT:")),
      then: [s.set_var("is_draft", c.bool(true))],
      else: [s.set_var("is_draft", c.bool(false))],
    }),
    // Inclusive at both ends. Expands to two ANDed comparisons, because the
    // runtime `between` filter does not resolve in a value pipeline at all.
    s.conditional({
      when: cond.between(inp("score"), c.int(1), c.int(10)),
      then: [s.set_var("in_range", c.bool(true))],
      else: [s.set_var("in_range", c.bool(false))],
    }),
    // `empty` is the engine's sense of empty — "", null, 0, "0", false, [], {} —
    // which is wider than null. Use `cond.isNull` when you mean only absent.
    s.precondition({
      expr: cond.notEmpty(inp("title")),
      error_type: "inputerror",
      error: c.text("A title is required."),
    }),
  ],
  response: obj({
    may_edit: ref("may_edit"),
    is_draft: ref("is_draft"),
    in_range: ref("in_range"),
  }),
});
