/**
 * The marketplace catalogue — the three public reads behind `xanosdk marketplace
 * list` / `search` / `details`.
 *
 * Everything here is unauthenticated. The catalogue is a public index, so these
 * reads take no token, touch no credential file, and work signed out; that is
 * the whole reason discovery can be a first-class verb rather than something you
 * do in a browser before you can use the CLI.
 *
 * All three verbs return the one whole-record {@link CatalogueModule}: a caller
 * piping `list`, `search` or `details` never has to learn which one happens to
 * carry more, and a catalogue UI fills every card from one `list` rather than a
 * `details` per module. `search` filters the `plugins` list here rather than
 * calling `plugins-search`, because that route answers a trimmed row — with no
 * `deleted` column either, so it could not drop a reserved name.
 *
 * Projection is field-by-field rather than a cast, for the same reason
 * `fetchProfile` projects: it pins the output contract to this file. A column
 * added upstream cannot silently widen what the CLI prints, and a column removed
 * upstream shows up as `undefined` here instead of a shape error downstream.
 *
 * Node-only by virtue of nothing — it is plain `fetch` — but it is reached only
 * through the lazy `await import` in cli.ts, alongside the rest of the command
 * layer.
 */
import { readEnvVar } from "../util/env.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";
import { parseJsonAnswer, serverMessage, statusLabel } from "../util/http.js";

/**
 * Where the catalogue lives. Public, and documented as a permanent workspace
 * rather than a throwaway or expiring environment.
 *
 * It is still one hardcoded host in a published package: if it ever moves, every
 * installed copy of this CLI loses all three read verbs at once, and only a
 * release fixes it. `XANOSDK_MARKETPLACE_URL` is the reason that is survivable —
 * it repoints the reads without an upgrade.
 */
const DEFAULT_BASE_URL = "https://xare-rvr8-mnnt.dev.xano.io";

/**
 * Bound every read so a stalled catalogue cannot hang the CLI. Matches
 * `profile me`'s budget — same class of call, same patience.
 */
const CATALOGUE_TIMEOUT_MS = 30_000;

/**
 * The base URL, overridable so the suite never reaches the network and a host
 * change is a one-line escape hatch rather than a release. Follows
 * `XANOSDK_UPDATE_REGISTRY` in update-check.ts, which exists for both reasons.
 */
function baseUrl(): string {
  return readEnvVar("XANOSDK_MARKETPLACE_URL") ?? DEFAULT_BASE_URL;
}

/**
 * What a module extends: a `workspace` module registers objects into the
 * backend, a `toolchain` module extends the CLI and registers nothing.
 */
export type CatalogueKind = "workspace" | "toolchain";

/** The fields that identify a module and say what it is — what a listing line shows. */
export interface CatalogueRow {
  id: number | undefined;
  /** Web identity: the detail page and the `plugins/{slug}` route. NEVER an install argument. */
  slug: string | undefined;
  /** What `xanosdk marketplace install` takes. The headline field. */
  npm_package: string | undefined;
  title: string | undefined;
  tagline: string | undefined;
  tags: string[];
  repo_url: string | undefined;
  docs_url: string | undefined;
  /** Absent when the catalogue does not say. Otherwise known only once npm has installed the package. */
  kind: CatalogueKind | undefined;
}

/** One object a module puts on the workspace. */
export interface CatalogueInclude {
  /** table | endpoint | function | task | trigger | agent | mcp | middleware */
  kind: string | undefined;
  name: string | undefined;
  summary: string | undefined;
}

/** The whole record, as every verb returns it. */
export interface CatalogueModule extends CatalogueRow {
  description: string | undefined;
  includes: CatalogueInclude[];
  /**
   * What the developer has to supply. Objects rather than plain strings because
   * the underlying column splits its own elements on commas.
   */
  requirements: string[];
  /** The `xano/index.ts` registration, verbatim. */
  register_snippet: string | undefined;
  /** Written to be handed to a coding agent to do the wiring. */
  agent_prompt: string | undefined;
  /** Unlisting hides a module from the index; deleting is soft and reserves the name. */
  listed: boolean | undefined;
  deleted: boolean | undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function projectRow(raw: Record<string, unknown>): CatalogueRow {
  return {
    id: typeof raw.id === "number" ? raw.id : undefined,
    slug: asString(raw.slug),
    npm_package: asString(raw.npm_package),
    title: asString(raw.title),
    tagline: asString(raw.tagline),
    tags: asStringArray(raw.tags),
    repo_url: asString(raw.repo_url),
    docs_url: asString(raw.docs_url),
    // Closed set: an unknown kind is not passed through for a caller to guess at.
    kind: raw.kind === "workspace" || raw.kind === "toolchain" ? raw.kind : undefined,
  };
}

/**
 * `requirements` arrives as `[{text}]` — objects, not strings, because a
 * list-of-text column splits its own elements on commas. Flattened to strings
 * here so every consumer downstream deals in the thing a reader actually needs.
 */
function projectRequirements(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => (typeof entry === "string" ? entry : asString(asRecord(entry)?.text)))
    .filter((t): t is string => t !== undefined);
}

function projectIncludes(v: unknown): CatalogueInclude[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry) => {
    const rec = asRecord(entry);
    if (rec === undefined) return [];
    return [{ kind: asString(rec.kind), name: asString(rec.name), summary: asString(rec.summary) }];
  });
}

function projectModule(raw: Record<string, unknown>): CatalogueModule {
  return {
    ...projectRow(raw),
    description: asString(raw.description),
    includes: projectIncludes(raw.includes),
    requirements: projectRequirements(raw.requirements),
    register_snippet: asString(raw.register_snippet),
    agent_prompt: asString(raw.agent_prompt),
    listed: asBoolean(raw.listed),
    deleted: asBoolean(raw.deleted),
  };
}

/**
 * The catalogue said no. Carried as its own class so `details` can tell "no such
 * module" apart from "the catalogue is down" without matching on message text.
 */
export class ModuleNotFoundError extends Error {
  override readonly name = "ModuleNotFoundError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A non-OK response, carrying its status so the caller can decide what it means.
 *
 * The status is deliberately NOT interpreted down here. A 404 from
 * `plugins-details` means "no such module"; a 404 from `plugins` means the route
 * is gone, and reporting that as "no module is published under that name" would
 * describe a broken catalogue as an empty one.
 */
class CatalogueHttpError extends Error {
  override readonly name = "CatalogueHttpError";
  constructor(
    readonly status: number,
    /** The server's own sentence, when it sent one worth showing. */
    readonly detail: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The catalogue could not be read — no answer, or a 5xx: transient, exit 8. */
export class CatalogueUnreachableError extends Error {
  override readonly name = "CatalogueUnreachableError";
  readonly exitCode = EXIT_SOURCE_UNRESOLVABLE;
}

/** Whether `err` is the catalogue being down rather than an answer about the name. */
export function isCatalogueOutage(err: unknown): boolean {
  return err instanceof CatalogueUnreachableError || (err instanceof CatalogueHttpError && err.status >= 500);
}

/** GET `path`, with the timeout, the status handling, and the parse guard all in one place. */
async function read(path: string, params?: Record<string, string>): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(path, baseUrl());
  } catch {
    // Only reachable through a malformed override. Naming it beats a bare
    // `TypeError: Invalid URL`, which reads as a bug in the CLI.
    throw new Error(
      `XANOSDK_MARKETPLACE_URL is not a valid URL: ${JSON.stringify(process.env.XANOSDK_MARKETPLACE_URL)}`,
    );
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  let res: Response;
  try {
    res = await fetch(url.href, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
  } catch (err) {
    // Offline, DNS, TLS, or the timeout firing. The reader needs to know it was
    // the network and not their argument, so this never reaches them as a bare
    // `TypeError: fetch failed`.
    throw new CatalogueUnreachableError(
      `Could not reach the marketplace catalogue at ${url.origin} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = serverMessage(text);
    throw new CatalogueHttpError(
      res.status,
      detail,
      `The marketplace catalogue returned ${statusLabel(res)} for ${url.pathname}` +
        (detail !== undefined ? `:\n${detail}` : "."),
    );
  }

  // The shared reader: a non-JSON answer names the host and says what arrived
  // in one line — never the route, and never the body (an HTML error page from
  // a proxy printed whole).
  return parseJsonAnswer(text, "Reading the marketplace catalogue", url.href);
}

/**
 * Name what actually arrived when the envelope is not what we read for. Without
 * this, a paging envelope appearing upstream surfaces as `.map is not a
 * function` — a stack trace about our code for a change in theirs.
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return `an object with keys ${keys.length > 0 ? keys.join(", ") : "(none)"}`;
  }
  return typeof value;
}

function expectArray(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${path} to return a list of modules, got ${describe(value)}.`);
  }
  return value.flatMap((entry) => {
    const rec = asRecord(entry);
    return rec === undefined ? [] : [rec];
  });
}

/**
 * The whole catalogue, newest first.
 *
 * Soft-deleted rows are dropped here. The route returns `deleted` on every
 * record, so honoring it costs one predicate and removes any dependence on
 * whether the server filters — and a module whose name is merely reserved is not
 * something to offer someone as installable.
 */
export async function fetchCatalogue(): Promise<CatalogueModule[]> {
  const path = "/api:marketplace/plugins";
  return expectArray(await read(path), path)
    .filter((raw) => raw.deleted !== true)
    .map(projectModule);
}

/**
 * The columns search reads. Tags are not among them: the catalogue's own search
 * does not match on a tag, and this matches it result for result.
 */
const SEARCHED: ReadonlyArray<keyof CatalogueModule> = ["title", "slug", "npm_package", "tagline", "description"];

/**
 * The catalogue modules whose title, slug, package, tagline or description
 * contains `query` as one phrase, ignoring case. Empty `query` matches
 * everything. Catalogue order is kept.
 */
export async function searchCatalogue(query: string): Promise<CatalogueModule[]> {
  const needle = query.toLowerCase();
  return (await fetchCatalogue()).filter((mod) =>
    SEARCHED.some((column) => {
      const value = mod[column];
      return typeof value === "string" && value.toLowerCase().includes(needle);
    }),
  );
}

/** One module by npm package name or slug. Throws {@link ModuleNotFoundError} when there is no such module. */
export async function fetchModule(pkg: string): Promise<CatalogueModule> {
  const path = "/api:marketplace/plugins-details";

  let body: unknown;
  try {
    body = await read(path, { package: pkg });
  } catch (err) {
    // A 404 means "no such module" HERE, and only here. The interpretation is
    // the caller's because the same status on a list route means the route is
    // gone — a broken catalogue, not an empty one.
    if (err instanceof CatalogueHttpError && err.status === 404) {
      throw new ModuleNotFoundError(err.detail ?? "No module is published under that name.");
    }
    throw err;
  }

  // A miss can also arrive as `200 null` rather than a 404. Same meaning to the
  // reader, so it gets the same error rather than a shape complaint.
  if (body === null) {
    throw new ModuleNotFoundError("No module is published under that name.");
  }

  const raw = asRecord(body);
  if (raw === undefined) {
    throw new Error(`Expected ${path} to return one module, got ${describe(body)}.`);
  }
  return projectModule(raw);
}
