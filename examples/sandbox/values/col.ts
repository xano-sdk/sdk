/**
 * `col(name)` — reference a table column. Only meaningful inside a `db.query`
 * `where`/view comparison (in a `db.add`/`db.edit` `row` it resolves to null —
 * the type rejects it there).
 */
import { defineFunction, s, c, col, ref, expr } from "@xano/sdk";
import { posts } from "../_shared.js";

export const valueCol = defineFunction({
  name: "ex_value_col",
  stack: [s.db.query({ table: posts, where: expr(col("score"), ">", c.int(10)), as: "rows" })],
  response: ref("rows"),
});
