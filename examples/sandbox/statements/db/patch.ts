/**
 * `s.db.patch` — partial-update a record by a field match. `data` is an object
 * value merged onto the row. Binds the full post-patch row.
 */
import { defineFunction, s, c, inp, ref, input } from "@xano/sdk";
import { users } from "../../_shared.js";

export const dbPatch = defineFunction({
  name: "ex_db_patch",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.patch({ table: users, fieldValue: inp("id"), data: c.obj({ name: "Renamed" }), as: "patched" }),
  ],
  response: ref("patched"),
});
