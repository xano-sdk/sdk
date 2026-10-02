/**
 * `s.db.has` — test whether a record exists by a field match. Binds a boolean.
 */
import { defineFunction, s, inp, ref, input } from "@xano/sdk";
import { users } from "../../_shared.js";

export const dbHas = defineFunction({
  name: "ex_db_has",
  input: { email: input.email({ required: true }) },
  stack: [s.db.has({ table: users, fieldName: "email", fieldValue: inp("email"), as: "exists" })],
  response: ref("exists"),
});
