/**
 * `s.db.increment` — add to a numeric column on every row a `where` matches, in
 * one atomic UPDATE. The race-free counter: `db.get` → math → `db.edit` loses
 * updates when two requests overlap.
 *
 * A guard in the `where` is re-checked under the row lock, so this decrements
 * only while stock remains. `returnType: "count"` binds how many rows changed —
 * 0 here means the post was sold out.
 */
import { defineFunction, input, s, c, col, inp, ref, expr, and } from "@xano/sdk";
import { posts } from "../../_shared.js";

export const dbIncrement = defineFunction({
  name: "ex_db_increment",
  input: { post_id: input.int({ required: true }) },
  stack: [
    s.db.increment({
      table: posts,
      where: and(expr(col("id"), "=", inp("post_id")), expr(col("score"), ">=", c.int(1))),
      fieldName: "score",
      value: -1,
      returnType: "count",
      as: "changed",
    }),
  ],
  response: ref("changed"),
});
