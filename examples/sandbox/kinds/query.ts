/**
 * `query({...})` — an HTTP API endpoint (payload key `query`), published under
 * an API group. This is the object kind; its `stack` uses the statement surface.
 */
import { query, s, inp, ref, input } from "@xano/sdk";
import { api, users } from "../_shared.js";

/**
 * A READ OF ONE ROW addresses that row in the PATH, not in the query string.
 *
 * The `{id}` segment binds to the `id` input of the same name — that is the
 * whole mechanism, and it is the same one whatever the value happens to be
 * called: `ex_blog/{category}` and `ex_shop/{country}` are this shape too. What
 * makes it a segment is that the value says WHICH resource is wanted, not that
 * it is named like a key.
 *
 * Written without the segment (`name: "ex_get_user"`, reading `?id=1`) the
 * endpoint still works — Xano serves it happily — which is why `export()` warns
 * rather than throws. Two things are lost: the route stops being addressable the
 * way every REST client, cache key, and access log expects, and `getPath()`
 * types as STATIC, so a caller cannot pass the value positionally and has to
 * hand-append a query string that nothing type-checks.
 *
 * An input that NARROWS A LIST is the other case, and it belongs in the query
 * string: `ex_items?status=open` is right, `ex_items/{status}` is not.
 */
export const getUserQuery = query({
  name: "ex_get_user/{id}",
  verb: "GET",
  apiGroup: api,
  // `history` omitted → inherits the API group's default (which inherits the
  // workspace). Set a scalar (`100`, `false`, `"all"`) to override per-endpoint.
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

/**
 * ACCEPTING ONE WARNING ON PURPOSE — `diagnostics: { allow }`.
 *
 * This is the shape the note above warns about: one row looked up by a value
 * in the query string. Here it is kept on purpose, because clients already call
 * `ex_user_by_name?name=…` and moving `name` into the path would break them.
 * `allow` accepts that one code on this def alone, so `export --strict` still
 * fails on every other warning, here and on every other def. It takes any
 * warning code the def raises and never an error. Reach for it only when the
 * shape is really meant, never to quiet a warning you have not read.
 *
 * An accepted warning is not printed, but it is still listed: in
 * `export({ accepted: [] })` and in the `--json` document's `accepted[]`, so a
 * test can assert the hazard is still diagnosed. An allowed code this def stops
 * raising warns `diagnostics.allow-unused`, which fails `--strict`, so remove
 * the allow when the shape it accepted is gone.
 */
export const userByNameQuery = query({
  name: "ex_user_by_name",
  verb: "GET",
  apiGroup: api,
  input: { name: input.text({ required: true }) },
  stack: [s.db.get({ table: users, fieldName: "name", fieldValue: inp("name"), as: "user" })],
  response: ref("user"),
  diagnostics: { allow: ["query.path-segment-candidate"] },
});

/**
 * REST VERB PAIR — one path, two methods, which is the ordinary way to spell a
 * collection. Both are named `ex_items`, and that is fine: a query's identity is
 * composed from its api group, its verb, and its name — the engine's own
 * uniqueness for an endpoint — so these are two distinct objects with distinct
 * guids and distinct lock entries (`query:<group>|GET|ex_items` and
 * `…|POST|ex_items`). The same name may also repeat across API groups, which is
 * what a `v1`/`v2` split looks like.
 *
 * The one consequence worth knowing: because the VERB is part of identity,
 * changing it is an identity change, not an edit. Switching `POST` to `PUT` here
 * would delete the POST endpoint and create a PUT one. `xanosdk lock rename query
 * "<group>|POST|ex_items" "<group>|PUT|ex_items"` carries the identity across
 * when that is not what you meant.
 *
 * Every other kind still collides on name alone — two functions called `helper`
 * derive one guid and `export()` throws.
 */
export const listItemsQuery = query({
  name: "ex_items",
  verb: "GET",
  apiGroup: api,
  stack: [s.db.query({ table: users, as: "rows" })],
  response: ref("rows"),
});

export const createItemQuery = query({
  name: "ex_items",
  verb: "POST",
  apiGroup: api,
  input: { name: input.text({ required: true }) },
  stack: [s.db.add({ table: users, row: { name: inp("name") }, as: "created" })],
  response: ref("created"),
});

/**
 * URL PATH PARAMS — a `{param}` segment in `name` binds that URL segment to the
 * input of the same name, and segments chain. Every `{param}` MUST have a
 * matching input or `query()` throws: Xano treats an unbound marker as inert
 * route text, so the endpoint would answer on the path and see nothing.
 *
 * The name itself holds only letters, digits, `_`, `-`, `/` and the `{}` of a
 * param (max 200). A `.` is the one to watch: Xano does not reject it, it saves
 * the endpoint with an EMPTY name, which deploys clean and then 404s on every
 * request — so `query()` throws instead. A download endpoint is `ex_export_zip`
 * or `ex_export/zip`, with the file extension set in the response headers.
 *
 * Read the value with `inp("<param>")`, exactly like any other input. Inputs
 * that are NOT in the path (`verbose` here) stay ordinary query-string params.
 *
 * Client side, `routePath()` from the generated route manifest
 * (`xanosdk routes <entry> --emit xano/routes.gen.ts`) builds the real URL —
 * never interpolate by hand, or a value containing `/` silently addresses a
 * different endpoint:
 *
 *   routePath("GET ex_users/{user_id}/posts/{slug}", { user_id: 7, slug: "hello" })
 *     → "/api:<canonical>/ex_users/7/posts/hello"
 *   (`userPostQuery.getPath({ params })` returns the same in Node or a test; a
 *    browser importing the def as a value pulls the SDK runtime into its bundle)
 *   userPostQuery.toSearchParams({ verbose: true })  → "verbose=true"
 *     (the handle's own toSearchParams drops path params; the free
 *      `query.toSearchParams` has no view of the route and keeps every key)
 */
export const userPostQuery = query({
  name: "ex_users/{user_id}/posts/{slug}",
  verb: "GET",
  apiGroup: api,
  input: {
    user_id: input.int(),
    slug: input.text(),
    verbose: input.bool(),
  },
  stack: [s.db.get({ table: users, fieldValue: inp("user_id"), as: "user" })],
  response: ref("user"),
});

/**
 * DATABASE LINK — `input.dbLink(table)` is ONE entry that EXPANDS into one input
 * per COLUMN of the linked table. It is the most confusing input in the catalog
 * for exactly that reason: the entry is not the input.
 *
 * The `users` table's columns arrive here as individual request inputs, so they
 * are read by their own column names — `inp("name")`, `inp("email")` — NOT by
 * the entry's name. The expansion is live: add a column to `users` and it
 * becomes an input here with no change to this file.
 *
 * `hidden` drops columns from the expansion, which is what you almost always
 * want for server-managed columns (`id`, `created_at`) — a caller has no
 * business supplying them.
 *
 * `customize` tunes the columns that DO expand, one at a time: make one
 * required, give one a default, or bind a normalizing filter. Anything not named
 * expands exactly as the table declares it.
 *
 * By convention the editor names the entry after the table with a trailing `__`.
 * The name is just the map key and any name works; matching the convention keeps
 * a pulled workspace diffing cleanly against a hand-written one.
 */
export const signupQuery = query({
  name: "ex_signup",
  verb: "POST",
  apiGroup: api,
  input: {
    users__: input.dbLink(users, {
      hidden: ["id", "created_at"],
      customize: { email: { required: true, methods: ["lower"] } },
    }),
  },
  stack: [
    s.db.add({ table: users, row: { name: inp("name"), email: inp("email") }, as: "created" }),
  ],
  response: ref("created"),
});
