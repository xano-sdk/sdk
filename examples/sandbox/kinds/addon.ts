/**
 * `addon({...})` — a reusable db-bound enrichment (payload key `addon`) that a
 * `db.query`/`db.get` grafts onto returned rows. It has a db context + `output`,
 * NOT a statement stack.
 */
import { addon } from "@xano/sdk";
import { users } from "../_shared.js";

export const authorAddon = addon({
  name: "ex_kind_author_addon",
  table: users,
  output: ["id", "name", "email"],
});
