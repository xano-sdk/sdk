<div align="center">

# Xano SDK

### The official TypeScript SDK for [Xano](https://xano.com).

**Write your app in TypeScript — the database, the APIs, even AI agents. Or let an
AI write it for you. Then run one command and it's live on Xano's cloud, with its own
URL. No servers, no setup, no config. That's it.**

[![npm](https://img.shields.io/npm/v/@xano/sdk?color=%230055FF&label=%40xanosdk%2Fsdk)](https://www.npmjs.com/package/@xano/sdk)
[![node](https://img.shields.io/node/v/@xano/sdk)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@xano/sdk)](LICENSE)

</div>

```bash
npx @xano/sdk login                      # 1. sign in (opens your browser)
npx @xano/sdk init my-app && cd my-app   # 2. scaffold your backend + frontend
npm run build                               # 3. build your frontend → frontend/dist
npx xanosdk deploy ./xano/index.ts --static ./frontend/dist   # 4. deploy both → live URLs
# Outside a project: npx @xano/sdk <cmd>. Inside one, npx xanosdk <cmd> runs its own install.
```

```
→ Deploying ./xano/index.ts → new ephemeral "my-app"
✓ Ephemeral e4f2-9ab1 deployed
! New ephemeral URL:
    https://e4f2-9ab1.xano.io                                     ← backend, live
    Expires in 1h 0m
✓ Static host deployed
    https://my-app.xano.io                                        ← frontend, live
```

<div align="center">

**From an empty folder to a live full-stack app.** `init` sets up your project — a
TypeScript backend and a React or Svelte frontend. `npm run build` builds your frontend, then
`deploy` puts both online and hands you a live URL. Change your code — yourself or with
an AI — and deploy again; your app updates in seconds. No servers to set up, nothing to
configure, no glue code between your backend and your frontend.

[Why](#why-xano-sdk) ·
[Quickstart](#quickstart) ·
[The model](#the-model) ·
[Deploying](#deploying) ·
[Type-safe frontend](#a-type-safe-frontend-for-free) ·
[Reference](#reference)

</div>

---

## Why Xano SDK

Xano gives you a genuinely scalable backend — Postgres, serverless functions, background
tasks, realtime, MCP servers (tools, prompts and resources), AI agents — without you
running a single server. Xano SDK is Xano's **officially supported** TypeScript SDK, and it
gives you that backend **as code you own**:

- **📦 TypeScript is the source of truth.** Your whole workspace — tables, indexes, API
  endpoints, functions, triggers, tasks, middleware, AI toolsets — is typed TS in your repo.
  Version it, review it in PRs, diff it, roll it back. No more clicking through a dashboard
  and hoping prod matches staging.

- **🚀 Deploy is built in.** `xanosdk deploy` compiles your code and ships it to a live Xano
  environment over an authenticated connection, then prints its URL. Backend **and** static
  frontend in one command — no export/import dance, no upload script to maintain.

- **⚡ Fast, safe iteration.** Ephemeral environments are disposable and auto-expiring, so
  you rebuild as often as you like. Deploys are identity-stable: re-running never duplicates
  objects, and every build writes a `xano.lock` you commit, so renames stay renames instead
  of delete-and-recreate and your public URLs stay yours.

- **🧩 The types flow to your frontend.** `import type` a `query()` def for its typed request
  and response, and read its path and verb from `xano/routes.gen.ts` — plain data the scaffold
  regenerates before every dev, build and typecheck. Rename a column and every consumer lights up red.

- **🤖 AI-first by design.** A deterministic, fully-typed authoring surface: an agent (or
  you) emits well-typed TS that always compiles to a valid, importable workspace. It ships
  with machine-readable grounding an agent reads instead of your source — see
  [Coverage & agent grounding](https://github.com/xanots/sdk/blob/main/guides/coverage.md).

---

## Quickstart

The four commands at the top of this page are the whole loop. Here they are one at a time.

**1. Sign in.** OAuth in your browser — no API keys to copy around. The CLI refreshes tokens
for you, and the target instance comes from your token rather than a flag.

```bash
npx @xano/sdk login
```

> On a remote shell, container, or Codespace — anywhere your browser can't reach this machine's `127.0.0.1` — add `--paste`. It prints the URL for you to open anywhere,
> and you paste the redirect back. No browser at all (CI, a headless agent)? Create a token in your instance's settings under **Metadata API & MCP Server**, then pipe it
> to `npx @xano/sdk profile add <name> --instance <url> --workspace-id <n>`. See [Signing in & deploying](https://github.com/xanots/sdk/blob/main/guides/deploying.md).

**2. Scaffold.** `init` writes a complete project: a Vite frontend under `frontend/` (React
19 + shadcn/ui by default, or SvelteKit with `--framework svelte`), a Xano SDK backend under
`xano/`, and the `xano:export` / `xano:deploy` scripts already wired.

```bash
npx @xano/sdk init my-app && cd my-app
npm run dev                       # the frontend runs immediately
```

In a terminal it asks one question — the framework — with a default. `AGENTS.md`, the
agent brief every coding agent reads, is written without asking; `--no-agents-md` skips it. The theme is a flag, not a question: it is shadcn's own, a base color plus an
optional accent, rendered into the token stylesheet with a complete dark palette either way.

```bash
npx @xano/sdk init my-app --theme zinc-blue --dark toggle
npx @xano/sdk init my-app --theme https://ui.shadcn.com/r/themes/slate.json   # or any registry theme
```

The starter backend is empty but already compiles and deploys — grow it from the walkthrough
in `xano/EXAMPLE.md`. For the flags, the two presets, theming, and add-ons, see
[The scaffolded project](https://github.com/xanots/sdk/blob/main/guides/scaffold.md).

Prefer to see the theme before you commit to it? `--web` picks the framework, the palette,
the typefaces and the add-ons in a browser, against a live preview, and hands the result
back to `init` here in your terminal.

```bash
npx @xano/sdk init my-app --web
```

It is a nicer way to arrive at the flags above, not a second scaffolder — it prints the
equivalent `init` command when it is done, so the project stays reproducible from a script.
The configurator is downloaded on demand, so `--web` needs the registry before it can
start; `init` reaches out only to install the new project's dependencies, which
`--no-install` skips.

**3. Build the frontend.**

```bash
npm run build                     # → frontend/dist
```

**4. Deploy both.** One authenticated call ships your database schema, your APIs, your
functions and triggers, **and** your compiled web app.

```bash
npx xanosdk deploy ./xano/index.ts --static ./frontend/dist
```

```
→ Deploying ./xano/index.ts → new ephemeral "my-app"
✓ Ephemeral e4f2-9ab1 deployed
! New ephemeral URL:
    https://e4f2-9ab1.xano.io                                         ← backend, live
    Expires in 1h 0m
✓ Config injected into 1 document: window.XANO_HOST                   ← backend URL, wired in
✓ Static host deployed
    https://my-app.xano.io                                            ← frontend, live
✓ Frontend is live                                                    ← edge confirmed serving THIS build
```

That's the dev loop. Change your code and run step 4 again; the environment refreshes in
seconds. The deploy bakes the backend URL into your build as `window.XANO_HOST`, so the
frontend never needs to know it ahead of time — read it with a build-time fallback:

```ts
const HOST = (typeof window !== "undefined" && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;
```

> Deploying again keeps the **backend** URL; the **frontend** one changes, because a deploy
> is a full replace and clears the environment's static hosting along with its workspace.
> Hand out the URL from the latest run. [Signing in & deploying](https://github.com/xanots/sdk/blob/main/guides/deploying.md) covers
> the injection rules, serving stored files, and headless CI runs.

**Prefer to wire it by hand?** Skip `init` — `npm init -y && npm pkg set type=module && npm install -D @xano/sdk`, then `npx xanosdk upgrade`
(it rewrites npm's caret to the range `init` writes). Write your workspace in `xano/index.ts`; steps 1 and 4
are unchanged. `type=module` matters: Xano SDK defs are ESM-only, and `npm init` writes `"type": "commonjs"`. A TypeScript entry wants
[`tsx`](https://tsx.is) (`npm i -D tsx`), which the CLI picks up — Node's type stripping does not remap a workspace's `./x.js` imports.

---

## The model

You author declarative def-objects, register them on one `Xano` instance, and Xano SDK
compiles the whole thing into Xano's importable bundle.

```ts
import { workspace, table, query, apiGroup, f, s, ref, c, expr, col } from "@xano/sdk";

// A database table — `id` + `created_at` auto-inject, so declare only your own columns.
const user = table({
  name: "user",
  auth: true,
  schema: {
    email: f.email({ required: true, methods: ["trim", "lower"] }),
    name:  f.text(),
  },
});

export const post = table({
  name: "post",
  schema: {
    title:     f.text({ required: true }),
    body:      f.text(),
    published: f.bool({ default: false }),
    author:    f.tableRef(user),          // a real foreign key, type-checked
  },
});

// A public API group + endpoint. This query def is also the contract your frontend imports.
const blog = apiGroup({ name: "blog", canonical: "blog" });

const listPosts = query({
  verb: "GET",
  apiGroup: blog,
  name: "list_posts",
  stack: [
    s.db.query({ table: post, where: expr(col("published"), "=", c.bool(true)), as: "rows" }),
  ],
  response: ref("rows"),
});

export default workspace("blog")
  .registerApiGroups([blog])
  .registerTables([user, post])
  .registerQueries([listPosts]);
```

Tab-complete `s.` to discover the entire statement catalog — `s.db.*`, `s.math.*`,
`s.array.*`, `s.text.*`, `s.storage.*`, `s.api.*`, `s.cloud.*`, control flow, AI agent runs,
and more. **All 218 engine statement surfaces are authorable** — every field name matches
the Xano engine, and the emitted shape is checked against bytes a real engine stored. Where
a surface has no stored instance behind it yet, it is built from the engine's own schema;
[Coverage](https://github.com/xanots/sdk/blob/main/guides/coverage.md) says which is which.

Give a table a `seed` array and those rows ship into the database on deploy, so a fresh
environment comes up with its lookup tables and fixtures already in place. A file column or an
MCP icon takes `hostedFile("./logo.png", import.meta.url)`: the file ships with the deploy.

Your workspace's own AI agents are configured the same way. `knowledge()` is the markdown
they read before they act — standing instructions, a skill, or reference docs — and the body
is a real `.md` file in your repo rather than a string in a def:

```ts
knowledge({
  name: "deploy-runbook",
  description: "How this workspace ships: environments, gates, and rollback.",
  body: knowledgeFile("./deploy-runbook.md", import.meta.url),
  refs: knowledgeDir("./deploy-runbook", import.meta.url),
});
```

So the instructions your agents follow are reviewed in a diff, versioned with the code they
describe, and redeployed with it — instead of living in a console where nothing tracks them.

Tables, fields,
statements, values, inputs, and middleware are all in the
[Authoring reference](https://github.com/xanots/sdk/blob/main/guides/authoring.md); every kind you can author is in
[Object kinds](https://github.com/xanots/sdk/blob/main/guides/object-kinds.md).

---

## Deploying

A deploy targets a **disposable ephemeral**. Reaching anything real goes through a **release** — the stored record
that this code came up and answered: `deploy --test`, then `release create v1`, then `promote v1`.

| Command | Where it goes |
|---|---|
| `xanosdk deploy` | A disposable **ephemeral** — create-or-refreshed each run, auto-expiring, with its own URL. The default; needs no flag. |
| `xanosdk deploy --local-engine` | A **local engine** on this machine — no network round-trip per deploy, nothing to configure, and no Xano account needed. The first run downloads the engine and pins its version in `package.json` so every checkout runs the same one; `xanosdk local-engine update` moves the pin ([details](guides/deploying.md#deploying-to-a-local-engine)). |
| `xanosdk promote <release>` | Your **main Xano instance** workspace — the production target. Lands a release on a branch named for it, reads the branch back, and fails naming anything the release declared that did not arrive. `--set-live` serves it once that check passes. Tables are shared by every branch, so its table changes reach live as it lands — one that alters a table is refused without `--allow-shared-schema-changes`. |
| `xanosdk tenant deploy <tenant> <release>` | A **customer tenant** — the same release, on someone else's deployment. It **replaces** what the tenant serves: anything the release does not carry is removed. Static hosting is kept. |
| `xanosdk release transfer <release> --to-profile <profile>` | **Another workspace or instance** — copies the stored release, checked by content hash, to `promote` there. |
| `xanosdk deploy --to <dest>` | The **escape hatch**: merges a local build straight into `workspace` or `tenant:<name>`, skipping the release record. |
| `xanosdk publish <dir>` | **Just the frontend**: an already-built directory onto the ephemeral you last deployed to (default), `workspace`, or `tenant:<name>` static host — after a local-engine deploy, `--to ephemeral`, as a local engine has none. No compile, no backend import — the retry when a frontend fails after its backend landed, and `npm run xano:deploy:frontend` in a scaffold. |

Every `deploy` is a **full replace** of the disposable environment unless [`--keep-data`](guides/deploying.md#keeping-your-data-between-deploys) merges, keeping its rows.
Promoting is the opposite by design: it changes what your code defines and keeps every row — so an unchanged
project is a no-op. But tables have no branch: a change that alters one reaches live as it lands, so it is refused without `--allow-shared-schema-changes`. A tenant deploy then serves
exactly the release, and a `--seed` release REPLACES its seeded tables' rows, named with counts first ([details](guides/deploying.md#what-a-landing-does-to-tables)).

Going the other way — from a backend you did not author — is `xanosdk pull release:v1`, which **rewrites** the decoded files in `xano/` — it keeps files you added, and lists and confirms first.

**The alternative.** `deploy --to workspace` merges your local build straight in, skipping the release record. Reach
for it to delete objects, or for the plan preview a release cannot run (`--dry-run`, `--prune`; `--yes` skips the
prompt for CI, never the preview). It leaves nothing to re-land — prefer a release for anything you may repeat.

A release name is **refused** rather than resolved when it already exists, and so is a public URL something else
already holds. Nothing is written, the message names what holds it, and the exit code is `2`. `--yes` does not
waive it: a taken identity is not a question about whether you meant it.

**Scripting a landing:** `release create`, `promote` and `tenant deploy --json` print one result, failures included; `completed: unknown` exits `9` —
run its `resolveWith` before retrying ([details](guides/deploying.md#reading-the-result---json-and-exit-codes)).

> ⚠️ A deploy is a full replace of the target environment, **including its table records**, before importing. The
> blast radius is your own disposable ephemeral — but anything you only ever created by hand in it is gone. That
> is exactly why reaching production goes through a release.

**Deploying to a branch.** With one workspace, a deploy and production are the same thing.
`--branch <label>` lands it on a non-live branch instead, `--set-live` promotes it, and
`--backup-branch` snapshots live's logic, not its shared tables, for a one-`set-live` rollback — see
[the deploying guide](guides/deploying.md). The flag reads too: `init --from workspace --branch
<label>` pulls that branch rather than live, so reviewing one as TypeScript costs no cutover.

> ⚠️ **A branch stages your logic, not your database.** Tables and microservices are shared by
> every branch, so a schema change reaches production whichever branch you target. A branch
> release carrying one is refused unless you pass `--allow-shared-schema-changes`. Seeded
> **rows** are shared too, so reference data has an order: rows first (`workspace
> reset-tables`), then the logic reading them — the guide has the recipe.

> ⚠️ **`--replace` clears by workspace, not by branch.** It deletes every non-live branch and
> the saved versions that would restore one — not recoverable. Refused unless you pass
> `--allow-branch-deletion`, which `--yes` does not cover; the guide has the recipe.

`xanosdk status` answers where you stand in one read — who you are signed in as, which
credential profile that came from, which instance and workspace it is bound to, and the
backend this project last deployed to — an ephemeral or a local engine — including whether it is still alive and when it
expires. More than one account or instance is `xanosdk login --profile <name>`, then
`--profile <name>` on any command. `xanosdk init` commits a `xano.profile.json` pinning the
repository to one credential (`xanosdk profile use <name>` repoints it), and nothing ambient
outranks that pin: a `$XANO_PROFILE` in a shell rc cannot retarget a pinned project, only
`--profile` can. The tracked environment is per profile, so a redeploy under another credential
cannot refresh the wrong tenant, and every writing command names its target before writing.

**Your dev server follows the deploy.** In a scaffolded project, a deploy that publishes no static site writes the backend
URL into the project's gitignored `.env.local` as `VITE_XANO_HOST`, in a marked block that leaves your own values alone and
is replaced rather than repeated next time. **Restart the dev server to pick it up.** `--no-dev-env` turns it off, and so
do `--static <dir>` and a site an earlier deploy published there that still serves — a frontend reads the URL at runtime. A `.env.local` your repo does not ignore is
reported, never written.

Every flag, the `--prune` rules, the identity model, and headless CI runs are in
[Signing in & deploying](https://github.com/xanots/sdk/blob/main/guides/deploying.md). Every operation names a backend one way — `workspace`, `ephemeral[:<name>]`, `local-engine[:<name>]`, `tenant:<name>`, `release:<name>` — and a bare one follows the ephemeral or local engine you last deployed to, never your workspace ([the grammar](guides/cli.md#naming-a-backend)).
Environment management is `xanosdk ephemeral <list|get|delete|export>`; `xanosdk tables [backend]` lists guids and `xanosdk impersonate [backend]` opens one in the builder.

### Testing

The tests you author — a `tests` entry on a query, function, or middleware, or a standalone
`workflowTest()` — run against a deployed environment:

```bash
npx xanosdk test run-all                       # the ephemeral or local engine you last deployed to
npx xanosdk test run-all --on ephemeral:e4f2-9ab1   # or one by its name, not its display name (also local-engine, tenant:<name>)
npx xanosdk test run-all --on workspace        # or your real workspace
```

A test's `datasource` defaults to `""` — an empty database, so `table({ seed })` rows are
not visible. On an ephemeral, set `datasource: "live"` to read them: there it holds only
your seed fixtures (plus any rows a `--keep-data` deploy kept). That value is **stored on the test**, so clear it before you release —
a non-empty datasource is cloned before every run, and against your real workspace that is
the production database.

`xanosdk test list` shows what is there without running it, and `xanosdk test run "<name>"`
runs one. A failing suite exits **5**, distinct from a crash, so CI can tell the two apart.
To deploy and prove it in one step, `xanosdk deploy ./xano/index.ts --test` — a failing test
exits 5 **without** retracting the deploy, so the environment is live either way.

---

## A type-safe frontend, for free

Because your API is a typed def, the code that *calls* it reuses that def instead of
re-typing URLs and request bodies. Paths come from a generated route manifest, types
straight from the defs:

```bash
npx xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts   # scaffolds run this before dev/build/typecheck
```

```ts
import { ROUTES, routePath } from "../xano/routes.gen.js"; // plain data, imports nothing
import type { post } from "../xano/index.js";            // the model above
import type { InferRow } from "@xano/sdk";

const BASE = window.XANO_HOST ?? import.meta.env.VITE_XANO_HOST; // deploy injects it; .env.local in dev

type Post = InferRow<typeof post>;                     // { id: number; created_at: number; title: string; … }

async function fetchPosts(): Promise<Post[]> {
  const res = await fetch(BASE + routePath("GET list_posts"), { method: ROUTES["GET list_posts"].verb });
  return res.json();                                   // typed end to end
}
```

- **`routePath("GET blog/{slug}", { slug })`** → the endpoint path, resolved from your code
  (or the frozen `xano.lock`). Keys are `"<VERB> <name>"`, so verb-differentiated siblings
  coexist (a pair two api groups share is keyed `"<group>:<VERB> <name>"`), and the keys and their `{param}` names are checked at compile time: a backend
  rename is a compile error rather than a 404.
- **`ROUTES[key].verb`** → the HTTP method, as a literal.
- **`InferInput<typeof someQuery>`** → the request-payload type, derived from a query's
  `input` map at compile time. Required inputs are required keys, enums literal unions, and
  a nullable field (explicit or by type default) adds `| null`. **No codegen, always in sync.**
- **`InferRow<typeof post>`** → the table's row type. Rename or retype a column and every
  consumer breaks at compile time — exactly where you want it.
- **`InferResponse<typeof someQuery>`** → the endpoint's **response** type, closing the round
  trip. It auto-derives the common shapes with no codegen, mirroring the static walk the
  engine itself does, and degrades to `unknown` in exactly the cases the engine cannot
  resolve either — declare `responseShape` there. A `db.get` row types as `Row | null`
  until `guard.found("row")` asserts it exists (404 otherwise), which narrows it to `Row`.

Import defs into a frontend with `import type` only. A def imported as a value, for its
`getPath()`/`verb`, runs its factory calls at module load and carries the SDK runtime and
the backend graph it references into the bundle. The measured bundle
numbers, the full response-inference rules, endpoint-name constraints, and the realtime
helpers are in
[The typed frontend surface](https://github.com/xanots/sdk/blob/main/guides/typed-frontend.md).

---

## Already have a Xano workspace?

`--from` runs the loop the other way: it reads a workspace and writes it back out as
readable Xano SDK source — real `s.db.query(...)`, `f.email()`, typed defs — not a JSON dump.
And not a loose pile of files either: it is the same runnable project `xanosdk init`
scaffolds, with the pulled workspace filling `xano/` instead of the starter. So a pull
deploys:

```bash
npx @xano/sdk init my-app --from workspace   # your real workspace (the one your login is scoped to)
cd my-app
npm run build
npm run xano:deploy                   # → a live ephemeral URL
```

The other sources are the same flag with a different value — `--from ephemeral:<name>`, `--from local-engine:<name>`,
and `--from ./ws.json` for a bundle already on disk (offline, no login). Everything else about the project is unchanged, so `--theme`, `--no-agents-md` and `--web`
compose with a pull exactly as they do with a starter. For just the `xano/` tree with no project around it, `xanosdk generate <source> [--out <dir>]` also reads `release:<name>` and `tenant:<name>`.

Object identities are preserved, so cross-references stay intact, and a statement this SDK
does not model yet round-trips verbatim rather than breaking the pull. Then it checks its own
work: the tree it just wrote is loaded, exported, and diffed against the workspace it came
from, so "it compiled" and "it means the same thing" are separate claims and you get both.

> ⚠️ **After a pull, `xano/` is your source** — edit it and commit it. A later `pull` replaces
> only what a decode wrote: it refuses a dirty tree, asks before discarding your edits, and keeps
> files no decode wrote. It carries schema only — no table rows or stored files — and deploying
> it is a *full replace* of the target, so try a change on a disposable ephemeral first.

A pull carries env var **names**, never values: the config declares each name with an empty
placeholder and the values stay in the workspace (`init --from ./ws.json` on a bundle that
carries values writes them to `xano/.env` for you). They belong in `xano/.env` — gitignored,
preserved across a pull, and read with no flag by every command that compiles a bundle. Copy
`xano/.env.example` and fill it in, or run `npx xanosdk env pull` to fetch them from a running
backend; `npx xanosdk env set NAME` / `env unset NAME` change one live value without a deploy.
Because a deploy *replaces* the backend's env set, a declared name with no value refuses the
deploy rather than clearing the live one; CI mounts its own file and passes `--backend-env-file <path>`. The token gating a **hosted doc site** is a secret too, and goes in a second
ignored file. The source declares only the gate — `documentation: { require_token: true }` on the
workspace config or an `apiGroup`, and a literal `token` fails the export. `npx xanosdk pull` writes
the value to `xano/.secrets.json` and every build reads it back; `npx xanosdk secrets fill` mints one
for a gate you declared yourself, which has none to pull. Omitting the workspace's block leaves the
target's alone, but an API group's is always sent, so omitting *that* one clears its gate — the
export fails when a group publishes docs and declares a gate with no token. A merge (`deploy --to
workspace`) never writes the workspace's block and says so; `--replace` does.

What the generated tree looks like, how faithful the pull is, and how to read its report are
in [Pulling an existing workspace](https://github.com/xanots/sdk/blob/main/guides/codegen.md).

---

## Reference

Every kind, statement, filter, and field type is typed, so your editor's autocomplete is
the fastest lookup — tab-complete `s.`, `f.`, `c.`, `fl.`, `input.`. For the written
reference, the guides carry the shape of a project and the behavior that will bite you:

| Guide | What's in it |
|---|---|
| [Project structure](https://github.com/xanots/sdk/blob/main/guides/project-structure.md) | How a `xano/` project is laid out, and why registration is explicit |
| [The scaffolded project](https://github.com/xanots/sdk/blob/main/guides/scaffold.md) | What `xanosdk init` writes, the two frontend presets, theming, add-ons, SvelteKit rules |
| [The marketplace](https://github.com/xanots/sdk/blob/main/guides/marketplace.md) | Finding add-ons, the two kinds of module, and the install/reinstall/remove lifecycle |
| [The module contract](https://github.com/xanots/sdk/blob/main/guides/module-contract.md) | Building an add-on: the manifest fields, the plugin types, every hook, and what is refused |
| [Object kinds](https://github.com/xanots/sdk/blob/main/guides/object-kinds.md) | Every authorable kind, and splitting a workspace across microservices |
| [Authoring reference](https://github.com/xanots/sdk/blob/main/guides/authoring.md) | Tables and fields, statements, values, inputs, middleware, seed data |
| [CLI](https://github.com/xanots/sdk/blob/main/guides/cli.md) | Every command, shell completion, and what failures look like |
| [Warning and error codes](https://github.com/xanots/sdk/blob/main/guides/codes.md) | Every code the CLI and the build emit, with what it means |
| [Signing in & deploying](https://github.com/xanots/sdk/blob/main/guides/deploying.md) | Auth, ephemerals, `--static`, releasing to production, `xanosdk preflight` |
| [Environment & identity](https://github.com/xanots/sdk/blob/main/guides/environment.md) | Every environment variable, and how `xano.lock` pins identity |
| [The typed frontend surface](https://github.com/xanots/sdk/blob/main/guides/typed-frontend.md) | Path resolution, input/response inference, bundle cost, the route manifest |
| [Pulling an existing workspace](https://github.com/xanots/sdk/blob/main/guides/codegen.md) | What `xanosdk init --from` writes, how faithful it is, and how to read its report |
| [Coverage & agent grounding](https://github.com/xanots/sdk/blob/main/guides/coverage.md) | What is covered, what is out of scope, and the files agents read |

### Reading a compiled bundle

`@xano/sdk` writes a bundle; `@xano/sdk/bundle` reads one back. It is the surface for
tools that take compiled JSON as input — a graph view, a diff, a linter, a docs generator —
so none of them has to reverse-engineer the storage shape and then go quietly wrong when the
engine grows a new one.

```ts
import { readFile } from "node:fs/promises";
import { statementCatalog, walk } from "@xano/sdk/bundle";

const bundle = JSON.parse(await readFile("bundle.json", "utf8"));
const catalog = statementCatalog();

for (const { raw, path, depth } of walk(bundle.payload.query[0].run)) {
  console.log(`${"  ".repeat(depth)}${path}  ${catalog.get(raw.name)?.sPath ?? raw.name}`);
}
// 0       db.query
// 1       conditional
// 1.if.0  db.add
```

- **`walk(run)`** → every statement in the tree, each with a `path` and a `depth`. The path
  format (`2.if.0`) is the shared address: a lint finding, a review comment and a runtime
  error written by three different tools all name the same node.
- **`subStacks(raw)`** → the nested stacks a statement carries, keyed by where they are
  stored and labelled by what they mean — a try/catch and a conditional share the same three
  storage keys. Found by shape, so a nesting form added later is still walked.
- **`statementCatalog()`** → the stored `mvp:*` name to its authoring path, minus the
  namespace (`mvp:dbo_view` → `db.query`, the `sPath` you write after `s.`) — which is
  the point: the stored name is often not the one you'd guess.
- **`structuralHash(raw)`** → a diff key for a statement and everything under it, with
  engine-filled operands excluded — so adding a column to a table leaves `db.edit` /
  `db.add_or_edit` unchanged. A `db.add` writes every column, so its hash does change.
- **`tableRefOf(column)` / `linkedTableOf(column)`** → the table a column points at.
- **`normalize(value)`** → the normalizer `xanosdk preflight` compares with, for diffing a
  stored workspace against a compiled one.

Everything on the entry is pure — no filesystem, network, or Node built-ins — so it runs anywhere.

The package also ships two machine-readable descriptions of the same surface, generated from the SDK's
own sources so they cannot drift from it: `llms.txt` (the router — the mental model and the gotchas, plus a
map of the `llms/*.md` topic files) and `manifest.json` (per-entry detail: field schemas, filter arguments,
stored names; its `cli` array plus `version` is the [compatibility contract](https://github.com/xanots/sdk/blob/main/guides/cli.md#checking-what-an-installed-sdk-can-do) for tools that drive the CLI).

---

<div align="center">

**Write TypeScript. Run `xanosdk deploy`. See it live.**

[npm](https://www.npmjs.com/package/@xano/sdk) ·
[GitHub](https://github.com/xanots/sdk) ·
[Issues](https://github.com/xanots/sdk/issues) ·
[Changelog](CHANGELOG.md) ·
[`llms.txt`](llms.txt) — the agent-facing router, mapping the `llms/` topic files

Xano SDK is the official TypeScript SDK for [Xano](https://xano.com). MIT licensed.

</div>
