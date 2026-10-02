/**
 * `s.db.schema` — read a table's schema at a dot-path.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";
import { users } from "../../_shared.js";

export const dbSchema = defineFunction({
  name: "ex_db_schema",
  stack: [s.db.schema({ table: users, path: c.text("email"), as: "colSchema" })],
  response: ref("colSchema"),
});
