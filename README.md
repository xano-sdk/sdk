<div align="center">

# Xano SDK

### The official TypeScript SDK for [Xano](https://xano.com).

**Write your app in TypeScript — the database, the APIs, even AI agents. Or let an
AI write it for you. Run it on your own machine on the Xano Engine, with no account and no
network. When it's ready, one command puts the same code live on Xano's cloud.**

[![npm](https://img.shields.io/npm/v/@xano/sdk?color=%230055FF&label=%40xano%2Fsdk)](https://www.npmjs.com/package/@xano/sdk)
[![node](https://img.shields.io/node/v/@xano/sdk)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@xano/sdk)](LICENSE)

[What is Xano](#what-is-xano) ·
[Why](#why-xano-sdk) ·
[Quickstart](#quickstart) ·
[Xano Engine](#xano-on-your-machine) ·
[The model](#the-model) ·
[Typed frontend](#a-type-safe-frontend-for-free) ·
[Already on Xano?](#already-have-a-xano-workspace) ·
[Agent skill](#the-agent-skill) ·
[Deploying](#deploying) ·
[Reference](#reference)

</div>

<!-- A short terminal recording of the three commands below belongs here. -->

```bash
npx @xano/sdk init my-app && cd my-app   # 1. scaffold your backend + frontend
npm run xano:deploy                      # 2. run the backend on the Xano Engine, on your machine
npm run dev                              # 3. start the frontend, already wired to it
```

```
→ Deploying ./xano/index.ts → Xano Engine
✓ Xano Engine xanosdk-4f2a91 deployed
! New Xano Engine URL:
    http://127.0.0.1:53358                                  ← your backend, on your machine
  Open the builder: http://127.0.0.1:53358/signin?key=…     ← Xano's visual builder, local too
  Pointed .env.local at this deploy (VITE_XANO_HOST)        ← the frontend, wired in
```

<div align="center">

**From an empty folder to a running full-stack app, without signing up.** `init` writes a
TypeScript backend and a React or Svelte frontend. The **Xano Engine** runs that backend on
your laptop: no account, no network round-trip, and your data kept between redeploys. Change
your code — yourself or with an AI — and redeploy in seconds. When it's ready to share,
`npm run xano:deploy:ephemeral` puts the same code on a live URL on Xano's cloud.

Outside a project the command is `npx @xano/sdk <cmd>`; inside one, `npx xanosdk <cmd>`.

</div>

---

## What is Xano?

[Xano](https://xano.com) is a hosted backend platform for business-critical systems — the
kind that run in production, not as prototypes. Postgres, REST APIs, auth, background tasks,
realtime, file storage, MCP servers and AI agents, all run for you on Kubernetes, with
SOC 2 Type II, ISO 27001, HIPAA and GDPR coverage ([trust center](https://security.xano.com)).

Xano's bet is simple: **AI builds software. Xano makes it trustworthy.** Everything an AI
writes — a schema, an endpoint, an agent — lands somewhere you can understand, govern and
run. This SDK is that idea as code in your repo: the backend is TypeScript you review, and
the platform is where it runs.

[Docs](https://docs.xano.com) ·
[Community](https://community.xano.com) ·
[YouTube](https://www.youtube.com/@XanoHQ) ·
[X](https://x.com/xanohq) ·
[Status](https://status.xano.com) ·
[Pricing](https://www.xano.com/pricing)

---

## Why Xano SDK

- **💻 Xano runs on your machine.** New for Xano: the Xano Engine is the platform on your
  laptop. It needs no account and no network. It downloads once,
  keeps your rows across redeploys, and opens the same visual builder you'd use in the cloud.
  The project pins its version in `package.json`, so everyone on the team runs the same engine.
  See [Xano, on your machine](#xano-on-your-machine).

- **🤖 Built for AI-written code.** A deterministic, fully-typed authoring surface: an agent
  (or you) emits well-typed TypeScript that always compiles to a valid, importable workspace.
  The package ships machine-readable grounding — `llms.txt` and the topic files beside it — so
  a coding agent writes against the real API instead of a guess, and `init` drops an
  `AGENTS.md` brief into every project. See
  [Coverage & agent grounding](https://github.com/xano-sdk/sdk/blob/main/guides/coverage.md).

- **📦 TypeScript is the source of truth.** Tables, indexes, endpoints, functions, triggers,
  tasks, middleware, AI toolsets — typed TS in your repo. Version it, review it in PRs, diff
  it, roll it back. Prod matches staging because they are the same commit.

- **🚀 Deploy is built in, from laptop to production.** One `xanosdk deploy` command compiles
  your code and ships it, first to the Xano Engine, then to an **ephemeral** on Xano's cloud,
  then through a release to your **workspace**. It sends the backend **and** the static
  frontend and prints their URLs. There's no export/import step and no upload script to maintain.

- **⚡ Disposable environments.** A Xano Engine and a cloud ephemeral are both yours to wipe
  and rebuild as often as you like. Deploys are identity-stable: re-running never duplicates
  objects, and the `xano.lock` every build writes keeps renames as renames, so your public
  URLs stay yours.

- **🧩 The types flow to your frontend.** A generated route manifest gives it every path, verb
  and request type; `import type` a `query()` def for its response. Rename a column and every
  consumer lights up red.

- **🔁 It works both ways.** Already have a workspace? `init --from workspace` reads it back
  as real, readable TypeScript — then deploys.

---

## Quickstart

The three commands at the top of this page are the whole local loop. Here it is one step at a
time, then out to the cloud.

**1. Scaffold.** No sign-in needed. `init` writes a Vite frontend under `frontend/` (React 19 +
shadcn/ui by default, SvelteKit with `--framework svelte`, none with `--framework none`), a Xano
SDK backend under `xano/`, and the `xano:deploy*` scripts already wired.

```bash
npx @xano/sdk init my-app && cd my-app
```

Theme it with a flag (`--theme zinc-blue --dark toggle`) or pick everything in a browser with
`--web`. The starter backend is empty but already deploys — grow it from `xano/EXAMPLE.md`.
Flags, presets, theming and add-ons: [The scaffolded project](https://github.com/xano-sdk/sdk/blob/main/guides/scaffold.md).

**Already have an app?** Run `init` inside it. In a directory that already has files, `init`
adds only the backend, with no prompt: it writes `xano/`, merges the `xano:*` scripts and
dependencies into your `package.json`, and writes no frontend. Anything it would overwrite is
listed and refused unless you pass `--force`
([details](https://github.com/xano-sdk/sdk/blob/main/guides/scaffold.md#no-frontend-and-existing-apps)).

**2. Run it on the Xano Engine.** The first deploy downloads the engine for your platform and
pins its version in `package.json`; every one after starts in seconds, offline.

```bash
npm run xano:deploy  # typecheck, then deploy the backend to an engine on this machine
npm run dev          # the frontend, pointed at it through .env.local
```

The deploy prints the backend URL and a link that opens Xano's visual builder on the engine.
That's the dev loop: edit `xano/`, redeploy, and keep `npm run dev` running. Redeploys keep
your rows (`--keep-data`); `-- --reset` gives a clean, re-seeded slate.

**3. Put it on Xano's cloud.** When you want a URL to share, sign in once and deploy to a
disposable **ephemeral** — a real Xano environment with its own address. The deploy prints
the backend and frontend URLs and bakes the backend one into your build as
`window.XANO_HOST`, so the frontend never needs to know it ahead of time.

```bash
npx xanosdk login              # OAuth in your browser — no API keys to copy around
npm run xano:deploy:ephemeral  # build the frontend, ship both → live URLs
```

> No browser on this machine — a container, a Codespace, CI? `npx @xano/sdk login --paste`
> prints the URL to open anywhere, and a token from your instance's settings works headless.
> See [Signing in & deploying](https://github.com/xano-sdk/sdk/blob/main/guides/deploying.md).

**4. Release it to your workspace:** `deploy --ephemeral --test`, `release create v1`, `promote v1` ([Deploying](#deploying)).

**Prefer to wire it by hand?** Install `@xano/sdk` in an ESM project and deploy
`xano/index.ts` with `npx xanosdk deploy ./xano/index.ts`; [Project structure](https://github.com/xano-sdk/sdk/blob/main/guides/project-structure.md)
has the two-line setup and the one rule that bites.

---

## Xano, on your machine

Xano has always been a hosted platform. The **Xano Engine** is that backend packaged to run on
your laptop. `xanosdk deploy` brings one up and deploys into it — it is where a deploy goes by default.

- **No account, no network.** A Xano Engine needs no sign-in, a cached one deploys offline,
  and every import runs on your machine. It's the fastest way to try Xano, and an AI agent
  can iterate against a real backend without credentials.
- **Your data stays put.** `--keep-data` merges each deploy into what the last one left, so
  rows you entered through the app survive the edit. `--reset` starts over and re-seeds.
- **The builder, locally.** Every deploy prints a sign-in link to Xano's visual builder
  running on the engine, so you can browse your tables and see what your code compiled to.
- **The whole stack.** `--static ./frontend/dist` has the engine serve your built frontend
  too, and a SvelteKit app built with `@xano/sdk/sveltekit` renders on the server there.
- **Pinned, like a dependency.** The first run pins the engine version in `package.json`;
  commit it and every checkout runs the same engine. Newer ones are offered, never forced.
- **Every command reaches it.** After a local deploy, `test run-all`, `tables`, `env set`,
  `impersonate` and `status` target the engine without a flag, and with no account.
- **An MCP server for your agent.** `init` connects Claude Code and Cursor to it: they read tables and
  rows, seed data, and run functions and tests. Code still changes in `xano/` and ships with a deploy.

```bash
npx xanosdk local list          # the engines running on this machine
npx xanosdk local mcp           # how a coding agent connects to the engine's MCP server
npx xanosdk local stop <name>   # stop one
npx xanosdk local update        # move the pin to the latest engine
npx xanosdk local cache clear   # reclaim the disk space
```

Where it keeps its data, serving a frontend, trying an engine build without moving the pin:
[Deploying locally](https://github.com/xano-sdk/sdk/blob/main/guides/deploying.md#deploying-locally).

---

## The model

You author declarative def-objects, register them on one `Xano` instance, and Xano SDK
compiles the whole thing into Xano's importable bundle.

```ts
import { workspace, table, query, apiGroup, f, input, s, inp, ref, c, expr, col } from "@xano/sdk";

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

const createPost = query({
  verb: "POST", apiGroup: blog, name: "posts",
  input: { title: input.text({ required: true }), body: input.text() },
  stack: [s.db.add({ table: post, row: { title: inp("title"), body: inp("body") }, as: "row" })],
  response: ref("row"),
});

export default workspace("blog")
  .registerApiGroups([blog])
  .registerTables([user, post])
  .registerQueries([listPosts, createPost]);
```

Tab-complete `s.` to discover the entire statement catalog — `s.db.*`, `s.math.*`,
`s.array.*`, `s.text.*`, `s.storage.*`, `s.api.*`, `s.cloud.*`, control flow, AI agent runs,
and more. **All 218 engine statement surfaces are authorable** — every field name matches
the Xano engine, and the emitted shape is checked against bytes a real engine stored. Where
a surface has no stored instance behind it yet, it is built from the engine's own schema;
[Coverage](https://github.com/xano-sdk/sdk/blob/main/guides/coverage.md) says which is which.

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

Tables, fields, statements, values, inputs, and middleware are all in the
[Authoring reference](https://github.com/xano-sdk/sdk/blob/main/guides/authoring.md); every
kind you can author is in [Object kinds](https://github.com/xano-sdk/sdk/blob/main/guides/object-kinds.md).

---

## A type-safe frontend, for free

Because your API is a typed def, the code that *calls* it never re-types a URL or a request
body: paths and request types come from a generated route manifest, responses from the defs:

```bash
npx xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts   # scaffolds run this before dev/build/typecheck
```

```ts
import { ROUTES, routePath, type RouteInputs } from "../xano/routes.gen.js"; // plain data, imports nothing
import type { post } from "../xano/index.js";            // the model above
import type { InferRow } from "@xano/sdk";

const BASE = window.XANO_HOST ?? import.meta.env.VITE_XANO_HOST; // deploy injects it; .env.local in dev

type NewPost = RouteInputs["POST posts"];              // { title: string; body?: string }
type Post = InferRow<typeof post>;                     // { id: number; created_at: number; title: string; … }

async function createPost(body: NewPost): Promise<Post> {
  const res = await fetch(BASE + routePath("POST posts"), {
    method: ROUTES["POST posts"].verb, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();                                   // typed end to end
}
```

- **`routePath("GET blog/{slug}", { slug })`** → the endpoint path, resolved from your code
  (or the frozen `xano.lock`). Keys are `"<VERB> <name>"` and are checked at compile time,
  `{param}` names included: a backend rename is a compile error rather than a 404.
- **`RouteInputs["POST posts"]`** → the request-payload type, under the same keys
  (`ChannelInputs`/`MessageInputs` for realtime); `InferInput<typeof q>` is the def-side twin.
- **`InferRow<typeof post>`** / **`InferResponse<typeof someQuery>`** → the table's row type
  and the endpoint's response type, closing the round trip. Rename or retype a column and
  every consumer breaks at compile time — exactly where you want it.
- **Runtime validation:** `npx xanosdk marketplace install zod` adds zod schemas to the file,
  keyed alike (`ROUTE_SCHEMAS["POST posts"].parse(body)`) and typechecked against the types.

Import defs with `import type` only: a def imported as a value carries the SDK runtime into
your bundle. Bundle numbers, inference rules, and the realtime helpers are in
[The typed frontend surface](https://github.com/xano-sdk/sdk/blob/main/guides/typed-frontend.md).

---

## Already have a Xano workspace?

`--from` runs the loop the other way: it reads a workspace and writes it back out as
readable Xano SDK source — real `s.db.query(...)`, `f.email()`, typed defs — not a JSON dump,
and inside the same runnable project `init` scaffolds. So a pull deploys:

```bash
npx @xano/sdk init my-app --from workspace   # your real workspace (the one your login is scoped to)
cd my-app
npm run xano:deploy                          # → your workspace, running on your machine
```

Object identities are preserved, so cross-references stay intact, and a statement this SDK
does not model yet round-trips verbatim rather than breaking the pull. Then it checks its own
work: the tree it just wrote is loaded, exported, and diffed against the workspace it came
from, so "it compiled" and "it means the same thing" are separate claims and you get both.

> ⚠️ **After a pull, `xano/` is your source** — edit it and commit it. A pull carries schema
> only — no table rows or stored files — and deploying it is a *full replace* of the target,
> so try a change on the Xano Engine or a disposable ephemeral first.

The other sources (`--from ephemeral:<name>`, `--from ./ws.json`), how env var names and
values travel, the doc-site token, and how to read the decode report are in
[Pulling an existing workspace](https://github.com/xano-sdk/sdk/blob/main/guides/codegen.md).

---

## The agent skill

`xano-backend` is an agent skill (`SKILL.md`) for the coding agent you already use: Claude Code,
Codex, Cursor, Copilot, Gemini CLI, Amp or OpenCode. When a project needs a backend and has none,
it has the agent confirm Xano with you, run `init`, deploy, and follow the `AGENTS.md` that `init`
wrote. (It is unrelated to `knowledge()`, the docs your workspace's own AI agents read.)

```bash
npx @xano/sdk agent-skill install   # into each coding agent on this machine (also: status, uninstall)
npx skills add xano-sdk/sdk         # or with the skills installer
```

In Claude Code: `/plugin marketplace add xano-sdk/sdk`, then `/plugin install xano@xano-sdk`.

---

## Deploying

Code moves through three places: the **Xano Engine** on your machine, a disposable
**ephemeral** on Xano's cloud, and your **workspace**. `deploy` reaches the first two.
Reaching anything real goes through a **release** — the stored record that this code came up
and answered: `deploy --ephemeral --test`, then `release create v1`, then `promote v1`.

| Command | Where it goes |
|---|---|
| `xanosdk deploy` | The **Xano Engine** on this machine — the default. No network round-trip per deploy, and no Xano account needed. The first run downloads the engine and pins its version in `package.json` ([details](#xano-on-your-machine)). |
| `xanosdk deploy --ephemeral` | A disposable **ephemeral** on Xano's cloud — create-or-refreshed each run, auto-expiring, with its own URL. |
| `xanosdk promote <release>` | Your **main Xano instance** workspace — the production target. Lands a release on a branch named for it, reads the branch back, and fails naming anything the release declared that did not arrive. `--set-live` serves it once that check passes. |
| `xanosdk tenant deploy <tenant> <release>` | A **customer tenant** — the same release, on someone else's deployment. It **replaces** what the tenant serves; static hosting is kept. |
| `xanosdk release transfer <release> --to-profile <profile>` | **Another workspace or instance** — copies the stored release, checked by content hash, to `promote` there. |
| `xanosdk deploy --to <dest>` | The **escape hatch**: merges a local build straight into `workspace` or `tenant:<name>`, skipping the release record. |
| `xanosdk publish <dir>` | **Just the frontend**: an already-built directory onto the Xano Engine or ephemeral you last deployed to, `workspace`, or `tenant:<name>` — the retry when a frontend fails after its backend landed. |

Every `deploy` is a **full replace** of the disposable environment, table records included,
unless `--keep-data` merges. Promoting is the opposite by design: it changes what your code
defines and keeps every row. Tables are shared by every branch, so a release that alters one
is refused without `--allow-shared-schema-changes`. `--branch <label>` lands on a non-live
branch and `--set-live` promotes it, while `--backup-branch` snapshots live's logic, not its shared tables,
for a one-`set-live` rollback. A release name is refused rather than resolved when it already exists.

`xanosdk status` answers where you stand in one read — who you are signed in as, which
instance and workspace, and the backend this project last deployed to. Every flag, the
identity model, `--json` and exit codes, and headless CI runs are in
[Signing in & deploying](https://github.com/xano-sdk/sdk/blob/main/guides/deploying.md).

### Testing

The tests you author — a `tests` entry on a query, function, or middleware, or a standalone
`workflowTest()` — run against a deployed environment:

```bash
npx xanosdk test run-all                       # the Xano Engine or ephemeral you last deployed to
npx xanosdk test run-all --on workspace        # or your real workspace
```

A failing suite exits **5**, distinct from a crash, so CI can tell the two apart. To deploy
and prove it in one step, `xanosdk deploy ./xano/index.ts --test`. A test's `datasource` is
stored on the test and cloned before every run, so read
[Object kinds](https://github.com/xano-sdk/sdk/blob/main/guides/object-kinds.md) before
pointing one at your real workspace.

---

## Reference

Every kind, statement, filter, and field type is typed, so your editor's autocomplete is
the fastest lookup — tab-complete `s.`, `f.`, `c.`, `fl.`, `input.`. For the written
reference, the guides carry the shape of a project and the behavior that will bite you:

| Guide | What's in it |
|---|---|
| [Project structure](https://github.com/xano-sdk/sdk/blob/main/guides/project-structure.md) | How a `xano/` project is laid out, why registration is explicit, wiring one by hand |
| [The scaffolded project](https://github.com/xano-sdk/sdk/blob/main/guides/scaffold.md) | What `xanosdk init` writes, the two frontend presets, no frontend, existing apps, theming, add-ons, SvelteKit rules |
| [The marketplace](https://github.com/xano-sdk/sdk/blob/main/guides/marketplace.md) | Finding add-ons, the two kinds of module, and the install/reinstall/remove lifecycle |
| [The module contract](https://github.com/xano-sdk/sdk/blob/main/guides/module-contract.md) | Building an add-on: the manifest fields, the plugin types, every hook, and what is refused |
| [Object kinds](https://github.com/xano-sdk/sdk/blob/main/guides/object-kinds.md) | Every authorable kind, and splitting a workspace across microservices |
| [Authoring reference](https://github.com/xano-sdk/sdk/blob/main/guides/authoring.md) | Tables and fields, statements, values, inputs, middleware, seed data |
| [CLI](https://github.com/xano-sdk/sdk/blob/main/guides/cli.md) | Every command, the agent skill, shell completion, and what failures look like |
| [Warning and error codes](https://github.com/xano-sdk/sdk/blob/main/guides/codes.md) | Every code the CLI and the build emit, with what it means |
| [Signing in & deploying](https://github.com/xano-sdk/sdk/blob/main/guides/deploying.md) | Auth, ephemerals, `--static`, releasing to production, `xanosdk preflight` |
| [Environment & identity](https://github.com/xano-sdk/sdk/blob/main/guides/environment.md) | Every environment variable, and how `xano.lock` pins identity |
| [The typed frontend surface](https://github.com/xano-sdk/sdk/blob/main/guides/typed-frontend.md) | Path resolution, input/response inference, bundle cost, the route manifest |
| [Pulling an existing workspace](https://github.com/xano-sdk/sdk/blob/main/guides/codegen.md) | What `xanosdk init --from` writes, how faithful it is, and how to read its report |
| [Reading a compiled bundle](https://github.com/xano-sdk/sdk/blob/main/guides/bundle.md) | `@xano/sdk/bundle`: walking, hashing and diffing compiled JSON from your own tools |
| [Coverage & agent grounding](https://github.com/xano-sdk/sdk/blob/main/guides/coverage.md) | What is covered, what is out of scope, and the files agents read |

The package also ships two machine-readable descriptions of the same surface, generated from
the SDK's own sources so they cannot drift from it: `llms.txt` (the router — the mental model
and the gotchas, plus a map of the `llms/*.md` topic files) and `manifest.json` (per-entry
detail: field schemas, filter arguments, stored names; its `cli` array plus `version` is the
[compatibility contract](https://github.com/xano-sdk/sdk/blob/main/guides/cli.md#checking-what-an-installed-sdk-can-do)
for tools that drive the CLI).

---

<div align="center">

**Write TypeScript. Run it on the Xano Engine. Ship it to Xano's cloud.**

[npm](https://www.npmjs.com/package/@xano/sdk) ·
[GitHub](https://github.com/xano-sdk/sdk) ·
[Issues](https://github.com/xano-sdk/sdk/issues) ·
[Changelog](CHANGELOG.md) ·
[`llms.txt`](llms.txt) — the agent-facing router, mapping the `llms/` topic files

Xano SDK is the official TypeScript SDK for [Xano](https://xano.com) —
[docs](https://docs.xano.com) · [community](https://community.xano.com). MIT licensed.

</div>
