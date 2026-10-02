/**
 * `s.db.del` — delete a single record by a field match (throws 404 when nothing
 * matches). The bound `as` var holds `null` (not the deleted row).
 */
import { defineFunction, s, inp, input } from "@xano/sdk";
import { users } from "../../_shared.js";

export const dbDel = defineFunction({
  name: "ex_db_del",
  input: { id: input.int({ required: true }) },
  stack: [s.db.del({ table: users, fieldValue: inp("id") })],
});
