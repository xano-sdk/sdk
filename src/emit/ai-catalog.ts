/**
 * The Xano AI model catalog: the public, tokenless read behind `xanosdk ai
 * models`, and the one place a maintainer script reads the same answer from.
 *
 * The catalog is served by the Xano sign-in server (the host `login` talks
 * to), so a signed-out run, a meta-token run and a CI run all reach it. No
 * token is ever sent: the answer holds nothing about the caller.
 *
 * Projection is field by field rather than a cast, as `marketplace-catalogue.ts`
 * does: the agent-facing contract is pinned to this file, so a field added
 * upstream never widens what the CLI prints, and a field removed upstream shows
 * up as a default here rather than a shape error downstream.
 *
 * Plain `fetch`, no Node built-ins; reached only through the lazy import in
 * cli.ts and from maintainer scripts.
 */
import { readEnvVar } from "../util/env.js";
import { parseJsonAnswer, serverMessage, statusLabel } from "../util/http.js";
import { DEFAULT_AUTH_HOST } from "../auth/oauth.js";
import { CliError } from "./errors.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";
import { AI_STATEMENTS, type AiStatement } from "../statements/xano-ai-statements.js";
import { asRecord, asString, asStringArray } from "../util/project.js";

/** The route on the sign-in server. One constant, so a move is a one-line change. */
export const AI_CATALOG_PATH = "/api:xano-ai/catalog";

/** Overrides every other host. Lets the suite stay offline, and repoints a release without an upgrade. */
export const AI_CATALOG_URL_ENV = "XANOSDK_AI_CATALOG_URL";

/** Bound the read so a stalled host cannot hang the CLI. Same budget as the marketplace reads. */
const AI_CATALOG_TIMEOUT_MS = 30_000;

export { AI_STATEMENTS, type AiStatement };

/** One model a statement can run. */
export interface AiCatalogEntry {
  /** The value a statement's `model` argument takes. */
  model: string;
  label: string;
  tier: string;
  stage: string;
  /** The model a picker defaults to. Never true on an unlisted entry. */
  suggested: boolean;
  /** False: still runs when a saved script names it, but no picker offers it. */
  listed: boolean;
  /** The list price, as display text. Empty when the host does not carry one. */
  price: string;
  /** Where this host calls the model. */
  location: string;
  /** The locations a caller may ask for with this model. */
  locations: string[];
  /** Model-specific limits and capabilities (protocol, files, temperature_max, ...). Keys vary per model. */
  options: Record<string, unknown>;
}

/** The projected catalog, as the host answered it. */
export interface AiCatalog {
  version: number;
  generated_at: string | undefined;
  /** False: this Xano does not offer Xano AI at all. */
  available: boolean;
  /** False while the host has not yet read the catalog it serves. */
  fetched: boolean;
  statements: Record<AiStatement, AiCatalogEntry[]>;
  agent: { default: string | undefined; models: string[] };
}

/** Why a read did not produce a usable catalog. Carried as `details.state` in a `--json` failure. */
export type AiCatalogFailure = "unavailable" | "not-fetched" | "unreachable" | "http" | "unsupported";

/** The catalog shape this SDK reads. A host answering another version needs a newer SDK. */
export const AI_CATALOG_VERSION = 1;

/**
 * The host to read: `$XANOSDK_AI_CATALOG_URL`, then the sign-in server the
 * active OAuth profile was minted at, then the default sign-in server. A base
 * path on the value is kept, and a trailing slash dropped.
 */
export function resolveAiCatalogHost(savedAuthHost?: string): string {
  return (readEnvVar(AI_CATALOG_URL_ENV) ?? savedAuthHost ?? DEFAULT_AUTH_HOST).replace(/\/+$/, "");
}

function failure(state: AiCatalogFailure, host: string, message: string, exitCode: number, cause?: unknown): CliError {
  return new CliError("SDK_ERROR", message, { details: { state, host }, exitCode, cause });
}

function projectEntry(raw: Record<string, unknown>): AiCatalogEntry | undefined {
  const model = asString(raw.model);
  if (model === undefined) return undefined;
  return {
    model,
    label: asString(raw.label) ?? model,
    tier: asString(raw.tier) ?? "",
    stage: asString(raw.stage) ?? "",
    suggested: raw.suggested === true,
    // Absent reads as listed: an unlisted entry is one the host marked so.
    listed: raw.listed !== false,
    price: asString(raw.price) ?? "",
    location: asString(raw.location) ?? "",
    locations: asStringArray(raw.locations),
    options: { ...(asRecord(raw.options) ?? {}) },
  };
}

function projectEntries(v: unknown): AiCatalogEntry[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    const rec = asRecord(e);
    const entry = rec === undefined ? undefined : projectEntry(rec);
    return entry === undefined ? [] : [entry];
  });
}

/** Project a raw answer. Exported for a script that already holds the body. */
export function projectAiCatalog(body: unknown): AiCatalog {
  const raw = asRecord(body) ?? {};
  const statements = asRecord(raw.statements) ?? {};
  const agent = asRecord(raw.agent) ?? {};
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    generated_at: asString(raw.generated_at),
    available: raw.available === true,
    fetched: raw.fetched === true,
    statements: Object.fromEntries(AI_STATEMENTS.map((s) => [s, projectEntries(statements[s])])) as Record<
      AiStatement,
      AiCatalogEntry[]
    >,
    agent: { default: asString(agent.default), models: asStringArray(agent.models) },
  };
}

/**
 * GET the catalog from `host` (see {@link resolveAiCatalogHost}) and project
 * it. Tokenless. Network and HTTP failures throw naming the host; the
 * `available` / `fetched` states are returned as read, for
 * {@link assertAiCatalogReady} to judge.
 */
export async function fetchAiCatalog(host: string): Promise<AiCatalog> {
  let url: URL;
  try {
    url = new URL(host.replace(/\/+$/, "") + AI_CATALOG_PATH);
  } catch {
    throw new Error(`The Xano AI catalog host is not a valid URL: ${JSON.stringify(host)}. Check ${AI_CATALOG_URL_ENV}.`);
  }

  // The body read shares the mapping: a body that stalls or aborts after the
  // headers is the same failure as a host that never answered.
  let res: Response;
  let text: string;
  try {
    res = await fetch(url.href, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(AI_CATALOG_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const why =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `no answer within ${AI_CATALOG_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    throw failure("unreachable", host, `Could not reach the Xano AI catalog at ${host}: ${why}.`, EXIT_SOURCE_UNRESOLVABLE, err);
  }

  if (!res.ok) {
    const detail = serverMessage(text);
    throw failure(
      "http",
      host,
      `The Xano AI catalog at ${host} returned ${statusLabel(res)}` + (detail !== undefined ? `:\n${detail}` : "."),
      res.status >= 500 ? EXIT_SOURCE_UNRESOLVABLE : 1,
    );
  }
  return projectAiCatalog(parseJsonAnswer(text, "Reading the Xano AI catalog", url.href));
}

/**
 * Refuse a catalog that cannot answer the question. The version is checked
 * first (a shape this SDK does not read answers nothing reliably), then
 * `available`, so a Xano with no Xano AI is never told to try again.
 */
export function assertAiCatalogReady(catalog: AiCatalog, host: string): void {
  if (catalog.version !== AI_CATALOG_VERSION) {
    throw failure(
      "unsupported",
      host,
      `The Xano AI catalog at ${host} is version ${catalog.version}; this SDK reads version ${AI_CATALOG_VERSION}. Upgrade @xano/sdk to read it.`,
      1,
    );
  }
  if (!catalog.available) {
    throw failure("unavailable", host, `Xano AI is not offered on this Xano (${host}).`, 1);
  }
  if (!catalog.fetched) {
    throw failure(
      "not-fetched",
      host,
      `The Xano AI catalog at ${host} is not ready: catalog not fetched yet, try again in a minute.`,
      EXIT_SOURCE_UNRESOLVABLE,
    );
  }
}

/** Fetch, project and check in one call: what a maintainer script wants. */
export async function readAiCatalog(host: string = resolveAiCatalogHost()): Promise<AiCatalog> {
  const catalog = await fetchAiCatalog(host);
  assertAiCatalogReady(catalog, host);
  return catalog;
}
