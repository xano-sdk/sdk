/**
 * `mcpServer({ oauth })` — per-server sign-in for an MCP server.
 *
 * Two modes, one discriminated union:
 *
 * - **hosted** — the platform runs the OAuth authorization server. A client is
 *   sent to `loginUrl`, a page you own, which is also the consent screen: its
 *   stack reads what is being asked with `s.mcp.oauth.request` (client name,
 *   logo, callback host, whether the client is verified, server name), shows
 *   it, and finishes with `s.mcp.oauth.complete`, passing the user's
 *   `decision` (`"approve"` or `"deny"`).
 * - **external** — your identity provider issues the tokens; the platform
 *   verifies them against `issuer` and maps the token's `claim` (default
 *   `sub`) onto the auth table's `column`.
 *
 * Either way `authTable` names the auth table whose row becomes the caller —
 * `auth()` in every tool, prompt and resource on the server, and the
 * connection trigger's `t.auth`.
 *
 * Stored as the server's `oauth` block, which always carries every key at its
 * default; the encoder writes the same shape, so a stored server and an
 * authored one compare byte for byte. A server with no `oauth` writes no key at
 * all and behaves exactly as before.
 *
 * `loginUrl`, `issuer` and `audience` take `${env.NAME}` references, resolved
 * per environment when a request arrives — pass `env("NAME")` (or a string
 * containing `${env.NAME}`), so one release serves every environment.
 */
import { refuseUnknown } from "./def-keys.js";
import { resolveAuthRef } from "../refs/auth.js";
import type { TableDef } from "./table.js";
import { isTaggedValue } from "../values/value.js";
import type { Value } from "../values/value.js";

/** The identity-provider presets an external server recognizes. */
export const MCP_OAUTH_PRESETS = ["auth0", "clerk", "workos", "entra", "okta", "cognito", "generic"] as const;
export type McpOauthPreset = (typeof MCP_OAUTH_PRESETS)[number];

/** Presets whose access tokens carry no audience, so `allowedClientIds` must pin the client. */
export const MCP_OAUTH_PRESETS_WITHOUT_AUD: readonly string[] = ["clerk"];

/** Claims accepted without `claimAck`: ones a user cannot edit at the provider. */
export const MCP_OAUTH_STABLE_CLAIMS: readonly string[] = ["sub", "oid", "email"];

/**
 * A setting that may hold an environment reference: a plain string (which may
 * contain `${env.NAME}` anywhere), or `env("NAME")`, which writes exactly
 * `${env.NAME}`.
 */
export type McpOauthEnvString = string | Value;

interface McpOauthCommon {
  /**
   * The auth table whose row a sign-in resolves to: a `table({ auth: true })`
   * handle, its name, or a raw numeric table id. Required — it is who the
   * caller is.
   */
  authTable: TableDef | string | number;
}

/** Hosted mode: the platform is the authorization server; your page signs the user in. */
export interface McpOauthHosted extends McpOauthCommon {
  mode: "hosted";
  /**
   * Your login page (https; `http://localhost` only on a development
   * instance). A client is sent here with an `mcp_request` parameter; the
   * page shows the request (`s.mcp.oauth.request`), signs the user in and
   * hands the user's decision to `s.mcp.oauth.complete`. Takes `env("NAME")`.
   */
  loginUrl: McpOauthEnvString;
}

/** External mode: tokens come from your identity provider and are verified here. */
export interface McpOauthExternal extends McpOauthCommon {
  mode: "external";
  /** The provider's issuer URL (https). Takes `env("NAME")`. */
  issuer: McpOauthEnvString;
  /** The auth-table column the token's `claim` is matched against (e.g. `"auth0_id"`). */
  column: string;
  /**
   * Accepted `aud` values. Each must be one of this server's MCP resource URLs
   * unless `audienceAck` is set. Each takes `env("NAME")`.
   */
  audience?: McpOauthEnvString[];
  /** Accept an `audience` value that is not one of this server's resource URLs. */
  audienceAck?: boolean;
  /** The token claim mapped onto `column`. Default `"sub"`; anything but `sub`/`oid`/`email` needs `claimAck`. */
  claim?: string;
  /** Accept a `claim` users can edit at many providers (anything but `sub`, `oid`, `email`). */
  claimAck?: boolean;
  /** The identity provider, which tunes verification. `"clerk"` requires `allowedClientIds`. */
  preset?: McpOauthPreset;
  /** The `azp`/`client_id` values accepted — required for a preset whose tokens carry no audience. */
  allowedClientIds?: string[];
}

/** An MCP server's sign-in setting. See the module header. */
export type McpOauth = McpOauthHosted | McpOauthExternal;

/** The stored block: every key, at its default when unset. */
export interface McpOauthXdo {
  mode: "hosted" | "external";
  /** A table guid (by handle or name) or a raw numeric table id. */
  auth_table: number | string;
  login_url: string;
  issuer: string;
  audience: string[];
  audience_ack: boolean;
  claim: string;
  claim_ack: boolean;
  column: string;
  preset: string;
  allowed_client_ids: string[];
}

const HOSTED_KEYS = ["mode", "authTable", "loginUrl"] satisfies (keyof McpOauthHosted)[];
const EXTERNAL_KEYS = [
  "mode", "authTable", "issuer", "column", "audience", "audienceAck", "claim", "claimAck", "preset", "allowedClientIds",
] satisfies (keyof McpOauthExternal)[];

/** Keys the platform once took and has dropped; named in the error so a stale def gets the new flow. */
const REMOVED_KEYS = ["consent", "branding", "trustedClients"] as const;

/** The env-reference name grammar the platform resolves. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Exactly one `${env.NAME}` reference, and nothing else — what `env("NAME")` writes. */
export const MCP_OAUTH_ENV_REF = /^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

function envString(owner: string, field: string, v: unknown): string {
  if (typeof v === "string") return v;
  if (isTaggedValue(v)) {
    const name = v.value;
    if (v.tag === "setting" && v.filters.length === 0 && ENV_NAME.test(name)) return `\${env.${name}}`;
    throw new Error(
      `${owner} \`oauth.${field}\`: only \`env("NAME")\` (a workspace environment variable) is accepted here, ` +
        `not ${JSON.stringify({ tag: v.tag, value: name })}. Built-in settings (\`$remote_ip\` and the like) and ` +
        `filtered values are not resolved in this setting — pass a string or \`env("NAME")\`.`,
    );
  }
  throw new Error(`${owner} \`oauth.${field}\`: expected a string or \`env("NAME")\` (got ${v === null ? "null" : typeof v}).`);
}

function strings(owner: string, field: string, v: unknown, envAllowed: boolean): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${owner} \`oauth.${field}\`: expected a list of strings.`);
  return v.map((item, i) => {
    if (envAllowed) return envString(owner, `${field}[${i}]`, item);
    if (typeof item !== "string") throw new Error(`${owner} \`oauth.${field}[${i}]\`: expected a string.`);
    return item;
  });
}

function oneOf(owner: string, field: string, v: unknown, allowed: readonly string[]): void {
  if (v === undefined) return;
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new Error(
      `${owner} \`oauth.${field}\` must be ${allowed.map((a) => JSON.stringify(a)).join(", ")} — got ${JSON.stringify(v)}. ` +
        `The platform refuses any other spelling rather than reading it as a different sign-in flow.`,
    );
  }
}

/**
 * Encode an `oauth` block to its stored shape. `owner` names the server for
 * error messages. Shape errors (an unknown mode, a missing table) throw here;
 * the rules the platform enforces at save — a Clerk preset without client ids,
 * an unacknowledged claim, an external server without issuer or column — are
 * `export()` diagnostics, so a pulled workspace reports them too.
 */
export function encodeMcpOauth(owner: string, oauth: McpOauth): McpOauthXdo {
  if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new Error(`${owner} \`oauth\`: expected { mode: "hosted" | "external", authTable, … }.`);
  }
  const raw = oauth as unknown as Record<string, unknown>;
  oneOf(owner, "mode", raw.mode, ["hosted", "external"]);
  if (raw.mode === undefined) throw new Error(`${owner} \`oauth.mode\` is required: "hosted" or "external".`);
  for (const key of REMOVED_KEYS) {
    if (key in raw) {
      throw new Error(
        `${owner} \`oauth.${key}\` no longer exists: the platform dropped \`consent\`, \`branding\` and ` +
          `\`trustedClients\`. Your \`loginUrl\` page is the consent screen — show what \`s.mcp.oauth.request\` ` +
          `returns (client name, logo, callback host, whether the client is verified) and pass the user's choice ` +
          `to \`s.mcp.oauth.complete\` as \`decision\`. Remove the key.`,
      );
    }
  }
  refuseUnknown(`${owner} \`oauth\` (mode "${String(raw.mode)}")`, raw, raw.mode === "hosted" ? HOSTED_KEYS : EXTERNAL_KEYS);

  const table = raw.authTable;
  if (table === undefined || table === null || table === false || table === "") {
    throw new Error(
      `${owner} \`oauth.authTable\` is required: the auth table (a \`table({ auth: true })\` handle or its name) ` +
        `whose row a sign-in resolves to.`,
    );
  }
  const authTable = resolveAuthRef("mcpServer oauth", owner, table as TableDef | string | number);

  const out: McpOauthXdo = {
    mode: raw.mode as "hosted" | "external",
    auth_table: authTable as number | string,
    login_url: "",
    issuer: "",
    audience: [],
    audience_ack: false,
    claim: "sub",
    claim_ack: false,
    column: "",
    preset: "",
    allowed_client_ids: [],
  };

  if (oauth.mode === "hosted") {
    out.login_url = envString(owner, "loginUrl", oauth.loginUrl ?? "");
    return out;
  }

  oneOf(owner, "preset", oauth.preset, MCP_OAUTH_PRESETS);
  out.issuer = envString(owner, "issuer", oauth.issuer ?? "");
  out.audience = strings(owner, "audience", oauth.audience, true);
  out.audience_ack = oauth.audienceAck === true;
  if (oauth.claim !== undefined && typeof oauth.claim !== "string") throw new Error(`${owner} \`oauth.claim\`: expected a string.`);
  out.claim = oauth.claim || "sub";
  out.claim_ack = oauth.claimAck === true;
  if (oauth.column !== undefined && typeof oauth.column !== "string") throw new Error(`${owner} \`oauth.column\`: expected a string.`);
  out.column = oauth.column ?? "";
  out.preset = oauth.preset ?? "";
  out.allowed_client_ids = strings(owner, "allowedClientIds", oauth.allowedClientIds, false);
  return out;
}
