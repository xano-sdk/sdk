/**
 * `auth(path?)` — reference the authenticated identity. `auth("id")` is the
 * authenticated row id; bare `auth()` is the whole record. Meaningful on an
 * endpoint whose `auth` names an auth table.
 */
import { defineFunction, s, auth, inp, input } from "@xano/sdk";
import { posts } from "../_shared.js";

export const valueAuth = defineFunction({
  name: "ex_value_auth",
  input: { title: input.text({ required: true }) },
  // Bind the caller as the post's author.
  stack: [s.db.add({ table: posts, row: { title: inp("title"), author_id: auth("id") } })],
});
