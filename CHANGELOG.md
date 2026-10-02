# Changelog

All notable changes to [`@xanosdk/sdk`](https://www.npmjs.com/package/@xanosdk/sdk).

This file is **generated** from the [GitHub releases](https://github.com/xanots/sdk/releases)
by `npm run changelog` — edit the release, not this file. Each entry summarizes
one release and links to its full notes.

Versions before 0.0.1 belong to the retired `@xanosdk/core` line and are not
listed here.

---

## 0.0.52 — Static frontends and server rendering on a local engine

_2026-09-30_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.52)

`xanosdk deploy --local-engine` can now publish a frontend with `--static`, and a new SvelteKit adapter builds sites whose server routes a local engine renders.

- `deploy --local-engine --static` publishes the frontend
- `@xanosdk/sdk/sveltekit`: server rendering on a local engine

---

## 0.0.51 — Prompts and resources for MCP triggers

_2026-09-30_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.51)

MCP server triggers can now see and narrow the prompts and resources their server lists. `export()` also warns when a function call leaves out an input the function declares, and `xanosdk upgrade` installs the version it reports.

- ⚠️ MCP server triggers receive `prompts` and `resources`
- `s.function.run` warns when it leaves out a declared input
- `xanosdk upgrade` installs the version it reports

---

## 0.0.50 — Full test and marketplace detail in --json

_2026-09-30_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.50)

This release puts the full detail into three `--json` outputs that used to trim it. `test run` reports every expectation of a failed unit test, and `marketplace list` and `search` return each module's whole record. A warning that `diagnostics.allow` accepts is now still reported, and an allow that no longer accepts anything warns.

- `test run --json` reports every expectation of a unit test
- `marketplace list` and `search` return each module's whole record
- A warning that `diagnostics.allow` accepts is still reported
- An allow that accepts nothing warns `diagnostics.allow-unused`

---

## 0.0.49 — Repo-hosted files for MCP and seeds

_2026-09-30_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.49)

This release adds `hostedFile()`, which points an MCP icon or a seeded file column at a file in your repo. The file ships with every deploy and is served by each backend at its own address. It also widens per-def `diagnostics.allow` to accept any warning raised about that def, and gives a refused credential its own `--json` error code.

- `hostedFile()` ships repo files for MCP icons and seeded file columns
- `diagnostics.allow` accepts any warning raised about the def
- Attached middleware with `input` warns again when it is also called
- A refused credential is `SDK_CREDENTIAL_REJECTED` in `--json`

---

## 0.0.48 — MCP prompts and resources

_2026-09-29_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.48)

This release adds MCP prompts and resources as first-class kinds, alongside tool metadata and two MCP-only statements. It also fixes two CLI papercuts: one bad local engine no longer breaks every other engine's commands, and a nested backend now reads its own env and secrets files.

- MCP servers can author prompts and resources
- Tools carry MCP metadata
- `s.mcp.elicit` and `s.mcp.progress` statements
- One foreign local engine no longer breaks `--local-engine`
- A nested backend reads its own env and secrets

---

## 0.0.47 — A CLI hardened end to end

_2026-09-29_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.47)

This release hardens the `xanosdk` CLI end to end. Every deploy, release, tenant, lock and account command was driven by repeated live E2E passes against real instances until each printed remedy ran as printed. Exit codes, `--json` documents and warnings now follow one contract. Scripts that read exit codes or `--json` output should check the ⚠️ items below.

- ⚠️ Exit codes follow one table: usage 1, not found or unanswered 8, unknown outcome 9
- ⚠️ `--json` failures and warnings have one shape
- `xano.lock` records where each deploy landed
- Deploys refuse instead of landing blind
- `export --strict` reports every finding in one numbered list
- Declaration builds and typed responses reach further
- Documentation corrections you may have copied
- Local engine, marketplace and account polish

---

## 0.0.46 — Declarations for guard defs, clearer deploy help

_2026-09-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.46)

A package that publishes defs using `guard.found` or `guard.owner` can now emit its own `.d.ts`. `xanosdk deploy --help` now says which flags only work with `--to`, and a refusal that already names its fix prints that line alone instead of above the full help page.

- Defs using `guard.found` or `guard.owner` can emit declarations
- `deploy --help` marks the ten flags that need `--to`
- Refusals that name their fix no longer print the help page after them

---

## 0.0.45 — Race-free counters with db.increment

_2026-09-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.45)

`s.db.increment` adds a number to a numeric column on every row a `where` matches, in one atomic UPDATE, so counters, stock levels, balances and tallies no longer lose updates when two requests overlap. `db.bulk.delete` now also catches a filter that is OR-ed with an empty `and()`, which deletes every row. The CLI guide lists the commands and flags it was missing.

- `s.db.increment` updates counters without losing concurrent writes
- ⚠️ `db.bulk.delete` requires `allRows` for a filter OR-ed with an empty `and()`
- The CLI guide lists its missing commands and flags

---

## 0.0.44 — Found rows narrow to non-null

_2026-09-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.44)

`guard.found` proves a row exists and narrows its type, so an endpoint that returns a fetched row no longer types as `Row | null` or needs a hand-written `responseShape`. `export()` also warns on a realtime channel trigger that reads a path param with `inp()`, which used to pass `--strict` and then deny every client at runtime. Five doc gaps from a field report are fixed too.

- `guard.found` narrows a fetched row to non-null
- `inp()` of a channel path param in a channel trigger now warns
- Five doc corrections from a field report

---

## 0.0.43 — Scaffolds that stay lean

_2026-09-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.43)

New projects now match what shadcn's CLI writes and take every endpoint path from the generated route manifest, so an agent working in a fresh scaffold stops rewriting correct CLI output and stops pulling the backend definition into the browser bundle. `query()` also keeps the verb you declare, so a check that a def matches its route now catches a swapped verb.

- Frontends take endpoint paths from the generated route manifest
- React scaffolds use shadcn's `cn` package
- A query's `verb` is typed as the literal you declared

---

## 0.0.42 — One way to name a backend

_2026-09-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.42)

This release gives every CLI command one way to name a backend, and makes a local engine a backend like any other. It also adds `xanosdk generate` and `xanosdk env set` / `env unset`, and fixes two export checks and a stall when reading back large workspaces. Some flags were renamed with no alias. The first section lists them, and each old spelling fails with a message that names the new one.

- ⚠️ Every command names a backend the same way, local engine included
- `xanosdk env set` / `env unset` change one env var without a deploy
- `xanosdk generate` writes just the `xano/` tree from any source
- Export refuses two routes that one request path can reach
- An input named `run` filled by a call is flagged
- Reading a workspace back skips stored file bytes
- Every deploy imports the same way

---

## 0.0.41 — Public seeds and nullable inputs

_2026-09-24_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.41)

This release fixes three problems found in real deploys: seed values in a `--static` deploy, optional date and file inputs, and preflight on queries that share a name. There is one behavior change: `--allow-seed-in-static` is gone, and you now list public seed columns on the table with `publicSeed`.

- ⚠️ `table({ publicSeed })` replaces `--allow-seed-in-static`
- Every `--json` failure has its own code and data
- An omitted optional date, timestamp or file input is null
- Inferred types include `| null` for fields that are nullable by default
- Preflight tells apart queries with the same name

---

## 0.0.40 — A pinned local engine, no setup

_2026-09-24_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.40)

This release makes `xanosdk deploy --local-engine` work on a fresh machine with nothing configured, and makes every checkout of a project run the same engine version. The version is pinned in the project's `package.json`, newer engines are offered rather than forced, and new `local-engine update` and `local-engine cache` commands manage the pin and the downloads. There is one behavior change: `XANOSDK_LOCAL_ENGINE_PATH` is gone, replaced by `XANOSDK_LOCAL_ENGINE_OVERRIDE`.

- `deploy --local-engine` needs no setup and pins the engine version
- Newer engines are offered, never forced
- A running engine on the wrong version is replaced
- New `local-engine update` and `local-engine cache list|clear` commands
- ⚠️ `XANOSDK_LOCAL_ENGINE_OVERRIDE` replaces `XANOSDK_LOCAL_ENGINE_PATH`

---

## 0.0.39 — Addons that hold up after a merge

_2026-09-23_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.39)

This release fixes addons, `obj()` records, workflow-test headers and one CLI flag. Addon output columns and sorts now behave the same after a merge deploy as after a replace. A filtered record member no longer drops the member after it. There is one behavior change: `addon({ sort })` with `cardinality: "count"` or `"exists"` now throws.

- Addon output columns survive a merge deploy
- `addon({ sort })` now sorts the grafted rows
- ⚠️ `addon({ sort })` with `cardinality: "count"` or `"exists"` throws
- A filtered `obj()` member no longer swallows the next one
- `s.api.call` sends header names Title-Cased, as real requests do
- `--out` is refused on commands that don't write to it
- An empty file column doesn't match a null check in `where`

---

## 0.0.38 — Move what you already built

_2026-09-23_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.38)

You can now move work you already built without rebuilding it. Publish a built frontend on its own, copy a release to another workspace or instance, and redeploy without losing your table rows. Release writes also report one result shape, and an outcome that can't be known exits with its own code. One breaking removal: `s.db.get_by_id` is gone, and `s.db.get` does the same fetch.

- `xanosdk publish <dir>` publishes a built frontend without touching the backend
- `xanosdk release transfer` copies a release to another workspace or instance
- `deploy --keep-data` keeps your table rows across redeploys
- Every release write reports one result, and exit 9 means "unknown"
- A release cut is confirmed under the name the server actually stored
- `xanosdk local-engine token` prints a local engine's meta API token
- Middleware in the `post` phase: `get_all_input` holds the response, not the request
- ⚠️ `s.db.get_by_id` and retired CLI flags are removed

---

## 0.0.37 — Your backend, on your machine

_2026-09-22_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.37)

A second deploy destination: your compiled workspace running on a real backend on your own machine, in one command, with no sign-in and no network round-trip per iteration. It ships behind a flag as a prototype. One change is not a prototype and reaches everyone — a deploy that publishes no static site now points a scaffolded project's dev server at the backend it just made, for the hosted destination as well as the new one.

- Your dev server follows the deploy, on every destination
- `xanosdk deploy --local-engine` deploys to an engine on this machine
- Point the flag at a file, not only a URL
- `XANOSDK_LOCAL_ENGINE_PATH` makes a bare flag work anywhere
- `xanosdk local-engine list`, `stop` and `impersonate`
- New projects get a one-command local redeploy
- The deploy summary gained a destination, and kept its old shape
- Two test guards that fired on correct code

---

## 0.0.36 — What a replace takes with it

_2026-09-22_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.36)

`xanosdk deploy --to workspace --replace` destroyed every branch in the target workspace and said nothing about it — not in the plan, not in the warning, and `--yes` skipped the confirmation entirely. The branches are gone permanently, along with the saved versions that would restore one. It is now refused unless you acknowledge the loss, and the branches at risk are named before anything is written. **If you run `--replace --yes` in CI against a workspace that has other branches, that command now fails until you add `--allow-branch-deletion`.**

- ⚠️ `--replace` deleted every branch in the workspace, silently
- The plan names the branches, and splits them by who made them
- The same scope is in `--json`, for tools that ask before acting
- A release could name code you never deployed, and said nothing

---

## 0.0.35 — Know where it went

_2026-09-18_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.35)

This release makes the CLI say where it is writing before it writes, and prove that what it wrote arrived. Two sessions had deployed a backend to the wrong workspace and reported green; a promote had landed a branch carrying none of its functions and reported success. Both are now errors rather than checkmarks. One behavior change to know about: `promote` can exit non-zero where it used to exit 0, which means the landing was incomplete.

- `promote` reads back what it landed and fails on anything missing
- ⚠️ `--set-live` is two steps now, and serves only a verified landing
- ⚠️ A project's profile pin now outranks `$XANO_PROFILE`
- Every writing command names its destination before it writes
- `workspace diff` compares a staged branch against your compile
- `workspace reset-tables` puts named tables back to their seed rows
- Reference data has a written ordering rule
- `promote --json` gains `ok` and `verification`

---

## 0.0.34 — CLI paths that shipped broken

_2026-09-17_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.34)

Two CLI paths that shipped broken now work. If your backend lives anywhere other than `xano/`, every command that reads or writes env and secrets was pointed at the wrong directory — and `xanosdk preflight` was unusable unless you had the maintainer environment variables set, despite the public help offering it. Both are fixed, with one behavior worth knowing about even on a standard layout: a stray `.env` in your working directory can no longer decide which instance your backend uploads to.

- A backend outside `xano/` now reads its own env and secrets
- `xanosdk preflight` works after `xanosdk login`
- A `.env` in your working directory can no longer redirect a deploy

---

## 0.0.33 — A pulled tree deploys as pulled

_2026-09-17_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.33)

`init --from` could not verify a workspace that stores a documentation token with the gate switched off, and a tree deployed past that check turned the gate on — closing a doc site the workspace had deliberately left open. Both are fixed and verified against a live backend. A round trip that fails for any other reason now also names version skew between the CLI and the SDK the tree resolved, instead of sending you to fix a workspace that was never wrong.

- A stored documentation token no longer invents a gate
- A failed round trip names version skew instead of blaming your workspace
- `xanosdk routes` and `paths` work on a project whose doc site is gated

---

## 0.0.32 — The doc token leaves your repo

_2026-09-17_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.32)

The token gating a hosted API doc site is a secret, and until now a pull wrote it straight into committed source — every API group's, plus the workspace's. Deleting the block to get rid of it was worse: an absent `documentation` key was sent as the engine default, which cleared a Private doc site's gate while leaving the docs published. Both are closed. The token now lives in a gitignored `xano/.secrets.json`, keyed by the object that owns it, and source declares only that a gate exists.

- ⚠️ A pulled doc-site token no longer lands in committed source
- ⚠️ Omitting `documentation` no longer clears a live doc-site gate
- `xanosdk secrets fill` mints a token for a gate you declared yourself
- CI supplies doc tokens without the sidecar
- ⚠️ A release name that is really a path is refused

---

## 0.0.31 — Modules refuse the wrong SDK

_2026-09-16_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.31)

A toolchain module built for a newer SDK than the one running it used to fail by succeeding: every hook on the contract is optional, so it loaded, registered, and contributed nothing while the command reported success. This release closes that in both directions — the loader refuses it by name, and the installers never leave one on disk to be refused later. The marketplace and module-contract guides land alongside it.

- A module built for a newer SDK is refused at load, by name
- An install that cannot work is undone, not announced
- `marketplace remove` says what is actually true
- Two guides for building and installing add-ons

---

## 0.0.30 — Install, and it's configured

_2026-09-16_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.30)

Installing a module now configures it. `xanosdk marketplace install` was `npm install` plus a message — a toolchain module's questions were never asked, its `.gitattributes` lines never written, and the per-project config block every later `deploy` reads never created. That is now one idempotent reconciler over your `dependencies` and stored config, which `install`, `reinstall` and `remove` all drive, so a module configures correctly however it arrived — including by a plain `npm install` or a merged PR that no xanosdk command ever saw. Module authors: the plugin contract changed shape and the old one is refused by name.

- `marketplace install` configures the module it installs
- `marketplace reinstall <package>` re-asks a module its questions
- `marketplace remove <package>` drops what the module contributed
- ⚠️ The plugin contract applies to a project, not a scaffold
- A module that arrived without the CLI is now reported
- `init` asked one question twice, and hid what npm was doing
- `init --force` dropped your module config block
- Managed blocks are a shared mechanism

---

## 0.0.29 — Modules that extend the CLI

_2026-09-16_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.29)

A second kind of module lands: one that extends the **CLI** instead of the workspace. A workspace module (`@xanosdk/auth`, `@xanosdk/chatbot`) adds tables and endpoints you register in `xano/index.ts`; a toolchain module registers nothing and instead participates in the commands — contributing `init` questions and scaffold fragments, and running hooks on `export`, `deploy` and `preflight`. Everything under it is built to fail loudly: a module that cannot run is never allowed to look like one that passed, and your env values never reach third-party hook code.

- The toolchain-module contract ships on `@xanosdk/sdk/plugin`
- A module that cannot run fails the build rather than passing it
- Env values are blanked before any hook sees them
- `init` installs before it asks
- Per-project module settings live in your `package.json`
- A module's own `--flag value` could steal the scaffold's target directory
- `--marketplace` reported a working module as broken
- `.gitattributes` gains a slot for module-contributed lines

---

## 0.0.28 — Secrets out of source

_2026-09-15_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.28)

Workspace env var values no longer live in a committed file: a pull now writes names
with the values in a gitignored `xano/.env`, and `xanosdk env pull` fills it from a live
backend. The rest closes the complex-app gap analysis — typed builders for the SQL-side
`qf.*` filter registry, the runtime predicates the eight operators cannot spell, ordered
authorization guards, and `respond.*` for the HTTP status line, probed against a live
engine rather than inferred.

- ⚠️ Workspace env values move to `xano/.env`, names are declared in source
- `xanosdk env pull` fills `xano/.env` from a live source
- `respond.status` / `respond.redirect` / `respond.header` — the status line
- `qf.*` — typed builders for the SQL-side query-expression filters
- `cond.*` — the runtime predicates the eight operators cannot spell
- `guard.role` / `guard.owner` / `guard.require` — authorization in the right order
- `typedEnv()` and the `stack.env-undeclared` warning
- Per-kind blocks the SDK was dropping
- Instance-capability listing at export, and `set_var` constant branding

---

## 0.0.27 — The guards that weren't

_2026-09-15_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.27)

Seven fixes, and most of them are the same story: a guard that was not guarding. The lock check passed the one rename it exists to stop, the release list walked itself into silence past 100 rows, and three release fields shipped structurally dead because the tests agreed with the projection instead of checking it. Also new: the CLI holds more than one credential.

- ⚠️ A rename in code no longer passes `xano:check`
- Named credential profiles
- `release list` no longer goes silent past 100 rows
- Three dead fields on a release record, found by recording a live one
- An empty description stays the empty string the server reported
- `release create --branch` refuses a bad label before it cuts
- `init --from` handles an archive that repeats one object

---

## 0.0.26 — The guid you can write down

_2026-09-14_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.26)

Object identity in this SDK is now something you can write down and rely on. A full-replace deploy used to mint a fresh guid for every object and discard the ones your project carried, so a guid noted before a redeploy named nothing afterwards — and the next release into that workspace matched nothing and duplicated everything. It no longer does. Alongside that, `release create --seed` gains guid-based table selection and a `tables` listing verb on every source you can cut from, so the values it takes are obtainable in the first place.

- `xanosdk deploy` and `release --replace` preserve object identity
- A replace no longer rewrites your `xano.lock`
- Guid selection is documented as stable, not as a trap
- `--seed` explains a guid that does not match
- Select seeded tables by guid, and list them from any source you can cut from
- A rows-free release says what it actually contains
- ⚠️ `--expires-hours` now accepts 1–24

---

## 0.0.25 — The release-chain fixes

_2026-09-10_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.25)

Three fixes to the release chain, all found by running `ephemeral → release → promote / tenant deploy` end to end against a live backend rather than in tests. One of them is that `tenant deploy` had never worked at all: it sent the wrong parameter name and every invocation was refused, so landing a release on a customer tenant was closed. Nothing here changes how you author a workspace.

- `tenant deploy` never landed a release, and now does
- `release create --json` reported `createdAt` in two different formats
- `release create --help` offered a source it refuses

---

## 0.0.24 — Every branch gets a name

_2026-09-10_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.24)

A promote used to land your backend on a branch nobody could name. The engine's answer to a release deploy that names no branch is a branch with an *empty label* — the queries, functions and tasks went there, the tables arrived anyway because they are workspace-scoped, and the whole thing reported success. Every promote names its branch now, and the branch listing admits when one has no name. Anyone whose workspace already holds one can finally see it.

- ⚠️ A promote landed your logic on a branch nobody could name
- `--set-live` with no `--branch` lands and serves in one call
- `--backup-branch` on a promote is refused, not silently ignored
- `xanosdk workspace branch list` shows a branch carrying no label

---

## 0.0.23 — The release that came from somewhere else

_2026-09-10_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.23)

Cutting a release from a running environment is now **one server-side call** instead of four, and the result is verified rather than trusted. Two platform changes landed together and both reach `xanosdk release`: the release route takes a source tenant, and an OAuth token is now pinned to the workspace it was issued for across the whole Meta API, for every role.

Everything below was measured against a live instance, not inferred.

- The cut is one call, and writes nothing to the source
- A release cut from an out-of-date instance is refused, not trusted
- ⚠️ A sandbox tenant can be a release source, and `--from <bare-name>` no longer resolves
- A workspace-binding refusal explains itself
- `release show` no longer tells you to re-cut an intact release
- The release name was being compiled as a project
- npm was not found when Homebrew installed node

---

## 0.0.22 — A release is a noun

_2026-09-07_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.22)

Xano has a first-class **release** object, and this version restructures the CLI around it. A deploy targets a disposable ephemeral; reaching anything real — your workspace, or a customer's tenant — goes through a release, the stored record that this code came up and answered.

**This is a breaking change.** `xanosdk release ./xano/index.ts` no longer exists. `release` is now a namespace, production is `xanosdk promote <release>`, and `xanosdk deploy --to workspace` keeps the old merge behaviour as a deliberate escape hatch.

- ⚠️ A release is a noun, and the destination is never a default
- `promote` and `tenant deploy` land a release without touching your data
- `deploy` takes any source, and `--to` is the escape hatch
- `xanosdk pull` refreshes a project's backend without rescaffolding it
- A release is cut where it can be cut, and always lands in your workspace
- `release create` no longer accepts a customer tenant
- Flags that chose a destination, or promised a preview, no longer fail quietly
- Scaffolded repos render and check their committed `xanoscript/` tree

---

## 0.0.21 — XanoScript, rendered where the code is

_2026-09-07_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.21)

XanoScript is now produced inside the SDK. `xanosdk export` renders a workspace to XanoScript locally, byte-identical to what the engine returns for the same workspace, and can keep that rendering committed beside the TypeScript as one `.xs` file per object. New projects get this by default: the `xanosdk init` scaffold's `xano:export` writes the tree and `xano:check` fails when it is stale.

- `xanosdk export --format xs` renders XanoScript locally, byte-identical to the engine
- `xanosdk export --xanoscript` keeps a committed XanoScript tree beside the source
- `xanosdk init` scaffolds `xano:export` and `xano:check` with `--xanoscript`
- `xanosdk preflight --xanoscript` diffs the local rendering against the engine's

---

## 0.0.20 — The statement that could not come back

_2026-09-06_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.20)

One removal: a builder whose output could not survive a round trip. `s.security.create_guid` emitted a statement that is real at runtime but **internal** — the XanoScript language has no spelling for it, so a workspace containing it rendered a placeholder on pull and did not come back on push.

- `s.security.create_guid` is removed — use `create_uuid`

---

## 0.0.19 — The internal statement

_2026-09-06_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.19)

Two changes, both about a surface that was telling callers the wrong thing: a builder that emitted an **internal** engine statement, and the call family's last unverified claim. One is a behaviour change for anyone using `s.db.get_by_id`; the other is the retirement of the final `@TODO(byte-verify)` marker.

- `db.get_by_id` emitted an internal statement — and a `0` key failed the whole request
- The call family's last unverified claim is now backed by engine bytes

---

## 0.0.18 — The confident wrong answers

_2026-09-04_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.18)

Six fixes, each one a case where the output was confident and wrong: a tool that reported success while writing nothing, a preflight that reported a diff on a correct deploy, an MCP URL that 404'd, and three documented claims that were the opposite of what the engine does. Four were found by measuring against 0.0.17 rather than by reading, which is why they had survived being read.

- A tool passed as a bare handle runs with no caller, and `auth()` inside it fails as a *successful* result
- Preflight reported a round-trip diff on every auth-gated query
- `mcpServer().getUrl()` built a 404 for any tenant
- `resultStrategy` in a `pre` middleware rewrites the host's request inputs
- An `auth()`-keyed limiter on a public host 403s the first call — it never shares a bucket
- The `exceptionPolicy` default contradiction told authors their guards were inert

---

## 0.0.17 — The unchecked paths

_2026-09-03_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.17)

Three paths in this release reported success without having checked anything: `xanosdk preflight` skipped whole object kinds, a release proceeded when it could not read the target workspace, and a microservice had no way to reference a secret instead of inlining it. All three now either check or refuse, and preflight's registry has a guard so a newly added kind cannot drop out of it silently.

- Preflight skipped realtime, microservice and API-group objects entirely
- A microservice can name a workspace env var instead of inlining the secret
- A pulled microservice lost its env reference on the next deploy
- A release into a workspace it could not read is refused, not warned
- Releases apply through one import route

---

## 0.0.16 — Branch reads and locked identity

_2026-09-03_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.16)

This release is about a release telling you the truth before it changes your workspace, and about reading a branch without touching production. Every build now writes `xano.lock` with no flag, `--branch` actually reads the branch you name instead of silently handing you live, and a release that would rename a workspace, collide with an identity it does not own, or land on a public URL it cannot serve now says so — several of those cases previously exited 0.

- ⚠️ Every build writes `xano.lock`; `--no-lock` opts out
- ⚠️ `--branch <label>` reads that branch — and refuses when it cannot
- Branch-targeted releases are no longer hidden
- A release refuses a collision instead of reporting success over a broken workspace
- The plan names the rename and the URLs the instance will invent
- The lock records whether a public slug is a contract or a convenience
- Releases use the SDK's own import route when the instance has it
- `f.decimal` and `f.int` state the bounds that were measured

---

## 0.0.15 — The silent failures

_2026-09-02_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.15)

Four of the five fixes here failed quietly: a downstream package that could not emit declarations at all, a paged endpoint answering `[]` at HTTP 200, a public API's 403 arriving as null fields, and a freshly scaffolded project that did not compile on a line nobody wrote. Each is now either fixed at the source or caught by a check that goes red. The seed-data guidance for tests also ships with the constraint that makes it safe.

- A downstream package could not emit declarations at all
- A paged `db.query` roots its `output` selection at the envelope
- `xanosdk init` never scaffolds a register call whose options are required
- `datasource: 'live'` is safe on an ephemeral — and stored, not per-run
- `s.api.request` sends no `User-Agent`
- `xanosdk status` no longer labels its reads `whoami`

---

## 0.0.14 — The router with headroom

_2026-09-01_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.14)

A grounding-docs release. The always-read `llms.txt` router was sitting at exactly its 10,000-token ceiling; it now reads at 8,192 with its gotchas grouped by where you are standing and the rule stated before the failure. Two new topic files carry what moved out plus an index of the exact error strings the engine returns. No runtime code changes.

- The router drops from 10,000 to 8,192 tokens
- Gotchas are grouped and rule-first
- Twelve long topic-file bullets are one rule per line
- New `llms/errors.md` maps exact error strings to their fix
- New `llms/client.md` for the frontend side
- The Quickstart names the check-your-work loop

---

## 0.0.13 — The realtime gate contract

_2026-09-01_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.13)

Realtime v2 lifecycle triggers get their contract straightened out. A `join`
gate written the way the docs described — reading a channel path param as
`inp("room_id")` — raises at runtime and refuses every client, and a `deliver`
trigger had no typed way to read the payload it exists to transform. Both are
fixed, along with two gate rules the docs never carried. Every claim here was
verified by driving a real websocket client against a live engine.

- ⚠️ A channel path param is not a lifecycle-trigger input — read it from the session
- A `deliver` trigger now reads its payload through the typed handle
- Inside `{ allowed }`, admission needs strictly `true`
- A gate establishes no auth, so `auth.id` reads 0

---

## 0.0.12 — Values that answer themselves

_2026-09-01_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.12)

0.0.12 fixes a silent wrong answer: `c.now()` inside an `obj()` served the string
`"now"` instead of a timestamp, and in a realtime handler that string was written
into the stored transcript and replayed to every joiner. It also lands the four
reports from #310 — `export` was rewriting `CLAUDE.md` with the wrong theme — and
a truthfulness pass over what ships to an agent: corrected claims, and ~480 KB of
maintainer-addressed JSDoc taken out of the consumer type surface.

- `c.now()` inside `obj()` answered the string `"now"`
- `export` rewrote `CLAUDE.md` with the wrong theme
- `bind` joins: the typed path across a join, stated
- `fields: null` on 65 statements means "typed wrapper", not "missing"
- `QUERY_EXPRESSION_FILTERS` / `VECTOR_FILTERS`: where they live, and that `fl.*` cannot spell them
- The shipped type surface stopped carrying maintainer residue
- Four documented claims corrected against the source

---

## 0.0.11 — The silent-success pass

_2026-08-31_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.11)

This release adds one new entry point and closes a set of shapes that compiled clean and then went wrong at request time — a regex pair that answered `false` for every input, a read addressed by query string instead of by path, a column name the engine reserves, and a `0` id that fails a whole request. Most land as warnings, so an ordinary build is unaffected; `export --strict` promotes them, so a strict build that passed on 0.0.10 can newly fail. It also corrects one piece of published advice: a physical table name is not stable across deploys, and the old atomic-counter guidance said to hardcode it.

- `@xanosdk/sdk/bundle` reads a compiled bundle without reimplementing the SDK
- ⚠️ A reversed regex operand pair is refused instead of answering `false` forever
- ⚠️ An addressing input missing from a query's path now warns
- ⚠️ A reserved `run` column and a `get_by_id` id that can be `0` now warn
- `obj()` accepts `c.obj` and `c.array` members
- `./manifest.json` is exported from the package
- Corrected: a physical table name is not stable across deploys

---

## 0.0.10 — The CLI surface pass

_2026-08-31_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.10)

This release is a CLI surface pass, and it is breaking throughout. Six ways to start a project collapse to `init` plus two flags, the sandbox environment is gone with every surface that named it, and a run of commands and flags were renamed to say what they actually do — including three that each carried two or three unrelated meanings. One command is new: `xanosdk status` answers where you stand in a single read.

- ⚠️ Project creation is one command: `init`, with `--from` and `--web`
- ⚠️ The sandbox environment is gone
- ⚠️ `deploy` takes no environment flag
- `xanosdk status` — who, where, and which environment
- ⚠️ `validate` is now `preflight`, and `lock adopt` is now `lock import`
- ⚠️ `--dest` is now `--env`, and names environments the way `--from` does
- ⚠️ Flags that carried several meanings were split apart
- `routes` and `whoami` are the canonical spellings

---

## 0.0.9 — Eight reports from real use

_2026-08-31_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.9)

Eight reports, all from one round of real-world use, and every one of them a case that type-checks, exports under `--strict` and deploys clean before going wrong. The headline is a deploy that could not succeed at all: any seeded number below `1e-4` failed the import with a signature error that named nothing. The rest correct places where the docs described behavior the engine does not have — a search operator that silently matches nothing, a by-id read that rejects the sentinel the field docs prescribe, and a seeding question whose two possible answers demanded opposite designs.

- Seed data holding a number below `1e-4` no longer fails the deploy
- ⚠️ Every test JSON document puts its per-test array under `tests`
- `like` and `ilike` match nothing for a bare term — reach for `includes`
- `db.get_by_id` rejects the `0` optional-FK sentinel, and takes the whole request with it
- A seeded `f.password()` column IS hashed, so demo credentials work as fixtures
- Native email is discoverable, and the built-in provider needs no configuration
- A relative entry path names the directory it resolved against
- Three fields the docs called plain values take tagged ones

---

## 0.0.8 — The auth() lookalike

_2026-08-30_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.8)

`ref("auth.id")` looks like it reads the authenticated caller. It does not, and the engine's error for it — `Missing var entry: auth` — pointed nowhere useful. That spelling, and every other reserved namespace read as if it were a stack variable, now fails the export with the accessor that works. The same mistake was shipped in our own file-upload recipe, which is corrected.

- ⚠️ `ref()` on an engine-reserved namespace now fails the export
- The file-upload recipe read the input bag the wrong way
- The unbound-variable warning now quotes the error you actually get

---

## 0.0.7 — Verb pairs on one path

_2026-08-29_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.7)

Queries are now identified the way the engine identifies them — by api group, verb, and name together — so `GET /items` and `POST /items` are two endpoints instead of one export error. The grounding docs an AI agent reads got a full pass for people arriving at Xano for the first time, and two silent-failure classes now surface at `export()` instead of on a live endpoint.

- A `GET` and `POST` on the same path no longer collide
- ⚠️ A query's verb and api group are now part of its identity
- ⚠️ `s.api.call` takes the query handle, not a bare name
- A tagged value in a template literal now fails the build instead of shipping garbage
- The grounding docs assume no prior Xano knowledge
- `xanosdk deploy` no longer loops on "re-run the deploy" when your session has expired

---

## 0.0.6 — The action identity fix

_2026-08-28_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.6)

`action.call` and `action.package.call` now take the identity the instance assigned at install
instead of deriving one from a name. A derived id is well-formed and addresses nothing, so those
calls exported clean and never resolved — if you have either in a workspace, this is a call-site
change you need to make. Alongside it: a lock-file false positive that refused a legal workspace,
and a grounding correction about what an omitted column on `db.add` actually stores.

- ⚠️ `action.call` takes the id the instance assigned, not one derived from a name
- One canonical on two different kinds is no longer a lock error
- An omitted column on `db.add` lands on its own default, not `null`
- `xanosdk init` asks two questions instead of three

---

## 0.0.5 — Sign in without a loopback

_2026-08-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.5)

`xanosdk login` only ever worked when the browser finishing consent could reach your machine's `127.0.0.1`. On a remote shell, a container, or a Codespace it can't — the redirect lands nowhere and login sits there for five minutes before timing out. `xanosdk login --paste` fixes that: it binds nothing, prints the URL for you to open anywhere, and you paste the redirect back. This release also corrects two documented promises that were wrong, one of which was actively misleading for exactly this case.

- `xanosdk login --paste` signs you in where the loopback can't be reached
- `XANO_NO_BROWSER` never covered remote shells, despite saying it did
- `--port` documented a default it did not have

---

## 0.0.4 — The markdown your agents read

_2026-08-26_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.4)

Knowledge is now workspace source: the markdown your Xano agents read before they act is authored as real `.md` files, reviewed in a diff, and deployed with the code it describes. Two commands join the CLI — `xanosdk onboard` puts the scaffold's choices in a browser, and `xanosdk upgrade` answers the version question on purpose rather than nudging. Windows users should take this one regardless: every npm call in the package was failing before it reached npm.

- `knowledge()` — author the markdown your Xano agents read
- `xanosdk onboard` — pick the scaffold's look in a browser
- `xanosdk upgrade` — the version question asked on purpose
- Every npm call failed on a current Node for Windows
- The guides ship in the tarball
- `CHANGELOG.md` ships, generated from the releases

---

## 0.0.3 — The scaffold gets a look

_2026-08-25_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.3)

`xanosdk init` wrote one hard-coded stylesheet, so every scaffolded project looked
identical. It now takes a theme, a corner radius, a dark-mode strategy, three
typeface slots and an icon set — 126 themes composed from shadcn/ui's own tables,
or any registry theme URL. The same command can install **and register**
marketplace add-ons in one line, and the agent grounding now points assistants at
a prebuilt module instead of hand-rolling one. Nothing changes for anyone not
passing the new flags: no flags and no TTY scaffolds exactly what it did before.

- `xanosdk init` takes a theme, typefaces and an icon set
- `chart-*` and `sidebar-*` were missing from every scaffolded stylesheet
- `components.json` hard-coded a base color the stylesheet no longer used
- Dark mode shipped inert
- `--marketplace` installs add-ons and registers them
- Agents are grounded in marketplace discovery and the first-party modules
- New `@xanosdk/sdk/scaffold` export carries the scaffold's palette as data

---

## 0.0.2 — What the engine actually requires

_2026-08-25_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.2)

This release is about the statement surface refusing what the engine cannot accept, while you are writing rather than after you deploy. An absent required argument does not error on Xano — it substitutes a type default and answers HTTP 200 with a confident wrong result, which nothing downstream can distinguish from a right one. So 50-odd arguments that were typed optional are now required, one field the engine never reads is gone, and the wrappers that used to pass a missing field along now name it. If your code omitted any of them it will stop type-checking; it was already producing the wrong answer.

- ⚠️ 25 arguments across 15 statements are now required
- ⚠️ The Elasticsearch and OpenSearch credentials and target are required
- ⚠️ `webflow.request` no longer offers a `headers` field
- ⚠️ Statements that passed a missing field along now refuse it
- A zero-argument call names the field it needs
- A pulled workspace decodes where it used to fall back to `raw()`
- Every statement in the catalog has byte evidence behind it

---

## 0.0.1 — The new name, and a README to match

_2026-08-24_ · [release notes](https://github.com/xanots/sdk/releases/tag/v0.0.1)

The SDK is now published as **`@xanosdk/sdk`**, starting a fresh version line at 0.0.1. The name says what the package is — the authoring surface, the compiler, and the CLI — rather than implying one member of a family with a shared core. Alongside the rename: two new build-time warnings for shapes that used to ship clean and then misbehave at request time, and a README rebuilt as a landing page with its reference material split into browsable guides.

- ⚠️ The package is now `@xanosdk/sdk`
- `s.switch` fell through without `break: true`
- A filtered operand in a `where` could 500 at request time
- The README is a landing page again
- Scaffolds build the frontend before deploying it
- `@xanosdk/auth` is authentication, not authorization
- `InferResponse`: the shapes that never derive, and the line that closes each
