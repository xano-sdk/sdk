# Pulling an existing workspace

What `xanosdk init --from` writes, how faithful the pull is, and how to read its report.

## Running it

A pull is `init` with `xano/` filled from an existing backend instead of the empty starter,
so it is the scaffold command with one extra flag:

```bash
xanosdk init my-app --from workspace          # your real workspace (the one your login is scoped to)
xanosdk init my-app --from ephemeral:my-env   # a named ephemeral environment
xanosdk init my-app --from local:<name> # a running Xano Engine (`local list`) — no login
xanosdk init my-app --from ./ws.json          # a bundle already on disk — offline, no login
```

`--from` takes any backend in [the CLI's one grammar](cli.md#naming-a-backend) —
`workspace`, `ephemeral[:<name>]`, `local[:<name>]`, `tenant:<name>`, `release:<name>` —
or a bundle path. Unlike most commands it has no default: a pull names its source.

Everything else about the project is unchanged: `--framework` (`react`, `svelte` or `none`), the
theme flags, `--no-agents-md` and `--web` mean the same thing here as they do without `--from`.
The three flags that describe the pull itself — `--report`, `--skip-roundtrip` and `--branch` —
are refused without it rather than silently ignored.

The target directory decides what is written around `xano/`, as it does for a plain
[`init`](scaffold.md#no-frontend-and-existing-apps):

- **Empty or missing:** a new project, with the frontend `--framework` names (`none` for the
  backend alone).
- **A previous pull** (`xano/.xanosdk-codegen.json` is there): `xano/` is refreshed in place —
  see [Verification, and the decode report](#verification-and-the-decode-report) below.
- **Anything else:** an existing app, which gets the backend only. The decoded `xano/` is
  written, and the `xano:*` scripts and the backend's dependencies are merged into its
  `package.json`. An existing `xano/`, a file the pull would write, or a `xano:*` script with
  another command is a clash: all of them are listed and nothing is read or written unless
  `--force`. `--framework react|svelte` and the frontend-only flags are refused.

```bash
cd my-existing-app && npx @xano/sdk init --from workspace   # add the pulled backend to this app
```

### Just the tree: `generate`

`xanosdk generate <source>` writes the same decoded tree `init --from` puts in `xano/`, and nothing
else — no `package.json`, no frontend, no round-trip check. Use it to drop a backend into a repo
that already has its own shell, or to read one.

```bash
xanosdk generate workspace                    # → ./xano
xanosdk generate release:v1 --out ./backend   # a stored release
xanosdk generate ephemeral:my-env             # also tenant:<name>, local[:<name>]
xanosdk generate ./ws.json                    # a bundle on disk — offline, no login
xanosdk generate workspace --branch staging   # --branch applies to `workspace` only
```

The output directory must be new, empty, or a tree an earlier decode wrote — `generate` and
`init --from` both leave `.xanosdk-codegen.json` in it, and that marker is the proof. Replacing a tree
needs `--force`, and keeps its `.env` and `.secrets.json`; a non-empty directory
without the marker, or the working directory itself, is refused even with `--force`. Env var names
land in `.env.example`; the values a bundle carries land in the tree's `.env` — owner-only and
gitignored, as `init --from` writes them — unless `--no-secrets` declines them, and an existing
`.env` is kept. `--json` names them under `env` (names only). `xano.lock` is reconciled the way `pull` does it:
an entry survives only when the source still carries an object with that name and identity, so
generating a different backend into a tree cannot carry its old identities forward.

### Pulling a branch

`--branch <label>` reads that branch instead of the live one:

```bash
xanosdk init review-staging --from workspace --branch staging
xanosdk pull workspace --branch staging              # refresh that tree from the same branch
xanosdk workspace export --branch staging --path -   # the raw bundle, same selector
```

Only logic differs. Tables and microservices are shared by every branch, so the schema in the
tree is the same one live has — a branch pull changes the APIs, functions and tasks around it.

Three things are refused rather than quietly worked around, because each would otherwise hand
back a plausible tree built from something other than what was asked for:

- **A label the workspace does not have**, answered with the labels it does have.
- **An instance too old to honor the selector.** Such an instance accepts the branch, ignores
  it, and returns the live branch with a success status — so the SDK asks it about a branch
  that cannot exist first, and refuses to read at all if it gets an archive back instead of a
  refusal.
- **`--branch` on a source with no branches to choose between** — an ephemeral carries the
  logic it was deployed with, and a bundle file is one archive already exported from one
  branch. Re-export, or deploy from the branch you want, instead.

## The generated tree

Inside, `xano/` is shaped the way the workspace is: one directory per kind, with each
object under its parent — queries under the API group that owns them, triggers under
what they fire on. Each table gets its own `table/<name>.ts`, settings sit in `xano/workspace.ts`,
`_shared.ts` holds anything else referenced from more than one file, and `xano/README.md`
lists anything that did not translate cleanly.
Object identities (`guid`) are preserved, so cross-references stay intact. A statement
this SDK does not model yet round-trips verbatim rather than breaking the pull.

Pulled objects are authored the same way you would write them by hand — `table({...})`,
`query({...})`, `defineFunction({...})` — so the generated tree keeps its types. A pulled
table's columns still check on `fieldName`/`output`/`sortBy`, `InferInput<typeof q>` still
resolves a pulled query's payload, and a pulled agent still types `s.ai.agent.run`.

A pull states what the source workspace actually holds and leaves out what the SDK would
put back anyway. A table's `primary(id)` / `created_at` / `gin(xdo)` indexes are the
engine's standard set, so only the indexes someone created are listed. A trigger comes back
through the factory that built it (`tableTrigger`, `realtimeTrigger`, …) rather than a bare
`satisfies TriggerDef`, which keeps its typed stack handle; the two realtime types that bind
a def handle are the exception, since a stored trigger carries two guids with no way to know
they agree. And two objects that reference each other — a pair of tables joined both ways,
two functions that call each other — can't both be declared first, so the second reference
is a `{name, guid}` const hoisted to the top of the file (`const OrdersRef = {…}`) instead of
an import that would close a cycle. Only the guid is ever read, so it binds exactly.

`xano/README.md` also lists objects that were **already empty in the source** — an
endpoint someone created and never filled in pulls as a def with no `stack`, which looks
identical to a decode that gave up. The report is what tells the two apart.

A few options exist only so a pull can be *faithful*, and reading them in generated code
is the only time you should see them: `table: null` / `fn: null` (a statement whose target
was deleted or never bound), `merge` / `hidden` on a field, `paging: { enabled }` on a
query, `c.blank(tag)` (the editor's unconfigured value box — **not** a zero or an
empty collection; the engine reads `""` and `"0"` differently, so tidying one into the
other changes what the workspace stores), and `c.null("const:obj")` (the object-typed null
a `db.*` statement's `@meta` slot carries — different stored bytes from `c.obj(null)`,
which is the blank object, though both evaluate to null). They describe what the source workspace actually
stored — a pulled `table: null` is a defect to fix upstream, not a shape to copy — and
each carries that warning at the call site. A blank binding also reports, because a
statement wired to a table or function that no longer exists is worth seeing even though
it round-trips exactly.

## Verification, and the decode report

Then it checks its own work: the project it just wrote is loaded, exported, and diffed
against the workspace it came from. A mismatch names the object and fails the command
(`--skip-roundtrip` opts out). So "it compiled" and "it means the same thing" are separate
claims, and you get both.

A tree that passes gets its `xano/xano.lock` from that same export, so the lock is committed
with the first commit rather than written by the first deploy. As with a plain `init`, the
project is pinned in `xano.profile.json` to the profile the pull ran under. Under `--json` the
command answers with the project — `dir`, `name`, `pinnedProfile`, `lock`, `verified` — and
the findings under `report`.

The findings above are printed either way. Verification runs after decoding is finished,
so whether it passes, disagrees, or cannot run at all, the report describing the decode is
rendered first — and a tree that was written but does not re-export exits **2**, distinct
from the **1** you get when nothing was written at all. A tree that fails verification is
reported as unverified rather than ready, and the deploy next steps are withheld: the check
exists precisely because re-exporting that tree does not reproduce the workspace it came
from.

**A source that carries one object twice.** An export can repeat a stored object — the same
guid appearing on several records, differing only in generated editor ids. Those are merged
into one definition keeping the original guid, and the merge is reported as a notice, so a
tree holding fewer objects than the archive has records is explained rather than merely
smaller. Records that share a guid but genuinely differ are refused before anything is
written (exit **1**), naming both records and the fields they disagree on: one guid cannot
describe two objects, and renaming one or pinning a fresh guid would repoint every
reference that resolves through it.

**Reading the report.** It opens with a headline (`27 distinct issues across 424 findings;
3 need your attention`) and splits into three sections, most actionable first: *problems in
your workspace*, *things Xano SDK could not model*, and the things stated only so the output
is not ambiguous. That split is the question a reader actually has — a `raw()` passthrough
is ours to close, a lambda reading an unbound name is theirs to fix, and an empty object is
neither. Findings that repeat the same sentence across objects collapse to one line with a
count and a collapsed object list, and each names the generated file it landed in.
`--report full` prints every site instead; `--report json` prints the findings as data (piped
or under `--json`, as the `report` field of the command's one JSON document), and the same data is written into `xano/.xanosdk-codegen.json` on every pull, so parity is
trackable release over release and gateable in CI without scraping output.

Re-pulling is a real workflow: a second `init --from` into the same directory refreshes
`xano/` and leaves the rest of the project — your `package.json`, your `frontend/` —
exactly as you left it. No `--force` needed, because the tree carries a marker saying it
was decoded. It and `xanosdk pull` share one planner: before any write it lists the files it
will delete and the files it will rewrite — telling a file you edited since the last decode
from one only the source changed — refuses a `xano/` git reports as dirty, and asks; without
a terminal, `--yes` answers. It removes only files the previous decode wrote; one you added
beside them is kept and named. `xano.lock` is reconciled against the source (dropped entries
are listed), then updated from the new tree, so `export --check` passes after it. `--force`
over a `xano/` no decode wrote follows the same rules.

> ⚠️ **`xano/` is your source once pulled — commit it.** A refresh overwrites the files it
> decodes, so commit before one (an existing `xano/` that isn't a previous pull is a clash, and
> needs `--force`).
> It carries schema only — no table rows or stored files.
> `xanosdk deploy` sends it to the Xano Engine on this machine (`--ephemeral`: a disposable
> ephemeral environment) as a *full replace*;
> `xanosdk promote <release>` or `xanosdk deploy --to workspace` merges it into your real
> workspace. Workspace env vars are declared by name only — their values never enter the tree.

---
