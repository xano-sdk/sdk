/**
 * OAuth 2.1 protocol layer for the CLI's login/push/logout flows, targeting the
 * Xano control-plane authorization server. Backed by `openid-client`
 * (OpenID-certified) — the same library the Xano dashboard's BFF uses — so
 * the two share one battle-tested implementation of RFC 8414 discovery, PKCE,
 * the authorization-code grant, refresh (with rotation), and revocation.
 *
 * The CLI differs from the dashboard in two ways, both handled here:
 *   - the redirect target is a loopback URL with a runtime-bound port (see
 *     `loopback.ts`), not a fixed config value;
 *   - the DCR client registration is cached per (auth host + redirect URI) in a
 *     global machine file (`client-store.ts`), reused across projects.
 *
 * Like the dashboard, the user picks the target instance at the hosted consent
 * screen; the binding is read back from the token's `aud` claim (see
 * `decodeAudience`), so there is no instance pre-selection to plumb through.
 *
 * `discover`, `registerClient`, and `decodeAudience` stay as pure/HTTP-only
 * helpers (fetch + decode, no openid-client) because they're both trivially
 * unit-testable and needed before a `Configuration` exists. Node-only; never
 * reachable from the browser-safe `index.ts` surface.
 */
import * as client from "openid-client";
import { getOrRegisterClient, clearClient } from "./client-store.js";
import { registerSecret } from "../util/secrets.js";
import { debugEnabled, describeTransportFailure, httpFailure, isTimeoutError, statusLabel } from "../util/http.js";

/**
 * The loopback path the callback server listens on and the client registers as
 * its redirect target. Combined with a FIXED port (see DEFAULT_PORT) this makes
 * the `redirect_uri` deterministic, so a Dynamic Client Registration can record
 * it exactly and the authorize server's exact-match check always passes.
 */
export const CALLBACK_PATH = "/oauth/callback";

/**
 * Fixed loopback port for the callback. Unlike an ephemeral port, a fixed value
 * lets the DCR redirect_uri be registered exactly (RFC 8252 loopback-port
 * flexibility is not relied upon). Overridable via `--port`; a re-registration
 * happens automatically when the resulting redirect_uri changes.
 */
export const DEFAULT_PORT = 47100;

/** RFC 7591 `software_id` for the CLI's dynamically-registered client. */
export const SOFTWARE_ID = "xanosdk";

/** Default Xano control-plane OAuth host when none is configured. */
export const DEFAULT_AUTH_HOST = "https://app.xano.com";

/**
 * Scopes requested by default. `offline_access` is what yields the refresh
 * token push relies on; `workspace:write`/`xano:dev` cover the environment import.
 * No `openid` — identity/instance binding is read from the token's `aud` claim
 * (see `decodeAudience`), not an id_token.
 */
export const DEFAULT_SCOPE = "offline_access workspace:read workspace:write xano:dev";

/** Well-known discovery path (served at the bare OAuth origin). */
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

/** Bound every OAuth HTTP call so a stalled endpoint can't hang the CLI/CI forever. */
const NETWORK_TIMEOUT_MS = 30_000;

/** The OAuth endpoints resolved from discovery (for the DCR pre-step). */
export interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 7591 Dynamic Client Registration endpoint (may be absent). */
  registration_endpoint?: string;
}

/**
 * The token-endpoint response as openid-client surfaces it, before we stamp an
 * absolute `expires_at` (that happens in `token.ts`/`login-command.ts`, where an
 * injectable clock lives).
 */
export interface RawTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * The failure for an authorization server nothing answered at: which host, and
 * the transport's own reason (`ECONNREFUSED`, `ENOTFOUND`, a timeout).
 */
export function unreachableAuthHost(authHost: string, err: unknown): Error {
  const why = isTimeoutError(err)
    ? `no answer within ${NETWORK_TIMEOUT_MS / 1000}s`
    : describeTransportFailure(err);
  return new Error(
    `Could not reach the sign-in server at ${authHost}: ${why}. ` +
      `Check the network, and --origin or XANO_ORIGIN if either is set.`,
    { cause: err },
  );
}

/** Fetch and validate the authorization-server metadata for `authHost`. */
export async function discover(authHost: string): Promise<Endpoints> {
  const url = new URL(DISCOVERY_PATH, authHost).href;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  } catch (err) {
    // The first request of every sign-in, so a dead origin surfaces HERE — and a
    // bare "fetch failed" named neither the host nor why.
    throw unreachableAuthHost(authHost, err);
  }
  if (!res.ok) {
    throw new Error(
      `OAuth discovery failed (${statusLabel(res)}) at ${url}. ` +
        `Check --origin (currently ${authHost}).`,
    );
  }
  const doc = (await res.json()) as Partial<Endpoints>;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`OAuth discovery doc at ${url} is missing authorization/token endpoints.`);
  }
  return {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    registration_endpoint: doc.registration_endpoint,
  };
}

/**
 * Dynamically register a public CLI client (RFC 7591) whose redirect URI is
 * EXACTLY the loopback callback we will use, so the authorize server's
 * exact-match check passes without relying on loopback-port normalization.
 *
 * Two Xano-specific quirks (mirroring xanosdk-dashboard's registrar, and the
 * reason we POST directly rather than via openid-client): the server answers 200
 * (not RFC 7591's 201), and it reads a `scopes` ARRAY rather than a
 * space-separated `scope` string.
 */
export async function registerClient(params: {
  registrationEndpoint: string;
  redirectUri: string;
  scope: string;
}): Promise<{ client_id: string }> {
  const res = await fetch(params.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "xanosdk CLI",
      software_id: SOFTWARE_ID,
      redirect_uris: [params.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scopes: params.scope.split(/\s+/).filter(Boolean),
    }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(httpFailure("Client registration", res, text));
  }
  const doc = JSON.parse(text) as { client_id?: string };
  if (!doc.client_id) {
    // Never the body — `XANOSDK_DEBUG` has it.
    throw new Error(`Client registration response had no client_id.${debugEnabled() ? `\n${text}` : ""}`);
  }
  return { client_id: doc.client_id };
}

/**
 * Read the instance origin a token is bound to from its `aud` claim (RFC 9068
 * at+jwt). Decodes the payload only — the instance meta API is the verifier of
 * record — and returns the audience, or undefined if it can't be read.
 */
export function decodeAudience(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      aud?: string | string[];
    };
    return Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  } catch {
    return undefined;
  }
}

/** Extract the OAuth error code from an openid-client error, if present. */
export function oauthErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "error" in err) {
    const code = (err as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * The HTTP `Response` an openid-client error carries when the authorization
 * server actually ANSWERED.
 *
 * The distinction this exists for: a transport blip (DNS, reset, timeout)
 * produces an error with no response at all, while a server that answered —
 * even unintelligibly — produces one whose `cause` is the `Response`. Only the
 * first is worth retrying, and only the first should be described to the user
 * as a network problem.
 */
export function oauthErrorResponse(err: unknown): Response | undefined {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  return typeof Response !== "undefined" && cause instanceof Response ? cause : undefined;
}

/** The RFC 6749 §5.2 token-endpoint error codes. */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/**
 * The OAuth error code for a failed token exchange, including servers whose
 * error envelope is not RFC-shaped.
 *
 * {@link oauthErrorCode} reads the RFC 6749 `error` field, which openid-client
 * surfaces only when the response conforms. A server may instead answer 401
 * with its own envelope — Xano's is `{"code":"ERROR_CODE_UNAUTHORIZED",
 * "message":"invalid_grant"}` — and openid-client then throws
 * `OAUTH_RESPONSE_IS_NOT_CONFORM` carrying the raw `Response` and no `error`
 * field at all. Reading the code out of that body is what keeps a REJECTED
 * credential from being misreported as a network blip.
 *
 * Only a code in the RFC set is trusted, wherever in the envelope it appears —
 * bare, or leading a `code: description` string. A server's own free-text
 * `message` must never be promoted to a protocol decision just because it is a
 * string.
 */
export async function resolveOAuthErrorCode(err: unknown): Promise<string | undefined> {
  const rfc = oauthErrorCode(err);
  if (rfc !== undefined) return rfc;
  const res = oauthErrorResponse(err);
  if (res === undefined || res.bodyUsed) return undefined;
  try {
    const body: unknown = await res.clone().json();
    if (!body || typeof body !== "object") return undefined;
    const fields = body as { error?: unknown; message?: unknown; code?: unknown };
    for (const candidate of [fields.error, fields.message, fields.code]) {
      const code = typeof candidate === "string" ? leadingOAuthCode(candidate) : undefined;
      if (code !== undefined) return code;
    }
  } catch {
    // A body that is not JSON, or a stream already consumed: nothing to read,
    // and the caller still knows the server answered from the status.
  }
  return undefined;
}

/**
 * The RFC code a server string names: the whole string, or the code followed by
 * `:` and a description — the dev authorization server answers a replayed
 * refresh token with `"message":"invalid_grant: refresh token replayed"`.
 * Anything else, including free text that merely CONTAINS a code, is undefined.
 */
function leadingOAuthCode(value: string): string | undefined {
  const colon = value.indexOf(":");
  const head = (colon === -1 ? value : value.slice(0, colon)).trim();
  if (colon === -1 && head !== value) return undefined;
  return OAUTH_ERROR_CODES.has(head) ? head : undefined;
}

/**
 * The protocol surface the CLI commands drive. Fakeable in tests (as in the
 * dashboard) so callers can be exercised without a live authorization server.
 */
export interface TokenProvider {
  /** Build the browser authorize URL (authorization-code + PKCE, S256). */
  buildAuthUrl(p: { verifier: string; state: string }): Promise<string>;
  /** Exchange the loopback callback URL for a token set. */
  exchange(callbackUrl: string, p: { verifier: string; state: string }): Promise<RawTokens>;
  /** Refresh — the server ROTATES the refresh token, so persist the new one. */
  refresh(refreshToken: string, opts?: { scope?: string }): Promise<RawTokens>;
  /** Revoke the refresh token at the AS (logout). */
  revoke(refreshToken: string): Promise<void>;
  /** Drop the cached config + DCR registration (e.g. after `invalid_client`). */
  reset(): Promise<void>;
}

export interface OpenIdProviderOptions {
  authHost: string;
  /** Loopback redirect URI — required for authorize/exchange, unused for refresh/revoke. */
  redirectUri?: string;
  scope: string;
  /**
   * A pre-known `client_id` (the refresh/logout paths read it from the token
   * cache). When set, discovery skips DCR entirely — we already have a client.
   */
  clientId?: string;
}

/**
 * openid-client-backed provider. Lazily builds (and memoizes) a `Configuration`
 * — discovery + a DCR registration when no `client_id` is known — then delegates
 * PKCE, the code grant, refresh, and revocation to openid-client.
 */
export class OpenIdProvider implements TokenProvider {
  private configPromise?: Promise<client.Configuration>;
  /** The client_id the resolved config uses — set once `build()` completes. */
  private resolvedClientId?: string;
  /** The issuer the resolved config discovered — set once `build()` completes. */
  private resolvedIssuer?: string;

  constructor(private readonly opts: OpenIdProviderOptions) {}

  private redirectUri(): string {
    if (!this.opts.redirectUri) {
      throw new Error("OpenIdProvider: redirectUri is required for the authorize/exchange flow.");
    }
    return this.opts.redirectUri;
  }

  /**
   * The client_id this provider registered or reused. Only valid after the
   * config has resolved (e.g. after `buildAuthUrl`/`exchange`); throws otherwise
   * so a caller never records an empty client_id.
   */
  clientId(): string {
    if (!this.resolvedClientId) {
      throw new Error("OpenIdProvider.clientId() called before the configuration was resolved.");
    }
    return this.resolvedClientId;
  }

  /**
   * The authorization server's issuer, as resolved by discovery. Only the paste
   * login mode needs it: a pasted BARE code carries no `iss`, and the AS
   * advertises issuer support, so one has to be supplied for the response to
   * validate at all. Same lifecycle guard as `clientId()` — valid once the
   * configuration has resolved.
   */
  issuer(): string {
    if (!this.resolvedIssuer) {
      throw new Error("OpenIdProvider.issuer() called before the configuration was resolved.");
    }
    return this.resolvedIssuer;
  }

  private async build(): Promise<client.Configuration> {
    const server = new URL(this.opts.authHost);
    // Allow plain-HTTP only when the target itself is http (local control-plane).
    const options =
      server.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;

    let clientId = this.opts.clientId;
    if (!clientId) {
      const { registration_endpoint } = await discover(this.opts.authHost);
      if (!registration_endpoint) {
        throw new Error(
          `The OAuth server at ${this.opts.authHost} does not advertise a registration ` +
            `endpoint, so xanosdk can't register its loopback client. Check --origin.`,
        );
      }
      clientId = await getOrRegisterClient({
        authHost: this.opts.authHost,
        redirectUri: this.redirectUri(),
        registrationEndpoint: registration_endpoint,
        scope: this.opts.scope,
      });
    }
    this.resolvedClientId = clientId;
    const config = await client.discovery(
      server,
      clientId,
      { token_endpoint_auth_method: "none" },
      client.None(),
      options,
    );
    this.resolvedIssuer = config.serverMetadata().issuer;
    return config;
  }

  private config(): Promise<client.Configuration> {
    return (this.configPromise ??= this.build());
  }

  async reset(): Promise<void> {
    this.configPromise = undefined;
    this.resolvedClientId = undefined;
    this.resolvedIssuer = undefined;
    if (this.opts.redirectUri) {
      clearClient({ authHost: this.opts.authHost, redirectUri: this.opts.redirectUri });
    }
  }

  async buildAuthUrl({ verifier, state }: { verifier: string; state: string }): Promise<string> {
    const config = await this.config();
    const code_challenge = await client.calculatePKCECodeChallenge(verifier);
    return client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(),
      scope: this.opts.scope,
      code_challenge,
      code_challenge_method: "S256",
      state,
    }).href;
  }

  async exchange(
    callbackUrl: string,
    { verifier, state }: { verifier: string; state: string },
  ): Promise<RawTokens> {
    const config = await this.config();
    const tokens = await client.authorizationCodeGrant(config, new URL(callbackUrl), {
      // We don't request `openid`, so no ID Token is expected.
      pkceCodeVerifier: verifier,
      expectedState: state,
      idTokenExpected: false,
    });
    return pick(tokens);
  }

  async refresh(refreshToken: string, opts?: { scope?: string }): Promise<RawTokens> {
    const config = await this.config();
    const params: Record<string, string> = {};
    if (opts?.scope) params.scope = opts.scope;
    return pick(await client.refreshTokenGrant(config, refreshToken, params));
  }

  async revoke(refreshToken: string): Promise<void> {
    const config = await this.config();
    await client.tokenRevocation(config, refreshToken, { token_type_hint: "refresh_token" });
  }
}

function pick(t: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): RawTokens {
  registerSecret(t.access_token);
  registerSecret(t.refresh_token);
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    scope: t.scope,
  };
}
