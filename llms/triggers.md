# Triggers

> Read when authoring any trigger. A trigger's `stack` is a callback rather than the plain array every other kind takes, so the shape does not carry over.

**A trigger's `stack` is a callback — `stack: (t) => [...]` — to read a trigger
input** (a plain list works when it reads none). That's the one
shape that doesn't carry over from the other kinds: a trigger has no
user-declared `input`, so its inputs are **implied by type** (fixed by Xano,
not editable) and arrive through the typed **stack handle** `t` — you can't
reference them without it. (`response` too — a callback, or a plain value that
reads none.) `t` exposes exactly that trigger type's inputs; a wrong
name is a compile error, not a runtime surprise. The seven trigger types are
distinct root factories (not a namespace): `{tableTrigger, realtimeServerTrigger,
realtimeChannelTrigger, mcpServerTrigger, agentTrigger, workspaceTrigger,
errorTrigger}({ name, guid?, description?, active?, tags?, history?, ... })`.
`history` is per trigger (omit to inherit the workspace's `history.trigger`, default
off); a trigger's own failure reaches the error log only while it is on.

- `tableTrigger({ name, table?, datasources?, actions?: {insert?,update?,delete?,truncate?}, stack })` — database/table trigger. `t.new` / `t.old` are the row **after** / **before** the change; `t.action` (`insert|update|delete|truncate`), `t.datasource`. Bind `table` to a `table()` handle and `t.new("col")` / `t.old("col")` are typed to that row (misspelled column = compile error). ⚠ Insert's `old` and delete's `new` are `{}`, not null — branch on `t.action`, not a null check. Config-only (no response).
- `realtimeServerTrigger({ name, realtimeServer, actions?: {connect?,disconnect?}, stack?, response?, responseShape? })` — realtime SERVER lifecycle (a client connecting to / disconnecting from the server, not a message). Inputs: `t.action` (`connect|disconnect`), `t.realtime_server`, `t.client`. Bind `realtimeServer` to a `realtimeServer()` handle (or its name).
  - `connect` GATES the connection — a denial sends an `error` and CLOSES the socket with code 4401 before it is ever ready, so it is a real front door, not an observer; same return shape as a channel `join` below (EMPTY/FALSY DENIES — INCLUDING a gating trigger with NO `response`, which returns nothing and so refuses every client).
  - A CRASH DENIES too — a gate that cannot answer must not admit. Both failure modes lock the door, so plan for a self-inflicted LOCKOUT (an unguarded drill into a null `db.get` raises → everyone refused), not a breach.
  - Gating is OPT-IN: a server with no `connect` trigger accepts every connection.
  - `disconnect` is OBSERVATIONAL (return ignored, throws swallowed — cleanup must always complete).
  - Both are SERVER-scoped, so `s.realtime.get_session` works but carries no channel path and no bound params.
- `realtimeChannelTrigger({ name, channel, actions?: {join?,leave?,deliver?}, stack?, response?, responseShape? })` — realtime CHANNEL lifecycle. Inputs: `t.action` (`join|leave|deliver`), `t.channel`, `t.payload`, `t.client`. Bind `channel` to a `realtimeChannel()` handle — a bare path is NOT accepted (it is unique only within its server). The three actions have DIFFERENT postures, and the posture decides what the stack should return:
  - `join` GATES the join (it runs before membership) — return `{ allowed: c.bool(true) }` (optional `reason` reaches the client) or any truthy value to admit, and an EMPTY OR FALSY RETURN DENIES, so a stack that just falls through — or a gating trigger with NO `response` — refuses everyone, and a CRASH DENIES too. ONCE the object carries an `allowed` key admission needs STRICTLY `true` — `1`/`"yes"` there DENIES. Compute it as `c.expression("…")` or a `ref()` to a `set_var` boolean (`expr()` is not a `response` value). That is the inverse of a crashing message, which still delivers, and of `deliver` below.
  - A lifecycle trigger's inputs are PINNED to those four, so a channel PATH PARAM is NOT among them — `inp("room_id")` RAISES, which crashes the gate and so REFUSES every client; take the param from `s.realtime.get_session` (`ref("session.params.room_id")`).
  - A gate establishes NO auth: `auth("id")` reads 0 when authenticated, `ref("auth.id")` raises — identity is `t.client("permissions.row_id")` or the session. A SERVER connect/disconnect has no channel, so no params at all.
  - `leave` is OBSERVATIONAL (return ignored, throws swallowed).
  - `deliver` GATES delivery PER RECIPIENT — the per-viewer redaction tool and the most expensive action here (a stack per recipient per message), and it needs `delivery.perRecipient` on the channel to run at all — BOTH HALVES are required, so a `deliver` trigger on a channel without the flag NEVER RUNS and every subscriber receives the UNREDACTED payload (no error, no log line); `export()` warns on each half alone.
  - **`deliver`'s RETURN VALUES DO NOT READ LIKE A FILTER:** ONLY an explicit NULL drops the message for that recipient; an OBJECT replaces that recipient's payload; ANYTHING ELSE — INCLUDING `false`, `0`, `""` — DELIVERS IT UNCHANGED, as does a crash. So `return false` from a yes/no redaction check SENDS the message it was written to suppress — return null instead.
  - The delivered payload arrives NESTED, so read `t.payload("<field>")`, and `t.client` is the SENDER while `s.realtime.get_session` describes the RECIPIENT this run is for.
- `mcpServerTrigger({ name, mcpServer, stack?, response?, responseShape? })` / `agentTrigger({ name, agent, stack?, response?, responseShape? })` — toolset connection. Bind with the `mcpServer()`/`agent()` def handle (or its name) — it resolves to the toolset guid at export. Raw numeric `objId` is the escape hatch, rarely right: ids are assigned at import, so a handle passed to `objId` is a type error, and binding nothing deploys a trigger that never fires. Inputs: `t.toolset` (`t.toolset("name")`), `t.tools`; an MCP server's also `t.prompts`/`t.resources`: return one filtered to narrow what the connection lists, omit it to list all — and `t.auth`, the signed-in user `{dbo, id, extras}` when the server has `oauth` (null otherwise). Response-bearing; the default returns every list input.
- `workspaceTrigger({ name, actions?: {branch_live?,branch_merge?,branch_new?}, stack? })` — branch lifecycle. Inputs: `t.to_branch`, `t.from_branch`, `t.action`. Config-only.
- `errorTrigger({ name, stack? })` — error-signature trigger. Inputs: `t.event` (`new|regression|fixed`), `t.id`, `t.signature`, `t.error` (`t.error("code")`/`t.error("message")`), `t.caller`, `t.statement`, `t.actor`, `t.count`, `t.first_seen`, `t.last_seen`, `t.fixed_at`. Config-only.
