/**
 * `disabled` / `description` — the two annotations every statement accepts.
 *
 * They annotate the stack ITEM rather than argue the statement, so they are
 * optional arguments on all of them: inline on the object-arg factories, and a
 * trailing options object on the positional specials.
 *
 * `disabled: true` is Xano's commented-out state — the step stays in the stack
 * and the engine skips it. `description` is the note shown beside the step in
 * the editor. Both default to absent.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const annotations = defineFunction({
  name: "ex_annotations",
  stack: [
    // Positional special → trailing options object.
    s.set_var("total", c.int(0), { description: "running total, filled in below" }),
    // Object-arg factory → inline.
    s.math.add({
      name: "total",
      value: c.int(41),
      description: "the interesting step",
    }),
    // Kept in the stack, skipped at runtime — not deleted.
    s.math.add({
      name: "total",
      value: c.int(1000),
      disabled: true,
      description: "spike from the old pricing model; re-enable when it ships",
    }),
    s.math.add({ name: "total", value: c.int(1) }),
  ],
  response: ref("total"),
});
