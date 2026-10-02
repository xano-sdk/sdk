/**
 * `s.db.bulk.delete` — delete many rows by a `where` search. Binds the deleted
 * count.
 *
 * An absent filter matches EVERY row, so a `where`-less delete is a truncate:
 * it throws unless the wipe is stated with `allRows: true`.
 */
import { defineFunction, s, c, col, ref, expr } from "@xano/sdk";
import { posts } from "../../../_shared.js";

export const dbBulkDelete = defineFunction({
  name: "ex_db_bulk_delete",
  stack: [
    s.db.bulk.delete({ table: posts, where: expr(col("published"), "=", c.bool(false)), as: "deleted" }),
  ],
  response: ref("deleted"),
});
