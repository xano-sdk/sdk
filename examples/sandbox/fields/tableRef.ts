/**
 * `f.tableRef(table, opts?)` — a foreign-key column that links to another
 * table's primary key. (Not `ref` — that is a stack-variable value reference.)
 *
 * An OPTIONAL link ("nobody has claimed this row yet") wants a `0` sentinel —
 * `f.tableRef(users, { required: true, default: 0 })` — not `nullable: true`.
 * The column stores an `int`, and `null` is never a legal match value, so a
 * null foreign key cannot be read back: `s.db.get`/`edit`/`del` on it answer
 * HTTP 400 naming the match argument. `fieldValue: c.int(0)` matches no row and
 * binds `null`, which is the answer the null was reaching for.
 */
import { table, f } from "@xano/sdk";
import { users } from "../_shared.js";

export const fieldTableRef = table({
  name: "ex_field_table_ref",
  schema: {
    owner_id: f.tableRef(users, { required: true }),
  },
});
