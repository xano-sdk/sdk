/**
 * Realtime message (`message`) — the invocable unit of the realtime layer, and
 * the bottom of `realtime_server -> channel -> message`. It is the realtime
 * analogue of a query: `run[]` is the SAME stack type queries, functions, tasks
 * and tools use, so input validation, middleware, history and the debugger all
 * behave identically.
 *
 * A channel owns N named message types, each with its own validated payload and
 * its own stack — rather than one handler switching on a convention field.
 *
 * `input` here types the message PAYLOAD. The owning channel's `input` types the
 * channel PATH parameters (`rooms/{room_id}`). Both reach the stack as ordinary
 * declared inputs, read the same way — `inp("body")` for a payload field,
 * `inp("room_id")` for the channel's path param:
 *
 * ```ts
 * const rooms = realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.int() } });
 * realtimeMessage({
 *   name: "send",
 *   channel: rooms,
 *   input: { body: input.text() },
 *   stack: [s.db.add({ table: messages, data: { room_id: inp("room_id"), body: inp("body") } })],
 * });
 * ```
 *
 * A path param is bound ONCE at join and read from the connection thereafter —
 * never from the frame — so a sender cannot claim a room it did not join. The
 * same values reach a channel `join`/`leave` trigger's stack, and ride the
 * realtime session as `session.params.<name>` (`s.realtime.get_session`).
 *
 * WHAT THE STACK RETURNS IS WHAT IS DELIVERED, and the three failure directions
 * are not symmetric:
 *
 *  - a RESPONSE is fanned out to `deliverTo` and, for `channel`/`others`, stored
 *    as the `conversation` transcript row — so broadcast everything a replayed
 *    message needs to render (author name, id, timestamp); nothing else comes back
 *  - a NULL response delivers NOTHING. This is the supported way for a handler to
 *    veto its own message; the sender is told it was dropped
 *  - a REJECTED PAYLOAD (the declared `input` refusing it) also delivers nothing,
 *    and the validation detail goes only to the sender
 *  - a CRASHED stack FAILS OPEN: the sender's ORIGINAL, UNVALIDATED payload is
 *    broadcast to the channel unchanged, so a bug cannot black-hole a channel.
 *    A handler that redacts, authorizes, or enriches must therefore not be the
 *    only thing between client input and subscribers
 *
 * A message names BOTH its channel and its server: a channel path is unique only
 * within a server, so the path alone cannot be resolved. Passing a
 * `realtimeChannel()` handle supplies both.
 */
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { resolveAuthRef } from "../refs/auth.js";
import type { AuthRef } from "../refs/auth.js";
import { deriveGuid, realtimeMessageSeedName } from "../refs/guid.js";
import { assertStoredName } from "./stored-name.js";
import {
  realtimeChannelGuid,
  realtimeServerRefName,
  resolveRealtimeServerRef,
  type RealtimeChannelDef,
  type RealtimeServerRef,
} from "./realtime-channel.js";
import { brandDef } from "./def-brand.js";

/**
 * A reference to the owning channel: a `realtimeChannel()` handle (which also
 * carries the server), or a bare channel path — in which case `server` must be
 * given alongside it.
 */
export type RealtimeChannelRef = string | RealtimeChannelDef;

/**
 * Who receives this handler's response:
 *  - `channel`  — everyone in the channel (the default)
 *  - `sender`   — only the sender (request/response over a socket)
 *  - `others`   — the channel minus the sender
 *  - `explicit` — nobody implicitly; the stack chooses the recipients
 */
export type MessageDeliverTo = "channel" | "sender" | "others" | "explicit";

/**
 * Generic over its input map `I` (so `InferInput` recovers the payload type),
 * over the branded stack tuple `S` and the literal response `Resp` (so
 * `InferResponse` can trace a ref back to the statement that bound it), and over
 * a declared `Res` (the `responseShape` override). All default, so every existing
 * use — a bare `RealtimeMessageDef` — works unchanged.
 *
 * Carrying `I` alone is not enough. A `Statement[]` stack is a widened
 * non-tuple, so no `as` binding in it is visible and every `ref()` in a
 * handler's response bottoms out — and with no `responseShape` field there is
 * no override either. That gap costs more here than on an HTTP kind: a realtime
 * client's whole data path is the socket (the transcript hydrates a joiner, so
 * there is deliberately no hydration endpoint to derive a shape from), which
 * makes the handler's response the ONLY type the client has.
 */
export interface RealtimeMessageDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
  C extends RealtimeChannelRef = RealtimeChannelRef,
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "message";
  /** The message type as addressed by clients, e.g. `"place_bid"`. */
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `<server>|<channel>|<name>`. */
  guid?: string;
  /**
   * The owning channel — a `realtimeChannel()` handle (preferred: it carries the
   * server too), or a bare channel path alongside an explicit `server`.
   */
  channel: C;
  /**
   * The owning realtime server. Required only when `channel` is a bare path; a
   * channel handle already names its server, and an explicit value here must
   * not contradict it.
   */
  server?: RealtimeServerRef;
  description?: string;
  /** Whether this message type is dispatchable. Defaults to `true`. */
  active?: boolean;
  /**
   * Auth for THIS message type, independent of the channel's join policy — a
   * channel may admit anonymous clients while a specific message still requires
   * a token. Name an auth **table** (a `table({ auth: true })` def or its name)
   * and it resolves to that table's guid; `false`/omitted means no auth.
   */
  auth?: AuthRef;
  /**
   * Who receives this handler's response. Defaults to `"channel"`.
   *
   * `"explicit"` hands recipient choice to the stack — and nothing can take it.
   * There is still no statement that SELECTS recipients from inside a handler, so
   * `"explicit"` delivers to nobody; prefer another value.
   *
   * `s.realtime.publish` is NOT the missing piece: it originates an event INTO a
   * channel from an ordinary stack (the push direction) and never chooses who a
   * handler's own response reaches.
   *
   * Only `"channel"` and `"others"` fan out, and ONLY THOSE TWO are written to
   * the channel's `conversation` transcript — a `"sender"` response is invisible
   * to every future joiner by construction.
   */
  deliverTo?: MessageDeliverTo;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"message">;
  /** The message PAYLOAD schema. Distinct from the channel's path parameters. */
  input?: I;
  /** Pre/post middleware wrapping `stack` — the same block a query carries. */
  middleware?: MiddlewareAttach;
  /**
   * The handler's statement stack. Captured as the literal tuple `S` (via
   * `realtimeMessage()`'s `const` inference) so `InferResponse` can trace a
   * response ref back to the branded `db.get`/`db.query` that bound it. A
   * dynamically-built `Statement[]` widens `S` and the trace degrades — declare
   * `responseShape` there.
   */
  stack?: S;
  /**
   * The broadcast payload: a single {@link Value} or a record of named values.
   * Captured as the literal `Resp` so `InferResponse` can derive its keys and,
   * with the branded stack, trace each member.
   *
   * ⚠ For `deliverTo: "channel"`/`"others"` this payload IS the stored
   * transcript row, so it must carry everything a replayed message needs to
   * render. Typing it is what lets a client catch a dropped field at compile
   * time instead of losing it irrecoverably from every past message.
   */
  response?: Resp;
  /**
   * Type-only: declare the broadcast payload's shape so `InferResponse<typeof
   * message>` recovers it exactly (the always-correct override, taking
   * precedence over automatic derivation). Use it for responses the static walk
   * can't see (filters, lambdas, control-flow vars, a widened stack). The
   * runtime value is ignored by `encodeRealtimeMessage`; only its type is read.
   */
  responseShape?: Res;
  /**
   * Request-history capture. Omit to inherit (channel → server → workspace).
   * Defaults **off** — message history is a hot path. A scalar: `false` off,
   * `true` on at default depth, a number = capture depth, `"all"` unlimited.
   */
  history?: HistoryInput;
  /** Soft-delete flag mirroring a query's. Defaults to `false`; prefer `active` to switch a message off. */
  disabled?: boolean;
  /** Workspace tags (stored `tag: [{tag}]`). */
  tags?: string[];
}

/**
 * Any message def, whatever its inputs/stack/response — the parameter type every
 * consumer that only READS a def wants (encoding, guid derivation, host
 * resolution). `Res` is widened to `unknown` rather than left at the `never`
 * default, which would reject a def that declares `responseShape`; the same
 * widening `encodeQuery` uses.
 */
export type AnyRealtimeMessageDef = RealtimeMessageDef<Record<string, InputDescriptor>, unknown>;

export interface RealtimeMessageXdo {
  name: string;
  description: string;
  active: boolean;
  /** The owning channel — `id` carries the resolved guid. */
  channel: { id: number | string };
  /** The owning server — `id` carries the resolved guid. */
  server: { id: number | string };
  /** `false` (no auth), the auth table's guid, or a raw numeric `dbo.id`. */
  auth: false | number | string;
  deliver_to: MessageDeliverTo;
  input: InputXdo[];
  output: unknown[];
  middleware: MiddlewareBlock;
  run: StackItemXdo[];
  result: ResultItemXdo[];
  history: { inherit: boolean; enabled: boolean; limit: number };
  disabled: boolean;
  tag: Array<{ tag: string }>;
}

/**
 * The channel path and server a message binds to, resolved once.
 *
 * A channel handle carries its own server; a bare path needs one supplied. An
 * explicit `server` alongside a handle must AGREE with the handle — silently
 * preferring one would bind the message to a channel that does not exist under
 * the other. Both the encoder and the guid derivation read this, so the identity
 * and the stored binding can never be composed from different hosts.
 */
function resolveHost(def: AnyRealtimeMessageDef): {
  channel: Pick<RealtimeChannelDef, "name" | "server" | "guid">;
  server: RealtimeServerRef;
  serverName: string;
} {
  const context = `realtimeMessage "${def.name}"`;
  if (!def.channel) throw new Error(`${context}: \`channel\` is required.`);

  const handle = typeof def.channel === "string" ? undefined : def.channel;
  if (!handle && def.server === undefined) {
    throw new Error(
      `${context}: \`server\` is required when \`channel\` is a bare path — a channel path is ` +
        `unique only within its realtime server, so "${def.channel as string}" alone is ambiguous. ` +
        `Pass the \`realtimeChannel()\` handle instead and the server comes with it.`,
    );
  }

  const server = (def.server ?? handle!.server)!;
  const serverName = realtimeServerRefName(context, server);
  if (handle && def.server !== undefined) {
    const fromHandle = realtimeServerRefName(context, handle.server);
    if (fromHandle !== serverName) {
      throw new Error(
        `${context}: \`server\` is "${serverName}" but the channel handle belongs to "${fromHandle}". ` +
          `Remove \`server\` (the handle already carries it) or bind the message to a channel on "${serverName}".`,
      );
    }
  }

  return {
    channel: handle ?? { name: def.channel as string, server },
    server,
    serverName,
  };
}

/** The guid a message def resolves to — composed from its server, channel path, and name. */
export function realtimeMessageGuid(def: AnyRealtimeMessageDef): string {
  if (def.guid) return def.guid;
  const { channel, serverName } = resolveHost(def);
  return deriveGuid("message", realtimeMessageSeedName(serverName, channel.name, def.name));
}

export function encodeRealtimeMessage(def: AnyRealtimeMessageDef): RealtimeMessageXdo {
  if (!def.name) throw new Error("realtimeMessage: `name` is required.");
  // Narrower than a channel path: a message name is not route-shaped, so the
  // engine stores no "/" or "{}" here. Same silent-NULL on violation.
  assertStoredName(`realtimeMessage "${def.name}"`, def.name, "plain");
  const host = resolveHost(def);
  const channelId = realtimeChannelGuid(host.channel);
  const serverId = resolveRealtimeServerRef(`realtimeMessage "${def.name}"`, host.server);
  return {
    name: def.name,
    description: def.description ?? "",
    active: def.active ?? true,
    channel: { id: channelId },
    server: { id: serverId },
    auth: resolveAuthRef("realtimeMessage", def.name, def.auth),
    deliver_to: def.deliverTo ?? "channel",
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    output: [],
    middleware: buildMiddlewareBlock(def.middleware),
    run: encodeStack("realtime message", def.name, def.stack),
    result: encodeResponse(def.response),
    history: encodeHistory("message", def.history),
    disabled: def.disabled ?? false,
    tag: encodeTags(def.tags),
  };
}

export const realtimeMessageKind: ObjectKind<AnyRealtimeMessageDef, RealtimeMessageXdo> = {
  name: "message",
  payloadKey: "message",
  encode: encodeRealtimeMessage,
  guidOf: (def) => realtimeMessageGuid(def),
};
registerKind(realtimeMessageKind);

/**
 * Author a realtime message handler — a named message type on a channel, with
 * its own validated payload and its own stack.
 *
 * The exact input map, stack tuple, and response are preserved on the return
 * type, so `InferInput<typeof msg>` types what a client SENDS and
 * `InferResponse<typeof msg>` types what it RECEIVES.
 */
export function realtimeMessage<
  const I extends Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  // Default `readonly []` (not `readonly Statement[]`), matching `query()`: an
  // OMITTED stack is an empty tuple — nothing to trace — while an explicitly
  // widened `Statement[]` keeps its widened type and is reported as the
  // tuple-collapse it is.
  const S extends readonly Statement[] = readonly [],
  // Captured so `InferResponse` types an `inp()` of a channel path param.
  C extends RealtimeChannelRef = RealtimeChannelRef,
>(def: RealtimeMessageDef<I, Res, Resp, S, C>): RealtimeMessageDef<I, Res, Resp, S, C> {
  return brandDef(def, "message");
}
