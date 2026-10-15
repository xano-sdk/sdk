# Changelog

All notable changes to [`@xano/sdk`](https://www.npmjs.com/package/@xano/sdk).

This file is **generated** from the [GitHub releases](https://github.com/xano-sdk/sdk/releases)
by `npm run changelog` — edit the release, not this file. Each entry summarizes
one release and links to its full notes.

---

## 1.0.13 — Docs that match the CLI

_2026-10-14_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.13)

A documentation release: every guide, the README and the agent grounding were checked against the current CLI and corrected where they had drifted. `knowledge()` is now described as what it is, markdown shared by every AI that builds your backend, and the `AGENTS.md` that `init` writes tells your coding agent to read it. No API changes.

- `knowledge()` is shared context for every AI building your backend
- `init`'s `AGENTS.md` points your coding agent at the knowledge files
- The CLI guide lists every command and the real bundle keys
- Deploy and environment guides match the CLI
- Scaffold and marketplace guides match `init` and `install`
- `--backup-branch` is a `deploy --to workspace` flag

---

## 1.0.12 — Every address in routes

_2026-10-14_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.12)

`xanosdk routes` now lists every address a frontend uses, not only HTTP routes: realtime servers, channels and MCP servers too. The `--json` listing changes shape to match. The public repository is also ready for launch: a contributing policy, bug-only issue forms, and a clone that builds as-is.

- `xanosdk routes` lists realtime servers, channels and MCP servers
- ⚠️ `xanosdk routes --json` returns all four address kinds
- `mcpUrl` is documented
- The public repository takes bug reports, and builds from a fresh clone

---

## 1.0.11 — MCP addresses and agent fallbacks

_2026-10-14_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.11)

This release mostly fixes what an agent is told. A field report on building against the Xano Engine turned up behavior the docs didn't mention, and one case where they were wrong. The route manifest now carries MCP server addresses, and a fresh project stops repeating a notice on every `dev` and `build`.

- `routes.gen.ts` carries MCP server addresses
- `caught()` docs now match what the engine binds, so agent fallbacks can branch
- MCP endpoints refuse browser origins, now documented
- `xano-free` agents need Xano's cloud, now documented
- The filter list shows each filter's operand type
- A fresh project no longer repeats "No API queries registered"

---

## 1.0.10 — The v3 messaging

_2026-10-13_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.10)

The README, the project `init` writes, and the npm listing now tell the same story as xano.com: Xano is one platform to build, run and govern AI-built software. Your coding agent writes the backend in TypeScript, you run it on the Xano Engine, then deploy it to Xano. Nothing changes at runtime.

- The README leads with Write with AI · Run locally · Deploy to Xano
- The SDK docs site is linked from the README
- The deploy link opens the Xano editor
- The npm description matches the deploy default

---

## 1.0.9 — Agents pick the right kind

_2026-10-13_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.9)

The docs your coding agent reads now say which kind to author for a task, not just what each kind is. An MCP server gets prompts and resources where they fit, instead of only tools. The guides also describe deploys to the Xano Engine correctly. Nothing changes at runtime.

- Agents are told which kind fits each task
- MCP servers get prompts and resources, not just tools
- The deploy guides match the Xano Engine default

---

## 1.0.8 — Deploys stop overwriting Xano edits

_2026-10-13_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.8)

A deploy to your workspace no longer overwrites edits a teammate made in Xano. This release also fixes a false `preflight` failure on zero-argument filters and warns when an agent run leaves its tools off.

- `deploy --to workspace` refuses to overwrite edits made in Xano
- `preflight` no longer fails on zero-argument filters
- A warning when an agent run leaves its tools off

---

## 1.0.7 — Your coding agent gets a backend

_2026-10-07_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.7)

This release is about coding agents working on a Xano backend. An agent in a Xano project now reaches the Xano Engine on your machine over MCP: it can read tables and rows, seed data, and run functions and tests with nothing to configure by hand. `xanosdk init` adds a backend to an app you already have instead of refusing it, and the new `xano-backend` agent skill points agents there. The `AGENTS.md` that `init` writes now briefs an agent on a project with a backend. It also fixes `.ts` entries failing on Node 20 and 22 with tsx 4.23.

- Coding agents reach the Xano Engine over MCP
- `init` adds a backend to an app you already have
- The `xano-backend` agent skill
- `AGENTS.md` is a backend brief, not a command list
- The brief's authoring example is compile-checked
- `.ts` entries load again with tsx 4.23 on Node 20 and 22

---

## 1.0.6 — Request types reach the frontend

_2026-10-05_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.6)

This release types every request a frontend sends from `routes.gen.ts` alone, opens that file to marketplace modules so runtime validators can sit beside the types, and teaches `workspace diff` to say which side changed since the project and a workspace branch last matched. ⚠️ One behavior break: `s.db.transaction` no longer accepts `as`, which always bound `null`.

- `routes.gen.ts` types every request the frontend sends
- Toolchain modules add their own section to `routes.gen.ts`
- `workspace diff` says which side changed since the last sync
- ⚠️ `s.db.transaction` no longer takes `as`
- A required input that carries a default is flagged
- The scaffolded README keeps its platform section

---

## 1.0.5 — The Xano Engine is the default

_2026-10-05_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.5)

This release makes the **Xano Engine**, the engine that runs on your machine, the default place your code goes. A bare `xanosdk deploy` now runs your backend locally with no Xano account, and `--ephemeral` sends it to Xano's cloud as the bare command used to. The engine is now called `local` everywhere in the CLI, and `publish` can put a frontend on it. ⚠️ Scripts that run a bare `deploy` expecting an ephemeral, or that use the `local-engine` spellings, need the changes below.

- ⚠️ `xanosdk deploy` goes to the Xano Engine by default
- ⚠️ The engine is `local` in the CLI
- `xanosdk publish` reaches the Xano Engine
- ⚠️ Scaffolded projects deploy locally first
- The README and scaffolded README introduce Xano
- The SDK lives at github.com/xano-sdk/sdk

---

## 1.0.4 — Marketplace moves to its new catalogue

_2026-10-03_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.4)

This patch release moves `xanosdk marketplace` to the catalogue's new home. The CLI now reads modules from a new default host, `XANOSDK_MARKETPLACE_URL` works with a tenant or ephemeral base, and a module withdrawn from the marketplace is refused by `install` again. No call-site changes are needed.

- The marketplace reads from its new catalogue host
- `XANOSDK_MARKETPLACE_URL` keeps the path on its base
- A module withdrawn from the marketplace is refused by `install`

---

## 1.0.3 — Agents and MCP servers pass preflight

_2026-10-03_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.3)

This patch release fixes `xanosdk preflight` on workspaces that have agents or MCP servers, and makes pulling an existing workspace into code more reliable. Agents and MCP servers without sign-in no longer fail the round trip. Workspaces pulled with `export`/codegen now re-export as they were stored and the generated tree typechecks, including shapes older workspaces carry.

- `preflight` no longer fails every agent and MCP server without `oauth`
- UUID primary keys keep their stored default
- Pulled workspaces decode more statements to typed code
- Guards the engine accepts are now warnings a def can allow
- Workspace defects are reported and the tree still compiles

---

## 1.0.2 — Fixtures can pin accepted hazards

_2026-10-03_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.2)

This patch release lets a def deliberately author three shapes the engine accepts but 1.0 refused outright: an active cache with `ttl: 0`, a call passing an input its target does not declare, and a lambda body that does not parse. Each is still flagged by default, and `export --strict` still fails on it, but a fixture that pins the engine's behavior for that input can now say so.

- `cache.ttl` of 0 is a warning a def can accept
- Passing an input the target does not declare is a warning a def can accept
- `lam.raw(code, { unchecked: true })` sends a body that does not parse

---

## 1.0.1 — Safer local-engine records

_2026-10-03_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.1)

This patch release makes the local engine's record file safe under concurrent use and removes the SDK's handling of its retired package names. If you run several local-engine deploys or stops at once, they no longer undo each other's bookkeeping.

- Concurrent local-engine deploys and stops no longer lose each other's records
- `local-engine stop --all` keeps the record of an engine a concurrent deploy just started
- The SDK no longer handles its retired package names

---

## 1.0.0 — Xano SDK, the new name

_2026-10-02_ · [release notes](https://github.com/xano-sdk/sdk/releases/tag/v1.0.0)

The SDK is now **Xano SDK**, published as `@xano/sdk` and restarting at 1.0.0. The CLI is `xanosdk`, and add-on modules ship as `@xano-sdk/*`. The earlier `@xanots/sdk` 0.0.x and `@xanots/core` 2.0.x lines are retired.

- The package is now @xano/sdk
- Modules publish as @xano-sdk/*
- ⚠️ The CLI is xanosdk
- ⚠️ XANOSDK_* env vars and the xanosdk project block
- Docs and messages say Xano SDK
