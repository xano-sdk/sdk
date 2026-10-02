/**
 * `s.db.bulk.patch` — partial-update many rows (each item carries its key).
 * Binds the patched-row list.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";
import { users } from "../../../_shared.js";

export const dbBulkPatch = defineFunction({
  name: "ex_db_bulk_patch",
  stack: [
    s.db.bulk.patch({
      table: users,
      items: c.array([
        { id: 1, votes: 10 },
        { id: 2, votes: 20 },
      ]),
      as: "patched",
    }),
  ],
  response: ref("patched"),
});
