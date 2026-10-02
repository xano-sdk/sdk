/**
 * `middleware({...})` — a reusable pre/post request middleware (payload key
 * `middleware`). `resultStrategy` controls how its result folds into the phase it
 * is attached to (`merge` folds keys, `replace` swaps wholesale) — in `post` that
 * is the host's RESPONSE, in `pre` it is the host's REQUEST INPUTS, so a `pre`
 * `replace` rewrites what the host receives. `exceptionPolicy` controls what a
 * throw in the stack does to the request (`rethrow` — the Xano SDK default —
 * aborts and surfaces the error, which is what a guard wants; `silent` swallows
 * it).
 *
 * A middleware runs only once *attached* to a host. Attach it with the host's
 * `middleware: { pre, post }` field — see `guardedEndpoint` below. Providing a
 * phase overrides that phase (sets its `_customize` flag); omitting it inherits
 * from the parent tier (Query → API Group → Workspace). `middleware.clear()`
 * overrides a phase with nothing (stop inheriting).
 */
import { middleware, query, s, c, ref, inp, input, auth, sys, withFilters, fl, obj } from "@xano/sdk";
import { api, users } from "../_shared.js";

/**
 * A per-user rate limiter — the canonical middleware. Two non-obvious parts:
 *
 * 1. **Composite key.** `s.redis.ratelimit` takes a `Value` key; to namespace the
 *    bucket per user you build it with the filter chain, not string concat
 *    (`"prefix" + auth("id")` does not exist). `withFilters(c.text(prefix),
 *    fl.concat(auth("id")))` → `"ex:rl:write:<id>"`.
 * 2. **`auth("id")` needs an authenticated host.** It resolves to the caller's id
 *    only when the host has an auth table; on a public host it does not resolve at
 *    all and the request fails with a 403 before the host runs — key off
 *    `sys.remoteIp()` there instead. `export()` warns if you attach this to a host
 *    with no auth table — so the `guardedEndpoint` query below sets `auth: users`.
 *
 * `exceptionPolicy: "rethrow"` makes a tripped limit abort the request (HTTP 429
 * with the authored `error`); it is also what Xano SDK writes when you omit the
 * field, so a guard is enforced by default. `"silent"` would let it through.
 */
export const rateLimit = middleware({
  name: "ex_kind_rate_limit",
  exceptionPolicy: "rethrow",
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("ex:rl:write:"), fl.concat(auth("id"))),
      max: c.int(10),
      ttl: c.int(30),
      error: c.text("Too fast — slow down."),
    }),
  ],
});

/**
 * The **public-endpoint** rate limiter. A host with no auth table has no caller
 * identity, so `auth("id")` does not resolve there and an `auth("id")`-keyed limit does not fall back to one
 * shared bucket — the request 403s before the host runs. Key off the client IP
 * instead — `sys.remoteIp()` (Xano's `$env.$remote_ip`). Same composite-key
 * pattern; just a different key source.
 *
 * To key off a request *field* instead (e.g. an email being submitted), a `pre`
 * middleware can read the host body: `s.util.get_all_input({ as: "payload" })`
 * exposes it — but wrapped as `{ type, vars }`, so the field is at
 * `ref("payload.vars.<field>")`, not `ref("payload.<field>")`.
 */
export const publicRateLimit = middleware({
  name: "ex_kind_public_rate_limit",
  exceptionPolicy: "rethrow",
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("ex:rl:public:"), fl.concat(sys.remoteIp())),
      max: c.int(20),
      ttl: c.int(60),
      error: c.text("Too many requests — try again shortly."),
    }),
  ],
});

export const auditLog = middleware({
  name: "ex_kind_audit_log",
  resultStrategy: "merge",
  exceptionPolicy: "silent",
  stack: [s.set_var("logged", c.bool(true))],
  response: ref("logged"),
});

/**
 * A `post` middleware reading both the host's response and the caller's request.
 *
 * `s.util.get_all_input` binds a `{ type, vars }` envelope whose `vars` depends
 * on the PHASE: in `pre` it is the request inputs (`payload.vars.<field>`), in
 * `post` it is `{ status, result }` — the host's outcome. So here the host's row
 * is `payload.vars.result`, and `payload.vars.id` would not exist: under the
 * default `rethrow` that read 500s AFTER the host already ran and wrote
 * (`export()` warns). The request body in `post` comes from
 * `s.util.get_raw_input`.
 */
export const responseAudit = middleware({
  name: "ex_kind_response_audit",
  resultStrategy: "merge",
  stack: [
    s.util.get_all_input({ as: "payload" }),
    s.util.get_raw_input({ as: "body" }),
    s.set_var("audit", obj({ status: ref("payload.vars.status"), requested_id: ref("body.id") })),
  ],
  response: { audit: ref("audit") },
});

/**
 * An authenticated query that runs `rateLimit` before its stack and `auditLog`
 * after. The endpoint's `auth: users` is what makes `auth("id")` inside the
 * rate-limit key resolve to the caller (on a public endpoint `auth("id")` would
 * not resolve and the request would 403 — and `export()` would warn).
 *
 * Shared-bucket note: attaching this one `rateLimit` object to several endpoints
 * means they share the *same* key and therefore *one* counter — `max: 10` becomes
 * a global per-user budget across all of them. For an independent limit per
 * endpoint, vary the key (fold the endpoint/action name into the prefix).
 */
export const guardedEndpoint = query({
  name: "ex_kind_guarded_endpoint",
  verb: "POST",
  apiGroup: api,
  auth: users,
  input: { id: input.int({ required: true }) },
  middleware: { pre: [rateLimit], post: [auditLog, responseAudit] },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});
