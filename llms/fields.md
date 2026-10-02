# Column and input types

> Read when declaring a table column (`f.*`) or a function/query input (`input.*`) — a type's options and methods, and the `s.precondition` error/status contract. Also `table({ seed })` rows and `use_xdo`.

Author table columns + function/API inputs with the typed catalog: `f.<type>(opts?)`
for columns, `input.<type>(opts?)` for inputs. Common opts: `required`, `nullable`,
`default`, `description`, `access` (a read omits `"internal"` columns, returns `"private"` ones; `InferRow`
is the full row, both kept), `sensitive` (masks the input's value in request logs; a read still RETURNS a sensitive column — `access: "internal"` keeps it out).
**`nullable` defaults PER TYPE, matching the engine's own column-creation API**: `true`
for `f.vector`, `f.uuid`, every `f.geo.*` and every file type (`f.image`/`f.video`/
`f.audio`/`f.attachment`), `false` for everything else (text, int, decimal, bool, email,
enum, json, object, password, date, tableRef); inputs add date, timestamp and file, so an
omitted one binds `null` (a `required` one still accepts an explicit `null`). Pass `nullable` to override —
e.g. `f.geo.polygon({ nullable: false })`. An empty default becomes NULL only when
nullable, so a non-null `f.vector(8)` column fails to create (`''` is not a vector).
**`f.geo.*` values are `{ type, data }`, not GeoJSON.** The same shape goes in and comes
back. `type` per column: `point` → `"point"`, `data` `{ lng, lat }`; `multipoint` → `"points"`,
`linestring` → `"path"`, `polygon` → `"poly"` (ring closed for you), `data` `[{ lng, lat }, …]`;
`multilinestring` → `"paths"`, `multipolygon` → `"polys"`, `data` `[[{ lng, lat }, …], …]`.
Any other spelling (`"multipoint"`, `"linestring"`, `"Point"`) 400s `Only strings are supported for:`.
Raw WKT text (`c.text("POINT(1 2)")`) is accepted on write too, but a read never returns one.
`methods` (validators/transforms, names per type below): `"trim"`, `"min:8"`
(a text arg keeps its `:`: `"startsWith:https://"`), or `{ name, arg }` — for unlisted names and `pattern`'s error text.
`f.json({children})` declares the nested shape stored INSIDE a json column — an ARRAY of
`{name, type, methods?, children?}`, order-significant, distinct from the `FieldMap` that
`f.object` takes positionally. Omit it for an unstructured json column.
`f.enum(values)`/`f.vector(size)`/`f.object(children)`/`f.tableRef(table)` take a
positional payload before opts — and still accept the standard `FieldOptions` after it
(`f.enum([])`/`input.enum([])` are accepted: a pulled enum with no options, not one to
author — it brands the column `never`, which `InferRow` surfaces as `undefined`.)
(e.g. `f.tableRef(users, { required: true })` — only `min`/`max` are listed as tableRef
methods below, but `required`/`nullable`/`description`/… apply like any field.)
An **OPTIONAL foreign key wants a `0` sentinel, not `nullable: true`**. `f.tableRef` to an int-keyed table stores
an `int`, and a null in it is unqueryable: `null` is never a legal `fieldValue`/`id`, so
`s.db.get`/`edit`/`del` on that column answer HTTP 400 `Missing param: field_value` rather
than matching nothing. Declare `f.tableRef(users, { required: true, default: 0 })` for
"not set yet" — `s.db.get({ fieldName: "driver", fieldValue: c.int(0) })` matches no row and
binds `null`, which is the answer the null was reaching for. `export()` warns on a literal
`c.null()` in that slot. A uuid-keyed ref stays nullable even when `required` (a non-null one defaults to `""`, which no insert accepts).
An `f.vector(size)` column is SEARCHED through `s.db.query`'s `eval` pipeline, not through
any `SearchOp`: give the table `index: [{ type: "vector", fields: [{ name: "embedding", op:
"vector_cosine_ops" }] }]`, then rank with a distance filter + a sort on its alias (see
`s.db.query` → `eval`). Without that pairing the column stores and indexes but nothing
queries it.
`{ array: true }` makes any `f.*` scalar a **list column** — `f.text({ array: true })`
surfaces as `string[]` in `InferRow<typeof table>` (the column analogue of `input.list`).
**Seed a table's starting rows with `table({ seed })`.** `seed` takes rows
typed against the table's schema as a WRITE shape (a column without
`required: true`, and the system columns, may be omitted; `null` needs
`nullable: true`) — inline (`seed: [{ name: "…" }]`), a FILE
(`seed: seedFile("./seed.json", import.meta.url)`; path resolves against the DECLARING
file), or a thunk (`seed: () => import("./seed.json")`, async ok, `.default` unwrapped).
Inline rows are TYPED against the schema at compile time; a `seedFile`/thunk seed is
not — `xanosdk export`/`deploy` validates it, naming the row index and column.
Timestamp seeds: epoch ms, `Date`, ISO 8601 date, or date-time with `Z`/offset; else THROWS.
Int seeds: whole, in int64 (past 2^53: a string).
⚠ Prefer `seedFile` for a file: a thunk's `import()` sits in
YOUR module, so a bundler emits the JSON as a served chunk. Never put secrets
in `seed`. `deploy --static` REFUSES a build carrying internal/sensitive seed values;
declare public ones (demo logins) on the table: `publicSeed: ["password"]`.
A replacing deploy re-seeds cleanly; `--keep-data` writes no seed rows.
`seed` is evaluated on EVERY build, so a computed value (`Date.now()`) is fine:
the lock records no seed data.
A FILE column seeds from a repo file: `logo: hostedFile("./logo.png", import.meta.url)`;
the row stores each backend's own copy. A wrong-kind file or a non-file column THROWS.
A release carries no file bytes: `release create` refuses such rows and icons.
Omit `id` and rows auto-number `1..N` (int PK) or take
a stable derived uuid (uuid PK); supplying `id` pins it (and
resets an int sequence past the max). All-or-nothing — mixing explicit and
omitted `id` throws. A `system:false` PK is the author's to supply. Pinning is
`seed`-only — `s.db.bulk.add` DROPS `id` unless `allowIdField: true`.
**`use_xdo` storage mode.** Workspace setting (`registerWorkspace({ use_xdo })`,
default `false`): `true` stores fields as JSON in the `xdo` column (+ `gin(xdo)` index),
`false` real columns.
Tables inherit it; override with `table({ useXdo })`; a merge refuses to switch a populated table.
A **column `default` must stay within the BMP** — a 4-byte character (codepoint > U+FFFF,
e.g. an emoji) is rejected at export; put such a value on an `input.<type>({ default })`.
`input.*` mirrors `f.*` — every column type below is
a legal input (scalars, files `input.image/video/audio/attachment`, `input.geo.*`,
`input.vector(size)`, `input.tableRef(table)`, `input.object(children)`), plus
`input.dbLink(table)` is the odd one: ONE entry that EXPANDS into one input per
COLUMN of the linked table, so read them by column name (`inp("email")`), never by
the entry's own name. `hidden: ["created_at"]` drops columns from that expansion.
`input.list(element)` for arrays — wrap any element constructor, e.g.
`input.list(input.text())` or `input.list(input.object({ id: f.int() }))`.
**A file reaches a column in two steps.** `input.file` is the RAW upload (the request's
multipart/base64 bytes) and cannot be written to a file column directly: store it first —
`s.storage.create_image({ as: "img", value: inp("avatar"), access: "public" })`
(read the upload with `inp`; `ref("input.avatar")` spells a stack VARIABLE named
`input` and fails the request with `Missing var entry: input`) — then write
`ref("img")` into the `f.image()` cell with `s.db.add`/`edit`. `access` defaults to
`"public"` (a guessable URL): pass `"private"` and hand out `s.storage.sign_private_url`
results for anything user-scoped. `create_video`/`create_audio`/`create_attachment` are
the same shape for the other file columns, each fed `input.file` (`input.image`/… 400s an upload).
**An empty file column is a stored null that `where` does not see as null.** `expr(col("file"), "!=", c.null())`
matches EVERY row, and `= c.null()` matches none. Compare a key inside the file instead:
`expr(col("file.path"), "!=", c.null())` keeps only the rows holding a file.
**Typed inputs validate/coerce on bind, before your stack runs** — so reach for the
specific type instead of hand-rolling checks. `input.email({ required: true })` rejects a
malformed address with a 400 (and trims; add `methods: ["lower"]` to downcase) — no
`regex_matches` needed; `input.int`/`input.decimal`/`input.uuid`/`input.enum([...])`/`input.date`
likewise reject or coerce bad input at the boundary. Drop to `input.text` + `s.precondition`
only for rules no type expresses.
⚠ `input.url` is NOT one of them — there is no engine `url` type, so it stores as `text`
and validates NOTHING: a `javascript:`/`data:` URL type-checks, imports, and binds. When the value gets navigated
to, check the scheme in the stack. It is INPUT ONLY — there is no `f.url` column.
⚠ `input.timestamp` binds epoch MILLISECONDS. A number is taken as ms as-is, so epoch
SECONDS (`date +%s`) bind in January 1970 with no error. An ISO-8601 string keeps its
offset but DROPS fractional seconds (`"…T19:30:00.123Z"` binds `…:00.000`). Send epoch ms
(`Date.now()`, `getTime()`) whenever sub-second precision matters.
⚠ `input.list` does NOT reject a non-array: one value binds as a ONE-item list (`"a"` →
`["a"]`), and a non-JSON string given to an `input.object` binds an object of its
children's DEFAULTS — so `input.list(input.object({...}))` given `"notalist"` binds
`[{ name: "", … }]` with a 200. A list `min` does not catch it (that is one item). A string
starting with `[` is parsed as JSON with NO element check at all. When the shape must hold,
mark an object child `required: true` (the default-filled object then 400s with its param
path) and check anything else with `s.precondition`.
⚠ `s.precondition`'s `error` must be a TAGGED value — `c.text("…")`, not a bare string.
The engine falls back to the generic "Precondition failed." whenever it reads an empty or
non-scalar message, and a bare string lands there, so the client never sees your text. The
`error_type` → HTTP status mapping is correct either way; only the message is lost.
`error_type` is how a stack sets a FAILURE status: `badrequest`/`inputerror` → 400, `unauthorized` → 401, `accessdenied` → 403, `notfound` → 404, `toomanyrequests` → 429, `standard` → 500.
For any other status — and for a redirect — use `respond.*`, which is sugar over
`s.util.set_header` (that statement reaches the status line): `respond.status(201)`,
`respond.redirect(url, { status?: 301|302|303|307 })` (a TUPLE — spread it; a `Location`
alone does NOT redirect), and `respond.header(name, value)`. Position in the stack does not
matter, a later status wins, and a FAILING `precondition` still wins over anything set
before it. ⚠ `204` answers with an empty body whatever `response` says. ⚠ `respond.status`
REFUSES `308`/`425`/`451`/`102`/`103`: the platform writes those and does not act on them,
so the response is 200 with nothing reported — use 301, 429 and 403 instead.
Normalizing transforms run on bind too — put `trim`/`lower`/`upper` on the input's `methods`
so `inp("name")` reads already-normalized; don't reroll `var $x = inp("name")|trim` in the stack.
⚠ `f.decimal`'s size depends on the table's layout; it takes no precision or scale option.
On a normalized table (`useXdo: false`, the default) it is FIXED: 5 decimal places out
of 14 total digits. `0.12345678` written and re-read is `0.12346` (`-0.000004` → `0`),
and the rounding is silent at HTTP 200 — for a scalar `s.db.add`'s `as` output carries the
STORED value, not the cell you sent, so comparing the two detects the loss; for a list
(`array: true`) it is the unrounded list you sent, so only a re-read shows it. Rounding happens BEFORE
the size is checked, so a magnitude needing 10 digits left of the point AFTER rounding 500s
`ERROR_FATAL` `SQL Error: 0`, naming neither column nor value: `999999999.5` stores,
`999999999.999999` does not. On a `useXdo: true` table it is a JSON number with no 5dp
rounding (`0.123456789` reads back `0.123456789`). On either layout, for anything finer than 5dp
store an integer count of the smallest unit (cents, satoshis) in an `f.int`.
⚠ `f.int` is a SIGNED 64-bit column — `-9223372036854775808` to `9223372036854775807` —
and past the ceiling it CLAMPS instead of failing: `9223372036854775808` and
`18446744073709551615` both store as `9223372036854775807`, at HTTP 200 with no error, so
an overflowed count reads back as a plausible number. The response carries every digit, but
`JSON.parse` (so `res.json()`) rounds past `9007199254740991` — read a count that large as
text or BigInt. `c.int()` refuses an unsafe number literal, so pass the string.

- `f.text` — methods: alphaOk, digitOk, lower, max, min, ok, pattern, startsWith, trim, upper
- `f.int` — methods: max, min
- `f.decimal` — methods: max, min
- `f.bool`
- `f.uuid`
- `f.date`
- `f.email` — methods: lower, trim
- `f.password` — methods: max, min, minAlpha, minDigit, minLowerAlpha, minSymbol, minUpperAlpha, salt
- `f.json`
- `f.timestamp` (stored `epochms`)
- `f.image` (stored `blob_img`)
- `f.video` (stored `blob_video`)
- `f.audio` (stored `blob_audio`)
- `f.attachment` (stored `blob`)
- `input.file` — INPUT ONLY (no `f.` form)
- `input.dbLink` (stored `<tableGuid>_mvpschema`) — INPUT ONLY (no `f.` form)
- `f.geo.point` (stored `geo_point`)
- `f.geo.multipoint` (stored `geo_multipoint`)
- `f.geo.linestring` (stored `geo_linestring`)
- `f.geo.multilinestring` (stored `geo_multilinestring`)
- `f.geo.polygon` (stored `geo_polygon`)
- `f.geo.multipolygon` (stored `geo_multipolygon`)
- `f.enum`
- `f.vector` — methods: max, min
- `f.object` (stored `obj`)
- `f.tableRef` (stored `int`) — methods: max, min
