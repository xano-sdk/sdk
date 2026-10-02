/**
 * `respond.*` — set the HTTP status, redirect, or add a response header.
 *
 * An endpoint answers 200 for everything that succeeds; `s.precondition`'s
 * `error_type` covers five FAILURE statuses and nothing else. These three
 * helpers are sugar over `s.util.set_header`, which reaches the status line.
 *
 * ⚠ `respond.status` REFUSES 308, 425, 451, 102 and 103. A live sweep of every
 * registered code found the platform writes those and does not act on them, so
 * the response is 200 with nothing reported anywhere — use 301, 429 and 403.
 */
import { defineFunction, s, c, respond, ref, obj } from "@xano/sdk";

/** 201 on create. Position in the stack does not matter — a later status wins. */
export const respondStatus = defineFunction({
  name: "ex_respond_status",
  stack: [s.set_var("id", c.text("note_1")), respond.status(201)],
  response: obj({ id: ref("id") }),
});

/**
 * A redirect is BOTH statements — a `Location` header alone answers 200 and no
 * client acts on it. Spread the tuple; returning `Statement[]` instead would
 * widen the stack and collapse `InferResponse`.
 *
 * 302 is the default (temporary, method may change). 301 is permanent, 307 the
 * temporary form that preserves the method, 303 forces GET. There is no 308.
 */
export const respondRedirect = defineFunction({
  name: "ex_respond_redirect",
  stack: [
    s.set_var("target", c.text("https://example.com/moved")),
    // A computed URL is concatenated onto the header at request time.
    ...respond.redirect(ref("target"), { status: 301 }),
  ],
  response: obj({ moved: ref("target") }),
});

/** Name and value separately — the underlying statement takes one joined string. */
export const respondHeader = defineFunction({
  name: "ex_respond_header",
  stack: [
    s.set_var("id", c.text("abc123")),
    respond.header("Cache-Control", "public, max-age=60"),
    respond.header("X-Request-Id", ref("id")),
  ],
  response: obj({ id: ref("id") }),
});
