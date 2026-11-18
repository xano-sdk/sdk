# Tests, assertions, and mocks

> Read when writing ANY test — a `workflowTest()` (shape, registration, `s.expect.*`, `s.api.call`), `tests` on an object, a statement `mock` — or running a deployed environment's tests.

Both kinds of test: saved unit tests (this section) and `workflowTest()` objects (**Workflow tests: `workflowTest()`**). **Running them** covers both.

Named input sets run against one object, with assertions on its response — the tests the Xano editor shows. NOT `workflowTest()`, which is a standalone object with its own stack that calls other objects.

- `tests?: TestDef[]` on `query()`, `defineFunction()`, `middleware()`, `tool()`, `prompt()` and `resource()`. No other kind stores them.
- `{ name, id?, description?, datasource?, input?, expect?, token? }`.
- `name` is unique within the object and is the key a statement's `mock` resolves against; a duplicate throws.
- `id` defaults to a derivation from the owning object plus the name. A pulled test carries the id Xano minted, emitted explicitly.
- `datasource` defaults to `""` — an EMPTY datasource. Any other value names one the engine CLONES before the run; `"live"` warns `test.live-datasource` on the owning def.
- That empty default means **no `table({ seed })` rows exist while a unit test runs**, as for a `workflowTest()`: every `db` read misses, so `resp("0.id")` fails though the deployed endpoint returns those rows. Create the rows INSIDE the run (a `defineFunction` fixture the stack calls first) or `mock` the read.
- **To read `table({ seed })` rows on an EPHEMERAL**, set `datasource: "live"`: there it holds only the seed fixtures (plus rows `--keep-data` kept); the run's writes are dropped. `diagnostics.allow` accepts its warning. ⚠ `datasource` is STORED, not a per-run flag: a test left on `"live"` clones the REAL database once it runs against an instance, so clear it before you promote.
- `input` is `{ <input name>: Value }` — tagged values (`c.*`, `ref`, …), never plain JS scalars.
- `token` runs the test as an authenticated caller. A pull does NOT bring it back: it is an expiring credential, reported as a deliberate omission. A token is signed per instance and expires: a literal one passes only on the backend that minted it, fails `Invalid token.` anywhere else, and commits a live credential to source. Keep `token` for a throwaway local check; for `query({ auth })` logic use the `defineFunction` route under **What a `workflowTest()` run actually sees**.

### Assertions: `expect.*`, not `s.expect.*`

- `expect.*` builds a `{type, vars}` record stored on a `tests` entry. `s.expect.*` builds a STATEMENT for a `workflowTest()` stack. Different return types; not interchangeable.
- Subject first — argument order is the assertion: `expect.to_equal(resp(), c.int(2))`.
- `resp()` is the response under test; `resp("id")` drills, `resp("a-b")` takes the bracket escape.
- Subject only: `to_be_defined`, `to_not_be_defined`, `to_be_empty`, `to_be_null`, `to_not_be_null`, `to_be_true`, `to_be_false`, `to_be_in_the_future`, `to_be_in_the_past`.
- ⚠ `to_be_in_the_past`/`to_be_in_the_future` compare at WHOLE-SECOND resolution and treat the SAME second as neither — a timestamp taken during the request under test (`c.now()`, a `created_at` the endpoint just wrote) fails `to_be_in_the_past` nearly every run. Assert `expect.to_be_less_than(resp("ts"), c.now())` instead (or `to_be_defined` plus a range).
- Subject + operand: `to_equal`, `to_not_equal`, `to_be_greater_than`, `to_be_less_than`, `to_contain`, `to_start_with`, `to_end_with`, `to_match` (operand is a delimiter-wrapped pattern — build it with `c.regex`).
- `to_be_empty` passes ONLY for `""`, `[]` and `{}` — `0`, `null` and `false` FAIL it; use `to_be_null` for null and `to_equal(…, c.int(0))` for zero.
- `to_equal`/`to_not_equal` compare LOOSELY: `"5"` equals `5`, and `5` equals `5.0`. To pin a value's TYPE, assert on a filter (`withFilters(resp("x"), fl.is_text())`), not `to_equal`.
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

### Workflow tests: `workflowTest()`

A standalone object whose stack calls other objects and asserts on what they bind.

- `workflowTest({ name, guid?, description?, docs?, datasource?, active?, tags?, stack? })` — an end-to-end test. NO `input`/`response`: `.call` something with an `as`, then assert on that var — `s.function.call({ fn, input, as: "r" })`, `s.expect.to_equal({ expr: ref("r"), value: c.int(42) })`. `s.expect.*` belongs here — it is not inert elsewhere (a failure 500s the request), so treat one in a query/function/task as a mistake to remove. `active?` defaults `true`; `active: false` parks the test — `test run-all`/`deploy --test` SKIP it (reported `status: "skipped"`, never failing the suite), `test list` shows it `inactive`, and `test run "<name>"` still runs it. Chain tests with `s.workflow_test.call({ workflowTest: <def handle>, as: "child" })` then `s.expect.to_be_null({ expr: ref("child") })`, or a failing child passes the parent.
  - `datasource?`: Default `""` is an EMPTY datasource (recommended), not "no datasource". Any non-empty name is CLONED before EVERY run — against production-sized data, slow enough to fail the run; `"live"` warns at compile time. On an EPHEMERAL, `"live"` holds only the seed fixtures (plus rows a `--keep-data` deploy kept): the way to read `table({ seed })` rows — a small clone, dropped after the run. ⚠ The value is STORED, so clear it before you promote or the same test clones the real database.
- Register each one with `.registerWorkflowTests([...])` on the workspace, as `.registerQueries([...])` registers a query. `export()` fails (`reference.unresolved`) when `s.workflow_test.call` targets one that is not registered.
- `s.expect.*` takes the `expect.*` names in ONE argument object, the subject as `expr`: subject only `{ expr }`; subject + operand `{ expr, value }`; `to_be_within` `{ expr, min, max }`; `to_throw` `{ body, exception? }`.

Calls that run ONLY in a workflow test:

- `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an endpoint. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).
  - `api` takes the `query()` def HANDLE (or a `{ name, guid }` pair) — a bare name is refused (identity = api group + verb + name).
  - `headers` REPLACES the request headers the callee sees and takes the same shapes as `s.api.request`'s, or one `Value`.
  - `auth` is `{ token, ignoreExpiration? }`: `token` must be a BARE STRING — a tagged `Value` deploys clean and then fails the run with `Param: token - Text filter requires an integer, float, string or boolean value`.
  - Neither slot authenticates the call; see **What a `workflowTest()` run actually sees**.
- `s.task.call({ task, as? })` — runs the task's stack once, now; takes NO `input` (a task declares none). `as` binds the task's `s.return` value (null without one), which is how a `workflowTest` asserts a task has a result. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).
- `s.trigger.call({ trigger, input?, as? })` — runs the trigger's stack once, now. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).
  - `s.trigger.call`'s `input` is UNTYPED and must carry the inputs the target trigger reads, which the `t` accessor names: a `tableTrigger` needs `action` (`"insert"`/`"edit"`/`"delete"`), `datasource` (REQUIRED — without it the run fails `Missing param: datasource`), and `new`/`old` row objects; a misspelled key type-checks and is just ignored.
- `s.workflow_test.call({ workflowTest, datasource?, as? })` — run another workflow test from inside one, which is the only place it runs (see Gotchas in `llms.txt`). NO `input`; `datasource?` has the kind's clone caveat.

### What a `workflowTest()` run actually sees

Isolation rules; each fails a correct test with a misleading message.

- The run uses an EMPTY datasource by default (`datasource: ""`), so **no `table({ seed })` rows exist while it runs** (same as a unit test): a read of seeded row 1 fails with its own precondition message, not an empty-database error. Build fixtures INSIDE the test, or set `datasource: "live"` under the ephemeral-only rule in the first section.
- `s.api.call` reports a failing endpoint by WHERE it fails, so no single assertion covers every failure. `s.function.run` raises on every failure instead.

| Failure | What `as` gets | Assert with |
|---|---|---|
| INPUT error (missing required input, wrong type) | nothing: the call RAISES and fails the test (`Missing param: msg`); later `s.expect.*` never run | `s.expect.to_throw({ body: [s.api.call({ api, input: {}, as: "r" })], exception: c.text("Missing param") })` |
| STACK error (`s.precondition`/`guard.*`) | the envelope `{ code, message, payload }`; the run carries on | `s.expect.to_contain({ expr: ref("r.code"), value: c.text("ERROR_CODE_ACCESS_DENIED") })` |
| `s.throw` | a codeless `{ payload, statement }`: `ref("r.code")` fails `Unable to locate var` | `ref("r.payload")` |

- `s.expect.to_throw` catches a call only when the error carries a MESSAGE. `ERROR_CODE_ACCESS_DENIED` arrives with an empty one, so `to_throw` around an auth-refused call reports `to_throw failed - response is ok`.
- `s.expect.to_throw({ body, exception? })` runs `body` in an ISOLATED var stack, so a variable bound EARLIER in the test is not visible inside it — bind what the body needs inside the body. An outer one raises `Missing var entry: <name>` there, which the test reports as `to_throw` not matching (`export()` warns). `exception` is a `Value` (`c.text("already exists")`), matched as in `expect.to_throw`; omit it to accept any error.
- An endpoint's `auth` gate is NOT enforced on `s.api.call`. A `query({ auth: users })` runs anyway and fails only where its stack dereferences `auth(...)`. A stack that never touches `auth(...)` runs unauthenticated and passes.
- Neither `auth.token` nor an `Authorization` entry in `headers` authenticates the call — a token that answers 200 over real HTTP is refused here. To cover auth-gated logic, move the body into a `defineFunction` taking the user id and `s.function.call` that; the gate itself is not reachable from a workflow test.
- Table triggers do not fire on writes made during a test run (unit or workflow); a test asserting a trigger's side effect finds 0 rows. Triggers fire only on a deployed/ephemeral instance, async after commit (`llms/triggers.md`). Test the trigger's stack directly with `s.trigger.call({ trigger, input: { new: obj({…}), old: obj({…}), action: c.text("insert"), datasource: c.text("live") } })` — a synthetic `new`/`old`/`action`; `datasource` is REQUIRED — then assert on what it wrote.
- A failing RUN's `message` is the authored message: a `s.precondition`/`guard.*` that raised inside a `.call` reports its own text (`"Bookings must start in the future."`), an `s.throw` its `name`.

### Running them

`npx @xano/sdk test run-all` runs the unit tests AND the `workflowTest()` objects an environment carries. It takes no entry file and compiles nothing: it runs what is DEPLOYED, so deploy before testing.

- `--on <backend>` picks the backend — `--on ephemeral:<name>`, `--on local`, `--on tenant:<name>`, `--on workspace`; omitted, the one this project last deployed to (grammar: **Backends** in `llms.txt`). ⚠ `workspace` runs against the REAL database: safe only while every test keeps `datasource: ""`, since a stored non-empty datasource is CLONED before the run.
- `npx @xano/sdk test list` shows what is there without running it; `test run "<name>"` runs one; an ambiguous name prints qualified forms (`function:math/happy path`, `workflow:<name>`) `run` accepts.
- `--kind unit|workflow` narrows to one family. `--concurrency <n>` defaults to 1: tests share the environment database.
- A failing suite exits 5; exit 6 when the suite could not be reached — retry it; a backend that can't be looked up exits 8 (see errors). Having no tests is success.
- For CI: the exit code says THAT something failed, the JSON says WHICH. Progress goes to stderr; stdout carries one JSON document when not a terminal, or with `--json`. `run-all` and `run`: `{ kind, env, name, display, total, passed, failed, tests: [{ kind, name, qualified, object?, status: "pass"|"fail", message?, expectations?: [{ index, status, message? }], timing? }] }` (`message`: the first failure; `expectations`: a unit test's every expectation in order, `index` from 0; `env`: an ephemeral's or tenant's name; `name`: the backend's own, a Xano Engine's too; null if none), same keys on an empty suite. `list` is `{ kind, env, name, display, total, tests }`; `deploy --test` nests the run under `testRun`.
- `npx @xano/sdk deploy ./index.ts --test` deploys and then runs the suite against what it just shipped. A failure exits 5 WITHOUT retracting the deploy — the environment is live either way.
- A `tool()`/`prompt()`/`resource()` test runs with the rest, qualified `tool:<name>/<test>` (`prompt:`, `resource:`). ⚠ A backend whose engine predates tests on these kinds lists none of them, so the suite passes without running them.
