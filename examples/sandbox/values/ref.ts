/**
 * `ref(name, opts?)` — reference a stack variable (the `as:` output of an
 * earlier statement). `ref` ≠ `f.tableRef` (a foreign key).
 *
 * PARAM GATE: `{ safe: true }` makes a *dotted* path null-safe — it compiles
 * through the `get` filter so `owner.user_id` resolves to null instead of 500ing
 * when `owner` is null. No effect on a bare, dot-free name.
 */
import { defineFunction, s, c, guard, ref, input, inp } from "@xano/sdk";
import { posts, users } from "../_shared.js";

/** Gate 1 — a plain reference to a stack variable. */
export const refPlain = defineFunction({
  name: "ex_ref_plain",
  stack: [s.set_var("greeting", c.text("hello"))],
  response: ref("greeting"),
});

/** Gate 2 — null-safe nested access on a row that may not exist. */
export const refSafe = defineFunction({
  name: "ex_ref_safe",
  stack: [s.db.get({ table: posts, fieldValue: c.int(1), as: "owner" })],
  // `owner` may be null (no matching row) — `{ safe: true }` yields null, not a 500.
  response: ref("owner.author_id", { safe: true }),
});

/**
 * Gate 3 — the boundary: `{ safe: true }` is an EXPRESSION opt-in, never a
 * `db.*` match argument. A chained ownership check (fetch the row, then fetch
 * its parent to check the owner) has to settle existence BEFORE it drills:
 * feeding the drill's null to the second `db.get` fails the whole request with
 * HTTP 400 `Missing param: field_value`, one statement before the precondition
 * that was meant to answer with a 404.
 */
export const refChainedOwnership = defineFunction({
  name: "ex_ref_chained_ownership",
  input: { post_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: posts, fieldValue: inp("post_id"), as: "post" }),
    // Existence first — mandatory here, not a stylistic alternative.
    guard.found("post", { message: "Post not found." }),
    // `post` is known non-null now, so the drill needs no `safe`.
    s.db.get({ table: users, fieldValue: ref("post.author_id"), as: "author" }),
  ],
  response: ref("author.id"),
});
