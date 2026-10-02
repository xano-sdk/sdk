/**
 * `s.db.bulk.update` — a full-row REPLACE, one item per row.
 *
 * Every column an item omits is written to its ZERO value (`""`, `0`, `null`),
 * not left alone, and the request still returns HTTP 200. So each item here
 * carries every writable column deliberately. `export()` warns if one does not.
 *
 * If you mean "change these fields and leave the rest", that is
 * `s.db.bulk.patch` — see the sibling example.
 */
import { defineFunction, s, c } from "@xano/sdk";
import { users } from "../../../_shared.js";

export const dbBulkUpdate = defineFunction({
  name: "ex_db_bulk_update",
  stack: [
    s.db.bulk.update({
      table: users,
      items: c.array([
        {
          id: 1,
          email: "a@example.com",
          name: "Ada",
          votes: 5,
          password: "",
          role: "member",
          verified: true,
          bio: "",
        },
      ]),
    }),
  ],
});
