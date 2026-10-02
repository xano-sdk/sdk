/**
 * `s.db.truncate` — empty a table.
 *
 * PARAM GATE: `reset` resets the auto-increment counters.
 */
import { defineFunction, s } from "@xano/sdk";
import { posts } from "../../_shared.js";

/** Gate 1 — empty the table, keep the id counter. */
export const dbTruncate = defineFunction({
  name: "ex_db_truncate",
  stack: [s.db.truncate({ table: posts })],
});

/** Gate 2 — empty the table and reset the id counter. */
export const dbTruncateReset = defineFunction({
  name: "ex_db_truncate_reset",
  stack: [s.db.truncate({ table: posts, reset: true })],
});
