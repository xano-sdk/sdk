/**
 * What a Xano Engine SAYS about itself, turned into a value this SDK is
 * willing to act on.
 *
 * The engine announces itself as one JSON object on stdout when it starts, and
 * re-announces every running engine the same way when it is asked to enumerate.
 * Both carry a bearer. So this module has one job beyond parsing: decide, from
 * the url alone, whether that bearer is allowed to go there — BEFORE anything
 * attaches it to a request.
 *
 * That check is not ceremony. The import transport builds its url by
 * concatenation and attaches the bearer, and the repo's origin assertion is
 * only reached on sign-in paths, which a local destination skips by design. So
 * without a check here, whatever host the engine printed is where a live token
 * gets posted — and an engine told to listen on all interfaces really does
 * report a non-loopback host, in the start handshake AND in the enumeration.
 * Hence {@link assertLoopbackUrl}, and hence resolution running it on the
 * REUSE arm too, not only on a fresh start.
 *
 * Pure: no filesystem, no network, no child processes. It is the half of the
 * local surface that can be tested without an engine at all, which is
 * why it is its own module rather than a section of the process one.
 */

/**
 * The typed Xano Engine — everything an import needs, and nothing shaped like
 * a credential.
 *
 * The field names are load-bearing. A value carrying an instance origin and a
 * workspace id structurally satisfies the hosted environment scope, so a local
 * engine spelled that way would be accepted by the hosted state writer and
 * would fall through the hosted binding-refusal explainer on a local failure.
 * `url`/`token` instead of `instance`/`access_token` makes that a compile
 * error, which is the only form of the separation that cannot be forgotten.
 */
export interface LocalEngine {
  /** The engine's own name, which is the ONLY handle anything matches on. */
  name: string;
  /** Base url it serves on. Loopback, always — see {@link assertLoopbackUrl}. */
  url: string;
  /** The workspace the engine stands up. Measured as `1` on every build so far. */
  workspaceId: number;
  /**
   * The bearer. Never written to disk, never logged, never in a summary —
   * printed only by `xanosdk local token`, for a caller that asked.
   */
  token: string;
  /** The engine's process id. Recorded by nobody and signalled by nobody. */
  pid: number;
  /**
   * A url that opens an owner session in the builder. Carries a per-process
   * sign-in key, NOT the bearer — so it may be shown to a person, and is still
   * kept out of logs and machine output because it opens a session.
   */
  signInUrl: string;
  /** The route that mints a one-time login link for a client holding the bearer. */
  loginLinkEndpoint: string;
  /** The log file the ENGINE writes (distinct from the one this SDK writes). */
  logPath: string;
  /**
   * Where the engine serves its MCP server for coding agents — a url, not a
   * credential; the bearer it wants is {@link token}. Absent when the engine
   * does not serve one (an older release, or MCP turned off), which is told
   * apart by presence alone, never by version. Not loopback-checked here: like
   * {@link loginLinkEndpoint}, it is checked right before the bearer follows it.
   */
  mcpUrl?: string;
}

/** The three spellings of "this machine, and nowhere else". */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/** Schemes a bearer may follow. Anything else is not an engine we addressed. */
const ALLOWED_PROTOCOLS: readonly string[] = ["http:", "https:"];

/**
 * Is `url` somewhere this SDK will send an engine's bearer?
 *
 * Three conditions, all of them cheap and none of them skippable: an http(s)
 * scheme, a loopback host, and a numeric port. The port is required rather than
 * defaulted — a Xano Engine binds an ephemeral one and always reports it, so a
 * url without one is not a url this side produced, and treating it as port 80
 * would silently widen the destination.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return false;
  // `URL` keeps IPv6 hosts bracketed (`[::1]`, and `[::]` for all-interfaces),
  // so the brackets come off before the comparison or neither spelling matches.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.includes(host)) return false;
  // `URL` has already rejected a non-numeric port by throwing, so what is left
  // to check is that there IS one.
  return /^[0-9]+$/.test(parsed.port);
}

/**
 * Refuse a destination before the token follows it.
 *
 * `what` names the arm — a fresh start or a reused engine — because the remedy
 * differs and the message is the only thing the developer sees.
 */
export function assertLoopbackUrl(url: string, what: string): void {
  if (isLoopbackUrl(url)) return;
  throw new Error(
    `${what} reports a url this SDK will not send a token to: ${url}\n` +
      `A Xano Engine has to serve loopback over http on a port of its own — ` +
      `${LOOPBACK_HOSTS.join(", ")} — and anything else is reachable from off this machine. ` +
      `Stop that engine and start a fresh one without binding it to all interfaces.`,
  );
}

/** The engine's own spelling of each field, so a refusal names what to look for. */
interface RawEngine {
  url: string;
  name: string;
  pid: number;
  workspace_id: number;
  access_token: string;
  sign_in_url: string;
  login_link_endpoint: string;
  log: string;
  mcp_url: string;
}

function requireString(raw: Record<string, unknown>, key: keyof RawEngine, source: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `${source} is missing \`${key}\`, or gave it as something other than text.\n` +
        `That is not an engine this SDK knows how to drive — the engine on this machine is ` +
        `older or newer than the one it was built against. Move to a current one with ` +
        `\`xanosdk local update\`.`,
    );
  }
  return value;
}

/**
 * A field an engine may leave out. Absent reads as undefined; present but not
 * non-empty text is the same version skew a missing required field is, and
 * refuses the same way.
 */
function optionalString(raw: Record<string, unknown>, key: keyof RawEngine, source: string): string | undefined {
  return raw[key] === undefined ? undefined : requireString(raw, key, source);
}

function requireNumber(raw: Record<string, unknown>, key: keyof RawEngine, source: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${source} is missing \`${key}\`, or gave it as something other than a number.\n` +
        `That is not an engine this SDK knows how to drive — the engine on this machine is ` +
        `older or newer than the one it was built against. Move to a current one with ` +
        `\`xanosdk local update\`.`,
    );
  }
  return value;
}

/**
 * One announced engine, field by field.
 *
 * No url check here: the enumeration is a census and has to be able to REPORT
 * an engine bound to all interfaces. The refusal belongs at the two points
 * where the token is about to be used, which is what the callers below do.
 */
function readEngine(value: unknown, source: string): LocalEngine {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} did not print an engine description.\n` +
        `Re-run, and if it happens again fetch a fresh copy with \`xanosdk local cache clear\`, ` +
        `then \`xanosdk deploy --local\`.`,
    );
  }
  const raw = value as Record<string, unknown>;
  const mcpUrl = optionalString(raw, "mcp_url", source);
  return {
    name: requireString(raw, "name", source),
    url: requireString(raw, "url", source),
    workspaceId: requireNumber(raw, "workspace_id", source),
    token: requireString(raw, "access_token", source),
    pid: requireNumber(raw, "pid", source),
    signInUrl: requireString(raw, "sign_in_url", source),
    loginLinkEndpoint: requireString(raw, "login_link_endpoint", source),
    logPath: requireString(raw, "log", source),
    ...(mcpUrl === undefined ? {} : { mcpUrl }),
  };
}

/** What a parse failure calls the two sources, so a refusal says which one. */
const HANDSHAKE_SOURCE = "The engine's start handshake";
const LISTING_SOURCE = "The engine's list of running engines";

/**
 * The engine's start announcement, parsed and CHECKED.
 *
 * The loopback assertion runs here rather than at the caller because this is
 * the function every start arm goes through, and a check the caller has to
 * remember is a check that gets skipped on the arm nobody was thinking about.
 * It covers `url` only: `mcpUrl`, like the sign-in route, is asserted where the
 * bearer is about to follow it.
 */
export function parseEngineHandshake(stdout: string): LocalEngine {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `${HANDSHAKE_SOURCE} did not print an engine description.\n` +
        `Re-run, and if it happens again fetch a fresh copy with \`xanosdk local cache clear\`, ` +
        `then \`xanosdk deploy --local\`.`,
    );
  }
  const engine = readEngine(value, HANDSHAKE_SOURCE);
  assertLoopbackUrl(engine.url, "The engine that just started");
  return engine;
}

/**
 * Every running engine, as the engine itself reports them.
 *
 * Empty output reads as "none running" rather than as an error: that is the
 * overwhelmingly common case and `local list` must answer it without
 * failing.
 */
export function parseEngineListing(stdout: string): LocalEngine[] {
  const text = stdout.trim();
  if (text === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `${LISTING_SOURCE} was not readable.\n` +
        `Re-run, and if it happens again fetch a fresh copy with \`xanosdk local cache clear\`, ` +
        `then \`xanosdk deploy --local\`.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `${LISTING_SOURCE} was not a list.\n` +
        `Re-run, and if it happens again fetch a fresh copy with \`xanosdk local cache clear\`, ` +
        `then \`xanosdk deploy --local\`.`,
    );
  }
  return value.filter((entry) => !isForeignEngine(entry)).map((entry) => readEngine(entry, LISTING_SOURCE));
}

/**
 * An entry of a different KIND of engine, which the SDK never started and cannot
 * drive: one that serves no single workspace (a dev stack on a server database)
 * carries neither `workspace_id` nor `access_token`.
 *
 * Both absent, not either: an entry with one of the two is the shape this SDK
 * drives, arriving damaged or from a newer engine, and that is version skew that
 * must stay loud. Skipping it would report a live engine as "none running" and
 * start a second one beside it.
 */
function isForeignEngine(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as Record<string, unknown>;
  return raw.workspace_id === undefined && raw.access_token === undefined;
}
