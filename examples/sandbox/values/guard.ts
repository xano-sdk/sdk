/**
 * `guard.*` — the existence and authorization checks every app writes, in the
 * ORDER that is actually correct.
 *
 * None is a new engine capability: each is `s.precondition`, after an
 * `s.db.get` it expects. What they add is the sequencing, because the natural
 * one-liner of each is wrong in a way nothing reports.
 *
 * `guard.role`/`guard.owner` return a fixed-arity TUPLE, so spread them — a
 * helper returning `Statement[]` widens the stack and every `as` in the def
 * stops being traceable, collapsing `InferResponse`.
 */
import { defineFunction, s, c, guard, inp, ref, input, expr } from "@xano/sdk";
import { posts, users } from "../_shared.js";

/**
 * An existence check that NARROWS. One statement: assert the row was found
 * (404). After it, `InferResponse` types `post` as the row — not `Row | null` —
 * so the response needs no `responseShape` and the client no `NonNullable`. A
 * hand-written `s.precondition` with the same condition does not narrow; its
 * condition is opaque to the type-level walk.
 */
export const guardFound = defineFunction({
  name: "ex_guard_found",
  input: { id: input.int() },
  stack: [
    s.db.get({ table: posts, fieldValue: inp("id"), as: "post" }),
    guard.found("post", { message: "Post not found." }),
  ],
  response: ref("post"),
});

/**
 * A role check. Three statements: fetch the caller's own row by `auth("id")`,
 * assert it EXISTS (401), assert its role is in the set (403).
 *
 * The existence step is the point — a role comparison against a null actor row
 * is only accidentally false, and a membership or negated test is not false at
 * all. The endpoint must still be authenticated; this is a check on top of
 * authentication, not a replacement for it.
 */
export const guardRole = defineFunction({
  name: "ex_guard_role",
  stack: [...guard.role(users, "admin"), s.db.query({ table: posts, as: "rows" })],
  response: ref("rows"),
});

/**
 * An ownership check. Assert the row was found, THEN compare its owner column to
 * the caller.
 *
 * Drilling before the existence check is a 500, not a denial: `s.db.get` binds
 * `null` on a miss and `ref("post.author")` against it raises
 * `Unable to locate var`. That is why this takes the variable NAME and the owner
 * column separately, and refuses a dotted path.
 *
 * The missing-row case answers 404 rather than 403 deliberately — a 403 tells an
 * unauthorized caller that the id exists.
 */
export const guardOwner = defineFunction({
  name: "ex_guard_owner",
  input: { id: input.int() },
  stack: [
    s.db.get({ table: posts, fieldValue: inp("id"), as: "post" }),
    ...guard.owner("post", "author"),
    // Any OTHER authorization rule takes the same shape. It matters that it does:
    // a bare `s.precondition` defaults to `error_type: "standard"`, which is HTTP
    // 500 — so the obvious way to write a denial answers a server error.
    guard.require(expr(ref("post.published"), "!=", c.null()), {
      message: "This post is still being imported.",
    }),
  ],
  response: ref("post"),
});
