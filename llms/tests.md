# Saved unit tests, assertions, and mocks

> Read when authoring a `workflowTest()` stack, when a query/function/middleware carries `tests`, when a statement needs a `mock`, or when running a deployed environment's tests.

Named input sets run against one object, with assertions on its response — the tests the Xano editor shows. NOT `workflowTest()`, which is a standalone object with its own stack that calls other objects.

- `tests?: TestDef[]` on `query()`, `defineFunction()`, and `middleware()`. No other kind stores them.
- `{ name, id?, description?, datasource?, input?, expect?, token? }`.
- `name` is unique within the object and is the key a statement's `mock` resolves against; a duplicate throws.
- `id` defaults to a derivation from the owning object plus the name. A pulled test carries the id Xano minted, emitted explicitly.
- `datasource` defaults to `""` — an EMPTY datasource. Any other value names one the engine CLONES before the run; `"live"` warns `test.live-datasource` on the owning def.
- ⚠ That empty default means **no `table({ seed })` rows exist while a unit test runs**, exactly as for a `workflowTest()` — every `db` read misses, so `resp("0.id")` fails though the deployed endpoint returns those rows. **To read `table({ seed })` rows on an EPHEMERAL**, set `datasource: "live"`: there it holds only the seed fixtures (plus rows `--keep-data` kept); the run's writes are dropped. `diagnostics.allow` accepts its warning. ⚠ `datasource` is STORED, not a per-run flag — a test left on `"live"` clones the REAL database once it runs against an instance, so clear it before you promote. Otherwise create the rows INSIDE the run (a `defineFunction` fixture the stack calls first) or `mock` the read.
- `input` is `{ <input name>: Value }` — tagged values (`c.*`, `ref`, …), never plain JS scalars.
- `token` runs the test as an authenticated caller. A pull does NOT bring it back: it is an expiring credential, reported as a deliberate omission.

### Assertions: `expect.*`, not `s.expect.*`

- `expect.*` builds a `{type, vars}` record stored on a `tests` entry. `s.expect.*` builds a STATEMENT for a `workflowTest()` stack. Different return types; not interchangeable.
- Subject first — argument order is the assertion: `expect.to_equal(resp(), c.int(2))`.
- `resp()` is the response under test; `resp("id")` drills, `resp("a-b")` takes the bracket escape.
- Subject only: `to_be_defined`, `to_not_be_defined`, `to_be_empty`, `to_be_null`, `to_not_be_null`, `to_be_true`, `to_be_false`, `to_be_in_the_future`, `to_be_in_the_past`.
- Subject + operand: `to_equal`, `to_not_equal`, `to_be_greater_than`, `to_be_less_than`, `to_contain`, `to_start_with`, `to_end_with`, `to_match` (operand is a delimiter-wrapped pattern — build it with `c.regex`).
- `expect.to_be_within(subject, min, max)` — both bounds EXCLUSIVE; a subject equal to either fails.
- `expect.to_throw(exception?)` takes NO subject. With an argument the error message must CONTAIN that text (case-insensitive substring); with none, any error passes. `exception` is a `Value` — `expect.to_throw(c.text("Wrong password"))`, not a bare string (a bare one fails to compile with TS2345).

### Mocks

A statement returns a value instead of doing its work, for one named test.

- `s.set_var("x", c.int(1), { mock: { "adds one": c.int(123) } })`. Every statement takes `mock`.
- Keyed by TEST NAME. A name the object does not declare THROWS at encode: the engine ignores a mock whose key is not a real test id, so it would deploy clean and silently never apply.
- `{ value, enabled: false }` keeps a mock stored but switched off.
- A mock applies ONLY while its test runs. It changes nothing about a normal request.

### `example`

`example?: { input?, output? }` on `query()` — the saved request/response sample the editor records. Free-form JSON, not tagged values. A pull DOES bring it back.

### What a `workflowTest()` run actually sees

The run is isolated in ways that make a correct test fail for reasons the failure message does not name.

- The run uses an EMPTY datasource by default (`datasource: ""`), so **no `table({ seed })` rows exist while it runs** (same as a unit test, above): a read of seeded row 1 fails with its own precondition message, not an empty-database error. Build fixtures INSIDE the test, or set `datasource: "live"` under the ephemeral-only rule above.
- `s.api.call` does NOT raise when the endpoint answers with an error. It BINDS the error envelope (`{code, message}`) to its `as` and carries on, so a later `s.expect.to_be_defined({ expr: ref("r.field") })` reports the ASSERTION while the real failure was the call, four statements up. Assert on the envelope — `s.expect.to_contain({ expr: ref("r.code"), value: c.text("ERROR_CODE_INPUT_ERROR") })` — when a call may fail. `s.function.run` raises instead; the two disagree.
- `s.expect.to_throw({ body, exception? })` runs `body` in an ISOLATED var stack, so a variable bound EARLIER in the test is not visible inside it — bind what the body needs inside the body. An outer one raises `Missing var entry: <name>` there, which the test reports as `to_throw` not matching (`export()` warns). `exception` is a `Value` whose text the raised message must CONTAIN (`c.text("already exists")`, not a bare string); omit it to accept any error.
- `s.expect.to_throw` catches such a call only when the error carries a MESSAGE. `ERROR_CODE_ACCESS_DENIED` arrives with an empty one, so `to_throw` around an auth-refused call reports `to_throw failed - response is ok` — which reads as a broken auth gate on a gate that works.
- An endpoint's `auth` gate is NOT enforced on `s.api.call`. A `query({ auth: users })` runs anyway and fails only where its stack dereferences `auth(...)`. A stack that never touches `auth(...)` runs unauthenticated and passes.
- Neither `auth.token` nor an `Authorization` entry in `headers` authenticates the call — a token that answers 200 over real HTTP is refused here. To cover auth-gated logic, move the body into a `defineFunction` taking the user id and `s.function.call` that; the gate itself is not reachable from a workflow test.

### Running them

`xanosdk test run-all` runs the unit tests AND the `workflowTest()` objects an environment carries. It takes no entry file and compiles nothing: it runs what is DEPLOYED, so deploy before testing.

- `--on <backend>` picks the backend — `--on ephemeral:<name>`, `--on local`, `--on tenant:<name>`, `--on workspace`; omitted, the one this project last deployed to (grammar: **Backends** in `llms.txt`). ⚠ `workspace` runs against the REAL database: safe only while every test keeps `datasource: ""`, since a stored non-empty datasource is CLONED before the run.
- `xanosdk test list` shows what is there without running it; `test run "<name>"` runs one; an ambiguous name prints qualified forms (`function:math/happy path`, `workflow:<name>`) `run` accepts.
- `--kind unit|workflow` narrows to one family. `--concurrency <n>` defaults to 1: tests share the environment database.
- A failing suite exits 5; exit 6 when the suite could not be reached — retry it; a backend that can't be looked up exits 8 (see errors). Having no tests is success.
- For CI: the exit code says THAT something failed, the JSON says WHICH. Progress goes to stderr; stdout carries one JSON document when not a terminal, or with `--json`. `run-all` and `run`: `{ kind, env, name, display, total, passed, failed, tests: [{ kind, name, qualified, object?, status: "pass"|"fail", message?, expectations?: [{ index, status, message? }], timing? }] }` (`message`: the first failure; `expectations`: a unit test's every expectation in order, `index` from 0; `env`: an ephemeral's or tenant's name; `name`: the backend's own, a Xano Engine's too; null if none), same keys on an empty suite. `list` is `{ kind, env, name, display, total, tests }`; `deploy --test` nests the run under `testRun`.
- `xanosdk deploy ./index.ts --test` deploys and then runs the suite against what it just shipped. A failure exits 5 WITHOUT retracting the deploy — the environment is live either way.
