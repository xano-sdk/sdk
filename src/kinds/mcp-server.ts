/**
 * MCP server (`mcp_server`) — a first-class root primitive: a collection of
 * tools exposed over the MCP protocol. Persists as `obj_type=toolset` with
 * `type:"mcp"` (verified against the Xano engine's stored mcp_server format),
 * so it shares the `toolset` payload
 * section and the `md5("toolset:"+name)` guid with agents (see the note in
 * `xano.ts`/`refs/guid.ts` about the shared identity namespace).
 *
 * Authoring surface = the shared {@link encodeToolsetBase} envelope
 * (name/description/instructions/docs/enabled/canonical/spec/tags/tools). There
 * is deliberately **no** server-level `authentication` field: Xano's MCP server
 * has none — auth is per-tool (`tool[].auth`, see {@link ToolsetToolRef}). There
 * is also no toolset-level `middleware`: the engine runs middleware per-tool,
 * not per-toolset (module header in `toolset.ts`).
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodePrimitiveRefs, encodeToolsetBase, resolveToolsetCanonical } from "./toolset.js";
import type { McpPrimitiveEntry, McpPrimitiveXdo } from "./toolset.js";
import { buildAgentSettings } from "./agent.js";
import type { AgentOutput, AgentSettingsXdo, LlmSettings } from "./agent.js";
import type { ToolsetBaseDef, ToolsetBaseXdo } from "./toolset.js";
import { brandDef } from "./def-brand.js";
import { encodeMcpOauth } from "./mcp-oauth.js";
import type { McpOauth, McpOauthXdo } from "./mcp-oauth.js";

/**
 * MCP server authoring def — the shared toolset envelope, plus the optional LLM
 * block.
 *
 * `agent` and `mcpServer` are two authoring surfaces over ONE stored
 * `mvp_toolset` row, distinguished only by `type`, so an MCP server can hold the
 * same `agent_settings` an agent does — and real ones do. `llm` stays optional
 * and is written only when authored, so an MCP server that does not set it
 * emits exactly the bytes it always has.
 */
export type McpServerDef = ToolsetBaseDef & {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "mcp_server";
  /** Typed LLM settings (provider + model + generation config), when this server carries them. */
  llm?: LlmSettings;
  /** Optional structured output schema, paired with {@link llm}. */
  output?: AgentOutput;
  /**
   * The prompts this server exposes: `prompt()` handles (or names), or a
   * `{ prompt, enabled?, auth? }` wrapper. An agent has no prompts — they are an
   * MCP server feature. See {@link McpPrimitiveEntry}.
   */
  prompts?: McpPrimitiveEntry<"prompt">[];
  /**
   * The resources this server exposes: `resource()` handles (or names), or a
   * `{ resource, enabled?, auth? }` wrapper. Two resources with the same `uri`
   * on one server are refused. See {@link McpPrimitiveEntry}.
   */
  resources?: McpPrimitiveEntry<"resource">[];
  /**
   * Per-server sign-in. Omit for a server whose tools gate per entry (`auth` on
   * a tool/prompt/resource entry) — exactly as before. With it, every MCP
   * request needs an OAuth access token, and the signed-in `authTable` row is
   * the caller everywhere on the server.
   *
   * `{ mode: "hosted", authTable, loginUrl }`: the platform is the
   * authorization server and sends the client to `loginUrl`, your page, which
   * finishes with `s.mcp.oauth.complete`. `{ mode: "external", authTable,
   * issuer, column }`: your identity provider issues tokens; the `claim`
   * (default `sub`) is matched against `column`. `loginUrl`/`issuer`/`audience`
   * take `env("NAME")`. See {@link McpOauth}.
   */
  oauth?: McpOauth;
};

/** Options for {@link McpServerHandle.getPath}/`getUrl`. */
export interface McpPathOptions {
  /** Override the resolved `canonical` URL token (bypasses the def/lock lookup). */
  canonical?: string;
  /**
   * The URL-embedded auth token path segment. Defaults to `"mcp"` — the literal
   * placeholder the endpoint treats as "no URL token", meaning auth is passed via
   * the `Authorization: Bearer …` header instead. Pass a token to embed auth in
   * the path.
   */
  token?: string;
  /**
   * The tenant whose workspace serves this MCP server. Rides as its own
   * `tenant/<name>` pair AFTER the `/x2/mcp` prefix and BEFORE the canonical —
   * `/x2/mcp/tenant/<tenant>/<canonical>/<token>/stream`. That is not where a
   * tenant's public base URL carries it: there it is a LEADING path segment
   * (`https://<host>/tenant/<name>`, what `xanosdk sandbox details` prints and
   * deploy injects as `window.XANO_HOST`), so concatenating the two yields
   * `https://<host>/tenant/<name>/x2/mcp/<canonical>/…`, a path the endpoint does
   * not register and which answers 404.
   *
   * OFTEN YOU CAN OMIT THIS: `getUrl` LIFTS the tenant out of a base URL that
   * already names one and re-places it after the prefix, so
   * `getUrl(window.XANO_HOST)` alone reaches the right database. Pass it
   * explicitly only when the base URL cannot name the tenant — notably a tenant
   * on its own domain, where the host header carries it instead.
   */
  tenant?: string;
}

/** Reject a tenant name that would smuggle extra path segments into the URL. */
function assertTenant(tenant: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tenant)) {
    throw new Error(
      `mcp server: invalid \`tenant\` ${JSON.stringify(tenant)} — a tenant name is alphanumeric with dashes ` +
        `(e.g. "xxxx-xxxx-xxxx"). It rides as its own "/tenant/<name>" path pair, so "/" cannot appear in it.`,
    );
  }
  return tenant;
}

/**
 * An `mcpServer()` handle: the def plus URL accessors. It stays a plain data
 * descriptor with two added methods — dropped by `JSON.stringify` and ignored by
 * `encodeMcpServer`, so serialization and conformance are unaffected (mirrors
 * `QueryHandle`).
 */
export type McpServerHandle = McpServerDef & {
  /**
   * The MCP server's **Streamable HTTP** endpoint path —
   * `/x2/mcp/<canonical>/<token>/stream`, or
   * `/x2/mcp/tenant/<tenant>/<canonical>/<token>/stream` when `tenant` is given —
   * ready to prepend a host and point a client at. The `canonical` is resolved
   * from the def's `canonical` (or `opts.canonical`, or the value frozen in
   * `xano.lock`); it throws if none resolves. `token` defaults to `"mcp"` (no
   * URL auth).
   *
   * Streamable HTTP only — the SDK does not surface the legacy HTTP+SSE
   * transport (deprecated in the MCP spec).
   */
  getPath(opts?: McpPathOptions): string;
  /**
   * The absolute endpoint URL — `baseUrl` (trimmed, trailing slash dropped) +
   * {@link getPath}.
   *
   * A base URL that already names a tenant (`https://<host>/tenant/<name>` —
   * `xanosdk sandbox details`' `baseUrl`, and the injected `window.XANO_HOST`)
   * has that tenant LIFTED out of the base and re-placed after the `/x2/mcp`
   * prefix, where the endpoint actually registers it, so
   * `getUrl(window.XANO_HOST)` alone reaches the right database:
   * `https://h/tenant/ab-cd` → `https://h/x2/mcp/tenant/ab-cd/<canonical>/mcp/stream`.
   * Left concatenated it would read `https://h/tenant/ab-cd/x2/mcp/…`, which is
   * not a registered route and answers 404. Passing a DIFFERENT `{ tenant }`
   * alongside such a base URL throws rather than picks a winner. A tenant served
   * on its own domain has nothing to lift — pass `{ tenant }` explicitly there.
   *
   * NOT IDEMPOTENT BY DESIGN: a `baseUrl` that already carries an
   * `/x2/mcp/<…>/stream` path (an earlier `getUrl()` result) THROWS, as does an
   * empty one — resolve ONCE from the instance base URL and pass that result to
   * the client.
   */
  getUrl(baseUrl: string, opts?: McpPathOptions): string;
};

export interface McpServerXdo extends ToolsetBaseXdo {
  type: "mcp";
  /** Present only when the def lists at least one. */
  prompt?: McpPrimitiveXdo[];
  resource?: McpPrimitiveXdo[];
  /** Present only when the def authored an {@link McpServerDef.llm}. */
  agent_settings?: AgentSettingsXdo;
  /** Present only when the def authored {@link McpServerDef.oauth}. */
  oauth?: McpOauthXdo;
}

export function encodeMcpServer(def: McpServerDef): McpServerXdo {
  if (!def.name) throw new Error("mcp server: `name` is required.");
  const owner = `mcpServer "${def.name}"`;
  const prompts = encodePrimitiveRefs("prompt", def.prompts, owner);
  const resources = encodePrimitiveRefs("resource", def.resources, owner);
  const base: McpServerXdo = {
    ...encodeToolsetBase(def, "mcpServer"),
    type: "mcp",
    // Written only when listed: a server with neither keeps the bytes it had
    // before prompts and resources existed.
    ...(prompts.length > 0 ? { prompt: prompts } : {}),
    ...(resources.length > 0 ? { resource: resources } : {}),
    // Written only when authored: a server without sign-in keeps its bytes.
    ...(def.oauth !== undefined ? { oauth: encodeMcpOauth(owner, def.oauth) } : {}),
  };
  // Written only when authored: an MCP server that sets no `llm` emits exactly
  // the bytes it always has, and the key stays absent rather than appearing at
  // a default nothing stored.
  return def.llm === undefined
    ? base
    : { ...base, agent_settings: buildAgentSettings({ llm: def.llm, output: def.output }, `mcpServer "${def.name}"`) };
}

export const mcpServerKind: ObjectKind<McpServerDef, McpServerXdo> = {
  name: "mcp_server",
  payloadKey: "toolset",
  encode: encodeMcpServer,
};
registerKind(mcpServerKind);

/**
 * A base URL that already ends in `/x2/mcp/<canonical>/<token>/stream` is this
 * function's OWN output fed back in — the shape `getPath()` appends, and nothing
 * an instance base URL ever carries. A client typically resolves the endpoint
 * once and passes the RESULT around, so any code treating that value as a
 * "base" re-resolves it and appends a second copy; the doubled URL 404s with
 * nothing pointing at the caller. Refuse here, where the mistake is unambiguous.
 */
function assertNotResolvedEndpointBase(base: string): void {
  // The optional `tenant/<name>` pair is part of this function's own output too
  // (a tenant base URL has its tenant lifted in), so the guard has to see it or
  // the one shape most likely to be re-fed passes straight through.
  const shape = /(\/x2\/mcp\/(?:tenant\/[^/]+\/)?[^/]+\/)[^/]+(\/stream)$/i;
  if (!shape.test(base)) return;
  // The token segment can be a real credential (`getUrl(host, { token })`), and
  // a thrown message ends up in consoles and error reporters. Redact it — the
  // rest of the URL is what makes this actionable.
  const redacted = base.replace(shape, "$1<token>$2");
  throw new Error(
    `mcp server: \`getUrl\` was given a base URL that already carries an MCP endpoint path (${redacted}). ` +
      "Pass the INSTANCE base URL, not the result of a previous getUrl() — resolving twice appends a " +
      'second "/x2/mcp/<canonical>/<token>/stream".',
  );
}

/**
 * Lift a `/tenant/<name>` prefix off a base URL into the MCP path's own tenant
 * slot.
 *
 * A tenant's public base URL names the tenant as its OWN leading path segment
 * (`https://<host>/tenant/<name>`) — the value `xanosdk sandbox details` prints
 * and deploy injects as `window.XANO_HOST`. The MCP endpoint registers the same
 * tenant one level in, AFTER the `/x2/mcp` prefix. Left alone, that base URL
 * yields `https://<host>/tenant/<name>/x2/mcp/<canonical>/mcp/stream`, which
 * matches no registered route and answers a plain 404 — a shape that reads as
 * "the server was never deployed" or "the canonical is wrong" rather than as a
 * misplaced path segment. So we translate instead.
 */
function liftTenantFromBase(
  base: string,
  explicit: string | undefined,
): { base: string; tenant: string | undefined } {
  // The scheme is optional: a caller can hand `getUrl` a bare `host/tenant/<name>`,
  // and that form has exactly the same misplaced segment to lift.
  const m = /^((?:https?:\/\/)?[^/]+)\/tenant\/([^/]+)(\/.*)?$/i.exec(base);
  if (!m) return { base, tenant: explicit };
  // Groups 1 and 2 are not optional in the pattern — a match always has them.
  const origin = m[1] as string;
  const fromBase = m[2] as string;
  const rest = m[3] ?? "";
  if (explicit !== undefined && explicit !== fromBase) {
    throw new Error(
      `mcp server: \`getUrl\` was given tenant ${JSON.stringify(explicit)} but the base URL names ` +
        `${JSON.stringify(fromBase)} (".../tenant/${fromBase}"). Refusing to guess which one you meant — pass the ` +
        `matching tenant, or a base URL without the "/tenant/<name>" prefix.`,
    );
  }
  return { base: `${origin}${rest}`, tenant: assertTenant(fromBase) };
}

/**
 * Author an MCP server — a collection of tools exposed over the MCP protocol.
 * Returns an {@link McpServerHandle}: the def plus `getPath()`/`getUrl()`, so a
 * frontend or external client derives the endpoint URL from the def instead of
 * hardcoding it (the same derive-don't-hardcode contract `query.getPath()` gives
 * API endpoints).
 */
export function mcpServer(def: McpServerDef): McpServerHandle {
  const getPath = (opts?: McpPathOptions): string => {
    const tenant = opts?.tenant ? `tenant/${assertTenant(opts.tenant)}/` : "";
    return `/x2/mcp/${tenant}${resolveToolsetCanonical(def, opts?.canonical)}/${opts?.token || "mcp"}/stream`;
  };
  const getUrl = (baseUrl: string, opts?: McpPathOptions): string => {
    const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error('mcp server: `getUrl` needs a base URL (e.g. "https://x.dev.xano.io").');
    assertNotResolvedEndpointBase(base);
    // A tenant base URL names its tenant in a slot the MCP endpoint does not
    // register; translate rather than concatenate. See liftTenantFromBase.
    const lifted = liftTenantFromBase(base, opts?.tenant);
    return `${lifted.base}${getPath({ ...opts, tenant: lifted.tenant })}`;
  };
  return brandDef({ ...def, getPath, getUrl }, "mcp_server");
}
