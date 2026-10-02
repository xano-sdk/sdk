# Authoring reference

Tables and fields, the statement and value surfaces, inputs, and the request-scoped machinery around them.

## Tables & fields

`f.*` covers the full column catalog — scalars, `f.timestamp`, the four file resources, the
six `f.geo.*` types, `f.enum(values)`, `f.vector(size)`, `f.object(children)`. A `json` column
can declare the shape stored inside it with `f.json({ children: [{ name, type }] })` — an
ordered array, unlike the named map `f.object` takes, because the engine persists json
children in the order given. Omit it for an unstructured json column. Foreign keys
are `f.tableRef(table)`, whose link resolves to the target table's guid at export — a
target that isn't registered on the same workspace fails **there**, naming the table and the
schema field, rather than during the import it would otherwise break. Any
scalar becomes a **list column** with `{ array: true }`, surfacing as `string[]` in
`InferRow`. Tables take a named-map schema, filter methods carry args (`"min:8"`), and
`views[]` encode through the shared comparison encoder.

- **A column `default` must stay within the BMP.** A 4-byte character (codepoint > U+FFFF,
  e.g. an emoji) is mangled into invalid UTF-8 by the engine's default pipeline, so it is
  rejected at export rather than 500ing at deploy with Postgres `22021`. Accents, `€`, and
  most CJK are fine; otherwise put the value on an endpoint input, applied at runtime bind.
- **`id` and `created_at` auto-inject** at the head of the schema unless `system: false` or
  you declare them (`idType: "uuid"` for a uuid key). A declared `id` is the primary key:
  `f.int()` or `f.uuid()`, made required whatever its options say; any other type is refused. A
  `system: false` table still declares `id` and a `primary` index on it. Both are usable wherever a column name
  is expected and both appear in `InferRow`. The standard indexes — `primary(id)`,
  `btree(created_at desc)`, plus `gin(xdo)` when the table stores fields as JSON —
  auto-prepend, de-duped against your own. Declare yours as
  `{ type, fields: [{ name, op? }] }`; `"unique"` is shorthand for `"btree|unique"`.
- **`use_xdo` picks the storage mode** — every field as JSON under the internal `xdo` column,
  or a real Postgres column per field. It is a workspace setting (default `false`) each table
  mirrors, overridable per table with `table({ useXdo })`, resolved at `export()` so the two
  can register in any order.

## Statements, values & inputs

The `stack` of a function/query/tool is a list of statements, all reachable through one
discoverable, typed namespace — `s`:

```ts
stack: [
  s.set_var("total", c.int(0)),
  s.math.add({ name: "total", value: c.int(5) }),
  s.array.find({ as: "hit", expr: ref("items"), if: expr(ref("$this"), "=", c.int(1)) }),
  s.conditional({ when: expr(ref("total"), ">", c.int(0)), then: [s.return(ref("total"))] }),
  s.function.run({ fn: getUser, as: "u", input: { id: ref("total") } }),
]
```

Tab-complete `s.` to explore. Each declarative statement takes one typed args object;
control-flow specials (`s.set_var`, `s.conditional`, `s.for`, `s.foreach`, `s.while`,
`s.group`, `s.switch`, `s.try_catch`, `s.return`, …) keep their authored signatures. **Every
statement also carries `description` and `disabled`** — inline on the object-arg factories,
a trailing options object on the positional specials. `disabled: true` is Xano's
commented-out state: the step stays in the stack and the engine skips it.

**Filter a statement's result as it binds.** Any statement with an `as` also takes
`asFilters` — the editor's `return as <var> | upper` — applied in order, from the same
`fl.*` catalog as value filters:

```ts
s.security.create_uuid({ as: "token", asFilters: [fl.upper()] })
s.set_var("email", inp("raw"), { asFilters: [fl.trim(), fl.lower()] })
```

It saves a follow-up `s.set_var` for the common "bind it in a different shape" case. A
statement that binds nothing does not offer the option.

**The chain retypes the value.** `InferResponse` folds each filter's declared result, so a
filtered binding reports what it actually holds rather than `unknown`:

```ts
s.db.query({ table: users, as: "rows", asFilters: [fl.count()] })       // rows: number
s.db.query({ table: users, as: "rows", asFilters: [fl.reverse(), fl.first()] })  // rows: Row
withFilters(ref("rows"), fl.count())                                    // number
```

Filters the engine declares as returning `any` — `get`, `set`, `transform`, `json_decode` —
fold to `unknown`, since no declaration could name their shape. Note this models a filter's
OUTPUT, not its input: a filter applied to a value it cannot accept returns `null` at
runtime rather than erroring, and still types as its declared result.

**Fields with a fixed set of values take a bare literal.** Where the engine accepts only
certain spellings, the field's type is that set, so autocomplete offers them and a typo is a
compile error rather than a runtime failure after deploy:

```ts
s.ai.external.mcp.tool.run({ url, tool, connection_type: "stream" }) // ✅ "sse" | "stream"
s.ai.external.mcp.tool.run({ url, tool, connection_type: "streaming" }) // ❌ compile error, and throws
s.ai.external.mcp.tool.run({ url, tool, connection_type: inp("mode") }) // ✅ resolved at runtime
```

`"stream"` and `c.text("stream")` encode identically — use whichever reads better. A value
the SDK can't evaluate (an `inp`/`ref`, or anything with a filter chain) is never checked,
so a computed field stays authorable.

One field is **resolved at encode time** and so is narrower than the rest: `s.db.query`'s
`returnType` picks which `context.return` block gets written, which has to happen before
there is a runtime. It takes the bare literal only — a tagged value is a compile error, and a
dynamic one (`inp`/`ref`, or any filter chain) throws rather than deferring. A spelling
outside the set throws too, in place of quietly falling back to `list`.

**The db family.** Single-record reads and mutations match one field
(`{ fieldName, fieldValue }`, defaulting to `id`) — there is no composite `(a, b)` form; for
a two-column lookup use `s.db.query` with a `where` array. Writes take a partial `row: {…}`,
and an `s.db.edit` writes **only** the columns you list, leaving every unmentioned column at
its stored value. A cell takes a tagged value or a **bare JS literal typed against its
column** — `row: { is_hidden: true, notes: "…" }` is exactly `{ is_hidden: c.bool(true),
notes: c.text("…") }`. The tag comes from the column, so the literal is checked against it:
a string on an `f.bool()` column is a compile error, and an `f.enum()` column keeps its
member union. Only `s.db.query` takes a `where`, and its `where`/`sort`/`paging`/`output`
are applied **by the engine**, not in your stack.

**Bulk writes: `bulk.update` REPLACES the row, `bulk.patch` doesn't.** `s.db.bulk.update`
writes every column an item omits to its zero value (`""`/`0`/`null`), with an HTTP 200 and
no error — `{ id: 7, status: "done" }` blanks the rest of row 7. `s.db.bulk.patch` writes
only the keys each item carries, which is what "update these rows" almost always means.
`export()` warns when a static `items` array omits columns of the bound table (and
`--strict` fails on it), but an `items` built from a `ref`/`inp` can't be inspected. Related:
`s.db.bulk.delete` with no `where` is a truncate, so it refuses to encode unless you say
`allRows: true`.

What each op binds decides your response type: `s.db.get` binds **`null`** on a miss (it does
not throw — null-check it), `s.db.add`/`edit`/`patch` bind the **full written row** including
auto-assigned `id`/`created_at`, `s.db.del` binds `null`, and `edit`/`del` **throw**
`NotFound` (404) when nothing matches. `InferResponse` derives all of that automatically.

`s.db.query` mirrors the whole Xano query builder — `returnType`, `bind` joins, computed
`eval` columns, `aggregate` groups, `distinct`, and the full operator set via
`cmp(left, op, right)` with `and(...)`/`or(...)` for boolean groups. Signatures are in
`llms/statements-data.md`; five behaviors are worth knowing here:

- **A join condition spells its two sides differently.** The joined table's column takes its
  `as` alias; this query's own columns stay bare:
  `bind: [{ table: users, as: "author", join: "left", where: expr(col("author_id"), "=", col("author.id")) }]`.
  Qualifying your own column by the table's name (`col("posts.author_id")`) resolves only if
  the query also sets `tableAlias` — the alias the qualifier is matched against. Unqualified,
  the engine reads the operand as a text literal and fails at runtime with a parse error
  naming the *other* operand, so `db.query` rejects that spelling at export instead.

- **A join adds no columns to the returned row.** With or without a `bind`, a row is the
  queried table's columns — which is what `InferResponse` types, so there is no `row.author`
  to read. To bring a joined column back, project it with an `eval` whose `name` is the dotted
  path: `eval: [{ name: "author.name", as: "author_name" }]` puts `author_name` on the row and
  on the inferred type. A *bare* name there fails at runtime (it qualifies to the base table),
  and a dotted joined column in `output` is dropped with no error.

- **Paging changes the response shape.** Supplying `paging` with metadata on (the default)
  returns a **paging envelope** — `{ items, curPage, nextPage, prevPage, offset, perPage,
  itemsReceived }`, plus totals when `totals: true` — instead of a bare `Row[]`, and
  `InferResponse` reflects that. Pass `metadata: false` to keep the bare array. Read
  `nextPage` (`number | null`) as the typed has-next signal.

  It also moves what `output` selects from. The selection applies to the value the statement
  binds, so under the envelope its roots are the counters and `items.<column>` —
  `output: ["itemsReceived", "curPage", "items.id", "items.title"]`. A bare column list there
  matches no envelope key, so every key is dropped and the endpoint answers `[]` at HTTP 200
  with no error. `export()` warns and `--strict` fails; with `paging: { metadata: false }` the statement
  binds the rows and bare columns are the right form.
- **Don't author `mixed(...)` conditions.** Xano's editor allows a container whose terms
  don't all join the same way, so pulled workspaces contain it and it round-trips — but the
  stored form doesn't record the intended grouping, and the two places it can appear
  disagree: a branch folds terms strictly left to right (`a OR b AND c` = `(a OR b) AND c`)
  while a `db.query` filter inherits SQL's AND-before-OR precedence (`a OR (b AND c)`). Write
  `and(or(a, b), c)` or `or(a, and(b, c))` — each says exactly one thing in every context.
- **`like`/`ilike` take the operand as the pattern, verbatim.** The operand *is* the pattern,
  so `cmp(col("body"), "ilike", inp("q"))` with a bare term matches only a whole-string equal —
  and the endpoint answers 200 with an empty list, which reads as "no results for that query".
  For substring search use `includes` / `not includes`, which wrap the operand in `%…%`
  themselves and match case-insensitively. Prefer that over building `"%" + term + "%"`: a
  hand-built pattern is non-empty even for a blank term, which defeats the `ignoreEmpty` below.
  `contains` / `@>` / `overlaps` are JSON and array containment, not text — on a text column
  they fail with a parse error.
- **`ignoreEmpty` DROPS the clause — it does not match zero rows.** `cmp(col("owner"), "in",
  ids, { ignoreEmpty: true })` with an empty `ids` returns the **unfiltered** table, where the
  same clause without the flag matches nothing. Never put it on a filter that scopes rows to a
  permitted set: an empty permission list then returns everything. It is for an optional search
  filter, where a blank box really does mean "don't filter". `export()` warns when the operand
  is empty in the bundle; a runtime-empty list is yours to reason about.
- **Compose a rule set as siblings, not a folded chain.** `and(...)`/`or(...)` take any number
  of terms and encode flat, so build the array and spread it — `and(...rules)`. Folding one term
  at a time (`rules.reduce((acc, r) => and(acc, r))`) nests a container per rule, and nesting
  costs quadratic bytes: 512 terms are 394 KiB as siblings and 21 MiB folded. Past 128 levels the
  build fails with a message naming the fix. Mixing joins? Group each run: `and(or(...anyOf), ...allOf)`.
- **An aggregate or `eval` `name` is written bare** (`"status"`) and alias-qualified on emit;
  the engine rejects a bare column in either, and an already-dotted joined column passes
  through. The statement also declares the alias it qualified with, so the qualified name
  resolves — nothing to set by hand.
- **`eval` is where vector search lives.** An `eval` filter pipeline compiles to SQL, so it
  resolves a different filter registry than `fl.*` (which runs in the request) — including
  the distance filters an `f.vector` column needs. Compute the distance, then sort by the
  alias it grafts onto the row; the ranking happens in the database, over the column's index:

  ```ts
  s.db.query({
    table: chunk,                                     // index: [{ type: "vector", fields: [{ name: "embedding", op: "vector_cosine_ops" }] }]
    eval: [{ name: "embedding", as: "distance",
             filters: [{ name: "vector_cos_distance", arg: [inp("q")] }] }],
    sort: [{ sortBy: "distance", dir: "asc" }],       // nearest first
    paging: { per_page: 10, metadata: false },
  })
  ```

  Match the filter to the index `op` (`VECTOR_FILTERS`, on `@xano/sdk/internal`, lists the
  family). The same filter
  works on a `where` operand to cut off *by distance* rather than by row count.
- **A `where` operand may carry filters — except the request-time timestamp ones.** A `where`
  is compiled into SQL, and most filters have a SQL form there (`trim`, `concat`, `upper`,
  `lower`, and the `epochms_add_day` / `epochms_sub_month` family). The request-time timestamp
  filters do not — `epochms_transform`, `epochms_add_ms`, `epochms_add_secs`, `epochms_date`,
  `epochms_from_format` — and the engine doesn't degrade gracefully: the request dies with a
  bare fatal naming nothing. For a relative cutoff, use the SQL-side family through `qf.*`
  (`fl.*` has no builder for it): `withFilters(c.now(), qf.epochms_sub_hour(1))`,
  `qf.epochms_add_day(7)`, … — or compute it in an earlier `s.set_var` and `ref()` that.
  `export()` warns; a bare `c.now()` is always fine.
- **A `s.switch` case without `break: true` falls through.** The engine's default is
  fallthrough, so a matched case also runs every *later* case body — and the `default` block
  too. Whatever those bodies write gets written two or three times, at HTTP 200, with `tsc`
  and a plain `export` both clean. Set `break: true` on every case unless you mean the
  cascade; `export()` warns when a break-less case has somewhere to fall into.

**Addons** enrich each returned row with related data, attached to the row-returning ops
(`query`/`get`/`add`/`edit`/`patch`). An addon is a single table-bound db query rather than a
statement stack: `addon({ table, where, output, cardinality })`, where `where` binds it to
the parent row and `cardinality` shapes the graft (`"single"` object, the default `"list"`,
`"count"`, `"exists"`, `"aggregate"`).

```ts
export const authorAddon = addon({
  name: "author",
  table: userTable,
  where: expr(col("id"), "=", inp("user_id")),   // bind to the parent row
  output: ["id", "name"],
  cardinality: "single",
  input: { user_id: input.int({ required: true }) },
});

s.db.query({
  table: post,
  addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") } }],
  as: "rows",
});
```

Attaching a typed handle merges the graft onto the row shape in `InferResponse` with no cast;
a **bare-name** reference grafts `unknown`. Author `as` relative to a row (`_author`) — when
the query returns a paging envelope the `items[]` offset is added for you. If an alias
**shadows an existing column** the build throws, because the engine would silently overwrite
that column at runtime (Xano convention: prefix with `_`).

**Values** — `c.int/text/bool/decimal/null/obj/array`, `c.now()`, `ref(var)`, `inp(input)`,
`col(name)`, the context refs `auth(path?)`/`env(name)`/`setting(name)`/`sys.*()`,
`out(name)` for a parent-row column in an addon input, and `toolset(path)` for the token
and URL parameters bound while a tool runs under its toolset. `withFilters(value, fl.a(), fl.b())`
attaches the value pipeline from a typed catalog of filters generated from the engine's own
sources.

- **`c.obj`/`c.array` take plain JSON literals only.** A nested tagged value
  (`inp`/`ref`/`auth`/`c.*`) is a compile error. For a computed object — a response, or an
  `api.request` `params` — use a record of values (`{ count: ref("count") }`). For a dynamic
  object argument use `obj({...})`, which builds a checked expression.
- **An `obj({...})` member may carry a filter chain.** That matters most for the null-safe
  drill: `db.get` binds `null` on a miss, so `obj({ city: ref("row.address.city", { safe: true }) })`
  is the normal shape — no per-member `s.set_var` to hoist it out. `c.now()`, `env()` and
  `sys.*()` are members too. `{ safe: true }` is for a base that exists and may be null: on a
  base nothing binds it would hide a typo behind a `null`, which is why `export()` warns
  (with a did-you-mean) when a `ref()`'s base segment names no `as` in that stack.
- **`c.int` takes a string or bigint past `Number.MAX_SAFE_INTEGER`.** The engine stores
  integers as strings and has no 53-bit limit, so `c.int("18446744073709551615")` is exact
  where the number literal for it is already `…616`. A `number` that is not a safe integer
  throws rather than encoding the rounded value.
- **A bare scalar works in any `fl.*` argument.** `fl.get("a.b", 0)` encodes identically to
  `fl.get(c.text("a.b"), c.int(0))`; strings, numbers and booleans are all wrapped for you.
  Objects and arrays still need `c.obj`/`c.array`.
- **A typed `fl.*` call is capped at its declared argument count.** Passing more throws,
  in the type and at runtime — an extra argument used to ride into the filter's arg list for
  the engine to ignore or fail on. `filter("name", …)` is the untyped escape. Seven filters the
  catalog under-declares stay variadic (`concat`, `index_by`, `get`, `array_merge`,
  `array_merge_recursive`, `jwe_encode`, `jwe_decode`). The other 102 filters take **no**
  arguments at all — they are emitted `()`, so `fl.abs(x)` is a compile error rather than an
  argument silently shipped to an engine that does not accept one.
- **`api.request` headers take a `{ "Name": value }` record**, values may be tagged:
  `headers: { "x-api-key": env("KEY") }`. Prefer a header over a `?key=` query param for a
  credential — a URL travels into access logs, proxies and `Referer`. That is not envelope
  safety, though: the `as` envelope's `request` half mirrors `url`, `params` **and**
  `headers`, so never return it raw from a credentialed request; read `response.result`.
- **Some filters require an argument their own docs call optional.** Filter arguments are
  positional, and a short call is refused by the engine before the filter runs — so
  `fl.csv_encode()` and `fl.number_format()` are compile errors here rather than a failure on
  a deployed endpoint. Which filters those are is probed, not declared: `fl.round()` is also
  documented optional and genuinely works. Pass every argument the signature shows without a
  `?`; the runtime guard names the count if you reach it from JavaScript.

  ```ts
  withFilters(ref("rows"), fl.csv_encode(",", '"', "\\")), // not fl.csv_encode()
  ```

- **`fl.csv_encode` writes no header — `fl.csv_create` is the one that does.** They read as
  interchangeable and are not. `csv_encode` emits each row's values in *that row's* key order
  with no normalization across rows, so rows whose keys differ in order or count misalign
  columns silently; nested cells are JSON-encoded, `false` writes empty, and a piped array of
  scalars collapses to a single line. `csv_create` takes the column names as its **piped**
  value and the data as its `rows` argument.
- **Only `fl.fsort({ type: "number" })` sorts numerically.** Every other comparator —
  including a spelling the engine does not recognize — sorts as case-insensitive text,
  silently and with no error, so `[2, 10, 1]` comes back `[1, 10, 2]`. A lexicographic sort
  agrees with a numeric one whenever the values share a digit count, so this looks correct
  on small data and goes wrong on real data: a "top N by score/distance/recency" endpoint
  returns the right rows in the wrong order. The union rejects the two plausible wrong
  spellings (`"decimal"`, `"int"`) outright.

  ```ts
  withFilters(ref("rows"), fl.fsort({ path: "score", type: "number", asc: true })),
  ```
- **`col()` does not resolve to a stored value inside a `db.edit` `row`.** To
  read-modify-write a column — incrementing a counter — `db.get` the row first and pipe its
  bound value through a filter. `col()` evaluates to `null` there, so `fl.add(1)` computes
  `null + 1` and the engine aborts.

  ```ts
  s.db.get({ table, fieldValue: inp("id"), as: "current" }),
  s.db.edit({ table, fieldValue: inp("id"), row: { clicks: withFilters(ref("current.clicks"), fl.add(c.int(1))) } }),
  ```

  That pair is **not atomic** — concurrent writers can lose an increment, and no atomic
  increment statement exists. A genuinely safe counter needs the arithmetic in the database
  via `s.db.direct_query`, which in turn needs the table's *physical* Postgres name; that
  name is assigned at import and is not knowable from a `table()` def, so it has to be
  hardcoded after inspecting the deployed table. A typed path requires an engine change
  ([issue #35](https://github.com/xanots/sdk/issues/35)).
- **A JavaScript body is written as a function, not a `c.text` string.** The lambda
  statement (`s.lambda`) and eight filters (`fl.map`/`filter`/`some`/`every`/`find`/
  `findIndex`/`reduce`/`lambda`) run JavaScript against a small, closed set of injected
  identifiers — and which ones are in scope depends on the surface. Write the body inline
  and the **surface is implied by where it sits**: the bindings are the function's
  parameters, typed from the position, so your editor supplies them and a wrong name is a
  compile error rather than a wrong value in production.

  ```ts
  // reduce's accumulator is `$result`. Autocomplete says so; `$acc` does not compile.
  withFilters(ref("prices"), fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })),

  // A map body, typed as a map body — nothing names the surface.
  withFilters(ref("prices"), fl.map(({ $this, $index }) => $this * ($index + 1))),

  // The statement surface binds ambient state only: `$this` here is a compile error.
  s.lambda({ as: "total", code: ({ $var }) => $var.subtotal * 1.2 }),
  ```

  The parameters are a fiction — only the **body** is sent, and the engine injects the
  bindings as free identifiers — so destructure them. `(b) => b.$this * 2` would emit
  `return b.$this * 2` with `b` undefined at runtime, and the SDK refuses it. Keep each
  binding's own name: `({ $this: item })`, a nested pattern, a default or a rest element is
  refused the same way, since only the body — never the pattern — reaches the engine.

  **`fl.transform` is not one of these.** It sits next to them and reads like one, but it
  takes a Xano *expression* — no `return`, and the piped value binds as `$0` (or `$$`),
  not `$this`. A `$this` there resolves to null and the call still returns HTTP 200, so
  the SDK refuses both spellings at author time and points at `$0`.

  ```ts
  // An expression over the piped value — not a JS body.
  withFilters(ref("prices"), fl.transform("$0 * 1.2")),

  // Parenthesize a pipe inside an object literal, or the filter argument's comma is read
  // as the key separator and every later key silently vanishes.
  withFilters(ref("items"), fl.transform('{ names: ($0|sort|join:","), n: ($0|count) }')),
  ```

  For a body built away from its call site, `lam.*` names the surface explicitly:

  ```ts
  const rate = 0.2;
  // Nothing from the enclosing scope crosses implicitly — declare what the body needs.
  // The capture key must differ from the module binding: the loader renames one of two
  // same-named bindings and the prelude is written under the original name.
  s.lambda({ as: "vat", code: lam.fn(({ $var }, { capturedRate }) => $var.total * capturedRate, { surface: "s.lambda", capture: { capturedRate: rate } }) }),
  ```

  Omit `surface` and the check is deferred to wherever the body lands, which is the thing
  that knows. `lam.file("./lambdas/total.ts")` (relative to the calling module, like an
  import) reads a default-exported function of the
  same shape from its own type-checked module — the deterministic option under a bundler,
  where a function's own source is whatever the bundler emitted. It needs a filesystem, so
  it ships on the Node entry only: `import { lam } from "@xano/sdk/node"`, whose `lam`
  carries `fn` and `raw` unchanged. `lam.raw(code)` is the text escape hatch, guarded
  identically, and works on either entry. The full
  binding table per surface is in `llms/lambda.md`.

  Three things to know, all live-verified against a real engine:

  - A body that **throws does not fail the request** — the engine returns its diagnostic
    text as the value with HTTP 200, so the failure arrives as bad data rather than an
    error. That is engine behavior and not interceptable from an SDK; validate before
    consuming a lambda result numerically, and prefer an authored body, which cannot fail
    that way for a binding reason.
  - The body is a **function body, not a module**: it must `return`, and a top-level
    `import` is a syntax error. Reach a dependency through the **preloaded globals** —
    `crypto`, `fetch`, `Buffer`, `axios`, `jose`, `_`, `math`, `moment`, `DateTime`,
    `uuid` and friends, which need no specifier. A dynamic `import("…")` or `require("…")`
    with a **literal specifier is not portable**: some instances bundle the body before
    running it and resolve every literal specifier ahead of time, so `await
    import("node:crypto")` comes back as the text `Could not resolve "node:crypto"` with
    HTTP 200; others resolve it at run time and it works
    ([issue #265](https://github.com/xanots/sdk/issues/265)).
  - `console` output goes to the **request log**, not stdout.

  A plain `c.text(...)` body is still accepted and gets the same build-time check — the
  guard sits at the call site, not inside `lam.*` — so an unknown `$identifier` fails
  whichever way you write it ([issue #221](https://github.com/xanots/sdk/issues/221)).
- **`c.expression("…")` is carried through verbatim and NOT validated.** Xano SDK does not
  parse it or type-check it; nothing inside participates in `InferResponse`, so a var named
  there is invisible to a rename that updates every typed `ref()`. A malformed expression
  fails at runtime; one that is merely wrong (`$var.tota1`) returns a wrong answer. Reach for
  it only for syntax the typed surfaces can't express — `~` concatenation, inline arithmetic,
  conditionals — and note it is **not** the `expr()` condition builder.
  (`c.expressionLegacy` exists only so `codegen` can return an older stored form.)

**System / request variables (`sys.*`).** Xano's built-in request context reads as
`$env.$remote_ip` in XanoScript — note the **second `$`**: these are settings with a
`$`-prefixed name, the same tag `env()` emits. That prefix is the footgun, because
`env("remote_ip")` reads a workspace env var literally named `remote_ip` (almost always
unset → null) rather than the caller's IP. `sys.*` spells the prefixed names for you:

| accessor | var | | accessor | var |
|---|---|---|---|---|
| `sys.remoteIp()` | `$remote_ip` | | `sys.datasource()` | `$datasource` |
| `sys.requestMethod()` | `$request_method` | | `sys.branch()` | `$branch` |
| `sys.requestUri()` | `$request_uri` | | `sys.tenant()` | `$tenant` |
| `sys.requestQueryString()` | `$request_querystring` | | `sys.release()` | `$release` |
| `sys.httpHeaders()` | `$http_headers` | | `sys.platform()` | `$platform` |
| `sys.requestAuthToken()` | `$request_auth_token` | | `sys.isDebugger()` | `$debugger` |
| `sys.apiBaseUrl()` | `$api_baseurl` | | | |

`setting("$<name>")` covers anything `sys` doesn't. The one that matters most in practice is
`sys.remoteIp()`, the rate-limit key for public endpoints.

**Inputs** — `input.*` mirrors `f.*` exactly: every engine-legal field type is a valid
function/query input, with `input.object(children)` and `input.list(element)` for structured
shapes. Comparisons use `= != > < >= <=`.

Binding coerces rather than rejects in two places. `input.timestamp` takes a number as epoch
**milliseconds** unchanged, so epoch seconds (`date +%s`) land in 1970, and it drops the
fractional seconds of an ISO-8601 string. `input.list` wraps a non-array into a one-item list,
and an `input.object` given a non-JSON string binds its children's defaults. When the shape
must hold, mark an object child `required: true` or check it with `s.precondition`.

**Validate input at the boundary.** Field types don't enforce arbitrary
rules, and `s.precondition` raises a **status-bearing** error a client can detect via
`res.ok` — unlike `s.throw`, which returns 200 with an error body. `error_type` picks the
status: `badrequest`/`inputerror` → 400, `unauthorized` → 401, `accessdenied` → 403,
`notfound` → 404, `toomanyrequests` → 429, `standard` (the default) → 500.

```ts
s.precondition({
  // `fl.regex_test` is PATTERN-piped: the piped value is the regex and the arg is the
  // text tested — the reverse of `istarts_with`. Build the pattern with `c.regex(...)`,
  // which delimiter-wraps it (a bare `c.text("^…")` is an invalid PCRE matching nothing).
  expr: expr(withFilters(c.regex("^https?://", "i"), fl.regex_test(inp("url"))), "=", c.bool(true)),
  error_type: "badrequest",
  error: c.text("url must be an http(s) URL"),
})
```

**Normalize on the input, not in the stack.** `methods` run at bind, before your stack, so
`input.email({ methods: ["lower"] })` makes `inp("email")` read already-normalized. Don't
reroll `trim`/`lower`/`upper` into a var.

**Email/password auth.** The trap: `input.password()` **hashes on bind**, so a password
typed that way is already a hash before your stack runs, and `check_password` then compares
hash against hash — login always fails. Take the password as **plain text** and let the
`f.password` *column* hash it on write; `check_password` compares the plaintext submission
against the stored hash.

```ts
// Signup — plaintext in; the f.password COLUMN hashes on write.
query({ name: "signup", verb: "POST", apiGroup: authApi,
  input: { email: input.email({ required: true }), name: input.text(),
           password: input.text({ required: true, methods: ["min:6"] }) }, // NOT input.password()
  stack: [
    s.db.add({ table: usersTbl,
      row: { email: inp("email"), name: inp("name"), password: inp("password") }, as: "user" }),
    s.security.create_auth_token({ table: usersTbl, id: ref("user.id"), as: "token" }),
  ],
  response: ref("token") });

// Login — plaintext compared against the stored hash.
query({ name: "login", verb: "POST", apiGroup: authApi,
  input: { email: input.email({ required: true }),
           password: input.text({ required: true }) },                     // NOT input.password()
  stack: [
    s.db.get({ table: usersTbl, fieldName: "email", fieldValue: inp("email"),
               output: ["id", "email", "password"], as: "user" }),
    s.precondition({ expr: expr(ref("user"), "!=", c.null()),
      error_type: "accessdenied", error: c.text("Invalid email or password.") }),
    s.security.check_password({ text_password: inp("password"),            // plaintext
      hash_password: ref("user.password"), as: "ok" }),
    s.precondition({ expr: expr(ref("ok"), "=", c.bool(true)),
      error_type: "accessdenied", error: c.text("Invalid email or password.") }),
    s.security.create_auth_token({ table: usersTbl, id: ref("user.id"), as: "token" }),
  ],
  response: ref("token") });
```

Reach for `input.password()` only when you specifically want its bind-time hash **and** are
not also feeding it to `check_password`.

## Middleware, request history and env vars

A `middleware({...})` is reusable logic (`input`/`stack`/`response` + `resultStrategy:
"merge"|"replace"` + `exceptionPolicy`). To run one, *attach* it with a host's
`middleware: { pre, post }` field on `query`/`apiGroup`/`defineFunction`/`task`/`tool`
(not triggers). Prefer a def handle over a bare name, the same rule as `auth`/`apiGroup`
references; `{ middleware: mw, active: false }` keeps an entry but disables it.

```ts
query({
  name: "get_user", verb: "GET", apiGroup: blog,
  middleware: { pre: [rateLimit], post: [audit] },
  stack: [/* ... */], response: ref("user"),
});
```

- **`exceptionPolicy` decides whether a guard is a guard.** Xano SDK always writes this
  field and defaults it to **`"rethrow"`**, so a rate limit or auth check you author here
  aborts the request as intended even with the field unspelled. `"rethrow"` surfaces the
  authored `error`/status (a tripped `s.redis.ratelimit` → 429) while still running `post`;
  `"critical"` is the same but skips the `post` chain. That is the only difference.
  `"silent"` swallows the throw and lets the request through — advisory middleware only.
  The **engine** falls back to `"silent"` when the field is absent *entirely*, which Xano SDK
  never emits; a middleware created in the workspace UI or carried in from a pulled
  workspace can be in that state, and there an unspelled guard is not enforced.
- **Inheritance is override, not merge.** Providing a phase overrides it; omitting a phase
  inherits the parent tier's chain, resolved at request time **Query → API Group →
  Workspace**. `pre: middleware.clear()` overrides a phase with nothing.
- **Setting `workspaceConfig.middleware` at all emits the whole map.** Any host/phase you
  don't list is emitted empty, which **clears** that tier on deploy. Omit the field entirely
  to leave the workspace's existing middleware untouched. The same wholesale rule applies to
  `datasources`.
- **A public host has no caller identity for `auth()` to resolve**, and a `pre` middleware
  runs after auth resolution. A rate limit keyed by `auth("id")` on a public endpoint does
  not degrade to a shared bucket — the request **fails with a 403 on the first call**, under
  `max`, with the host never running. Key off `sys.remoteIp()` instead.
  `export()` warns on direct attachment of an `auth()`-keyed middleware to a host where
  `auth()` may be null.
- **`resultStrategy` applies to the accumulator of the phase the middleware is attached
  to, and those are two different things.** In **`post`** the accumulator is the host's
  **result**, so a returned `response` changes what the CALLER receives. In **`pre`** it is
  the host's **request inputs**, so a returned `response` changes what the HOST receives.
  `merge` folds key-by-key, `replace` substitutes wholesale; either way the next entry in
  the chain sees the updated value. A `pre` + `replace` middleware therefore discards every
  input the caller sent that it does not re-emit, and a dropped input becomes unreadable —
  a 500, even where the input is declared `required: false`, because defaulting has already
  happened by the time the override lands.
- A `resultStrategy: "replace"` middleware attached `post` rewrites the response at runtime,
  which `InferResponse` can't see — declare `responseShape` on the endpoint.
- `workspaceConfig` also carries `realtime`, `documentation`, and `swagger`, which are
  server-shaped and carried verbatim rather than authored. `realtime` there is the **legacy**
  workspace-level block, not the realtime primitives you author.

**The canonical rate-limit middleware.** Build the per-user key with the filter chain
(`"prefix" + auth("id")` doesn't exist):

```ts
const writeRl = middleware({
  name: "write_rl",
  exceptionPolicy: "rethrow", // a tripped limit must abort (silent would let it through)
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("rl:write:"), fl.concat(auth("id"))), // "rl:write:<id>"
      max: c.int(10), ttl: c.int(30), error: c.text("Too fast."),
    }),
  ],
});

query({ name: "create_post", verb: "POST", apiGroup: blog, auth: users, // authed ⇒ per-user
  middleware: { pre: [writeRl] }, stack: [/* ... */], response: ref("post") });
```

On a **public** endpoint key off the client IP instead — `sys.remoteIp()` — since
`auth("id")` does not resolve there and the request 403s. And note the **shared-bucket rule**: co-attaching one middleware
object to N hosts means all N share the same key and therefore one counter, so `max: 10` is
a global budget across them. Vary the key (fold the host name into the prefix) for an
independent limit per host.

**Reading the request, or the response, in a middleware.** `s.util.get_all_input({ as: "payload" })`
binds a **`{ type, vars }` envelope whose `vars` depends on the phase** the middleware is
attached to:

| phase | `vars` holds | read a field at |
|---|---|---|
| `pre`  | the host's request inputs | `ref("payload.vars.<field>")` |
| `post` | `{ status, result }` — the host's outcome; plus `payload` when the host failed with an error payload | `ref("payload.vars.result.<field>")` |

The un-nested path (`ref("payload.<field>")`) is the usual cause of an `Unable to locate var`
500 in `pre`. In `post` the request path fails the same way — **after the host already ran and
its writes landed**, so under the default `rethrow` the caller gets a 500 for work that
succeeded. `export()` warns on it. To read the request in a `post` middleware, use
`s.util.get_raw_input({ as: "body" })`, which returns the request body:

```ts
middleware({
  name: "audit_post",
  resultStrategy: "merge",
  stack: [
    s.util.get_all_input({ as: "payload" }),   // { type: "post", vars: { status, result } }
    s.util.get_raw_input({ as: "body" }),      // the request body
    s.set_var("audit", obj({ id: ref("payload.vars.result.id"), note: ref("body.note") })),
  ],
  response: { audit: ref("audit") },
});
```

**Request history** — the per-object execution trace behind Xano's debugger, authored as a
single scalar `history` field: `false` off, `true` on at the default depth, a **number** =
capture depth (statement executions recorded per record, *not* records retained), `"all"` =
unlimited. **Omitting it inherits**; any value stops inheriting. Inheritance resolves
**object → container → workspace** (a query from its API group, a tool from its
toolset/agent, everything else straight from the workspace). Per-kind defaults when
inheriting: query / task / tool capture **on**; function / trigger / middleware **off**.
`workspaceConfig.history` is wholesale in the same way the middleware map is.

```ts
query({ name: "get_user", verb: "GET", history: 100 });   // capture, depth cap 100
apiGroup({ name: "blog", history: false });               // default for its queries
workspaceConfig({ history: { query: 100, trigger: "all" } });  // name inherited from workspace("…")
```

**Workspace environment variables** — author them as a name→value map on the workspace
object; read them at request time with `env("NAME")`:

```ts
workspaceConfig({
  name: "my-app",
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY!,          // sourced from the deploy environment
    APP_BASE_URL: "https://my-app.example.com",   // a plain config value
  },
});
```

**Values are secrets.** Prefer sourcing them from the deploy environment over committing
literals, and don't commit a compiled bundle holding real ones. Deploying sets the vars you
declare; omit the field to leave the workspace's existing env untouched.

Better still, keep the value out of the repo entirely: declare the NAME here with an empty
value and keep the value in `xano/.env`.

```ts
workspaceConfig({ name: "my-app", env: { STRIPE_KEY: "" } });
```

```bash
# xano/.env — gitignored, preserved across a pull, and read with no flag by every
# command that compiles a bundle (deploy, export, preflight).
STRIPE_KEY=sk_live_...
```

`xano/.env.example` is generated beside it listing the declared names, and `xanosdk env pull`
fills `xano/.env` from a running backend after confirming. Two flags override the default:

```bash
xanosdk deploy --backend-env-file ci.env                  # REPLACES the default (CI has no xano/.env)
xanosdk deploy --env-var STRIPE_KEY=sk_live_...   # one value, beats both files
```

A deploy REPLACES the workspace's env set, so a declared name that no file and no flag
supplies would clear the live value — `deploy` refuses instead, naming the variables;
`--allow-empty-env=STRIPE_KEY` clears that one on purpose. `export` and `preflight` report
rather than refusing: one writes a file, the other imports into a throwaway tenant.

### The documentation token

The token gating a hosted doc site is a secret too, and it lives in `xano/.secrets.json` —
gitignored, beside `xano/.env` but not in it. Source declares only the GATE:

```ts
workspaceConfig({ documentation: { require_token: true } })
apiGroup({ name: "Public API", swagger: true, documentation: { require_token: true } })
```

That is the whole declaration. There is no variable name to pick, because a documentation token
has no name — it belongs to an object (this workspace, that API group), and the sidecar stores
it under that object's identity. An API group is keyed by its **guid**, not its name, so two
groups that legitimately share a name keep their own tokens.

A literal `token` in source fails the export — there is no migration path, because declaring
the gate covers every use and the literal form's only distinguishing property is that it commits
a secret. `xanosdk pull` writes the value to the sidecar, reports every scope it carried, and
every build reads it back, so pull-then-deploy restores the gate with no step in between.

A gate you write here is the other direction: there is no live value to pull, because the
object has never had one. `xanosdk secrets fill` mints one for every declared gate the sidecar
has no value for, and leaves every value it already holds alone:

```bash
xanosdk secrets fill                      # or `xanosdk secrets fill ./xano/index.ts`
```

It writes nothing when every gate is already filled, so it is safe to re-run. A minted token
gates nothing until a `deploy` sends it.

This token is **not** a backend env var. It never reaches the workspace's own env, and `env(...)`
in a stack cannot read it.

`deploy` refuses on a declared gate nothing supplies, with `--allow-empty-doc-token=<scope>` as
the per-scope opt-out — and unlike its backend sibling, that opt-out *opens* something: it
clears the target's gate and makes those docs publicly readable. Without the flag, an
unsupplied gate emits no `documentation` block at all — which leaves the workspace's gate
alone, but would clear a group's, so a group that publishes docs and declares a gate with no
token fails the export on every command rather than writing a bundle no later refusal could
catch.
A merge (`--keep-data`, or `--to` without `--replace`) never writes the workspace's block, so
it does not require the workspace's token, and the opt-out is not applied there; a group's
gate is still required, since a merge writes a group's docs.

See [Environment & secrets](environment.md) for the CI inputs (`--secrets-file`, `--doc-token`)
and what a pull does when it cannot confirm the file is ignored.

**The two blocks behave oppositely on omission, and this is the part that bites.** Omitting
`documentation` from the workspace config emits no key, so a deploy leaves the target's block
alone. Omitting it from an API group does *not*: an absent key on a group is written as the
engine default on import, which clears that group's gate. So a group you want gated must say
so every time. `export` warns once per build naming every group whose docs the deploy would
leave publicly readable, and `--strict` turns that into a failed build.

**Across environments.** A `release` merge is ADD-ONLY and matched by name: a name the target
already has keeps the target's value, so one release can be promoted to several environments
without carrying the creds it was cut with. Set each target's env once and the release's own
values stay inert. Two consequences to plan around:

- A release carries no env values. A **newly declared** name the target does not hold yet
  is not created by `promote` or `tenant deploy`: the release's objects read it as null there
  until it is set. Both commands name every env var the release reads that the target lacks,
  before the confirmation, with the `printf %s "$VALUE" | xanosdk env set NAME --to … --yes`
  that sets it.
- `deploy --to workspace --replace` rebuilds the workspace, so the env set becomes exactly what the config
  declares. Every env var the target holds that your config does not declare is DROPPED —
  including ones set through the UI or by an earlier release. A replace names those before it
  runs and asks to confirm, because the value is not recoverable from anything the project
  holds: by definition the project never declared it. Declare the name to keep it, or merge
  without `--replace`.

> ⚠️ The refusal is part of the COMPILE, so `xanosdk deploy --bundle <path>` does not get it:
> a pre-built bundle carries whatever env it was built with, and deploying it sends exactly
> that. A build-once-deploy-the-artifact pipeline therefore has to resolve its values at
> BUILD time — pass `--backend-env-file`/`--env-var` to the `export` that produces the bundle, and
> treat that export's "declared names are unsupplied" warning as the gate — `export --strict`
> fails on it — because nothing re-checks it later.

A value passed with `--env-var` exists only for the length of that process, and no value is
ever printed back. Declaring the name is what keeps it checkable: `typedEnv(config)` turns the
declared names into properties, so `E.STRIPE_KEY` autocompletes and `E.STRIP_KEY` is a
compile error, and `export()` warns (`stack.env-undeclared`) on any `env()` naming something
outside the set.

```ts
const E = typedEnv(wsConfig);
s.api.request({ url: c.text("https://api.stripe.com/v1/charges"), headers: { Authorization: E.STRIPE_KEY } });
```

A name that does not exist resolves to **null** rather than erroring, which is why this
matters: a typo deploys clean, the request succeeds, and the failure surfaces somewhere
downstream of the missing value.

Do NOT confuse this with `deploy --static-env`, which bakes PUBLIC config into the HTML a
browser downloads. One is a workspace secret; the other is visible to everyone.


## Receiving a webhook

Every SaaS integration needs the same four steps, and two of them are inert unless they come
before the thing they protect. All the pieces exist already — what follows is the ORDER.

```ts
export const webhookEvents = table({
  name: "webhook_events",
  schema: { provider_event_id: f.text({ required: true }), payload: f.json() },
  // The durable duplicate guard: a replayed event id fails the insert.
  index: [{ type: "unique", fields: [{ name: "provider_event_id" }] }],
});

export const stripeWebhook = query({
  name: "stripe_webhook",
  verb: "POST",
  apiGroup: api,
  // 1. No declared `input`. The body must be read RAW — anything the input
  //    layer parses and re-serializes is a different byte string, and the
  //    signature is over the bytes the provider actually sent. `encoding:
  //    "none"` binds those bytes as one string; the default (`"json"`) binds a
  //    JSON body as an object, which `hmac_sha256` refuses (500).
  stack: [
    s.util.get_raw_input({ as: "raw", encoding: "none" }),
    s.set_var("headers", sys.httpHeaders()),

    // 2. Recompute the signature over the raw body with the shared secret…
    s.set_var("expected", withFilters(ref("raw"), fl.hmac_sha256(env("STRIPE_WEBHOOK_SECRET")))),
    //    …and compare it BEFORE anything else reads the payload. A guard that
    //    runs after the work is not a guard.
    s.precondition({
      // Header keys arrive Title-Cased whatever the provider sent, so a
      // lowercase "x-signature" reads null in production.
      expr: expr(withFilters(ref("headers"), fl.get("X-Signature")), "=", ref("expected")),
      error_type: "unauthorized",
      error: c.text("Bad signature."),
    }),

    s.set_var("event", withFilters(ref("raw"), fl.json_decode())),

    // 3. Idempotency. `create_only` makes this a CLAIM rather than a write: it
    //    succeeds exactly once per key, so a replay — and providers do retry —
    //    takes the false branch instead of processing the event twice.
    s.redis.set({
      key: withFilters(c.text("wh:"), fl.concat(ref("event.id"))),
      data: c.bool(true),
      ttl: c.int(every("7d")),
      create_only: c.bool(true),
      as: "claimed",
    }),
    s.conditional({
      when: expr(ref("claimed"), "=", c.bool(true)),
      then: [s.db.add({ table: webhookEvents, row: { provider_event_id: ref("event.id"), payload: ref("event") } })],
    }),
  ],

  // 4. Answer 200 either way. A provider that sees a non-2xx retries, and a
  //    duplicate is not a failure — returning an error for one is how a retry
  //    storm starts.
  response: { received: c.bool(true) },
});
```

Four things that are easy to get wrong:

- **Declaring `input` breaks the signature.** The raw body and the re-serialized one differ
  in whitespace and key order, so the HMAC will not match and every delivery is rejected.
- **The header name is whatever the provider uses** (`X-Signature`, `Stripe-Signature`,
  `X-Hub-Signature-256`, …) — read it Title-Cased, however the provider spells it — and several providers prefix the digest or pack a timestamp
  alongside it. Read the provider's spec for the exact string being signed — some sign
  `timestamp + "." + body`, not the body alone.
- **`create_only` is the whole idempotency mechanism.** Without it the write always succeeds
  and the branch always runs, so the guard reads as present and does nothing.
- **Redis is an instance capability.** On an instance without cache support every
  `s.redis.*` statement fails at request time; `xanosdk export` lists what a bundle needs.
  The unique index on `webhook_events.provider_event_id` above is the durable fallback — the insert fails on a
  duplicate rather than being skipped, so wrap it in `s.try_catch` if you take that route.

Give the endpoint no `auth`: the signature IS the authentication, and a webhook caller has
no Xano identity to present.



## Seed data

Give a table `seed` rows and they ship into the database on deploy — so a fresh
environment comes up with lookup tables, demo content, or fixtures already in place,
not empty:

```ts
const product = table({
  name: "product",
  schema: {
    sku:   f.text({ required: true }),
    name:  f.text({ required: true }),
    price: f.decimal(),
    tags:  f.text({ array: true }),
  },
  // Rows are validated against the column types before deploy. A column without
  // `required: true` may be omitted (the engine applies its default). Omit `id` and
  // rows are keyed for you — 1..N for an int PK, a stable uuid for a uuid PK (or
  // set `id` on every row); a bad value
  // or unknown column is a loud error, never a silent drop.
  seed: [
    { sku: "SKU-001", name: "Aeron Chair",   price: 1395, tags: ["furniture", "ergonomic"] },
    { sku: "SKU-002", name: "Standing Desk", price: 599,  tags: ["furniture"] },
  ],
});
```

Pinning an `id` this way is a `seed` property, not a general bulk-insert one: the runtime
statement `s.db.bulk.add` **drops `id` from every row** unless you pass `allowIdField: true`,
assigning the next sequence value instead.

Its sibling `s.db.bulk.delete` has the mirror-image rule: a filter that constrains nothing
matches every row, so a `where`-less delete is a truncate. It **throws** unless you say so
with `allRows: true`, which wipes the table and returns the deleted count — the wipe can no
longer be reached by forgetting an argument. Reach for `s.db.truncate({ table, reset: true })`
when the id sequence should restart too.

Deploy is a full replace, so re-deploying re-seeds cleanly — no duplicate rows. Seed
data travels only in the deploy package (resolved at deploy time); it never enters the
compiled workspace bundle.

For data in a file, use `seedFile`:

```ts
seed: seedFile("./products.seed.json", import.meta.url),
```

The path resolves against the file that declares the table, and it is read with `node:fs`
at deploy time. Note the tradeoff: inline rows are typed against the table schema at compile
time, while a `seedFile`/thunk seed is opaque to the typechecker — `xanosdk export`/`deploy`
validates it instead, naming the row index, the offending column and the table's known
columns. A thunk (`seed: () => import("./products.seed.json")`) also works and is
the right shape for *computed* seeds — but be aware it does **not** keep seed values out of
a frontend build: the `import()` lives in your module, so a bundler emits the JSON as a
served chunk, and any frontend that imports a def whose module graph reaches that table
ships the seed to the browser. `seedFile` stores a path string, which a bundler has nothing
to follow.

Either way, keep secrets out of `seed` — it is throwaway fixture data for disposable
environments. As a backstop, `xanosdk deploy <entry> --static <dir>` and `xanosdk deploy <entry> --to workspace --static <dir>`
refuse to publish a frontend build containing seed values from password columns or columns
your schema marks `access: "internal"` or `sensitive`. If the data is deliberately public (a
demo login the frontend shows), declare it on the table: `publicSeed: ["password"]`.

Typing is unaffected by the form you choose — the table's row type and column names stay
inferred.

---
