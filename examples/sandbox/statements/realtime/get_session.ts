/**
 * `s.realtime.get_session` — bind the CALLER's realtime session.
 *
 * The bound variable carries the connection behind the current frame: the channel
 * path it joined, that path's bound params (`session.params.room_id`), and the
 * connection's identity (whether it authenticated, and its extras). It answers
 * "who is this sender" on a channel that admits anonymous clients — the question
 * every realtime app eventually asks.
 *
 * ONLY meaningful inside a realtime message or channel-trigger stack: off that
 * path there is no websocket connection, so the session degrades to an anonymous
 * one (which is what this example — a plain function, deployable in the sandbox —
 * returns). For a channel path param, prefer `inp("room_id")` in the message
 * stack; reach for the session when you need the CONNECTION itself.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const realtimeGetSession = defineFunction({
  name: "ex_realtime_get_session",
  stack: [s.realtime.get_session({ as: "session" })],
  // One field reads with a dotted ref — e.g. ref("session.params.room_id")
  // inside a `rooms/{room_id}` message stack.
  response: ref("session"),
});
