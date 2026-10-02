/**
 * Realtime server (`realtime_server`) — the top-level container of Xano's
 * realtime layer, and the root of the containment chain
 * `realtime_server -> channel -> message` (the realtime analogue of
 * `api_group -> query` and `mcp_server -> tool`).
 *
 * A realtime server is branch-scoped and canonical-addressed like an API group,
 * so a workspace may own several of them and each round-trips through
 * export/import as its own object. Its existence is what marks a workspace as
 * using the current realtime layer — there is no `mode` field and no version
 * discriminator.
 *
 * Clients dial it at `wss://<instance host>/ws/<canonical>` — derive that with
 * `realtimeServer().getUrl(baseUrl)` rather than hardcoding it, and see
 * {@link RealtimeServerHandle} for the frame protocol that follows the
 * handshake.
 *
 * Two engine details this encoder honors and that are easy to get wrong:
 *  - `enabled` defaults to **false**, unlike almost every other `enabled` field
 *    in the SDK. A server you author is off until you turn it on.
 *  - `history` is the *container* tier its channels' messages inherit
 *    (`message_enabled`/`message_limit`) and it defaults **off** — message
 *    history is a hot path.
 *
 * Deploys like any other object: the workspace archive carries realtime sections,
 * and the round trip is verified against a live engine — the server, its channels,
 * and its messages import, read back, and re-resolve their cross-references to the
 * imported rows. The three encoders are byte-verified against engine-captured
 * goldens.
 */
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
import { resolveCanonicalToken } from "./canonical.js";
import { assertCanonical } from "./stored-name.js";
import { brandDef } from "./def-brand.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";

export interface RealtimeServerDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "realtime_server";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  /**
   * Whether the server accepts connections. Defaults to **false** — a realtime
   * server is off until explicitly enabled. An enabled server with no active
   * channel still refuses the handshake, so ship at least one
   * `realtimeChannel()` with it.
   */
  enabled?: boolean;
  /**
   * The public URL token this server is addressed by. Omit and it is minted and
   * frozen in `xano.lock` at `xanosdk export <entry>`; set it explicitly to pin
   * one. Never generated at encode time — a canonical must be unique per Xano
   * instance across all workspaces.
   */
  canonical?: string;
  /**
   * Server-level message-history default — the container tier this server's
   * channels' messages inherit (stored `message_enabled`/`message_limit`). Omit
   * to inherit from the branch/workspace. Defaults **off**: message history is a
   * hot path. A scalar: `false` off, `true` on at default depth, a number =
   * capture depth, `"all"` unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * Container-tier pre/post middleware — the default chain every message on this
   * server inherits, exactly as an API group's is the default for its queries.
   * The full chain is message -> channel -> realtime server -> branch/workspace,
   * mirroring `history`. A server that customizes neither phase falls to branch/workspace.
   *
   * Live-verified: a deployed workspace whose server carries this block exports
   * back with it intact, the customize flag set on the phase that was given and
   * clear on the one that was not.
   *
   * Presence-preserving: omit it and the stored object carries no `middleware`
   * key at all, which is what an engine-captured server has. Providing a phase
   * sets its `_customize` flag, so this tier stops inheriting the one above it;
   * `pre: middleware.clear()` customizes with nothing.
   *
   * Before this, a realtime auth or rate-limit guard had to be repeated on every
   * `realtimeMessage()` — the only realtime kind that took one.
   */
  middleware?: MiddlewareAttach;
  /** Workspace tags (stored `tag: [{tag}]`). */
  tags?: string[];
  /** Accepted export warnings — a server off on purpose. Never emitted. */
  diagnostics?: DiagnosticsFor<"realtime_server">;
}

/**
 * The stored envelope. Note there is deliberately no `docs` key: unlike
 * `app`/`query`/`toolset`, the realtime objects do not persist one — the
 * XanoScript kind accepts `docs` but the stored record has no such field, so
 * emitting it would add a key the engine never wrote.
 */
export interface RealtimeServerXdo {
  name: string;
  description: string;
  canonical: string;
  enabled: boolean;
  history: ContainerHistoryBlock<"message">;
  /** Written only when the def provides one — an engine-captured server has no such key. */
  middleware?: MiddlewareBlock;
  tag: Array<{ tag: string }>;
}

/**
 * Resolve a realtime server's `canonical` URL token, in priority order:
 * an explicit override, the def's own non-empty `canonical`, then the value
 * minted-and-frozen in `xano.lock` under `realtime_server:<name>`.
 *
 * Deliberately never mints: a canonical must be unique per Xano *instance
 * across all workspaces*, so the only safe place to generate one is
 * an ordinary `xanosdk export` (random, collision-checked, then frozen so every later export
 * and every client agrees). Mirrors the api-group and toolset resolvers.
 */
export function resolveRealtimeServerCanonical(
  def: { name: string; canonical?: string },
  override?: string,
): string {
  return resolveCanonicalToken("realtime server", "realtime_server", "getCanonical", def, override);
}

export function encodeRealtimeServer(def: RealtimeServerDef): RealtimeServerXdo {
  if (!def.name) throw new Error("realtimeServer: `name` is required.");
  assertCanonical(`realtimeServer "${def.name}"`, def.canonical);
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    enabled: def.enabled ?? false,
    history: encodeContainerHistory("message", def.history),
    ...(def.middleware !== undefined ? { middleware: buildMiddlewareBlock(def.middleware) } : {}),
    tag: encodeTags(def.tags),
  };
}

export const realtimeServerKind: ObjectKind<RealtimeServerDef, RealtimeServerXdo> = {
  name: "realtime_server",
  payloadKey: "realtime_server",
  encode: encodeRealtimeServer,
};
registerKind(realtimeServerKind);

/** Options for {@link RealtimeServerHandle.getPath}/`getUrl`/`getCanonical`. */
export interface RealtimeUrlOptions {
  /** Override the resolved `canonical` URL token (bypasses the def/lock lookup). */
  canonical?: string;
  /**
   * Address a TENANT's isolated database instead of the instance's own
   * workspace. Rides as a `<tenant>:<canonical>` prefix on the socket path; the
   * websocket tier splits on the FIRST `:`, applies the tenant's database, and
   * only THEN resolves the canonical — so a bare canonical on a tenant host is
   * looked up in the instance workspace instead, which either misses or serves a
   * different workspace's channels. Omit for a normal (non-tenant) instance.
   *
   * This colon form is PECULIAR TO THE SOCKET: the tenant is glued to the
   * canonical inside ONE path segment, whereas every other tenant-addressed URL
   * gives it a segment of its own — the HTTP half of the same client is
   * `https://<host>/tenant/<tenant>/api:<canonical>/…`. Neither is derivable
   * from the other, and no request header is required for either. That both
   * halves must name it matters because **tokens are tenant-scoped**: a realtime
   * token carries the audience
   * `<tenant>:<license>` rather than the bare license, so one minted through the
   * instance workspace is rejected by a tenant's realtime server (and vice
   * versa). Authenticate and dial through the same tenant.
   *
   * OFTEN YOU CAN OMIT THIS: `getUrl` LIFTS the tenant out of a base URL that
   * already names one (`https://<host>/tenant/<name>` — what `xanosdk sandbox
   * details` prints and what deploy injects as `window.XANO_HOST`), rewriting it
   * to the socket's colon form. Pass it explicitly when the base URL does NOT
   * name the tenant — notably a tenant on its own domain, where HTTP resolves
   * the tenant from the hostname but the socket cannot (the connection hash is
   * the websocket tier's only signal).
   */
  tenant?: string;
}

/** Reject a tenant name that would break the `<tenant>:<canonical>` split. */
function assertTenant(tenant: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tenant)) {
    throw new Error(
      `realtime server: invalid \`tenant\` ${JSON.stringify(tenant)} — a tenant name is alphanumeric with dashes ` +
        `(e.g. "xxxx-xxxx-xxxx"). It rides as a "<tenant>:<canonical>" prefix, so ":" and "/" cannot appear in it.`,
    );
  }
  return tenant;
}

/**
 * A base URL that already ends in `/ws/<something>` is this function's OWN
 * output fed back in — the shape `getPath()` appends, and nothing an instance
 * base URL ever carries. Appending a second `/ws/<canonical>` produces a URL
 * wrong twice over: the trailing segments join the connection hash, and the
 * re-resolved half has no `/tenant/<name>` left to lift (the first call consumed
 * it), so the tenant is silently dropped too. Both failures surface far away
 * from the call site — the engine reports a workspace-level toggle that this
 * path never consults — so refuse here, where the mistake is unambiguous.
 */
function assertNotResolvedSocketBase(fn: string, socketBase: string, given: string): void {
  if (!/\/ws\/[^/]+$/i.test(socketBase)) return;
  // Echo what the CALLER passed, not the scheme-normalized form — the normalized
  // string appears nowhere in their code.
  throw new Error(
    `realtime server: \`${fn}\` was given a base URL that already carries a socket path ` +
      `(${given}). Pass the http(s) INSTANCE base URL, not the result of a previous ` +
      `getUrl()/socketUrl() — resolving twice appends a second "/ws/<canonical>" and drops the tenant.`,
  );
}

/**
 * A base URL carrying a query, a fragment, or an API group's `/api:<…>`
 * segment is not an instance base URL: the socket path is appended after it,
 * so `https://h?x=1` built `wss://h?x=1/ws/<canonical>` (the socket path inside
 * the query) and `https://h/api:abc` a socket under the API group's path —
 * neither reaches the server.
 */
function assertInstanceBase(fn: string, given: string): void {
  const problem = /[?#]/.test(given)
    ? "a query or fragment"
    : /\/api:/i.test(given)
      ? "an API group's /api:<…> path"
      : undefined;
  if (problem === undefined) return;
  throw new Error(
    `realtime server: \`${fn}\` was given a base URL with ${problem} (${given}). Pass the INSTANCE base URL — ` +
      `"https://<host>", or "https://<host>/tenant/<name>" — and the socket path is appended to it.`,
  );
}

/**
 * Lift a `/tenant/<name>` prefix off a base URL into the socket's tenant slot.
 *
 * A tenant's public base URL names the tenant as its OWN leading path segment
 * (`https://<host>/tenant/<name>`) — the value `xanosdk sandbox details` prints
 * and deploy injects as `window.XANO_HOST`. The socket spells the same tenant
 * differently: glued to the canonical inside one segment. Left alone, that base
 * URL yields `wss://<host>/tenant/<name>/ws/<canonical>`, which is wrong twice —
 * no tenant is applied, AND the leftover segments are read as part of the
 * connection hash, so the canonical does not resolve either. Verified live: that
 * URL never upgrades at all, the handshake is answered with a plain 404. So we
 * translate instead.
 */
function liftTenantFromBase(
  socketBase: string,
  explicit: string | undefined,
): { base: string; tenant: string | undefined } {
  const m = /^(wss?:\/\/[^/]+)\/tenant\/([^/]+)(\/.*)?$/i.exec(socketBase);
  if (!m) return { base: socketBase, tenant: explicit };
  // Groups 1 and 2 are not optional in the pattern — a match always has them.
  const origin = m[1] as string;
  const fromBase = m[2] as string;
  const rest = m[3] ?? "";
  if (explicit !== undefined && explicit !== fromBase) {
    throw new Error(
      `realtime server: \`getUrl\` was given tenant ${JSON.stringify(explicit)} but the base URL names ` +
        `${JSON.stringify(fromBase)} (".../tenant/${fromBase}"). Refusing to guess which one you meant — pass the ` +
        `matching tenant, or a base URL without the "/tenant/<name>" prefix.`,
    );
  }
  return { base: `${origin}${rest}`, tenant: assertTenant(fromBase) };
}

/**
 * A `realtimeServer()` handle: the def plus `getCanonical()` and the websocket
 * connection accessors `getPath()`/`getUrl()`, so a client derives its socket
 * URL from the def instead of hardcoding it (the same derive-don't-hardcode
 * contract `query.getPath()` and `mcpServer().getUrl()` give). The accessors are
 * dropped by `JSON.stringify` and ignored by `encodeRealtimeServer`, so
 * serialization is unaffected (mirrors {@link McpServerHandle}).
 *
 * WIRE PROTOCOL (what to do once the socket is open), for reference:
 *  - Auth is a bearer token carried as the websocket SUBPROTOCOL
 *    (`new WebSocket(url, token)` — `Sec-WebSocket-Protocol`), not a query
 *    param. No token = an anonymous client, admitted only by channels with
 *    `anonymousClients: true`.
 *  - The server builds its context during the handshake; a frame sent
 *    immediately after `open` can be refused as not-ready. Wait out a short
 *    settle window before the first frame — there is no explicit ready frame.
 *  - KEEP IT ALIVE. An idle connection is reaped after ~10 minutes, so a
 *    LISTEN-ONLY client (a feed, a dashboard — anything that subscribes and
 *    rarely publishes) must send something periodically or it is disconnected.
 *    `{ action: "ping" }` answers `{ action: "pong" }` and exists for exactly
 *    this; any frame resets the clock.
 *  - Client frames are JSON `{ action, channel, type?, payload?, options?, id? }`
 *    where `action` is `join` | `leave` | `broadcast` | `ack` | `ping` |
 *    `presence`, `channel` is the resolved channel path
 *    (`realtimeChannel().getChannel()`) and `type` is the `realtimeMessage()`
 *    name. You must `join` before you may `broadcast`. `options` carries
 *    `{ to?, client_id?, channel? }` — `to: { dbo_id, row_id }` sends a DIRECT
 *    message to one user (needs `publish.direct`), `client_id` is the
 *    at-least-once cursor handle (below), and `options.channel` wins over a
 *    top-level `channel`.
 *  - Server frames carry `action`: `join` (ack — `{ joined: true, params }`, plus
 *    `cursor`/`resumed` on an `at_least_once` channel), `message`, `replay`,
 *    `broadcast` (a RECEIPT to the sender: `delivered_local` counts recipients on
 *    the answering node only, NOT the channel, plus `id` on an at-least-once
 *    channel and `dropped: true` when the handler returned null),
 *    `presence_full`/`presence_join`/`presence_leave`,
 *    `conversation_start`/`conversation_end` (replayed transcript frames are
 *    flagged `conversation: true` so they are distinguishable from live
 *    traffic), `pong`, `ack`, and `error`.
 *  - `replay` and the `conversation_*` frames answer DIFFERENT questions and can
 *    both be on: the transcript is the SHARED "what was said before I arrived"
 *    (replayed as ordinary `message` frames), while `replay` is the PER-CLIENT
 *    "what I missed while disconnected", resumed from this client's own cursor.
 *  - AT-LEAST-ONCE IS A CLIENT CONTRACT. On such a channel, ack what you receive
 *    with `{ action: "ack", channel, id }`; the server confirms with
 *    `{ action: "ack", channel, payload: { cursor } }`, and the next reconnect
 *    replays only what follows that cursor. An ANONYMOUS client must also send a
 *    durable `options.client_id` in its JOIN frame — without one it has no cursor,
 *    its acks are ignored silently, and it degrades to at-most-once. An
 *    authenticated client is keyed by identity and needs no `client_id`.
 *  - `error` carries `payload.message`, plus `payload.code` /
 *    `payload.limit` / `payload.retry_after` when rate limited (`rate_limited` is
 *    the only code — the rest are message-only, so do not switch on `code`). An
 *    `error` is a per-frame refusal, NOT a disconnect — EXCEPT for a failed
 *    handshake and a refused `connect` trigger, which each push an `error` and
 *    then close with code 4401.
 *  - PRESENCE frames (only on a `presence: true` channel) carry a roster:
 *    `presence_full` → `payload.members` (an ARRAY — the one sent at join
 *    EXCLUDES the receiving client, so the first joiner gets `[]`; the one a
 *    `{ action: "presence" }` re-request answers includes it),
 *    `presence_join`/`presence_leave` → `payload.member` (a single entry). A member is
 *    `{ id, dbo_id, authenticated, extras, joined_at }` — `id` is the auth row id
 *    as a string (`"0"` for an anonymous client), `dbo_id` the auth table's id
 *    (`0` when anonymous), `extras` the connection's extras (`[]` when none), `joined_at`
 *    epoch SECONDS. Render the roster from `presence_full` and apply the deltas;
 *    the count is members, not connections — the roster is refcounted per
 *    identity, so a second tab of the same user fires no second `presence_join`.
 *    Order on join is: `join` ack → `presence_full` → (others see
 *    `presence_join`) → conversation replay. A joined client can re-request the
 *    snapshot at any time by sending `{ action: "presence", channel }`; it
 *    answers with `presence_full`, or an `error` if you never joined. The full
 *    join order, with everything optional included, is: `join` ack →
 *    `presence_full` → (others see `presence_join`) → conversation replay →
 *    `replay` frames.
 */
export type RealtimeServerHandle = RealtimeServerDef & {
  /** The server's resolved `canonical` token; throws if none resolves. */
  getCanonical(opts?: { canonical?: string }): string;
  /**
   * The websocket connection PATH — `/ws/<canonical>`, or
   * `/ws/<tenant>:<canonical>` when `tenant` is given — ready to prepend a host
   * to. The `canonical` is resolved from the def's `canonical` (or
   * `opts.canonical`, or the value frozen in `xano.lock`); it throws if none
   * resolves.
   */
  getPath(opts?: RealtimeUrlOptions): string;
  /**
   * The absolute websocket URL — `baseUrl` + {@link getPath}, with the scheme
   * normalized to `ws`/`wss` (`https://x.xano.io` → `wss://x.xano.io/ws/…`), so
   * the instance base URL you already have can be passed straight in.
   *
   * A remote host must end up `wss://`: instances do not serve plain websockets
   * and browsers block a `ws://` socket from an https page — both surface as an
   * opaque 1006 close with no reason. Pass the instance base URL (`https://…`,
   * or `wss://…`); this is the only form `getUrl` builds.
   *
   * A base URL that already names a tenant (`https://<host>/tenant/<name>` —
   * `xanosdk sandbox details`' `baseUrl`, and the injected `window.XANO_HOST`)
   * has that tenant LIFTED into the socket's own form, so
   * `getUrl(window.XANO_HOST)` alone reaches the right database:
   * `https://h/tenant/ab-cd` → `wss://h/ws/ab-cd:<canonical>`. Passing a
   * DIFFERENT `{ tenant }` alongside such a base URL throws rather than picks a
   * winner. NOT IDEMPOTENT BY DESIGN: a `baseUrl` that already carries a
   * `/ws/<…>` path (an earlier `getUrl()`/`socketUrl()` result) THROWS —
   * resolving twice would append a second `/ws/<canonical>` and drop the tenant.
   * A tenant served on its own domain has nothing to lift — HTTP
   * resolves that tenant by hostname, but the websocket tier only ever reads the
   * connection hash — so pass `{ tenant }` explicitly there.
   *
   * IN A BROWSER BUNDLE, prefer the generated manifest: importing this def for
   * its `getUrl()` pulls the SDK runtime in with it (the same ~267 kB floor a
   * query def costs — the factory CALLS that build the def run at module load).
   * `xanosdk routes <entry> --emit xano/routes.gen.ts` writes the identical
   * address, tenant lift included, as `socketUrl("<server>", baseUrl)` in a file
   * that imports nothing.
   *
   * `/ws` is the INSTANCE INGRESS's routing segment, stripped before the
   * websocket tier sees the path — the tier reads whatever remains, whole, as
   * the connection hash. That matters in exactly one case: a direct dial at a
   * local dev websocket port bypasses the ingress, so it wants the hash ALONE
   * (`ws://127.0.0.1:<port>/<canonical>`) and `getUrl`'s `/ws/` segment would be
   * read as part of the hash and fail to resolve. Build that dev URL by hand
   * from {@link getCanonical}; every deployed host takes `getUrl`.
   */
  getUrl(baseUrl: string, opts?: RealtimeUrlOptions): string;
};

/**
 * Author a realtime server — the container that owns realtime channels.
 * Returns a {@link RealtimeServerHandle}: the def plus `getCanonical()` and
 * `getPath()`/`getUrl()`.
 *
 * Pass the handle (not a bare name) to `realtimeChannel({ server })` so the
 * channel and the server agree on identity even when the server pins an
 * explicit `guid`.
 */
export function realtimeServer(def: RealtimeServerDef): RealtimeServerHandle {
  const getCanonical = (opts?: { canonical?: string }): string =>
    resolveRealtimeServerCanonical(def, opts?.canonical);
  const getPath = (opts?: RealtimeUrlOptions): string => {
    const canonical = getCanonical(opts);
    const prefix = opts?.tenant ? `${assertTenant(opts.tenant)}:` : "";
    return `/ws/${prefix}${canonical}`;
  };
  const getUrl = (baseUrl: string, opts?: RealtimeUrlOptions): string => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("realtimeServer: `getUrl` needs a base URL (e.g. \"https://x.dev.xano.io\").");
    // http(s) is what a caller has on hand (the instance base URL); ws(s) is
    // what a socket needs. A scheme-less host is assumed secure — the only
    // scheme a deployed instance accepts.
    const socketBase = /^wss?:\/\//i.test(base)
      ? base
      : /^https?:\/\//i.test(base)
        ? base.replace(/^http/i, "ws")
        : `wss://${base}`;
    assertNotResolvedSocketBase("getUrl", socketBase, base);
    assertInstanceBase("getUrl", base);
    // A tenant base URL names its tenant in a shape the socket does not use;
    // translate rather than concatenate. See liftTenantFromBase.
    const lifted = liftTenantFromBase(socketBase, opts?.tenant);
    return `${lifted.base}${getPath({ ...opts, tenant: lifted.tenant })}`;
  };
  return brandDef({ ...def, getCanonical, getPath, getUrl }, "realtime_server");
}
