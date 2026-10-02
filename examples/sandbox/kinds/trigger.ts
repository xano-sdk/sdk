/**
 * `{tableTrigger,realtimeServerTrigger,realtimeChannelTrigger,mcpServerTrigger,
 * agentTrigger,workspaceTrigger,errorTrigger}(...)` — the seven current trigger
 * types (payload key `trigger`), each a distinct root factory. A trigger's `stack`
 * is a CALLBACK `(t) => [...]`; inputs are implied by type and exposed on `t`.
 *
 * The two realtime lifecycle types live in `realtime.ts` alongside the objects they
 * bind to. What is here instead is `realtimeTrigger` — the SUPERSEDED one — kept as
 * a round-trip fixture, NOT as an example to copy. See Gate 2.
 *
 * PARAM GATE: the trigger type (`obj_type`).
 */
import { tableTrigger, realtimeTrigger, workspaceTrigger, s, c } from "@xano/sdk";
import { users } from "../_shared.js";

/** Gate 1 — database table trigger. `t.new`/`t.old` are typed to the row. */
export const onUserInsert = tableTrigger({
  name: "ex_kind_trigger_on_user_insert",
  table: users,
  actions: { insert: true },
  stack: (t) => [s.debug.log({ value: t.new("email") })],
});

/**
 * Gate 2 — the SUPERSEDED realtime trigger. **Do not copy this into new code.**
 *
 * It fires against Xano's older workspace-global realtime layer, which is a
 * different object from the current `channel` despite the shared vocabulary. It is
 * here only so the corpus proves `xanosdk codegen` can bring one back out of a
 * workspace that still holds it — the round-trip has to keep working for people
 * migrating off it.
 *
 * The current equivalents, both in `realtime.ts`:
 *  - its `join` action  -> `realtimeChannelTrigger({ actions: { join: true } })`
 *  - its `message` action -> a `realtimeMessage()` handler, since a message is
 *    an authored unit with its own typed payload and stack, not a trigger action
 *
 * (Response-bearing; `response` defaults to echoing the payload.)
 */
export const onMessage = realtimeTrigger({
  name: "ex_kind_trigger_on_message",
  actions: { message: true },
  response: (t) => t.payload,
});

/** Gate 3 — workspace lifecycle trigger. */
export const onBranchLive = workspaceTrigger({
  name: "ex_kind_trigger_on_branch_live",
  actions: { branch_live: true },
  stack: () => [s.debug.log({ value: c.text("branch went live") })],
});
