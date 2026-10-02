/**
 * `s.db.direct_query` — run raw SQL against the workspace database with
 * positional bind args.
 *
 * PARAM GATE: `responseType` — `"list"` (default) or `"single"`.
 */
import { defineFunction, s, inp, ref, input } from "@xano/sdk";

/** Gate 1 — list result. */
export const dbDirectQueryList = defineFunction({
  name: "ex_db_direct_query_list",
  input: { min_votes: input.int({ required: true }) },
  stack: [
    s.db.direct_query({
      sql: "SELECT id, email FROM users WHERE votes >= ?",
      args: [inp("min_votes")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Gate 2 — single-row result. */
export const dbDirectQuerySingle = defineFunction({
  name: "ex_db_direct_query_single",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.direct_query({
      sql: "SELECT * FROM users WHERE id = ?",
      responseType: "single",
      args: [inp("id")],
      as: "row",
    }),
  ],
  response: ref("row"),
});
