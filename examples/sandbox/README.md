# Sandbox — implementation examples

A **full, deployable sandbox** demonstrating every primitive and statement in
`@xano/sdk`. One file per statement / filter / field type / value
constructor / object kind, wired together into a single Xano workspace that
type-checks and `export()`s as one coherent bundle.

This exists to (1) let a human eyeball how each piece of the API looks in real
code, and (2) give agents concrete, verified usage examples to learn from.

## Coverage

| Area | Count | Location |
|---|---|---|
| Statements (`s.*`) | 214 | `statements/**` |
| Value filters (`fl.*`) | 345 | `filters/**` |
| Field types (`f.*`) | 24 | `fields/**` |
| Value constructors (`c.*`, `ref`, `inp`, `col`, `auth`, `expr`, …) | 17 | `values/**` |
| Object kinds (`table`, `query`, `trigger`, `agent`, `workflowTest`, …) | 17 | `kinds/**` |

## Conventions

- **One primitive per file.** The directory mirrors the API path — e.g.
  `s.cloud.aws.s3.upload_file` lives at
  `statements/cloud/aws/s3/upload_file.ts`. Single-segment control-flow
  statements are grouped under `statements/control-flow/`.
- **Param gates → multiple exports.** When a statement/primitive has distinct
  authoring modes, each gate is its own exported `defineFunction` with a
  `/** Gate N — … */` note (see `statements/db/add.ts`, `statements/db/query.ts`,
  `values/const/obj.ts`, `kinds/trigger.ts`).
- **Everything is exercised.** A statement that binds an `as` output captures it
  and returns it via `response: ref("…")`, so the whole path is real.
- **Shared handles** (`users`, `posts`, `api`, `doubleFn`) live in `_shared.ts`
  and are reused across examples so cross-object references resolve.

## Regenerate & validate

The statement (codegen'd), filter, and field examples are produced by scripts;
the specials, object kinds, and value primitives are hand-authored. Generators
**never overwrite** existing files, so hand-tuned examples are safe.

```bash
npm run examples:gen     # (re)generate statements + filters + the _auto barrel
npm run examples:check   # regenerate the barrel and type-check the whole sandbox
npm test -- examples     # assert the sandbox exports as a valid workspace bundle
```

The sandbox carries a `workflowTest()` (in `_capture.ts`). Once it is deployed, run it —
and every saved unit test — with `xanosdk test run-all` (the backend you last deployed to;
`--on <backend>` names another), or deploy and run in one step with
`xanosdk deploy ./index.ts --test`.

## The loop, end to end

A deploy targets a disposable ephemeral. Reaching anything real goes through a
**release** — the stored record that this code came up and answered:

```bash
xanosdk deploy ./index.ts --test        # stand it up, run its tests
xanosdk release create v1               # cut a release from what just ran
xanosdk promote v1                      # land it, and read the branch back to check it arrived
xanosdk tenant deploy acme v1           # or on a customer tenant
```

`promote` names the workspace it is about to write to before it writes, and fails naming
anything the release declared that did not land. To look at what staged:

```bash
xanosdk workspace diff ./index.ts --branch <label>   # missing, differing, unexpected
xanosdk workspace export --branch <label>            # or the whole bundle
```

Going the other way — starting from a backend you did not author — is `pull`.
It takes the backend grammar every command shares (`release:<name>`,
`ephemeral[:<name>]`, `local-engine[:<name>]`, `tenant:<name>`, `workspace`; `init --from`
also takes a bundle path):

```bash
xanosdk init app --from release:v1      # a whole project around a release
xanosdk pull release:v1                 # or refresh xano/ in a project you have
xanosdk deploy ./index.ts               # iterate
xanosdk release create v2               # cut the next one
```

`pull` **replaces** `xano/`: anything the decode did not produce is deleted. It
lists what will go and refuses a dirty working tree, but it cannot preserve hand
edits — keep those outside `xano/`.

One escape hatch, deliberately less convenient than the path above:
`xanosdk deploy ./index.ts --to workspace` merges the local build straight into a
real destination. It keeps the checks that need a local build (`--dry-run`,
`--prune`) and leaves nothing to roll back to.

`_auto.ts` is generated — it collects every `statements/`, `filters/`,
`values/`, and `fields/` example and buckets it by kind for `index.ts`. The
object-kind examples in `kinds/` are hand-wired in `index.ts`.

The example tree type-checks against **source** via `tsconfig.json` here (which
aliases `@xano/sdk` → `../../src`). It is excluded from the package's own
build and typecheck; the runtime export guarantee is enforced by
`test/examples.test.ts`.
