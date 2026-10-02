# Core def shapes

> Read when authoring a function, query, api group, task, workflow test, middleware, tool, or addon — and for the `response` and `expr` shapes every one of them uses.

The def-object passed to each factory. `?` = optional. `input` is keyed by
input name (`input.<type>(opts?)`); `stack` is `Statement[]` (`s.*`); `response`
is a `ResponseDef` (see **Responses** below). Object identity is `guid?` —
omit it and it derives from `name` (for a query, from group + verb + name; set it
to survive a rename).

- `defineFunction({ name, guid?, description?, docs?, workspace?, input?, stack?, response?, tests? })`
- `query({ name, verb, apiGroup?, guid?, auth?, input?, stack?, response?, responseType?, apiEnabled?, disabled?, cache?, description?, docs?, tests?, example? })` — a `cache` setting turns caching on unless `active: false`
  - `verb`: `"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"` (required), UPPERCASE. Anything else — most often a lowercase `"post"` — makes `query()` THROW, because Xano does NOT reject it: it stores the verb as NULL, a null verb serves as GET, and the endpoint then answers on the wrong method while the one you meant 404s `Unable to locate request.`
  - `apiGroup`: an `apiGroup()` def handle (or its name) — binds by guid, stable across syncs. Raw numeric `apiGroupId?` is the escape hatch and wins if both given.
  - `auth`: `false` (no auth) or an auth-table id; `responseType`: `"standard" | "stream"` (default `standard`) — any other spelling THROWS, since Xano stores an unrecognized one as NULL and a null buffers as `standard`, so a misspelled stream quietly does not stream.
  - `name` is the endpoint PATH within the group.
    - A `{param}` segment is a URL PATH PARAM bound to the input of the same name, and segments chain: `name: "blog/{slug}/review/{review_id}"` + `input: { slug: input.text(), review_id: input.int() }`. Read it with `inp("slug")` like any other input.
    - Every `{param}` MUST have a matching input or `query()` THROWS — Xano treats an unbound marker as inert route text, so the endpoint would answer on the path and see nothing.
    - A `{param}` need NOT be a whole segment (`"blog/post-{slug}"` routes fine), but its type must fit one segment (no object/list/json/file/geo/vector); there are no wildcards or patterns. `required: true` is NOT demanded (the engine's editor leaves path inputs unmarked).
    - An input a `GET`/`DELETE`/`HEAD` looks ONE ROW up by (`s.db.get`/by-field edit/patch/delete; not `has` or an email/token/code) belongs in the path — `export()` warns `query.path-segment-candidate`: `getPath()` types STATIC. A segment is any value naming WHICH resource is wanted (`"shop/{country}"`); one that NARROWS A LIST (`s.db.query`) stays a query param. Intended? `diagnostics: { allow: [code] }` on the query (any def, for its own advisories) accepts it under `--strict`.
    - Routes are matched FIRST-FIT in creation order, and a literal gets NO precedence over a `{param}`: `"runs/{id}"` (a text `id`) created before `"runs/trend"` answers `GET /runs/trend` itself. Two routes in one group and verb that one request path can match are REFUSED at `export()` (`query.route-shadowed`) — reordering `registerQueries` cannot fix it, since a release keeps an existing route first. Make the paths disjoint (`"runs/by-id/{id}"`), or declare a numeric param `input.int({ required: true })` (or `decimal`): only a REQUIRED int/decimal segment matches digits only — an OPTIONAL one matches any text, so `input.int()` still takes `trend`.
    - Inputs absent from the path are ordinary query-string/body params.
    - Name charset is ONLY `A-Za-z0-9_-/{}`, max 200: a `.` (`"export.zip"`) is NOT rejected by Xano — it stores an EMPTY name that deploys clean then 404s forever, so `query()` THROWS. Use `"export_zip"` and set the extension in the response headers.
  - **Client recipe:** `q.getPath({ params: { slug: "hello" } })` → `/api:<canonical>/blog/hello` — never interpolate by hand.
    - `getPath` percent-encodes each value (so `?`/`#`/spaces stay in their segment) and throws on what encoding cannot contain: a `/`, and a segment that becomes `.`/`..` as sent (a URL parser drops those before routing, addressing a different endpoint).
    - The keys are typed from the literal `name`, so a typo is a compile error.
    - `q.toSearchParams(input)` drops GET path params (free `query.toSearchParams` keeps them); lists send `k[]=a&k[]=b` (`k=a&k=b` binds only `b`).
  - Browser bundle cost, the `routes.gen.ts` alternative, and spot-checking a def from Node: `llms/client.md`.
- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors?, middleware? })` — a query container; queries bind to it via their `apiGroup`. `canonical` holds only letters, digits, `_` and `-` (it is the `<canonical>` of `/api:<canonical>`); anything else THROWS at build.
  - `documentation?`: `{ require_token? }` — the gate on this group's hosted docs. `require_token: true` IS the declaration; the token lives in `xano/.secrets.json` under this group's guid, and a literal `token` FAILS the export. ⚠ ALWAYS emitted, present or not: an absent key is written as the engine default on import, so omitting the block CLEARS an existing gate (the opposite of the `workspaceConfig` rule). `swagger: true` publishes the docs; `require_token` gates them only alongside a non-empty token, so `swagger: true` with no gate makes the whole group readable by anyone with the URL — export warns once per build and `--strict` fails; `diagnostics: { allow: ["api-group.docs-public"] }` accepts it. A declared gate with NO token drops the block, so those bytes clear it: export FAILS under `swagger: true`, and with `swagger` off warns and completes.
  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.
    - `mode?`: `"default"` (the default) | `"custom"` | `"disabled"`, lowercase — a fourth value THROWS at export (`apiGroup()` itself does not check), because Xano neither rejects nor blanks it: it DROPS THE WHOLE API GROUP on import, so the deploy succeeds and every query in the group 404s. ⚠ Every OTHER field applies only under `"custom"`: `"default"` serves a FIXED permissive policy (any origin, `allow-headers: *`, `allow-credentials: true`, `max-age: 86400`) and ignores the block, so setting `maxAge`/`allowCredentials`/`allowHeaders` alone changes nothing. `"disabled"` sends no CORS headers at all, so every browser call fails.
    - ⚠ Under `"custom"`, `allowOrigins` is matched as EXACT strings (scheme+host+port, no wildcard or subdomain expansion) and `"*"` is compared as a literal origin — it matches NOTHING. An unmatched origin gets no `access-control-*` headers at all, so the browser call fails while export, deploy and the preflight look fine. Name each origin, or use `mode: "default"` for any-origin. `allowMethods` gates the REAL response too: a verb left off gets no CORS headers back even though its preflight passes. Export warns on an empty origin list, a `"*"` entry, and a policy with no method enabled; a non-origin entry (trailing `/`, path) is refused.
- Tasks, workflow tests, middleware and tools below (agents and MCP servers: `llms/kinds-agent-mcp.md`) share the envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.
- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`). `active?` defaults `true`; `active: false` deploys it parked.
  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`. `startsOn`/`endsOn` are **timestamp strings** validated at encode time — `"2026-01-01T00:00:00Z"`, or the space-separated `"2026-01-01 00:00:00+0000"` a pulled workspace carries — never epoch numbers, and never zoneless; `freq` is the repeat interval **in SECONDS** (omitted ⇒ runs ONCE) — spell it `every("15m")`, a compile-time duration-to-seconds helper (`s`/`m`/`h`/`d`/`w`, terms concatenate). No cron, no timezone — a fixed-offset `startsOn` drifts an hour at each DST change; for a local time run hourly, gated on the local hour `withFilters(c.now(), fl.epochms_date("G", "America/New_York"))`. `repeatEnabled?`/`endsEnabled?` follow whether `freq`/`endsOn` is set and are recovery-only — state one to reproduce a stored gate left OFF. Fires on an ephemeral (see Gotchas).
- `workflowTest({ name, guid?, description?, docs?, datasource?, active?, tags?, stack? })` — an end-to-end test. NO `input`/`response`: `.call` something with an `as`, then assert on that var — `s.function.call({ fn, input, as: "r" })`, `s.expect.to_equal({ expr: ref("r"), value: c.int(42) })`. `s.expect.*` belongs here — it is not inert elsewhere (a failure 500s the request), so treat one in a query/function/task as a mistake to remove. `active?` defaults `true`; chain tests with `s.workflow_test.call({ workflowTest: <def handle> })`.
  - `datasource?`: Default `""` is an EMPTY datasource (recommended), not "no datasource". Any non-empty name makes the engine CLONE it before EVERY run — against production-sized data, slow enough to fail the run, which is why `"live"` warns at compile time. On an EPHEMERAL, `"live"` holds only the seed fixtures (plus rows a `--keep-data` deploy kept), so it is the way to read `table({ seed })` rows — a small clone, dropped after the run. ⚠ The value is STORED, so clear it before you promote or the same test clones the real database.
- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response?, responseShape?, tests? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`. ⚠ `input` ENCODES but an ATTACHED middleware never has it bound — the host request binds its own inputs, so `inp()` inside pre/post fails at runtime with `Unable to locate input` and a declared default does not stand in (`export()` warns). Read the request body with `s.util.get_all_input` instead; it yields a `{ type, vars }` envelope whose `vars` DIFFERS BY PHASE: `pre` → the request inputs (`payload.vars.<field>`); `post` → `{ status, result }`, the host's outcome (`payload.vars.result.<field>`; plus `payload` on an error). A request field read in `post` 500s after the host already ran (`export()` warns); read the request there with `s.util.get_raw_input`. `s.middleware.call` is the one path that DOES bind the declared map.
  - `resultStrategy?`: `"merge" | "replace"` (default `merge`) — how the middleware `response` folds into the accumulator of the phase it is ATTACHED to, and the two phases accumulate DIFFERENT things. In `post` the accumulator is the host's RESULT, so a returned object changes what the CALLER receives. In `pre` it is the host's REQUEST INPUTS, so a returned object changes what the HOST receives. `merge` folds key-by-key, `replace` substitutes wholesale; either way the next entry in the chain sees the updated value. So `pre` + `replace` DISCARDS every caller input the middleware does not re-emit, and a discarded input is then unreadable — a 500, even where it is declared `required: false`, because input defaulting has already happened by the time the override lands.
  - `exceptionPolicy?`: `"silent" | "rethrow" | "critical"` (default `"rethrow"` — a throw ABORTS the request and surfaces the authored error/status, which is what a guard wants). `"silent"` swallows the throw and lets the request through, so a guard set to it is NOT enforced — use it only for advisory middleware. `"critical"` is `"rethrow"` plus skipping the `post` chain.
- `tool({ name, guid?, description?, instructions?, docs?, enabled?, title?, annotations?, icons?, output?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`. `title`/`annotations`/`icons`/`output` are MCP metadata (`llms/kinds-agent-mcp.md`).
- An addon is a single table-bound db query, NOT a statement stack: `addon({ name, table, tableAlias?, where?, sort?, output: [cols], cardinality?: "single"|"list"|"count"|"exists"|"aggregate", group?, eval?, input?, context? })`, registered via `registerAddons([...])`.
  - `table` auto-fills the `context.dbo` binding. ⚠ Never author `table: null` — that is a BROKEN table-less addon returning nothing; `codegen` emits it only for an already-broken pulled object.
  - `tableAlias` is its SQL alias (`context.dbo.as`), qualifying `where`/`sort` columns (`col("merchant.id")`).
  - `where`/`sort` take the same surface as `s.db.query`; `where` encodes `context.search`, `sort` encodes `context.return.list.sort` (`return.single.sort` with `cardinality: "single"`) and is refused with `count`/`exists`. `where` is the predicate binding the addon to the parent row — `expr(col("id"), "=", inp("user_id"))`.
  - `cardinality` shapes the result (`context.return.type`, omitted for the `"list"` default). Rarer context (`eval`/`bind`/`lock`) stays raw `context` passthrough.
  - End to end — define, register, attach:
    ```ts
    const author = addon({ name: "author", table: users, input: { user_id: input.int() }, where: expr(col("id"), "=", inp("user_id")), output: ["id", "display_name"], cardinality: "single" });
    workspace("forum").registerAddons([author]); // plus the tables/queries
    s.db.query({ table: threads, addon: [{ addon: author, as: "_author", input: { user_id: out("author_id") } }], as: "rows" }) // rows[]._author: { id, display_name }
    ```
### Responses

The `response?` field (on functions, queries, tools, middleware, and
response-bearing triggers) maps to the stored `result[]`:

- `ResponseDef = Value | Record<string, Value>`.
- A single `Value` → one unnamed result item: `response: ref("rows")`.
- A record → one named item per key: `response: { user: ref("u"), token: ref("t") }`.
- Omitted → empty `result[]` (no response body).

### Expressions (`expr`)

`expr(left, op, right)` builds the comparison used by every condition/`where`
surface — `s.conditional`/`s.while` `when` (incl. each `elif` branch), and
`db.query` `where`/`additionalWhere` (and the search triggers) — one shared tree.

- `op`: `=`, `!=`, `>`, `<`, `>=`, `<=` (JS aliases `==` `===` `!==` are accepted and normalized).
- `left`/`right` are `Value`s — `col("x")` (a table column, `db.*` statements only), `ref`, `inp`, `auth(...)`, or `c.*`.
- For the full operator set (`in`/`like`/`ilike`/`between`/`contains`/`overlaps`/`@>`/`~`/`search`/…)
  use `cmp(left, op, right, { ignoreEmpty? })`; compose nested boolean logic with `and(...)`/`or(...)`.
- ⚠ The wider `cmp` operators are DATABASE-only (`where`, table view filter, db trigger
  `search`). A RUNTIME condition — `s.conditional`/`elif`, `s.while`, `s.precondition`,
  `array.*` `if` — takes the `expr` set only; the rest are refused at build time because
  deployed they fail the request with `Invalid op: <op>` on that branch, usually a guard.
  `cond.*` builds the filter-then-compare form that DOES run there, and handles the operand
  direction (the engine's `in` filter pipes the ARRAY, the reverse of `contains`): `cond.in`,
  `notIn`, `contains`/`icontains`/`notContains`, `startsWith`/`endsWith` (+ `i` forms),
  `empty`/`notEmpty`, `isNull`/`notNull`, `between(v, lo, hi)`, `has(obj, path)`, `count(v, n)`.
  Each returns a `Comparison`, usable anywhere `expr(...)` is.
- A condition/`where` accepts a single `expr(...)`/`cmp(...)`, an `and()`/`or()` group, an array of
  those (ANDed), or (for `where`) a raw `Value`. `s.conditional`/`s.while`/`s.switch`, `db.query`,
  `precondition`, and the `array.*` predicates all take the same TREE shape (operators per above).
- ⚠ `mixed(a, { or: b }, { and: c })` reproduces a container whose terms do NOT all join the
  same way — pulled workspaces contain it. **Do not author it** (export warns `condition.mixed`). The
  stored form does not record the grouping, and the two places it can appear disagree: a
  branch (`s.conditional`/`s.while`/`precondition`) folds terms strictly left to right, so
  `a OR b AND c` is `(a OR b) AND c`, while a `db.query` filter applies the engine's
  AND-before-OR precedence and selects `a OR (b AND c)`. Write `and(or(a, b), c)` or
  `or(a, and(b, c))` — each says one reading in every context. Pulls report these as
  `ambiguous-condition`.
- A **filtered** operand (`withFilters(...)`) works inline in any condition/`where` (conditional,
  while, `db.query`/addon, …) — e.g. `cmp(withFilters(col("title"), fl.trim()), "=", inp("q"))`.
- **Compose a rule set as SIBLINGS, not a folded chain.** `and(...rules)` takes any
  number of terms and encodes flat; `rules.reduce((acc, r) => and(acc, r))` nests one
  container per rule, which costs quadratic bytes (512 terms: 394 KiB flat, 21 MiB
  folded) and is refused past 128 levels. Mixed joins: `and(or(...anyOf), ...allOf)`.
- e.g. `db.query({ table: posts, where: expr(col("author"), "=", auth("id")), as: "rows" })`.
