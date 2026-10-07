# CLI

Every `xanosdk` command, shell completion, and what the CLI prints when something fails.

The examples spell the bare `xanosdk` of a global install (`npm i -g @xano/sdk`). In a project
with `@xano/sdk` installed, run them as `npx xanosdk …`; anywhere else, `npx @xano/sdk …` (see
[Commands the CLI prints](#commands-the-cli-prints)).

```bash
xanosdk init my-app                         # scaffold a full project (frontend/ + xano/)
xanosdk init my-app --framework svelte      # SvelteKit instead of the default React
xanosdk init my-api --framework none        # a new project with the backend only (no frontend/)
xanosdk init                                # inside an existing app: add xano/ and the xano:* scripts, no frontend (lists clashes and writes nothing; --force overwrites)
xanosdk init my-app --no-agents-md --no-install  # skip AGENTS.md and npm install
xanosdk init my-app --theme zinc-blue --dark toggle --icons tabler  # the look
xanosdk init my-app --marketplace @xano-sdk/auth,@xano-sdk/vector  # install add-ons AND register them

xanosdk marketplace list                    # every published add-on (no login needed)
xanosdk marketplace search auth             # narrow by keyword
xanosdk marketplace details @xano-sdk/auth    # what it installs + the registration to copy
xanosdk marketplace details @xano-sdk/auth --prompt  # …as a prompt for a coding agent
xanosdk marketplace install @xano-sdk/auth    # add an add-on to the project you're in (and configure it)
xanosdk marketplace reinstall <toolchain-package>  # re-ask a toolchain module its questions
xanosdk marketplace remove <toolchain-package>     # uninstall it and drop what it contributed

xanosdk export ./xano/index.ts              # bundle to stdout
xanosdk export ./xano/index.ts --out ws.json
xanosdk compile ./xano/functions/get-user.ts  # a single function's JSON
xanosdk routes ./xano/index.ts              # each query's verb + resolved api:<canonical>/<name> (`paths` is an alias)

xanosdk export ./xano/index.ts --strict     # CI: fail the build on any warning, don't just print it
xanosdk export ./xano/index.ts --no-lock    # build with no xano.lock (one is written by default; refused once one exists)
xanosdk export ./xano/index.ts --frozen-lock  # CI guard: fail if the export would change the lock, or if the lock carries an entry no object matches
xanosdk export ./xano/index.ts --check --strict  # the same guard, writing nothing (no bundle, no lock) — needs no .env or .secrets.json; the scaffold's xano:check
xanosdk lock rename --entry=xano/index.ts table users members  # move a lock entry after renaming in code
xanosdk lock prune ./xano/index.ts --yes    # drop lock entries nothing exports anymore
xanosdk lock prune --identity-only --entry=xano/index.ts --yes dbo:notes  # …or drop named keys without running the workspace
xanosdk lock import live-export.json --entry=xano/index.ts --yes  # seed the lock from a live engine export

xanosdk login                               # OAuth sign-in (once) — pick the instance + workspace at consent
xanosdk login --paste                       # …when the browser can't reach this machine's 127.0.0.1 (remote shell, container, Codespace)
xanosdk login --scope "<list>"              # request these OAuth scopes instead of the built-in set
xanosdk login --profile staging             # sign in as a second named credential, leaving the others alone
xanosdk <command> --profile staging         # act as that profile for one run (-p is the short form)
xanosdk workspace details                   # which instance/workspace am I bound to, and via which credential?
xanosdk deploy ./xano/index.ts              # compile + import into the Xano Engine on this machine (the dev loop) → URL; no account needed
xanosdk deploy ./xano/index.ts --ephemeral  # …or into a live ephemeral on Xano's cloud → URL
xanosdk deploy ./xano/index.ts --ephemeral --static ./frontend/dist   # also deploy a static frontend (onto the ephemeral)
xanosdk deploy ./xano/index.ts --ephemeral --static ./frontend/dist --static-env PK=pk_live_1   # + extra public config
xanosdk deploy --bundle ws.json             # deploy an already-exported bundle
xanosdk deploy ./xano/index.ts --open       # …and open the deployed URL in your browser
xanosdk deploy ./xano/index.ts --ephemeral --expires-hours 8   # the ephemeral's TTL when this deploy creates it: 1–24 hours (default: 1)
xanosdk deploy ./xano/index.ts --ephemeral --keep-data --static ./frontend/dist --static-host docs   # publish to a named static host — merge only: a replace deletes it, and a deploy creates only `default` (create `docs` in the dashboard first)
xanosdk deploy ./xano/index.ts --ephemeral --static ./frontend/dist --static-routing spa   # override URL resolution, spa|multipage (inferred from the bundle; rarely needed)
xanosdk deploy ./xano/index.ts --keep-data  # redeploy but keep table rows (merge instead of replace; seeds aren't re-written)
xanosdk env set STRIPE_KEY --to workspace --yes   # set ONE env var on a running backend, value piped on stdin (no deploy; never printed)
xanosdk env unset STRIPE_KEY --to local # clear one (--to workspace|ephemeral[:<name>]|local[:<name>]|tenant:<name>, default: last deployed)
xanosdk publish ./frontend/dist             # publish a built frontend alone — no compile, no backend import (default: last deployed)
xanosdk publish ./frontend/dist --to ephemeral   # …or onto an ephemeral instead (after a local deploy, bare publish goes to the engine)
xanosdk deploy ./xano/index.ts --static ./frontend/dist   # on the Xano Engine, the engine serves the build at http://<prefix>.localhost:<port>
xanosdk publish ./frontend/dist --to workspace --branch v2 --yes   # …onto the workspace, refused unless branch v2 is live
xanosdk deploy ./xano/index.ts --local   # the default, spelled out: the Xano Engine on this machine (runs the version pinned in package.json)
xanosdk deploy ./xano/index.ts --local=~/Downloads/engine.tar.gz   # override: run this archive, URL or version (v0.1.8), never touching the pin
XANOSDK_ENGINE_OVERRIDE=v0.1.8 npm run xano:deploy   # the same override for every deploy in the shell
xanosdk local list                   # Xano Engines on this machine, marking the ones xanosdk started
xanosdk local token                  # print its meta API bearer: XANO_META_TOKEN=$(xanosdk local token)
xanosdk local mcp                    # how a coding agent connects to its MCP server (url, command, config); never the bearer
xanosdk local mcp --stdio            # the bridge an agent's .mcp.json launches: follows restarts, brings the current bearer
xanosdk local stop <name>            # stop one (--all: every one xanosdk started, and what a crashed one left running)
xanosdk local update                 # move this project's pinned engine to the latest (--version <v>: that one) and restart it — commit package.json
xanosdk local cache list             # each cached engine version, its size, and the engines running on it
xanosdk local cache clear            # remove every cached engine and its unpacked runtime (--version <v>: just that one); running ones are stopped first
xanosdk ephemeral list                      # list your ephemeral environments (--all-workspaces spans every workspace; --json: { ephemerals: [...] })
xanosdk ephemeral get <name>                # base URL, state, and expiry for one (<name> = the tenant name, e.g. ewap-8wz9-9e13, NOT the display name — `ephemeral list` shows it in bold)
xanosdk ephemeral delete <name> --yes       # destroy one
xanosdk tables                              # the last-deployed backend's tables: id, guid, name (for release create --seed)
xanosdk tables tenant:acme                  # …or name one
xanosdk test run-all                        # run the tests the last-deployed backend carries (exits 5 on a failure)
xanosdk test run-all --on local      # …or name one (--on ephemeral:<name>|tenant:<name>|workspace)
xanosdk test list                           # list the tests a backend carries, without running any
xanosdk test run "<name>"                   # run one test by its name
xanosdk test run-all --kind unit            # only one family (unit|workflow; default: both) — also on test list
xanosdk test run-all --concurrency 4        # run 4 at once (default: 1); tests share the backend's database, so only when yours don't share state
xanosdk impersonate                         # open what this project last deployed to in the builder (--guest = read-only; --url-only prints the URL; the URL is a session — treat it as a credential)
xanosdk impersonate ephemeral:<tenant>      # …or name one: local[:<name>] or tenant:<name> (open your workspace from the Xano dashboard)
xanosdk deploy ./xano/index.ts --test        # THE RELEASE FLOW, step 1: stand it up and run its tests
xanosdk release create v1                   # …2: cut a release from the ephemeral this project last deployed to (after a local deploy: --from ephemeral)
xanosdk release create v1 --from ephemeral:e4f2-9ab1 --description "what shipped"   # …from a named source
xanosdk release create v1 --from workspace --branch staging   # …or from a branch of your workspace (default: what it serves)
xanosdk release list                        # every release in this workspace, newest first, a description cut to one line (--json: { releases: [...] }, each with the origin show names)
xanosdk release show v1                     # one release: when it was cut, from what (a cut from an environment records it in the description), what it carries
                                           # --json origin: {kind:"branch",label} | {kind:"environment",name,type} | {kind:"copy",source:{host,workspaceId,release},from?:<branch or environment>} (transferred in) | null
xanosdk release export v1                   # download it as a XanoScript multidoc (workspace block named "v1")
xanosdk release delete v1 --yes             # remove one (a tenant may be running it — there is no undo)
xanosdk release transfer v1 --to-profile prod   # copy a release to another workspace/instance, checked by content hash
xanosdk promote v1                          # …3: land it in your workspace, as a new branch
xanosdk promote v1 --branch staging         # …on a named branch instead of one named after the release (a taken label exits 2, SDK_BRANCH_TAKEN)
                                           # (a label is letters, digits, _ . - and starts with a letter, digit or _; surrounding spaces are trimmed)
xanosdk tenant list                         # every tenant under this workspace (--json: { tenants: [...] })
xanosdk tenant get acme                     # base URL and state for one
xanosdk tenant deploy acme v1               # …or 3: land it on a customer tenant instead
xanosdk tenant delete acme --yes            # destroy one (by its NAME — a display name fails with exit 8 and names the tenant it belongs to)
xanosdk pull release:v1                     # refresh xano/ from a release: rewrites decoded files, keeps and names files you added, lists and confirms (also workspace, ephemeral[:<name>], local, tenant:<name>)
xanosdk pull release:v1 --yes               # …skip the confirmation and the dirty-tree refusal (CI)
xanosdk pull workspace --backend-dir ./backend   # …when this project keeps its backend somewhere other than xano/ and nothing on disk says so (also on env pull)
xanosdk generate release:v1 --out ./backend # write ONLY the decoded xano/ tree, no project around it (any source above, or a bundle path; --force replaces the files an earlier generate wrote, asks first when that loses your edits (--yes answers), and keeps and lists any others)
xanosdk deploy ./xano/index.ts --to workspace --dry-run   # ALTERNATIVE to the release flow: preview a merge of the local build
xanosdk deploy ./xano/index.ts --to workspace             # …send it: add + update, never delete, never touch table data. Leaves no release to re-land
xanosdk deploy ./xano/index.ts --to workspace --prune     # …also delete objects this project LANDED here and no longer defines (per xano.lock's `landed` record; commit it)
xanosdk deploy ./xano/index.ts --to workspace --branch staging   # …land on a NEW branch instead of live (created; an existing label is refused, exit 2; stages LOGIC only — schema and workspace settings are shared, so not applied from a branch)
xanosdk deploy ./xano/index.ts --to workspace --branch staging --set-live   # …and set it live the moment the import succeeds
xanosdk deploy ./xano/index.ts --to tenant:acme          # …or merge into a customer tenant
xanosdk ephemeral export <name>             # export a DEPLOYED ephemeral as a JSON bundle → .xano/exports/<name>.json
xanosdk ephemeral export <name> --format multidoc --name backend    # …or as XanoScript → .xano/exports/backend.xs (--path picks elsewhere; a secret-bearing file git would commit is added to .gitignore)
xanosdk ephemeral export <name> --format multidoc --path -          # …stream the multidoc to stdout (deploy first)

xanosdk workspace details                   # which workspace your token is scoped to (instance, id, name)
xanosdk workspace export --path ws.json     # your REAL workspace as a JSON bundle (`--path -` streams to stdout)
xanosdk workspace diff ./xano/index.ts --branch staging   # did my release land? which objects on the branch differ from your compile, are missing, or are unexpected (default: live), and which side changed each since the last sync (`changedThere`/`changedHere`/`changedBoth`); exits 2 when anything declared differs or is missing
xanosdk workspace branch list               # its branches, and which one is live
xanosdk workspace branch set-live staging   # promote a branch (also the way back after --backup-branch)
xanosdk workspace branch delete staging --yes   # remove a non-live branch (a label padded with spaces is found by the trimmed one; one not there exits 0, alreadyGone; the live branch exits 2, SDK_BRANCH_LIVE)
xanosdk init my-app --from workspace        # …or as a runnable project (the pull direction)
xanosdk init my-app --from ephemeral:<tenant>   # same, from an ephemeral (the env is named inside the flag)
xanosdk init my-app --from ./ws.json        # …or from a bundle already on disk (offline, no auth)

xanosdk status                              # who am I, which workspace, and the env this project last deployed to
xanosdk whoami                              # print the scoped user + instance base URL (pretty on a TTY, JSON when piped)
xanosdk profile list                        # every stored credential profile, with the default and the active one marked
xanosdk profile show [name]                 # what one profile addresses — never its token
xanosdk profile use <name>                  # pin THIS PROJECT to a profile (writes a committed xano.profile.json)
xanosdk profile set-default <name>          # set the profile THIS MACHINE falls back to
xanosdk profile add <name> --instance <url> --workspace-id <n>   # store a meta API token (prompts, or reads it piped on stdin; checked before storing)
xanosdk profile delete <name>               # revoke that session and remove the profile (xano.profile.json is kept, as logout keeps it)
xanosdk logout                              # revoke the active profile and remove it (--all for every profile)
# Both ask first (--yes off a terminal) when the profile is the one xano.profile.json pins, or the default while others stay.
xanosdk version                             # print the installed @xano/sdk version
xanosdk upgrade --check                     # is a newer @xano/sdk published? exits 7 if so, 0 if current
xanosdk upgrade                             # install it: globally (npm i -g) for a global CLI; in a project, into the block that lists it (--save-prod or --save-dev)
xanosdk agent-skill install                 # put the xano-backend skill into each coding agent detected on this machine (--agent <id> to pick)
xanosdk agent-skill status                  # each copy: current, stale, edited or absent
xanosdk agent-skill uninstall               # remove the copies install wrote (an edited copy is kept)
xanosdk help                                # grouped command reference (also the no-arg default)
xanosdk <command> --help                    # that command's usage, subcommands, and flags (`xanosdk deploy --help`)
xanosdk <noun> <verb> --help                # scoped to one verb (`xanosdk workspace export --help`)
xanosdk <command> --json                    # force JSON on stdout (otherwise: whenever stdout isn't a terminal)
xanosdk <command> --no-refresh              # don't refresh the managed blocks in AGENTS.md and the README (a build that writes nothing outside its output)
xanosdk completion zsh                      # shell completion script (also bash, fish) — see below

xanosdk preflight ./xano/index.ts           # import into a live instance, diff each object back (needs auth + a throwaway tenant)
xanosdk preflight ./xano/index.ts --runtime # also run each deployed function on the engine
xanosdk preflight ./xano/index.ts --capture # write the fetched JSON as fixture candidates
```

The `marketplace` family has a guide of its own: [The marketplace](marketplace.md) for what
each verb does to a project, and [The module contract](module-contract.md) for writing an
add-on.

## Naming a backend

Every command that reads, writes or opens a running backend names it with one grammar:

| Spelling | What it is |
|---|---|
| `workspace` | Your real workspace — the one your login is scoped to |
| `ephemeral` / `ephemeral:<name>` | The ephemeral this project deployed to, or a named one — by its name (`e4f2-9ab1`, from `xanosdk ephemeral list`), not its display name |
| `local` / `local:<name>` | The engine this project deployed to, or a named one from `xanosdk local list`. Needs no Xano account |
| `tenant:<name>` | A tenant on your instance |
| `release:<name>` | A stored release — where a command reads one (`deploy`, `pull`, `generate`, `init --from`) |
| a bundle path | Where a command takes a file (`deploy`, `generate`, `init --from`) |

The flag follows what the command does with it: **reads take `--from`** (`env pull`, `release
create`, `init`), **writes take `--to`** (`env set`, `env unset`, `publish`, `deploy`), `test`
takes **`--on`**, and a command whose subject IS the backend takes it positionally (`deploy`,
`pull`, `generate`, `tables`, `impersonate`).

**Leave it off and a command follows the backend this project last deployed to** — recorded
in `.xano/deployed.json` by an ephemeral or local deploy, and never by a deploy to your
workspace or a tenant, so a bare command cannot reach something real unasked. With no record,
it falls back to the ephemeral recorded under your current credential, then to the engine
recorded for this directory, and otherwise refuses naming the flag, `xanosdk deploy` and
`xanosdk deploy --local`.
`deploy` is the exception: bare, it compiles the project and stands it up on an ephemeral
unless `--to` or `--local` says otherwise, so it writes that record rather than
reading it. `generate` and `init --from` need a backend named.

A command that cannot serve a backend refuses it, whether you typed it or it came from the
record, with the reason and the spellings it does take: `publish` refuses a Xano Engine (no
static host — pass `--to ephemeral`), and so does `release create` (the cut runs on the
instance — pass `--from ephemeral`). A write to your workspace or a tenant confirms first,
or needs `--yes` off a terminal; an ephemeral or Xano Engine never asks.

## Bundle key names vs. the names everything else uses

A bundle's `payload` arrays are keyed by the engine's **storage** name, which for five kinds
is not the name the SDK, the CLI, or a release plan uses for the same thing. Scripting against
a bundle means translating:

| You author / the plan reports | `payload` array |
|---|---|
| `table` | `payload.dbo` |
| `api_group` | `payload.app` |
| `agent` | `payload.toolset` |
| `mcp_server` | `payload.toolset` |
| `toolset` | `payload.tool` |
| `realtime_channel` | `payload.channel` |
| `realtime_message` | `payload.message` |

Everything else (`query`, `function`, `task`, `trigger`, `middleware`, `microservice`,
`addon`, `workflow_test`, `workspace`) is keyed the same on both sides.

Two traps worth naming. A release plan reports operations as `{"type": "table", …}` while the
bundle it came from stores that object under `payload.dbo` — so a table that released
correctly looks *missing* if you go looking for `payload.table`. And `agent` and `mcp_server`
both land in `payload.toolset`, while the kind actually named `toolset` lands in
`payload.tool`; matching on the word alone will pick the wrong array.

This is also the format `xanosdk lock import` reads, so both directions are user-facing.


**Build warnings, and `--strict`.** `export`/`deploy` print a warning (a `!` line) for the
shapes that ship clean and then do the wrong thing — a `bulk.update` zero-filling the columns
an item omits, an `ignoreEmpty` on an operand that's already empty, a `ref()` no `as` binds,
a filter name the engine can't resolve, a `s.switch` case that falls through into the next
one, a request-time timestamp filter on a `where` operand. Each stays a warning because each
has a legitimate use. Nothing fails on a message nobody reads, though, so pass `--strict` in CI and in
unattended agent builds: every warning becomes a hard failure and the exit code carries it —
the CLI's own too (an unsupplied documentation token or env name, a `xano.lock` entry that
matches no object), and a db step bound to no table (`table: null`), which a pulled tree may
carry and which does nothing when run. When a shape is meant — a fixture that pins a hazard on
purpose — `diagnostics: { allow: ["<code>"] }` on that def accepts that warning for it alone, and
`--strict` still fails everything else. Every def kind takes it, and it takes any warning code the
def raised (never an error); the advisory warnings name the form in their own message. Some lines are deliberately
exempt, because each describes a choice you made rather than a defect in the build: a `--no-lock`
build says so as information, and a bundle written to stdout that carries env values or a
documentation token says so on stderr — `--strict` passes both.
The programmatic equivalents are `emitBundle(app, { strict: true })` and
`app.export({ strict: true })`. The bundle bytes are identical either way.

**Warnings under `--json`.** Every `!` line a run prints on stderr is also in the `--json`
document it writes, on every command, as `warnings: [{ code, message }]`, and a failure
document carries the same list as `error.details.warnings`. `code` is stable and dotted, so
match on it rather than on the sentence. A build diagnostic keeps its own code
(`stack.env-undeclared`), and the export's own warnings take theirs (`workspace-env.undeclared`,
`workspace-env.unsupplied`, `lock.orphan`, `lock.dropped-entry`, `lock.ceded-canonical`,
`filter.unresolvable`, `doc-token.orphan`, `doc-token.cleared`, `doc-token.unsupplied`) — these, and only these, are
what `--strict` fails on. Every other code is a NOTICE about this run, and `--strict` passes it:
`secrets.cleartext-export`, `credential.readable-file`, `credential.unpinned-profile`,
`credential.shadowed-global`, `credential.env-overrides-pin`, `profile.local-shadows-pin`, `static-env.secret-like`, `publish.unbuilt-source`, and a code
dotted by area on each other line — among them `deploy.tenant-write`, `deploy.destructive`,
`plan.nothing-matched`, `plan.workspace-rename`, `plan.column-drop`, `release.no-env`,
`release.drift`, `promote.server-release`, `promote.seed-rows`, `pull.no-git`,
`pull.kept-files`, `pull.unverified`, `tenant.not-found`,
`release.not-found`. `message` is the line stderr printed, with any fix-up commands printed
under it (a lock orphan's `lock rename` / `lock prune`) appended one per line.
An export that fails its checks — `--strict` promoting a warning included, whichever
layer raised it — is `SDK_EXPORT_INVALID`, with its checks in `error.details.diagnostics` as
`{ severity, code, message }` and every warning the run printed beside them in
`error.details.warnings`.

**Naming the backend under `--json`.** Every document that names a backend — a write's
`destination`, a read's `kind`/`name` (`tables`, `test`), `status`, `ephemeral get`,
`workspace details`, `impersonate`, and each `tenant list`/`ephemeral list` row — also carries
`selector`, the spelling the next command's backend slot takes (`"ephemeral:e4f2-9ab1"`,
`"tenant:acme"`, `"local:<name>"`, `"workspace"`; `ephemeral get|delete|export` and
`tenant get|deploy|delete` take it as well as the bare name), and `workspaceId`, the numeric workspace it acts on (for an ephemeral or tenant,
the workspace it lives under). The fields each command already had stay. `export --out --json`
carries `written: true`, as `export --check` carries `written: false`. `help --json` lists each
flag as `{ flag, summary, name, short?, arg?, values?, examples?, description }` — `flag` the spec
string, `values` its whole closed set, `examples` a few values of a flag that takes others too
(`--to tenant:<name>`, `--theme <url>`).

## Shell completion

`xanosdk completion <bash|zsh|fish>` prints a completion script covering every command, verb, flag,
and closed value set (`--on workspace|ephemeral|local`, `--format json|multidoc`, `--icons lucide|tabler|phosphor`).
A flag's value completes as what it takes: its closed set, file names for a path (`--config`,
`--secrets-file`), directories for a directory (`--backend-dir`), stored profile names for
`--profile`/`--to-profile`, and nothing for a free-form value (`--name`, `--expires-hours`).
`xanosdk help <Tab>` completes command names, then verbs.
It is generated from the CLI's own command table, so it never drifts from what the CLI accepts — but it
is baked at generation time, so re-run it after upgrading.

```bash
# zsh
xanosdk completion zsh > "${fpath[1]}/_xanosdk"   # then restart your shell

# bash
xanosdk completion bash > ~/.xanosdk-completion.bash
echo 'source ~/.xanosdk-completion.bash' >> ~/.bashrc

# fish
xanosdk completion fish > ~/.config/fish/completions/xanosdk.fish
```

After a command succeeds the CLI checks npm (at most once an hour, cached in
`~/.xanosdk/update-check.json`) and prints a one-line nudge to **stderr** when a newer
`@xano/sdk` is published — never to stdout, so piped bundles stay clean. The suggested
command adapts to how you installed it: `npm i -g @xano/sdk@latest` for a global install,
`xanosdk upgrade` when it's a project dependency (it keeps the SDK in the `package.json` block
that lists it and restores the scaffolded range, which a raw `npm i` would not). The check is best-effort and bounded (a slow or offline
registry never delays a command), and stays silent under CI or when stderr isn't a terminal.
Opt out with `XANOSDK_NO_UPDATE_CHECK=1` (or the conventional `NO_UPDATE_NOTIFIER=1`).

`xanosdk upgrade` is the same question asked on purpose, and it answers under all the
conditions the nudge stays quiet for — CI, a piped stderr, the opt-out variables — reading the
registry live rather than serving the hourly cache. `--check` reports without installing and
exits **7** when a newer version is published, **0** when you are current or ahead of the
latest published version (a local build; `status: "ahead"`, and a bare `upgrade` installs
nothing), so a pipeline can branch on it:

```bash
xanosdk upgrade --check || echo "an upgrade is waiting"
xanosdk upgrade --check | jq -r .latest        # piped stdout is JSON already
```

A registry it cannot reach is an error (exit 1), never a quiet "you are up to date". Without
`--check` it installs the exact version the check found (never npm's `latest` tag, which npm
resolves from a cache that lags a fresh release) and reports the version it actually installed
as `installed`. The install matches how this CLI is installed (`npm i -g` for a global one; for a
project, `--save-prod` when `@xano/sdk` is in `dependencies`, as a scaffold puts it, else
`--save-dev`) — and for a project-local install it
then restores the `@xano/sdk` range your project was scaffolded with (npm rewrites it to a
caret) and restamps the managed blocks in your
`AGENTS.md` and README so what they say matches the version you now have. Set `XANOSDK_INSTALL_MODE` to
`global` or `local` to override the detection. Run through `npx` (or `pnpm dlx`, `yarn dlx`, `bunx`)
outside a project, it installs nothing (`status: "not-installed"`): that copy is temporary,
and `npx @xano/sdk@latest` already runs the newest release.

## Adding the backend to an existing app

`init` decides what to write from its target directory. An empty or missing directory is a
**new** project: a full app, `react` unless `--framework` says otherwise, with a framework
prompt on a terminal whose choices include "No frontend" (`--framework none`, the backend
alone). Any other directory is an **existing** project: `init` writes `xano/` and merges the
`xano:*` scripts and the backend's dependencies into its `package.json`, with no prompt and no
frontend. [The scaffolded project](scaffold.md#no-frontend-and-existing-apps) lists exactly
what each mode writes and merges.

Each of these is a **clash**: an existing `xano/`, any other file `init` would write that is
already there, and a `xano:*` script the project defines with another command. `init` lists
every clash and writes nothing. `--force` lists what it would overwrite and asks first
(`--yes` answers without a terminal).

`--framework react` or `--framework svelte` is refused in an existing project, and the
frontend-only flags (`--theme`, `--radius`, `--dark`, `--font`, `--font-mono`,
`--font-heading`, `--icons`) are refused wherever no frontend is written, rather than
silently ignored. `init --from` follows the same two modes
([Pulling an existing workspace](codegen.md#running-it)).

```bash
xanosdk init --json   # inside the app; then run the command in `next`
```

`init --json` reports `mode` (`new` or `existing`), `files` (every file it wrote or merged
into, relative to the project) and `next` (the command to run next: the install when one is
still needed, then `xano:deploy`).

## The agent skill

`xano-backend` is an agent skill for coding agents such as Claude Code, Codex and Cursor: it
tells the agent when to set up a Xano backend and hands it to `init`, then to the project's
`AGENTS.md` and `llms.txt`. It is not a `knowledge()` def; those are docs your workspace's own
AI agents read. The package ships it at `skills/xano-backend/SKILL.md`.

```bash
xanosdk agent-skill install                       # every coding agent detected on this machine
xanosdk agent-skill install --agent claude-code   # …or name one (repeatable)
xanosdk agent-skill install --dry-run             # report what would change, write nothing
xanosdk agent-skill status --json                 # each copy, as data
xanosdk agent-skill uninstall
```

It writes at most two copies. Claude Code reads `~/.claude/skills/xano-backend/SKILL.md`
(under `$CLAUDE_CONFIG_DIR` when that is set). Codex, Cursor, Copilot, Gemini CLI, Amp and
OpenCode read the shared `~/.agents/skills/xano-backend/SKILL.md`. An agent is detected by its
home config directory; `--agent` takes `claude-code`, `agents` (the shared directory),
`codex`, `cursor`, `copilot`, `gemini`, `amp` or `opencode` instead. When no agent is detected
and none is named, `install` refuses.

Each copy carries the SDK version and a digest. `status` reports a copy as **current**,
**stale** (an older version, unedited), **edited** (changed since it was installed) or
**absent**. `install` writes a missing or stale copy and leaves a current one unchanged; it
leaves an edited copy alone unless `--force`. `uninstall` removes only unedited copies. A
symlinked skill directory belongs to another installer, and neither command touches it.
Nothing prompts, so both run unattended; `--json` reports one entry per target.

The skill also installs without the CLI, from the public repository:
`npx skills add xano-sdk/sdk`, or in Claude Code `/plugin marketplace add xano-sdk/sdk`
followed by `/plugin install xano@xano-sdk`.

## Checking what an installed SDK can do

A tool that drives the CLI, such as an editor extension or a CI step, should check that the
installed SDK has the commands it needs before it starts. **The compatibility contract is the
installed version plus the `cli` array in its `manifest.json`.** There is no capability
endpoint and no protocol number. The manifest is a file inside the package, so reading it
needs no sign-in and no network. It comes from the same registry that parses the
command line, so it cannot list a command the CLI does not accept.

Each `cli` entry carries a `command` (`"promote"`, `"release create"`, `"publish"`) and its
`flags`. Check for the commands and flags you will actually run:

```bash
M=node_modules/@xano/sdk/manifest.json
jq -r .version "$M"                                              # e.g. 1.0.3
jq -e '.cli[] | select(.command=="promote")' "$M" >/dev/null     # exit 0: present
jq -e '.cli[] | select(.command=="publish") | .flags[]
       | select(.flag | startswith("--release"))' "$M" >/dev/null  # a flag, not just the command
```

```ts
import manifest from "@xano/sdk/manifest.json" with { type: "json" };
const has = (cmd: string) => manifest.cli.some((c) => c.command === cmd);
```

Read the manifest from the install whose `xanosdk` you will run: a project dependency and a
global install can be different versions.

- **Check each operation, not the whole feature.** A backend-only promotion needs `promote`,
  and it should not be refused because `publish` is missing. Gate each command on its own entry.
- **When something is missing, name the command.** `This workflow needs \`xanosdk publish\`,
  which the installed @xano/sdk (1.0.x) does not have. Run \`xanosdk upgrade\`.` is accurate. "This SDK has
  no release support" is not, when `release create` and `promote` are right there.
- **The manifest describes the package, not the target.** Whether a particular workspace or
  instance will accept an operation is decided when the command runs. The command's own
  failure is the answer to that, not a check you make in advance.

## Commands the CLI prints

Every command the CLI prints for you to run next (a remedy, a rerun, a hint, `--help`) is spelled
for where it runs, in the text and in `--json` fields such as `rerun` alike: plain `xanosdk …` from a
global install; otherwise `npx xanosdk …` in a project with `@xano/sdk` installed, and
`npx @xano/sdk …` anywhere else (a `cd <dir> && …` is spelled for `<dir>`). Paths in it read from
where you typed — under `npm run`, the directory you ran npm in. Files it writes to disk (a
scaffold's README, `AGENTS.md`, `.env.example`) always say `npx xanosdk …`.

## When something fails

Failures are written for the person reading the terminal. A request the instance refused
prints the server's own sentence on one line (`deploy failed (403 Forbidden): Access denied
for this workspace.`) rather than the whole JSON envelope; a request that never arrived names
what it could not reach and why (`workspace list could not reach https://…: fetch failed
(ECONNRESET)`), and a request that timed out says so separately, because "slow" and
"unreachable" call for different next steps. Set `XANOSDK_DEBUG=1` to append the untouched
response body underneath — nothing is discarded, only folded away.

A malformed invocation fails before any work happens: a missing or misspelled entry file, an
argument the command has nowhere to put (`xanosdk export --lock xano.lock` — that flag takes
its value attached, as `--lock=xano.lock`), or a missing credential, each answered with the
command's usage block instead of a stack trace. `deploy` and `release` check that you are
signed in *before* compiling, so a lapsed session costs you a message, not a build.

Emitters that write to disk (and the programmatic CLI) are Node-only — import them from
`@xano/sdk/node`. The string emitters (`emit`, `emitBundle`) stay on the browser-safe
`@xano/sdk` entry.

```ts
import { emitBundle } from "@xano/sdk";        // pure string — browser-safe
import { writeBundle } from "@xano/sdk/node";  // writes a file — Node only
```

**Four entry points, and only the first is the authoring API.** `@xano/sdk` is what you
define a workspace with; `@xano/sdk/node` adds the filesystem half; `@xano/sdk/codegen`
is what a generated tree imports; and `@xano/sdk/internal` holds the compiler machinery —
the per-kind encoders, the kind and statement registries, the bundle serializer, the
`xano.lock` model. Nothing on `/internal` is needed to author anything, and it is kept off
the root so an agent scanning the package's exports sees the surface rather than the guts.

`emit`, `emitBundle` and the `@xano/sdk/node` writers run the same build-time checks, including seed validation of a literal
`seed: [...]` array. A **deferred** seed (a thunk, or `seedFile()`) needs an await or the
filesystem, so it is materialised and checked only by `xanosdk export` / `xanosdk deploy`.
