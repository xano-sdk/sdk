/**
 * `s.db.add_or_edit` — upsert: edit the matched row if it exists, else insert.
 * Binds the full upserted row.
 *
 * Normalize on the input, not in the stack: `methods` run at bind, before the
 * stack, so `inp("email")`/`inp("name")` below are ALREADY lowercased/trimmed —
 * no `var $email_norm = inp("email")|to_lower` reroll needed. `input.email`
 * trims + 400s on a malformed address on its own; `methods: ["lower"]` downcases
 * so the match key is stable.
 */
import { defineFunction, s, inp, ref, input } from "@xano/sdk";
import { users } from "../../_shared.js";

export const dbAddOrEdit = defineFunction({
  name: "ex_db_add_or_edit",
  input: {
    email: input.email({ required: true, methods: ["lower"] }),
    name: input.text({ methods: ["trim"] }),
  },
  stack: [
    s.db.add_or_edit({
      table: users,
      fieldName: "email",
      fieldValue: inp("email"),
      row: { email: inp("email"), name: inp("name") },
      as: "upserted",
    }),
  ],
  response: ref("upserted"),
});
