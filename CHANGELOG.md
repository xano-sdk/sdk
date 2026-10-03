# Changelog

All notable changes to [`@xano/sdk`](https://www.npmjs.com/package/@xano/sdk).

This file is **generated** from the [GitHub releases](https://github.com/xanots/sdk/releases)
by `npm run changelog` — edit the release, not this file. Each entry summarizes
one release and links to its full notes.

---

## 1.0.3 — Agents and MCP servers pass preflight

_2026-10-03_ · [release notes](https://github.com/xanots/sdk/releases/tag/v1.0.3)

This patch release fixes `xanosdk preflight` on workspaces that have agents or MCP servers, and makes pulling an existing workspace into code more reliable. Agents and MCP servers without sign-in no longer fail the round trip. Workspaces pulled with `export`/codegen now re-export as they were stored and the generated tree typechecks, including shapes older workspaces carry.

- `preflight` no longer fails every agent and MCP server without `oauth`
- UUID primary keys keep their stored default
- Pulled workspaces decode more statements to typed code
- Guards the engine accepts are now warnings a def can allow
- Workspace defects are reported and the tree still compiles

---

## 1.0.2 — Fixtures can pin accepted hazards

_2026-10-03_ · [release notes](https://github.com/xanots/sdk/releases/tag/v1.0.2)

This patch release lets a def deliberately author three shapes the engine accepts but 1.0 refused outright: an active cache with `ttl: 0`, a call passing an input its target does not declare, and a lambda body that does not parse. Each is still flagged by default, and `export --strict` still fails on it, but a fixture that pins the engine's behavior for that input can now say so.

- `cache.ttl` of 0 is a warning a def can accept
- Passing an input the target does not declare is a warning a def can accept
- `lam.raw(code, { unchecked: true })` sends a body that does not parse

---

## 1.0.1 — Safer local-engine records

_2026-10-03_ · [release notes](https://github.com/xanots/sdk/releases/tag/v1.0.1)

This patch release makes the local engine's record file safe under concurrent use and removes the SDK's handling of its retired package names. If you run several local-engine deploys or stops at once, they no longer undo each other's bookkeeping.

- Concurrent local-engine deploys and stops no longer lose each other's records
- `local-engine stop --all` keeps the record of an engine a concurrent deploy just started
- The SDK no longer handles its retired package names

---

## 1.0.0 — Xano SDK, the new name

_2026-10-02_ · [release notes](https://github.com/xanots/sdk/releases/tag/v1.0.0)

The SDK is now **Xano SDK**, published as `@xano/sdk` and restarting at 1.0.0. The CLI is `xanosdk`, and add-on modules ship as `@xano-sdk/*`. The earlier `@xanots/sdk` 0.0.x and `@xanots/core` 2.0.x lines are retired.

- The package is now @xano/sdk
- Modules publish as @xano-sdk/*
- ⚠️ The CLI is xanosdk
- ⚠️ XANOSDK_* env vars and the xanosdk project block
- Docs and messages say Xano SDK
