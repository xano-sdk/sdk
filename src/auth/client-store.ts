/**
 * Global cache of Dynamically-Registered OAuth clients (RFC 7591). A client is
 * registered once per (auth host + redirect URI) and reused across every project
 * — unlike the per-project token cache, the client registration is a machine
 * fact, so it lives in `~/.xano/xanosdk-clients.json` (0600). Reusing it avoids
 * re-hitting the rate-limited registration endpoint on every login.
 *
 * Node-only; never reachable from the browser-safe `index.ts` surface.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { readPathEnvVar } from "../util/home-path.js";
import { registerClient } from "./oauth.js";

interface ClientRecord {
  client_id: string;
  /**
   * The scope set the client was registered for. A client is reused only for
   * the same set: an authorization server refuses a client a scope it was not
   * registered with (`invalid_scope`), so a login asking for a scope added
   * since would fail. Absent on records written before it was kept, which
   * therefore re-register once.
   */
  scope?: string;
}

/** A scope string as a set, so word order and spacing do not force a re-registration. */
function sameScopes(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const norm = (s: string): string => [...new Set(s.split(/\s+/).filter((w) => w !== ""))].sort().join(" ");
  return norm(a) === norm(b);
}

/** Location of the global client cache (overridable for tests). */
export function clientStorePath(): string {
  return readPathEnvVar("XANO_CLIENT_FILE") ?? join(homedir(), ".xano", "xanosdk-clients.json");
}

/** Stable key for one registration: the auth host plus the exact redirect URI. */
function key(authHost: string, redirectUri: string): string {
  return `${authHost}|${redirectUri}`;
}

function readAll(path: string): Record<string, ClientRecord> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, ClientRecord>) : {};
  } catch {
    // A corrupt cache is non-fatal — re-register and overwrite.
    return {};
  }
}

function writeAll(path: string, all: Record<string, ClientRecord>): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Return the client registered for (authHost, redirectUri) and this scope
 * set, registering a new one (and caching it) when none exists. The registration's redirect_uri is
 * exactly `redirectUri`, so the authorize exact-match check always passes.
 */
export async function getOrRegisterClient(params: {
  authHost: string;
  redirectUri: string;
  registrationEndpoint: string;
  scope: string;
}): Promise<{ client_id: string }> {
  const path = clientStorePath();
  const all = readAll(path);
  const k = key(params.authHost, params.redirectUri);
  const cached = all[k];
  if (cached?.client_id && sameScopes(cached.scope, params.scope)) return { client_id: cached.client_id };

  const { client_id } = await registerClient({
    registrationEndpoint: params.registrationEndpoint,
    redirectUri: params.redirectUri,
    scope: params.scope,
  });
  all[k] = { client_id, scope: params.scope };
  writeAll(path, all);
  return { client_id };
}

/**
 * Forget the cached client for (authHost, redirectUri). Called after the AS
 * rejects the registration (`invalid_client`) — a revoked/expired dynamic client
 * can't be salvaged mid-flight, so we drop it and let the next login re-register.
 * Idempotent; a no-op when nothing is cached.
 */
export function clearClient(params: { authHost: string; redirectUri: string }): void {
  const path = clientStorePath();
  const all = readAll(path);
  const k = key(params.authHost, params.redirectUri);
  if (!(k in all)) return;
  delete all[k];
  writeAll(path, all);
}
