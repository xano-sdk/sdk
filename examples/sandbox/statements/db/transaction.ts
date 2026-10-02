/**
 * `s.db.transaction` — run a block of statements in a single database
 * transaction (all-or-nothing).
 */
import { defineFunction, s, c, inp, input } from "@xano/sdk";
import { users, posts } from "../../_shared.js";

export const dbTransaction = defineFunction({
  name: "ex_db_transaction",
  input: { email: input.email({ required: true }), title: input.text({ required: true }) },
  stack: [
    s.db.transaction({
      body: [
        s.db.add({ table: users, row: { email: inp("email") }, as: "u" }),
        s.db.add({ table: posts, row: { title: inp("title"), author_id: c.int(1) } }),
      ],
    }),
  ],
});
