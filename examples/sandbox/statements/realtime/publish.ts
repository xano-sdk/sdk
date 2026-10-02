/**
 * `s.realtime.publish` — originate a server-authored event onto a realtime channel
 * from an ordinary function stack.
 *
 * This is the push direction: a query, task, function, or trigger tells connected
 * clients something happened, with no client frame arriving first. "The auction
 * closed", "the import finished", "row 42 changed".
 *
 * Three things this example is shaped to teach:
 *
 *  1. DERIVE the channel path — `roomChannel.getChannel({ room_id })` — instead of
 *     concatenating `"rooms/" + id`. Publishing to a path no channel matches is not
 *     an error you will see (see 3), so the typed accessor is the only guard there is.
 *     When the id is only known at RUNTIME — one channel per row, the ordinary shape —
 *     `getChannel()` cannot help: it needs the id while you are writing the code. Build
 *     the path as a value instead (the second statement below), which the export check
 *     leaves alone because it cannot read it.
 *
 *  2. `authTable`/`authId` are ATTRIBUTION, not a credential. They stamp "this event
 *     is attributed to user 7" onto the frame so a client can render it. Nothing
 *     validates them and no auth gate consumes them — do NOT reach for them to grant
 *     a publish a channel's `publish.who` would refuse. This statement is
 *     server-authoritative and bypasses that gate outright, which is the whole point:
 *     it runs in YOUR stack, so YOUR stack is where the authorization belongs.
 *
 *  3. It is FAIL-SOFT and DELIVERY-ONLY. A missing or disabled server, or an
 *     unreachable bus, is swallowed engine-side — nothing throws and there is no
 *     result to check, so a mis-targeted publish is silent. And naming a `message`
 *     type does NOT invoke that message's handler; the payload is fanned out as-is.
 *     What Xano SDK can check, it checks loudly instead: a `channel` constant still
 *     carrying its `{param}` template throws at author time, and a constant
 *     `server`/`channel` naming nothing this workspace registers warns at export.
 */
import { defineFunction, s, c, obj, inp, input, auth, withFilters, fl } from "@xano/sdk";
import { users } from "../../_shared.js";
import { chatServer, roomChannel } from "../../kinds/realtime.js";

export const realtimePublish = defineFunction({
  name: "ex_realtime_publish",
  input: { room_id: input.int({ required: true }), body: input.text({ required: true }) },
  stack: [
    s.realtime.publish({
      // The server is named, not referenced by guid — the engine resolves it by
      // name within this workspace and branch. Pass the handle and the name comes
      // with it.
      server: chatServer,
      // The FILLED-IN path, not the `rooms/{room_id}` template.
      channel: c.text(roomChannel.getChannel({ room_id: 42 })),
      // Optional: the message TYPE stamped on the frame, so a client can route this
      // server-originated event the same way it routes a client-originated one.
      message: c.text("post"),
      data: obj({ body: inp("body"), room_id: inp("room_id") }),
      // Attribution only — see (2) above.
      authTable: users,
      authId: auth("id"),
    }),
    // The per-row shape: the room is whatever this request names, so the path is
    // built at runtime by concatenating onto the template's literal prefix. A
    // filtered constant is a COMPUTED value — the export check reads constants
    // only and stays off it, exactly as it does for a plain `ref`/`inp`.
    s.realtime.publish({
      server: chatServer,
      channel: withFilters(c.text("rooms/"), fl.concat(inp("room_id"))),
      message: c.text("post"),
      data: obj({ body: inp("body"), room_id: inp("room_id") }),
    }),
  ],
});
