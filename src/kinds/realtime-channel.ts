/**
 * Realtime channel (`channel`) — the middle tier of
 * `realtime_server -> channel -> message`, the realtime analogue of an API
 * group.
 *
 * A channel is addressed by a PATH, not a plain name: `"rooms"` is one channel,
 * `"rooms/{room_id}"` is one channel per room whose `room_id` is bound and
 * validated at join time exactly as a query's path parameters are. Both may
 * coexist under one server, and a literal segment beats a parameter when a join
 * is matched — so `"rooms/lobby"` and `"rooms/{room_id}"` are two distinct
 * channels, not a conflict.
 *
 * Matching is STRICT, and each rule is a join that fails rather than a path that
 * gets fixed up: segment counts must be EQUAL, so `"rooms/{room_id}"` does not
 * match `"rooms/42/edit"` (which is what lets `"org/{org_id}/room/{room_id}"`
 * exist separately); literal segments are CASE-SENSITIVE; and an empty segment
 * is rejected rather than collapsed, so a leading, trailing, or doubled `/`
 * matches nothing — `realtimeChannel()` refuses such a path, and a `{param}`
 * that is not a whole segment. This is why `getChannel()` throws on an empty
 * param or one holding anything but letters, digits, `_` and `-` — the
 * alternative is a join refused for a reason the error message never mentions.
 *
 * The `input` map here types the channel PATH parameters. It is NOT the message
 * payload — that is `realtimeMessage({ input })`. Both reach the stack.
 *
 * A channel path is unique only WITHIN its server, so `server` is required and
 * is part of the channel's identity (see `realtimeChannelSeedName`).
 */
import type { InputXdo } from "../types/xdo.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import {
  encodeContainerHistory,
  type ContainerHistoryBlock,
  type HistoryInput,
} from "./history.js";
import { deriveGuid, noteHandleRef, realtimeChannelSeedName } from "../refs/guid.js";
import type { RealtimeServerDef } from "./realtime-server.js";
import {
  parsePathParams,
  assertPathParamInputs,
  fillPathParams,
  type IsStaticPath,
  type PathParamValues,
} from "./path-params.js";
import { assertStoredName } from "./stored-name.js";
import { brandDef } from "./def-brand.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";

/** A reference to the owning realtime server: its `realtimeServer()` handle, or its name. */
export type RealtimeServerRef = string | (Pick<RealtimeServerDef, "name"> & { guid?: string });

/** The name of the referenced server — the component channel/message identity is composed from. */
export function realtimeServerRefName(context: string, server: RealtimeServerRef): string {
  const name = typeof server === "string" ? server : server?.name;
  if (!name) {
    throw new Error(`${context}: \`server\` is required — a channel path is unique only within its realtime server.`);
  }
  return name;
}

/** Resolve the owning server reference to its guid (an explicit `guid` on the handle wins). */
export function resolveRealtimeServerRef(context: string, server: RealtimeServerRef): string {
  if (typeof server !== "string" && server?.guid) return server.guid;
  return deriveGuid("realtime_server", realtimeServerRefName(context, server));
}

/** Who may publish to a channel. */
export type ChannelPublishWho = "nobody" | "anyone" | "authenticated";

/**
 * Delivery guarantee. `at_least_once` changes the TRANSPORT — a briefly
 * disconnected client must not miss messages, which fire-and-forget pub/sub
 * cannot provide — so it is a meaningfully heavier setting than a flag.
 */
export type ChannelDeliveryGuarantee = "at_most_once" | "at_least_once";

export interface ChannelPublishDef {
  /** Who may publish. Defaults to `"nobody"` — nobody can publish until you set it. */
  who?: ChannelPublishWho;
  /**
   * Whether a client may send a DIRECT message — a broadcast frame carrying
   * `options.to = { dbo_id, row_id }`, addressing a USER by identity (`dbo_id`
   * is the auth table's id, as `s.realtime.get_session` reports it; `row_id`
   * the user's row id, text or number). It reaches every socket of that user
   * joined to the channel and no one else; the sender gets a receipt
   * `{ delivered_local, direct: true }`, not a copy. Defaults to `false`, which
   * refuses a direct frame (`Direct messaging is disabled`); an anonymous
   * sender is refused too.
   *
   * It REPLACES `who` for a direct frame rather than adding to it: `direct:
   * true` with `who: "nobody"` refuses ordinary broadcasts and delivers direct
   * messages. A direct message is never written to the transcript or the
   * `at_least_once` stream, so an offline user never receives it. ⚠ A frame
   * whose `options.to` names no usable identity is treated as an ordinary
   * broadcast — where `who` admits the sender it reaches the whole channel.
   */
  direct?: boolean;
}

/**
 * The client-visible TRANSCRIPT — "I just joined `rooms/42`, send me what was
 * already said". PUSHED to every joiner automatically; there is deliberately no
 * separate replay toggle and no fetch for the client to make.
 *
 * `limit` IS REQUIRED IN PRACTICE: `{ enabled: true }` alone records nothing and
 * replays nothing, silently. See `limit`.
 *
 * Distinct from `history` (EXECUTION history, for the debugger) and from
 * `delivery.guarantee`'s replay, which answers a different question — the
 * transcript is the SHARED "what was said before I arrived", while at-least-once
 * replay is the PER-CLIENT "what I missed while disconnected". Both may be on.
 */
export interface ChannelConversationDef {
  /**
   * Retain and replay a transcript. Defaults to `false`. Not sufficient on its
   * own — pair it with `limit`.
   */
  enabled?: boolean;
  /**
   * Messages retained, newest-capped. `0` (the default) retains NONE, which
   * makes `enabled: true` a no-op — the transcript is never written and never
   * replayed. Set it to the number of messages a joiner should see.
   */
  limit?: number;
  /**
   * Idle expiry for the WHOLE transcript, in seconds. `0` (the default) means no
   * expiry.
   *
   * Not a per-message age cap: every write refreshes the clock, so an active
   * channel's transcript never ages out, and when it does expire the entire
   * transcript is dropped at once rather than decaying oldest-first.
   *
   * On an `at_least_once` channel this same value ALSO bounds the durable replay
   * window — and there it does behave as a per-message age cut, taking priority
   * over `limit`. See `ChannelDeliveryDef.guarantee`.
   */
  ttl?: number;
}

export interface ChannelDeliveryDef {
  /**
   * Defaults to `"at_most_once"`.
   *
   * `"at_least_once"` IS A CLIENT CONTRACT, not just a channel setting. The
   * client must acknowledge what it receives (`{ action: "ack", channel, id }`),
   * and an ANONYMOUS client must also send a durable `options.client_id` in its
   * join frame — without one it has no cursor, its acks are ignored, and it
   * silently degrades to at-most-once. An authenticated client is keyed by its
   * identity and needs no `client_id`.
   *
   * The replay window is sized by `conversation.ttl`, else `conversation.limit`,
   * else 1000 messages — even on a channel with no transcript enabled.
   */
  guarantee?: ChannelDeliveryGuarantee;
  /**
   * Run the channel's `deliver` trigger once PER RECIPIENT — a stack on the hot
   * path, on every node that holds a recipient. Off by default; the cost is
   * real, and it is per recipient per message.
   *
   * Independent of `guarantee`. A no-op unless the channel actually declares a
   * `deliver` trigger — see `realtimeChannelTrigger({ actions: { deliver } })`,
   * whose return value decides per recipient.
   */
  perRecipient?: boolean;
}

export interface ChannelRateLimitDef {
  /**
   * `0` (the default) means unlimited. Counted per publishing client per
   * channel, and checked BEFORE the handler runs, so a throttled frame costs no
   * stack execution. The sender is refused with a `rate_limited` error carrying
   * `limit` and `retry_after`.
   *
   * A cost guardrail, not a security control: an ANONYMOUS client is bucketed
   * per connection, so reconnecting resets its budget, and the limiter fails
   * OPEN if its backing store is unavailable.
   */
  messagesPerMinute?: number;
}

export interface RealtimeChannelDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  N extends string = string,
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "channel";
  /**
   * The channel PATH, e.g. `"rooms"` or `"rooms/{room_id}"`. A `{param}`
   * segment makes the channel dynamic and MUST have a matching `input` entry
   * whose type is a SCALAR and not a list, or `realtimeChannel()` throws — the
   * same contract a query's URL path params carry. Unlike a query path, a
   * `{param}` must be a WHOLE segment (`rooms/{room_id}`, never
   * `rooms/room-{room_id}`), and no segment may be empty (no leading, trailing
   * or doubled `/`); `realtimeChannel()` throws on either. There are no
   * wildcards or patterns.
   *
   * `required: true` is NOT part of that contract and is not checked: path
   * matching is strict on segment count, so the segment is always present at
   * join time and an optional scalar declaration binds it fine.
   *
   * Captured as a literal so `getChannel(params)` types its keys from it.
   */
  name: N;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `<server>|<path>`. */
  guid?: string;
  /** The owning realtime server — a `realtimeServer()` handle, or its name. Required. */
  server: RealtimeServerRef;
  description?: string;
  /** Whether the channel accepts joins. Defaults to `true`. */
  active?: boolean;
  /**
   * Typed PATH parameters, bound at join time. Joining `"rooms/42"` against
   * `"rooms/{room_id}"` yields `room_id = 42`, coerced and validated by the
   * declared type. Distinct from a message's `input`, which types the payload.
   */
  input?: I;
  /**
   * Admit clients with no auth token. Defaults to `false`.
   *
   * It also decides the CONNECT: `realtimeServer()` has no anonymous flag of
   * its own, and a socket with no token is admitted only when at least one
   * ACTIVE channel of that server sets this. Each channel then admits its own
   * join, so a tokenless client that connected through one channel is still
   * refused by a channel that leaves this `false`.
   */
  anonymousClients?: boolean;
  /** Track and expose channel membership. Defaults to `false`. */
  presence?: boolean;
  publish?: ChannelPublishDef;
  conversation?: ChannelConversationDef;
  delivery?: ChannelDeliveryDef;
  rateLimit?: ChannelRateLimitDef;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"channel">;
  /**
   * Channel-level message-history default — the container tier this channel's
   * messages inherit (stored `message_enabled`/`message_limit`). Omit to
   * inherit from the server, then branch/workspace. Defaults **off**.
   */
  history?: HistoryInput;
  /**
   * Container-tier pre/post middleware — the default chain every message on this
   * channel inherits, exactly as an API group's is the default for its queries.
   * The full chain is message -> channel -> realtime server -> branch/workspace,
   * mirroring `history`. A channel that customizes neither phase falls to the server's block.
   *
   * Live-verified: a deployed workspace whose channel carries this block exports
   * back with it intact, the customize flag set on the phase that was given and
   * clear on the one that was not.
   *
   * Presence-preserving: omit it and the stored object carries no `middleware`
   * key at all, which is what an engine-captured channel has. Providing a phase
   * sets its `_customize` flag, so this tier stops inheriting the one above it;
   * `pre: middleware.clear()` customizes with nothing.
   *
   * Before this, a realtime auth or rate-limit guard had to be repeated on every
   * `realtimeMessage()` — the only realtime kind that took one.
   */
  middleware?: MiddlewareAttach;
  /** Workspace tags (stored `tag: [{tag}]`). */
  tags?: string[];
}

export interface RealtimeChannelXdo {
  name: string;
  description: string;
  active: boolean;
  /** The owning server — `id` carries the resolved guid (the engine remaps it on import). */
  server: { id: number | string };
  input: InputXdo[];
  anonymous_clients: boolean;
  presence: boolean;
  publish: { who: ChannelPublishWho; direct: boolean };
  conversation: { enabled: boolean; limit: number; ttl: number };
  delivery: { guarantee: ChannelDeliveryGuarantee; per_recipient: boolean };
  rate_limit: { messages_per_minute: number };
  history: ContainerHistoryBlock<"message">;
  /** Written only when the def provides one — an engine-captured channel has no such key. */
  middleware?: MiddlewareBlock;
  tag: Array<{ tag: string }>;
}

export function encodeRealtimeChannel(def: RealtimeChannelDef): RealtimeChannelXdo {
  if (!def.name) throw new Error("realtimeChannel: `name` is required (the channel path).");
  const context = `realtimeChannel "${def.name}"`;
  // The backstop for a hand-built def, mirroring `encodeQuery` — the factory
  // checks the same contract at authoring time.
  assertChannelPathParams(def);
  return {
    name: def.name,
    description: def.description ?? "",
    active: def.active ?? true,
    server: { id: resolveRealtimeServerRef(context, def.server) },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    anonymous_clients: def.anonymousClients ?? false,
    presence: def.presence ?? false,
    publish: {
      who: def.publish?.who ?? "nobody",
      direct: def.publish?.direct ?? false,
    },
    conversation: {
      enabled: def.conversation?.enabled ?? false,
      limit: def.conversation?.limit ?? 0,
      ttl: def.conversation?.ttl ?? 0,
    },
    delivery: {
      guarantee: def.delivery?.guarantee ?? "at_most_once",
      per_recipient: def.delivery?.perRecipient ?? false,
    },
    rate_limit: { messages_per_minute: def.rateLimit?.messagesPerMinute ?? 0 },
    history: encodeContainerHistory("message", def.history),
    ...(def.middleware !== undefined ? { middleware: buildMiddlewareBlock(def.middleware) } : {}),
    tag: encodeTags(def.tags),
  };
}

export const realtimeChannelKind: ObjectKind<RealtimeChannelDef, RealtimeChannelXdo> = {
  name: "channel",
  payloadKey: "channel",
  encode: encodeRealtimeChannel,
  guidOf: (def) => realtimeChannelGuid(def),
};
registerKind(realtimeChannelKind);

/** The `{param}` segment names in a channel path, in order (`[]` for a static path). */
export function channelPathParams(path: string): string[] {
  return parsePathParams(`realtimeChannel "${path}"`, path);
}

/**
 * Validate the channel path against its input map and return the `{param}` names
 * it declares. Shared by `realtimeChannel()` (authoring time) and
 * `encodeRealtimeChannel` (the backstop) — the same contract, and the same
 * helper, a query's URL path params use.
 */
function assertChannelPathParams(def: Pick<RealtimeChannelDef, "name" | "input">): string[] {
  const context = `realtimeChannel "${def.name}"`;
  // Same stored charset as a query name, and the same silent-NULL on violation.
  // It bites harder here: a channel name becomes a pub/sub key segment.
  assertStoredName(context, def.name, "route");
  assertChannelSegments(context, def.name);
  const params = parsePathParams(context, def.name);
  assertPathParamInputs(context, params, def.input);
  return params;
}

/**
 * Refuse a path the engine's join matching can never match: an empty segment
 * (a leading, trailing or doubled `/`) and a `{param}` that is not a whole
 * segment — `"rooms/x{room_id}"` is the LITERAL segment `x{room_id}`, so no
 * joined path matches it.
 */
function assertChannelSegments(context: string, name: string): void {
  const segments = name.split("/");
  if (segments.includes("")) {
    const fixed = segments.filter((seg) => seg !== "").join("/");
    throw new Error(
      `${context}: a channel path cannot have an empty segment (a leading, trailing or doubled "/") — the ` +
        `join matching rejects it rather than collapsing it, so no client could ever join this channel. ` +
        (fixed ? `Write "${fixed}".` : `Name the channel, e.g. "lobby".`),
    );
  }
  const partial = segments.find((seg) => /[{}]/.test(seg) && !/^\{[^/{}]+\}$/.test(seg));
  if (partial !== undefined) {
    throw new Error(
      `${context}: the segment "${partial}" embeds a {param} — in a channel path a {param} must be the WHOLE ` +
        `segment ("rooms/{room_id}"). Anything else is matched as literal text, so no joined path would match ` +
        `it. Make the param its own segment, e.g. "rooms/x/{room_id}".`,
    );
  }
}

/**
 * A `realtimeChannel()` handle: the def plus `getChannel()`, which resolves the
 * path a client actually joins. The accessor is dropped by `JSON.stringify` and
 * ignored by `encodeRealtimeChannel`, so serialization is unaffected.
 */
export type RealtimeChannelHandle<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  N extends string = string,
> = RealtimeChannelDef<I, N> & {
    /**
     * The concrete channel path to put in a frame's `channel` field —
     * `{param}` segments filled from `params` (`"rooms/{room_id}"` +
     * `{ room_id: 42 }` → `"rooms/42"`). A static path needs no argument, and a
     * parameterized one REQUIRES the params, typed to exactly its segments.
     * Throws on a missing, empty, or unknown param, and on a value outside
     * letters, digits, `_` and `-` — the only characters a joined channel
     * name may hold (a `/` would also fabricate a segment and join a
     * different channel).
     *
     * IN A BROWSER BUNDLE, prefer the generated manifest's `channelPath()`
     * (`xanosdk routes <entry> --emit`): identical output and the same
     * compile-time param checking, in a file that imports no SDK runtime.
     */
    getChannel: IsStaticPath<N> extends true
      ? (params?: Record<string, never>) => string
      : (params: PathParamValues<N>) => string;
  };

/**
 * Author a realtime channel — a joinable path on a realtime server that owns
 * message handlers. Returns a {@link RealtimeChannelHandle}: the def plus
 * `getChannel()`.
 *
 * Pass the returned handle (not a bare path) to `realtimeMessage({ channel })`:
 * the handle carries the owning server, so the message resolves both refs
 * without repeating it.
 */
export function realtimeChannel<
  const I extends Record<string, InputDescriptor>,
  const N extends string = string,
>(def: RealtimeChannelDef<I, N>): RealtimeChannelHandle<I, N> {
  // Fail on the line the author wrote: a {param} with no matching SCALAR input
  // is a channel nobody can join with a bound value. `required` is not part of
  // this check — the segment is always supplied by the path that matched.
  assertChannelPathParams(def as RealtimeChannelDef);
  const context = `realtimeChannel "${def.name}"`;
  const getChannel = (params?: Record<string, string | number>): string =>
    fillPathParams(context, "getChannel()", def.name, params);
  return brandDef({ ...def, getChannel } as RealtimeChannelHandle<I, N>, "channel");
}

/** The guid a channel def resolves to — composed from its server and its path. */
export function realtimeChannelGuid(def: Pick<RealtimeChannelDef, "name" | "server" | "guid">): string {
  // Always a def: a channel is bound by its handle, never by a bare name.
  const guid =
    def.guid ||
    deriveGuid("channel", realtimeChannelSeedName(realtimeServerRefName(`realtimeChannel "${def.name}"`, def.server), def.name));
  noteHandleRef(guid);
  return guid;
}
