# Error index

> Read when a request, test, build, or pull fails with a message you did not write — the string, its cause, and where the fix is.

### Request-time (deployed) failures

- `Unable to locate input: <name>` — `inp()` names an undeclared input, or an attached middleware reads its own `input` (never bound). Declare it; a stack value is `ref("var.field")`; middleware reads the body with `s.util.get_all_input`. `llms.txt`; `llms/kinds-core.md`.
- `Unable to locate var: <a.b>` (HTTP 500) — a dotted `ref` into a null base (a `db.get` miss), or a column absent from the row (`f.password` is `internal`). Guard existence first, or use the null-safe `safe` option; name the column in `output`. In a `post` middleware, `<var>.vars` from `s.util.get_all_input` holds `{ status, result }` (plus `payload` on an error), not the request. `llms.txt`; `llms/kinds-core.md`.
- `Missing var entry: <name>` inside `s.expect.to_throw` — the body runs in an isolated var stack; bind what it needs inside the body. `llms/tests.md`.
- `Missing param: field_value` (HTTP 400) — a `db.*` match argument resolved to `null` (a safe ref, a nullable foreign key). Guard existence before the lookup; an optional FK stores `0` and is read with field-match `db.get`. `llms.txt`; `llms/fields.md`.
- `Value is less than the minimum value of 1` (HTTP 400) — a `db.get` given `0` in an editor-authored workspace (SDK field-match `db.get` answers 200 + null). `llms/statements-data.md`.
- `Invalid op: <op>` — a `cmp` operator (`in`, `like`, …) in a RUNTIME condition, which takes the `expr` set only; write `or(expr(...), expr(...))`. `llms/kinds-core.md`.
- `Unsupported param format` / `Unsupported parameter reference` — an aggregate or `eval` `name` that is not a bare column, or a bare `eval` name for a joined column. `llms/statements-data.md`.
- `ParseError: Invalid value for param` (HTTP 400) — `contains`/`@>`/`overlaps` on a text column (use `includes`), or a joined column qualified without `tableAlias`. `llms/statements-data.md`.
- `ERROR_FATAL: <Type> does not exist: <type>:<n>` — `s.api.call`/`s.task.call`/`s.trigger.call`/`s.workflow_test.call` outside a workflow test; share logic via `defineFunction` + `s.function.run`. `llms.txt`.
- `ERROR_FATAL "Unable to decode."` — a populated JSON string where the engine expects `c.obj`'s form; write `c.obj({...})` or `obj({...})`. `llms/values.md`.
- `Precondition failed.` in place of your message — `error` was a bare string; pass `c.text("…")`. `llms/fields.md`.
- `Param: token - Text filter requires an integer, float, string or boolean value` — `s.api.call` `auth.token` given a tagged `Value`; it must be a bare string. `llms/statements-calls.md`.
- Every `s.db.add` into one table 400s naming a column while complaining about its VALUE — the column is named `run`. `llms.txt`.
- HTTP 200 with an EMPTY body where `0` was expected — a bare `returnType: "count"` of zero; wrap it as `{ count: ref("n") }`. `llms/statements-data.md`.
- HTTP 200 with `[]` from a `db.query` that matches rows — a paged query (`metadata: true`, the default) whose `output` names bare columns; the selection applies to the ENVELOPE, so prefix them (`items.<column>`) or set `metadata: false` inside `paging`. `llms.txt`; `llms/statements-data.md`.
- Every field mapped off an `s.api.request` result reads `null` — the upstream answered an error (a 403 for a missing `User-Agent` is the common one) and its body arrived as ordinary `response.result`; send a `User-Agent` and gate on `response.status`. `llms/statements-calls.md`.
- A lambda returns error TEXT with HTTP 200 (`Could not resolve "node:crypto"`, an undefined-binding message) — the body threw; use the preloaded globals, the surface's bindings, and `capture`. `llms/lambda.md`.
- `Unable to locate request.` (404) on an endpoint that deployed — a lowercase verb, a `.` in the name, or a CORS `mode` typo that dropped the whole API group. `llms/kinds-core.md`.
- A browser call fails on a missing `access-control-allow-origin` while deploy looks fine — CORS `mode: "custom"` with `"*"` or an unmatched origin. `llms/kinds-core.md`.
- A websocket is closed right after the handshake — a refused `connect` gate: an empty/falsy return, a crash, or a gating trigger with no `response`. `llms/triggers.md`.
- `to_throw failed - response is ok` around an auth-refused call — `ERROR_CODE_ACCESS_DENIED` carries no message; the auth gate is not reachable from a workflow test. `llms/tests.md`.
- Output reads `Hi [object Object]` — a tagged value inside a JS template literal; compose at runtime with `withFilters` + `fl.concat`. `llms.txt`.

### Build-time and tooling failures

- `export --strict` fails on a warning whose shape is meant (a fixture pinning a hazard) — accept it on ITS def only with `diagnostics: { allow: ["<code>"] }`, which takes any warning code that def raised (never an error) on every def kind. Accepted warnings are still listed: `export({ accepted: [] })`, `--json` `accepted[]`. An allowed code the def no longer raises warns `diagnostics.allow-unused`.
- `must be ES modules` — package.json says `"type": "commonjs"`; set `"type": "module"`. `llms.txt` Quickstart.
- A response types as `StackTupleWidened` — a `Statement[]` helper was spread into the stack; return `statements(...)`. `llms.txt`; `llms/statements-runtime.md`.
- `ERR_PACKAGE_PATH_NOT_EXPORTED` — `tsx -e "import …"`, or running from outside the project root; run a real file with `tsx <file.ts>` from the root. `llms/client.md`.
- `Missing statement: mvp:placeholder` on import — an unconfigured slot in a pulled tree; replace it with the statement it stands in for. `llms/legacy.md`.
- A CLI command fails under `--json` or piped (unless stdout carries data): stdout is `{ ok: false, error: { code, message, exitCode, details?, suggestion? } }`, as does a failed release write. Codes: `SDK_SEED_IN_STATIC` (`details.leaks[]` → `publicSeed`), `SDK_EXPORT_INVALID` (`details.diagnostics[]`, `--strict` too), `SDK_DRIFT`, `SDK_BRANCH_TAKEN`, `SDK_BRANCH_LIVE`, `SDK_RELEASE_NAME_TAKEN`, `SDK_RELEASE_FILES_NOT_CARRIED`, `SDK_LIVE_BRANCH_MISMATCH` (`details.conflictsWith`), `SDK_IDENTITY_CONFLICT`, `SDK_KIND_CONFLICT`, `SDK_PRUNE_OUT_OF_SCOPE`, `SDK_IMPORT_REFUSED`, `SDK_SHARED_SCHEMA_CHANGE`, `SDK_CONSTRAINT_VIOLATION`, `SDK_CREDENTIAL_REJECTED` (`details`: `{ profile, credentialType, instance, workspaceId, signIn }`; ids null on a refused env refresh), `SDK_USAGE` (`details.reason: "needs-confirmation"`: run its `Re-run as`), `SDK_ERROR`. Landing refusal `details.refused`: identityConflict, renamePending, kindConflict, uniqueViolation, tableTrigger, importInProgress, importRefused, pruneOutOfScope. `warnings[]` / `details.warnings` / `accepted[]` entries: `{ code, message, subject? }` (`subject`: the def's `{ kind, name }`). Backend documents add `selector` and `workspaceId`.
- A CLI command reports `could not reach <url>: fetch failed (<code>)` — blocked egress, not a bad credential; fix it before `xanosdk login`, which rotates a single-use refresh token.

### CLI exit codes

A failure document's `exitCode` matches.

| Code | Meaning | Next step |
|---|---|---|
| 0 | Success, and a `delete` of a missing name (`alreadyGone`). | — |
| 1 | A usage error (a missing local file included), a refused request, or anything not listed. | Read the message. |
| 2 | Ran and disagreed: `preflight` failed, `workspace diff` differed, `promote`, a release or an import did not land as sent or hit a conflict, the `init --from`/`pull` round-trip check failed, a lock or branch-label conflict, or `init` could not install its dependencies or an add-on (scaffolded anyway). | Fix what it reports. |
| 3 | `deploy --static`: the backend landed, the static site did not. | Deploy the site again. |
| 4 | `deploy --require-microservices`: a microservice was not ready in time. The backend landed. | Check the microservice. |
| 5 | `test` / `deploy --test`: the suite ran and a test failed. A deploy is not retracted. | Fix the test or the code. |
| 6 | `test`, `deploy --test`: the suite could not be reached. | Check the backend; rerun. |
| 7 | `upgrade --check`: an upgrade is available. | `xanosdk upgrade`. |
| 8 | A named backend could not be addressed (or a named release, profile, branch, test, module, lock entry, `--seed` guid or local-engine version is missing): gone, expired, unreachable, a stopped local engine, or a busy import. | Retry, or redeploy. |
| 9 | A write whose outcome is unknown, Ctrl-C during a write included. | Read the target's state before retrying. |
| 130 | Ctrl-C outside a write or install. | — |
