/**
 * `s.api.realtime_event({ channel, data, authId, authTable? })` — publish a
 * realtime event to a channel.
 */
import { defineFunction, s, c, auth } from "@xano/sdk";
import { users } from "../../_shared.js";

export const apiRealtimeEvent = defineFunction({
  name: "ex_api_realtime_event",
  stack: [
    s.api.realtime_event({
      channel: c.text("chat/room-1"),
      data: c.obj({ text: "hello" }),
      authTable: users,
      authId: auth("id"),
    }),
  ],
});
