/**
 * `s.db.add` — insert a record. Binds the full inserted row (with `id`/`created_at`).
 *
 * PARAM GATE: the row payload. Use the ergonomic `row: {...}` partial (expanded
 * against the table's columns) or the explicit `data: [{ name, value }]` entries
 * for byte-exact control over each field.
 */
import { defineFunction, s, c, inp, ref, input } from "@xano/sdk";
import { users } from "../../_shared.js";

/**
 * Gate 1 — ergonomic `row` (expanded against the table schema).
 *
 * A cell takes a tagged value, or a bare JS literal typed against that column:
 * `verified: false` is exactly `c.bool(false)` and `role: "member"` is exactly
 * `c.text("member")`. The tag comes from the COLUMN, so the literal is checked
 * against it — `verified: "no"` is a compile error, and `role` keeps the enum's
 * member union. Reach for `c.*` when you want a tag the column does not imply.
 */
export const dbAddRow = defineFunction({
  name: "ex_db_add_row",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add({
      table: users,
      row: { email: inp("email"), name: inp("name"), verified: false, role: "member" },
      as: "created",
    }),
  ],
  response: ref("created"),
});

/**
 * Gate 3 — `output` restricts the columns of the RETURNED row. It does NOT
 * change what is written: every column in `row` is still inserted, the response
 * just carries the listed ones. `InferRow` narrows to match, so `created` here
 * is typed `{ id, email }` and reading `created.name` is a compile error.
 *
 * This is the surface for not handing a caller back columns it should not see
 * (a password hash, an internal flag) on the write that created them.
 * The same `output` is available on `s.db.edit` and `s.db.patch`.
 */
export const dbAddOutput = defineFunction({
  name: "ex_db_add_output",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add({
      table: users,
      row: { email: inp("email"), name: inp("name") },
      output: ["id", "email"],
      as: "created",
    }),
  ],
  response: ref("created"),
});

/**
 * Gate 4 — the two cells whose right spelling is the short one.
 *
 * An `f.password()` cell takes the PLAINTEXT: the column hashes it on write, so
 * hashing it here (or piping the cell through a hashing filter) would store a
 * hash of a hash and `s.security.check_password` could never match it. Take the
 * submission as `input.text()` for the same reason — `input.password()` hashes
 * on bind, which is the other half of the same double-hash.
 *
 * An explicit `null` is a write OF null, accepted on every column — including
 * ones that refuse every other bare literal. It is not the same as leaving the
 * key out, which takes the column's type default here on `add` (and leaves the
 * stored value alone on `edit`).
 */
export const dbAddSignup = defineFunction({
  name: "ex_db_add_signup",
  input: { email: input.email({ required: true }), password: input.text({ required: true }) },
  stack: [
    s.db.add({
      table: users,
      row: { email: inp("email"), password: inp("password"), bio: null },
      output: ["id", "email"],
      as: "created",
    }),
  ],
  response: ref("created"),
});

/** Gate 2 — explicit `data` entries (full control over each field + `ignore`). */
export const dbAddData = defineFunction({
  name: "ex_db_add_data",
  stack: [
    s.db.add({
      table: users,
      data: [
        { name: "email", value: c.text("new@example.com") },
        { name: "votes", value: c.int(0) },
      ],
      as: "created",
    }),
  ],
  response: ref("created"),
});

/**
 * Gate 4 — `enforceHiddenFields` closes the write side of the same door
 * `output` closes on the read side.
 *
 * A row write AUTO-WIRES any column whose name matches an incoming request
 * input. That is the convenience that makes `s.db.add({ table, data: [] })`
 * work at all — and it is also how a caller can reach a column the endpoint
 * never meant to accept, by posting a field nobody declared. Turning this on
 * makes the engine consult the endpoint's declared inputs and skip auto-wiring
 * anything outside them. Explicit `row`/`data` entries are unaffected: those are
 * bindings you wrote.
 *
 * It is OFF by default, because that is the engine's default — so reach for it
 * on any write whose table has a column a caller must not set (`role`,
 * `is_admin`, `credits`).
 */
export const dbAddEnforceHiddenFields = defineFunction({
  name: "ex_db_add_enforce_hidden_fields",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add({
      table: users,
      row: { email: inp("email"), name: inp("name") },
      enforceHiddenFields: true,
      as: "created",
    }),
  ],
  response: ref("created"),
});
