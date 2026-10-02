/**
 * `realtimeServer({...})` / `realtimeChannel({...})` / `realtimeMessage({...})`
 * — the realtime (websocket) family, and the only three-level containment chain
 * in the SDK:
 *
 *   realtimeServer  ->  realtimeChannel  ->  realtimeMessage
 *   (api group       ->  … as a query would sit under a group, one level deeper)
 *
 * PARAM GATE: the tier. A server owns channels; a channel owns message handlers.
 *
 * Two things worth copying from this example:
 *
 *  1. Pass the HANDLE, not a name. `realtimeChannel({ server: chatServer })` and
 *     `realtimeMessage({ channel: roomChannel })` — a channel path is unique only
 *     within its server, so a handle is what makes the binding unambiguous. A
 *     message given a bare channel path must also be given a `server`.
 *
 *  2. A channel's `input` types its PATH parameters; a message's `input` types
 *     the message PAYLOAD. Both reach the stack as ordinary declared inputs, read
 *     with `inp()` — `inp("room_id")` for the channel's path param, `inp("body")`
 *     for the payload field. They are different schemas for different things —
 *     see `roomChannel` (path) vs `sendMessage` (payload), whose stack reads both.
 *
 *  3. DERIVE the client's socket URL and channel path from the defs —
 *     `chatServer.getUrl(baseUrl)` and `roomChannel.getChannel({ room_id })` —
 *     never hardcode them. See `CLIENT_SNIPPET` at the bottom.
 */
import {
  realtimeServer,
  realtimeChannel,
  realtimeMessage,
  realtimeServerTrigger,
  realtimeChannelTrigger,
  input,
  inp,
  s,
  c,
} from "@xano/sdk";

/** Gate 1 — the server: the canonical-addressed container. Off until enabled. */
export const chatServer = realtimeServer({
  name: "ex_kind_chat_server",
  description: "Team chat over websockets",
  enabled: true,
});

/** Gate 2a — a STATIC channel: one lobby everyone joins. */
export const lobbyChannel = realtimeChannel({
  name: "lobby",
  server: chatServer,
  description: "The single shared lobby",
  // Anyone authenticated may publish; presence tracks who is in the room.
  publish: { who: "authenticated" },
  presence: true,
});

/**
 * Gate 2b — a PARAMETERIZED channel: one channel per room. `{room_id}` is bound
 * and validated at join time from the joined path (`rooms/42` → `room_id = 42`),
 * exactly as a query's path params are. A literal segment beats a parameter, so
 * `lobby` and `rooms/{room_id}` coexist without conflict.
 */
export const roomChannel = realtimeChannel({
  name: "rooms/{room_id}",
  server: chatServer,
  description: "One channel per room",
  input: { room_id: input.int() },
  publish: { who: "authenticated" },
  // Required for `onRoomDeliver` below to run AT ALL. The per-recipient
  // delivery path needs BOTH halves — this flag AND an active `deliver`
  // trigger bound to the channel — and with either missing the message is
  // delivered UNCHANGED to everyone, silently. Export warns on either half
  // alone. It costs a stack PER RECIPIENT PER MESSAGE, so turn it on only
  // where per-viewer redaction is actually wanted.
  delivery: { perRecipient: true },
  // The client-visible TRANSCRIPT: at join the server PUSHES the last 50
  // messages back, unasked — `conversation_start`, then ordinary `message`
  // frames flagged `conversation: true`, then `conversation_end`. That IS the
  // frontend's hydration; do not write a "fetch recent messages" endpoint for
  // it. Log to a table only for durability/search beyond this window.
  // Distinct from `history`, which is execution history for debugging.
  //
  // `limit` IS NOT OPTIONAL IN PRACTICE — it defaults to 0, and 0 means retain
  // NONE rather than retain everything, so `{ enabled: true }` on its own
  // records nothing, replays nothing, and reports no error. Note also that what
  // a handler broadcasts IS the stored row (see `sendMessage.response` below):
  // anything the response omits is simply gone on replay.
  conversation: { enabled: true, limit: 50 },
});

/**
 * Gate 3 — a message handler: the invocable unit, and the realtime analogue of a
 * query. `input` here is the message PAYLOAD; `stack` is the same statement
 * stack every other kind uses.
 */
export const sendMessage = realtimeMessage({
  name: "send",
  channel: roomChannel, // the handle carries the server too
  description: "Post a message to a room",
  input: { body: input.text({ required: true }) },
  // Everyone in the channel receives the result (the default). `sender` would
  // make it request/response over the socket; `others` excludes the sender.
  deliverTo: "channel",
  // BOTH input surfaces read the same way — `inp()`. `inp("body")` is this
  // message's payload; `inp("room_id")` is the CHANNEL's path param, bound once
  // when the client joined `rooms/42` and read from the connection thereafter
  // (never from the frame, so a sender cannot post into a room it did not join).
  // A persisting handler swaps the log for `s.db.add({ table, data: { ... } })`.
  stack: [s.debug.log({ value: inp("room_id") })],
  response: { room_id: inp("room_id"), body: inp("body") },
});

/** A second handler on the same channel — a channel owns N named message types. */
export const typingMessage = realtimeMessage({
  name: "typing",
  channel: roomChannel,
  description: "Ephemeral typing indicator",
  // Only the other participants need to know; echoing to the sender is noise.
  deliverTo: "others",
});

/**
 * Server lifecycle trigger — fires on connect/disconnect.
 *
 * `connect` GATES the connection: the stack's return admits or denies it, and a
 * denial closes the socket (code 4401) before it is ever ready. `disconnect` is
 * observational and ignores the return, so one admitting response serves both.
 *
 * WHICH IS WHY `response` IS MANDATORY ON A GATING TRIGGER. Without it the
 * trigger returns nothing, nothing is falsy, and a falsy return DENIES — a
 * `connect` trigger with no response refuses every client on the server. A
 * CRASH denies too — a gate that cannot answer must not admit. So BOTH failure
 * modes lock the door, and the risk here is a self-inflicted lockout rather
 * than a breach: an unguarded drill into a `db.get` that bound null raises, and
 * every client is refused. `export()` warns on the missing
 * `response`; nothing can warn about the raise, so guard the drill
 * (`ref(path, { safe: true })`).
 *
 * The one thing that admits without asking is not declaring the action at all —
 * gating is opt-in, so a server with no `connect` trigger accepts everyone.
 */
export const onChatConnect = realtimeServerTrigger({
  name: "ex_kind_trigger_on_chat_connect",
  realtimeServer: chatServer,
  actions: { connect: true, disconnect: true },
  stack: (t) => [s.debug.log({ value: t.action })],
  // `{ allowed }` is the explicit admit shape; an optional `reason` rides along
  // on a denial and reaches the client's error frame. Swap the constant for a
  // real decision (a ban check, a seat count) to gate for real.
  response: () => ({ allowed: c.bool(true) }),
});

/**
 * DERIVE THE CLIENT SIDE. Both halves of what a browser needs come off the
 * defs, so a rename or a re-minted canonical cannot desync the client:
 *
 *   chatServer.getUrl("https://x.dev.xano.io")      // wss://x.dev.xano.io/ws/<canonical>
 *   chatServer.getUrl("https://x/tenant/a-b-c")     // /ws/a-b-c:<canonical> — lifted from the URL
 *   chatServer.getUrl(base, { tenant: "a-b-c" })    // /ws/<tenant>:<canonical> — tenant DB
 *   roomChannel.getChannel({ room_id: 42 })         // "rooms/42" — the frame's `channel`
 *
 * `getUrl` accepts the instance base URL you already have (`https://…`) and
 * normalizes the scheme to `wss://`; a remote host must be `wss` (a `ws://`
 * socket fails as an opaque 1006). RESOLVE ONCE — the result is a socket URL,
 * not a base, and passing it back in throws rather than append a second
 * `/ws/…` (which would also drop the tenant the first call lifted).
 *
 * ON A TENANT INSTANCE, both halves of the client must name the tenant, and both
 * do it in the URL — but not in the same shape. The socket glues it on with a
 * colon inside ONE segment (`/ws/<tenant>:<canonical>`, `{ tenant }` above),
 * while HTTP gives it a segment of its own
 * (`/tenant/<tenant>/api:<canonical>/…`). No request header is required either
 * way. So
 * `getUrl` TRANSLATES a tenant base URL rather than concatenating it: pass the
 * `window.XANO_HOST` deploy injects (`https://<host>/tenant/<name>`) and the
 * tenant is lifted into the socket form with no `{ tenant }` needed; a
 * conflicting `{ tenant }` throws. A tenant on its OWN DOMAIN has nothing to
 * lift — pass `{ tenant }` there. Tokens are tenant-scoped, so one minted
 * through the instance workspace is rejected by the tenant's realtime server —
 * authenticate and dial through the same tenant.
 *
 * Auth is a bearer token passed as the
 * websocket SUBPROTOCOL — `new WebSocket(url, token)` — with no token meaning an
 * anonymous client. Join before you broadcast:
 *
 *   const ws = new WebSocket(chatServer.getUrl(BASE), TOKEN);
 *   const channel = roomChannel.getChannel({ room_id: 42 });
 *   ws.onopen = () => setTimeout(() => {
 *     ws.send(JSON.stringify({ action: "join", channel }));
 *     ws.send(JSON.stringify({ action: "broadcast", channel, type: "send", payload: { body: "hi" } }));
 *   }, 500); // the server finishes its handshake first; an early frame is refused
 *
 *   // KEEP IT ALIVE. An idle socket is reaped after ~10 minutes, which is easy
 *   // to miss because a chatty client never hits it — but a listen-only client
 *   // (a feed, a dashboard, a presence sidebar) joins and then goes quiet, and
 *   // silently drops. Any frame resets the clock; `ping` exists for this.
 *   setInterval(() => ws.send(JSON.stringify({ action: "ping" })), 60_000);
 *
 * IF YOU SET `delivery: { guarantee: "at_least_once" }` on a channel, the client
 * has to hold up its end or the guarantee is silently absent. It must ack what
 * it receives — `{ action: "ack", channel, id }` — and if it may be ANONYMOUS it
 * must also send a durable id once, in the join frame:
 *
 *   ws.send(JSON.stringify({ action: "join", channel, options: { client_id: DEVICE_ID } }));
 *
 * An authenticated client is keyed by its identity and needs no `client_id`; an
 * anonymous one without it has no cursor, its acks are ignored, and it quietly
 * falls back to at-most-once. The gap it missed then arrives as `replay` frames
 * — which are NOT the transcript above: `conversation_*` is the shared "what was
 * said before I arrived", `replay` is the per-client "what I missed while
 * disconnected".
 *
 * A canonical is minted and frozen by `xanosdk export <entry>`, so these throw
 * (rather than guess) until one is pinned in code or in `xano.lock`.
 */

/**
 * Channel lifecycle trigger — fires on join/leave of a specific channel.
 *
 * `join` GATES: it runs before the client becomes a member, so a denial means it
 * never receives a fan-out. Return `{ allowed: c.bool(true) }` (an optional `reason`
 * reaches the client) or any truthy value to admit — an EMPTY OR FALSY return
 * DENIES.
 *
 * WHICH MEANS `response` IS NOT OPTIONAL ON A GATING TRIGGER. A `join` trigger
 * with a stack but no `response` returns nothing, nothing is falsy, and a falsy
 * return DENIES — it refuses every join on the channel it was added to protect.
 * A `leave` trigger may omit `response` safely; a `join` one may not, and
 * `export()` warns when one does.
 *
 * A lifecycle trigger's inputs are PINNED to `action`/`channel`/`payload`/
 * `client`, so a channel path param is NOT one of them: `inp("room_id")` RAISES
 * here, which crashes the gate and so refuses every client. Read it from
 * `s.realtime.get_session` under `params` (`ref("session.params.room_id")`) and
 * the gate can decide per room. A SERVER connect/disconnect has no channel and
 * so no params at all.
 *
 * A gate also establishes NO auth, so `auth("id")` is 0 even for an
 * authenticated client (and `ref("auth.id")` raises) — identity is
 * `t.client("permissions.row_id")` (0 is anonymous) or the session;
 * `permissions.dbo_id` is the auth TABLE's id. And once the returned object
 * carries an `allowed` key, admission needs STRICTLY `true`, so hand it a real
 * bool.
 *
 * Note `c.bool(true)`, not `true`: a response member is a VALUE, and a bare
 * JavaScript boolean is not one.
 */
export const onRoomJoin = realtimeChannelTrigger({
  name: "ex_kind_trigger_on_room_join",
  channel: roomChannel,
  actions: { join: true },
  stack: (t) => [s.debug.log({ value: t.channel })],
  response: () => ({ allowed: c.bool(true) }),
});

/**
 * The channel's third action, and the one with a different posture: `deliver`
 * runs once per RECIPIENT of a message, not once per channel event.
 *
 * `join` gates the join and `leave` only observes, but `deliver` gates each
 * individual delivery, which makes it the tool for per-viewer redaction ("hide
 * the author's address from everyone but the author") and also the most
 * expensive action here by a wide margin: a stack per recipient per message. It
 * needs `delivery: { perRecipient: true }` on the channel to run at all.
 *
 * ITS RETURN VALUES DO NOT READ LIKE A FILTER, and this is the easiest thing in
 * the family to write backwards. Only an explicit NULL drops the message for
 * that recipient. An OBJECT replaces that recipient's payload. Everything else
 * — including `false`, `0` and `""` — delivers it UNCHANGED. So a yes/no
 * redaction check that returns `false` sends the very message it was written to
 * suppress; return null instead.
 *
 * Kept as its own trigger rather than folded into `onRoomJoin` because the two
 * fire at unrelated moments and want unrelated stacks.
 *
 * ITS RESPONSE SHAPE IS DELIBERATELY UNLIKE THE GATES ABOVE. `join`/`connect`
 * answer a yes/no with `{ allowed }`, but `deliver` answers "what does THIS
 * recipient get", so an OBJECT means REWRITE — returning `{ allowed: c.bool(true) }`
 * here would replace the message payload with `{"allowed": true}`. A bare truthy
 * value means "deliver the original untouched", which is the right no-op, and
 * omitting `response` entirely returns null, which DROPS the message for every
 * recipient.
 *
 * IT TAKES TWO OBJECTS TO MAKE THIS RUN. The engine gates the per-recipient
 * path on BOTH `delivery: { perRecipient: true }` on the channel AND an active
 * `deliver` trigger bound to it; with either half missing it takes the
 * passthrough path and delivers the payload UNCHANGED to every recipient. That
 * is the unsafe direction — a redaction gate that silently does not run ships
 * the unredacted payload with no error and no log line — so `roomChannel` sets
 * the flag, and `export()` warns if you ever write one half without the other.
 */
export const onRoomDeliver = realtimeChannelTrigger({
  name: "ex_kind_trigger_on_room_deliver",
  channel: roomChannel,
  actions: { deliver: true },
  stack: (t) => [s.debug.log({ value: t.action })],
  // Truthy NON-object = pass the original through. Return an object to rewrite
  // this recipient's payload, or null to drop the message for them.
  response: () => c.bool(true),
});
