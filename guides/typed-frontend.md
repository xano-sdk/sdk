# The typed frontend surface

Every type and helper a frontend gets from a deployed def — path resolution, input and response inference, and the two ways to pay for it.

## Endpoint names, path params, and encoding

- **URL path params** → name the endpoint with `{param}` segments and declare an input per
  segment. `getPath({ params })` fills them, with the keys typed from the name itself:

  ```ts
  const getPost = query({
    name: "blog/{slug}/review/{review_id}",       // segments chain; no wildcards
    verb: "GET",
    apiGroup: api,
    input: { slug: input.text(), review_id: input.int(), verbose: input.bool() },
    stack: [s.db.get({ table: post, fieldName: "slug", fieldValue: inp("slug"), as: "row" })],
    response: ref("row"),
  });

  getPost.getPath({ params: { slug: "hello", review_id: 7 } });
  // → "/api:<canonical>/blog/hello/review/7"
  getPost.toSearchParams({ verbose: true });      // → URLSearchParams; String(...) is "verbose=true" (path params dropped)
  ```

  Every `{param}` must have a matching input or `query()` throws — Xano treats an unbound
  marker as inert route text, so the endpoint would answer on the path and see nothing.
  Inputs that aren't in the path (`verbose`) stay ordinary query-string params. Never
  interpolate the path by hand: `getPath` percent-encodes each value, so a `?`, `#` or space
  stays inside its segment instead of restructuring the URL, and it throws on the two values
  encoding can't contain — one holding `/`, and one that *is* `.` or `..` (a URL parser drops
  those before routing, addressing a different endpoint). `realtimeChannel()` paths work
  identically, minus the encoding: a channel address is matched literally, not parsed as a URL.
- **Sibling routes must not overlap.** Xano serves the first route that matches, in creation
  order, and a literal route gets no priority over a `{param}` one. So `"runs/{id}"` created
  before `"runs/trend"` answers `GET /runs/trend` itself. `export()` refuses any two routes in
  one group and verb that a single path can reach (`query.route-shadowed`). Make the paths
  disjoint (`"runs/by-id/{id}"`), or declare a numeric param `input.int({ required: true })`:
  only a REQUIRED int/decimal segment matches digits only, and an optional one matches any text.
- **`InferRow<typeof post>`** → the table's row type. Rename or retype a column and every
  consumer breaks at compile time — exactly where you want it.
- **`InferResponse<typeof someQuery>`** → the endpoint's **response** type, closing the round
  trip. It auto-derives the common shapes with no codegen: an object-literal response yields
  those keys, and a query that returns a variable filled by a db op derives that op's result —
  the full row for `db.add`/`db.edit`/`db.patch`/`db.add_or_edit` (→ `Row` — each binds the
  full written row rather than null, so it stays non-nullable; a genuine miss throws instead of
  yielding null — `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`, while
  `add_or_edit` upserts and never misses), `Row | null` for `db.get` (it binds
  `null` on a miss rather than throwing — handle the not-found path), a row list for

## Inferring the response type

  `db.query`/`db.bulk.patch` (→ `Row[]`), a `boolean` for `db.has`, a `number` count for
  `db.bulk.delete`, and a `get`/`query` `output: [...]` selection narrows to a `Pick` (still
  `| null` for `get`). A dotted entry selects sub-keys of an object column
  (`output: ["id", "meta.url"]`, on a statement or an addon); the narrowing keys off the
  path's root, since an object column's sub-keys aren't declared in the schema.
  Where the shape isn't statically knowable — a value reshaped by a filter/lambda, built by
  control flow, or from an op the engine itself leaves untyped (`db.del`, `db.bulk.add`/`bulk.update`,
  raw `direct_query`) — it resolves to `unknown`; declare `responseShape` to close it.
  In an object-literal response the **keys** are always known, and a `c.*` constant **value**
  types like an `s.set_var` of it: `response: { success: c.bool(true) }` derives
  `{ success: boolean }`.
  A **nested** member resolves by those same rules, to any depth, in either spelling —
  `response: { user: obj({ id: ref("row.id") }) }` and the raw literal
  `response: { user: { id: ref("row.id") } }` both derive `{ user: { id: number | null } }`.
  A **call** carries the shape across: `s.function.call`/`s.function.run`, `s.tool.call` and
  `s.api.call` (workflow-test only, above) given a def **handle** bind their `as` with the
  target's own `InferResponse`,
  so `ref("discount_result.discount_cents")` in the caller types to that field instead of
  `unknown`. What the target resolves to is what propagates, so declaring `responseShape` on
  the **target** fixes every caller at once. A target named by *string* has no def to read and
  stays `unknown`, as does an async `s.function.run` (it binds a job handle, not the result).
  The same derivation runs on every response-bearing kind — `query()`, `defineFunction()`,
  `realtimeMessage()`, `tool()`, `middleware()`, and the response-bearing triggers — and each
  of them takes `responseShape`. A trigger builds its stack and response through *callbacks*
  (`stack: (t) => [...]`), and the trace follows through them. This matters most where a
  handler's response is the only type a client has: a realtime message's broadcast payload,
  or a channel `deliver` trigger's return, which is that recipient's copy of the message.

```ts
import { listPosts, getPost } from "../xano/index.js";
import type { InferResponse } from "@xano/sdk";

type Posts = InferResponse<typeof listPosts>;   // Post[]      — derived from the db.query it returns
type Post  = InferResponse<typeof getPost>;      // Post | null — a db.get misses to null
```

For a **computed or multi-key object response**, author it as a *record of values* —
`response: { success: c.bool(true), id: inp("id") }` — **not** `c.obj({ ... })`. `c.obj` builds a
*constant*, so a tagged value nested inside it would serialize as internal representation the
engine can't decode (a runtime 500); nesting one is now a compile error that points you at the
record form (issue #42). A **nested plain object** in a record
response (`response: { user: { id: ref("u"), age: 3 } }`) is auto-wrapped for you — no manual
`obj({ ... })` — and raw literals in a call/agent `input` map coerce too
(`s.function.run({ fn, input: { max_age_days: 3 } })` — no `c.int(3)`).

When a response is filtered, computed, or otherwise opaque to the static walk, declare it once
on the query and every caller derives from that single source of truth:

```ts
const getPost = query({
  verb: "GET", apiGroup: blog, name: "get_post/{id}",   // one row → address it in the path
  input: { id: input.int({ required: true }) },
  stack: [s.db.query({ table: post, where: expr(col("id"), "=", inp("id")), as: "rows" })],
  // A filtered response is opaque to the static walk, so derivation is `unknown`.
  response: withFilters(ref("rows"), fl.first()),
  responseShape: null as InferRow<typeof post> | null,   // declare the real shape once
});
type MaybePost = InferResponse<typeof getPost>;           // InferRow<typeof post> | null
```

(A plain `response: ref("row")` off a `s.db.get` needs no `responseShape` — it already
derives `InferRow<typeof post> | null`, since `db.get` misses to `null`.)

**Factoring statements into a helper.** The trace walks the stack's *tuple*, so spreading a
helper typed `Statement[]` widens the stack and nothing in it resolves any more — the response
types as `StackTupleWidened`, which names the cause. Return `statements(...)` from the helper
and the tuple survives the spread:

```ts
import { statements } from "@xano/sdk";

function assertOk(v: string) {                 // no `: Statement[]` annotation
  return statements(s.lambda({ ... }), s.precondition({ ... }));
}

stack: [...assertOk("res"), s.db.add({ table: post, row, as: "created" })],
response: ref("created"),                      // still traced
```

Fixed arity only — a helper that builds its array in a loop can't be a tuple, so declare
`responseShape` there.

This mirrors how the Xano engine itself derives an endpoint's response schema (a static walk of
the stack), so what you get in the type is what the endpoint actually returns — and it degrades
to `unknown` in exactly the cases the engine can't resolve either.

A GET endpoint carries its inputs in the query string rather than a JSON body:

```ts
import { getSnippet } from "../xano/index.js";
import { query, type InferInput } from "@xano/sdk";

const BASE = "https://your-instance.xano.io";

async function fetchSnippet(id: number) {
  const params = { id } satisfies InferInput<typeof getSnippet>;   // { id: number }
  const res = await fetch(`${BASE}${getSnippet.getPath()}?${query.toSearchParams(params)}`);
  return res.json();
}
```

`toSearchParams` sends a list as `tags[]=a&tags[]=b` and an object as `range[min]=1`
(a list of objects indexes each item: `items[0][id]=1`; a list of lists goes as one
JSON value, `lol=[[1,2],[3]]`). A list item that sends nothing (`null`, `{}`) throws,
naming it. A repeated plain key (`tags=a&tags=b`) reaches the endpoint as its last
value only, so don't hand-roll it.

The `@xano/sdk` entry has **zero Node dependencies**, so importing your workspace
graph into a browser bundle just works. The `node:fs`-backed emitters live in the
separate `@xano/sdk/node` entry a frontend never pulls in.

## Bundle size, and the route manifest

**Bundle size & tree-shaking.** `@xano/sdk` is `sideEffects: false`, so a bundler drops
the SDK exports your frontend doesn't use. But importing a query **def** for its `getPath()`
also pulls whatever its `stack` builds — the `s.*`/`c.*` factory *calls* run at module load
to construct the def, so they can't be tree-shaken out. Types are free (`InferInput`/
`InferRow` erase to nothing — use `import type`). That cost is a **floor**, not a function of
how lean the def is. Measured on a Vite lib build against the published package: one
`apiGroup` + one empty `query`, imported for a single `getPath()`, is **267 kB minified
(65 kB gzipped)** against 56 B for a hand-written path string. A realistic def — two
tables, a foreign key, a typed input, a `db.query` with a `where` and a sort, plus a
second endpoint — measures 269 kB. That 2 kB spread is the point: the floor is the SDK
runtime itself, so splitting modules or simplifying a def does not move it, and the cost
is paid by importing any def at all.

**Generate a route manifest instead.** It keeps the derived-not-hardcoded contract at
almost no bundle cost:

```bash
xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts
```

The emitted file is plain data plus one interpolator and imports nothing at all — the same
app builds to 1.3 kB, a ~200x saving, with no SDK code in the output. Route keys and their
`{param}` names are still checked at compile time, so a backend rename is a compile error
rather than a 404:

```ts
import { routePath, ROUTES } from "../xano/routes.gen";

fetch(BASE + routePath("GET blog/{slug}", { slug }), {
  method: ROUTES["GET blog/{slug}"].verb,
});
```

A route key is `"<VERB> <name>"`, which is the endpoint identity the engine itself uses —
so verb-differentiated siblings are ordinary, and a REST-shaped group emits without
renaming anything:

```ts
routePath("GET listings");                  // list
routePath("POST listings");                 // create
routePath("PATCH listings/{id}", { id });   // update
```

The verb comes first so the key is stable: adding a `POST` sibling never renames the `GET`
that was already there. When two api groups hold the same verb AND name (a `v1` and a `v2`
both serving `GET vehicles`), each of those endpoints is keyed by its group's name instead,
`"<group>:<VERB> <name>"`, and every other key stays short:

```ts
routePath("v1:GET vehicles");
routePath("v2:GET vehicles");
routePath("GET vehicles");   // compile error: "... is in more than one api group - use v1:GET vehicles or v2:GET vehicles"
```

Adding the second group's endpoint is what renames the first one's key, so its call sites
stop compiling rather than silently addressing one group of the two.

Realtime is in the same file when the workspace has any: `socketUrl(server, baseUrl)` for the
websocket URL and `channelPath(channel, params)` for the path a frame's `channel` field takes,
both keyed and `{param}`-checked exactly like the routes. A channel path two servers both own
is keyed by server, `"<server>:<path>"` (`channelPath("staff:lobby")`), and the bare path is a
compile error naming both keys, as with api groups. `socketUrl` is the equivalent of
`realtimeServer().getUrl()` down to the tenant rule — a base URL that names a tenant
(`https://host/tenant/ab-cd`, what deploy injects as `window.XANO_HOST`) is rewritten to the
socket's own `wss://host/ws/ab-cd:<canonical>` form, which is the one address a frontend has no
way to reconstruct. Resolve once, from the `https://` base — feeding a resolved socket URL back
in as a `baseUrl` throws rather than append a second `/ws/…`:

```ts
import { socketUrl, channelPath } from "../xano/routes.gen";
import { XANO_HOST } from "./lib/api"; // a string: the injected URL, else VITE_XANO_HOST

const ws = new WebSocket(socketUrl("chat", XANO_HOST), token);
ws.send(JSON.stringify({ action: "join", channel: channelPath("rooms/{room_id}", { room_id }) }));
```

Add `--strict` in CI to fail when the committed manifest is out of date. A hand-typed
`ROUTES` table is the option that gives up both the bundle saving and the rename safety.
