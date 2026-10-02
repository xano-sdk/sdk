/**
 * `s.db.get` — fetch a single record by a field match (defaults to `id`).
 *
 * PARAM GATE: the lookup field. Omit `fieldName` to match the primary key `id`,
 * or name a column to match on it. `output` narrows the returned columns.
 *
 * `db.get` binds `null` on a miss (no row matched) rather than throwing, so a
 * response that returns it derives `Row | null` — handle the null path.
 */
import { defineFunction, s, inp, ref, input } from "@xano/sdk";
import { users } from "../../_shared.js";

/** Gate 1 — lookup by primary key (`fieldName` omitted → `id`). */
export const dbGetById = defineFunction({
  name: "ex_db_get_by_id",
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

/**
 * Gate 2 — lookup by a named column, with a narrowed `output` column set.
 *
 * `methods: ["lower"]` normalizes the lookup key AT BIND, so `inp("email")`
 * matches an email stored lowercased. Without it, `Foo@x.com` misses the stored
 * `foo@x.com` row — normalize the key on the input, don't reroll it in the stack.
 */
export const dbGetByEmail = defineFunction({
  name: "ex_db_get_by_email",
  input: { email: input.email({ required: true, methods: ["lower"] }) },
  stack: [
    s.db.get({
      table: users,
      fieldName: "email",
      fieldValue: inp("email"),
      output: ["id", "email", "name"],
      as: "user",
    }),
  ],
  response: ref("user"),
});
