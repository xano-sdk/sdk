/**
 * `out(name)` — reference a column of the parent statement's output row
 * (`$output.<col>`). Only meaningful inside an addon spec's `input` map (a
 * `db.query` `addon`), where the engine resolves it against each parent row.
 */
import { defineFunction, s, out, ref } from "@xano/sdk";

export const valueOut = defineFunction({
  name: "ex_value_out",
  // Shown standalone; in practice this feeds an addon `input: { user_id: out("id") }`.
  stack: [s.set_var("parentId", out("id"))],
  response: ref("parentId"),
});
