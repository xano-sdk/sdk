/**
 * `s.db.bulk.add` — insert many rows at once.
 *
 * PARAM GATE: `allowIdField` permits explicit `id` values in the rows. Leave it
 * unset and the engine DISCARDS every `id`, assigning the next sequence value
 * instead — silently. Rows other rows reference by id need `allowIdField: true`.
 */
import { defineFunction, s, c } from "@xano/sdk";
import { users } from "../../../_shared.js";

export const dbBulkAdd = defineFunction({
  name: "ex_db_bulk_add",
  stack: [
    // Engine-assigned ids: no `id` supplied, so the gate is irrelevant.
    s.db.bulk.add({
      table: users,
      items: c.array([{ email: "a@example.com" }, { email: "b@example.com" }]),
    }),
    // Pinned ids: the gate MUST be on, or `id` is dropped and these rows land
    // at whatever the sequence hands out.
    s.db.bulk.add({
      table: users,
      items: c.array([
        { id: 101, email: "c@example.com" },
        { id: 102, email: "d@example.com" },
      ]),
      allowIdField: true,
    }),
  ],
});
