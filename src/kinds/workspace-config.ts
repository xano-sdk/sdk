/**
 * Workspace config kind → payload key `workspace` (singleton object, not
 * an array). Emits the author-provided settings subset; the engine fills the
 * remaining server-managed fields on import. Authoring shape validated
 * against the Xano engine's persisted workspace shape.
 *
 * Two blocks — `preferences` and `settings` — merge over a named engine default
 * rather than passing through, so an author can name one flag without restating
 * the twenty members beside it and still send complete bytes. Codegen subtracts
 * the same defaults on the way back out.
 */
import type { StackItemXdo } from "../types/xdo.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeMiddlewareList } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { buildWorkspaceHistory } from "./history.js";
import type { WorkspaceHistoryDef, WorkspaceHistoryXdo } from "./history.js";
import { assertCanonical } from "./stored-name.js";
import { env } from "../values/value.js";
import { describeEntry } from "../statements/args.js";
import type { Value } from "../values/value.js";
import { brandDef } from "./def-brand.js";
import { findNonJson, nonJsonMessage } from "../workspace/non-json.js";

/**
 * The three preferences the workspace settings form persists.
 *
 * These are the keys the engine stores — a pulled workspace carries
 * `allow_push`, `track_performance`, and `use_internal_docs` — so the generated
 * `preferences: {...}` literal passes excess-property checking. (The form also
 * offers `use_marketplace`, which is browser local storage and never reaches
 * the workspace object.)
 */
export interface WorkspacePreferences {
  /** Allow this workspace to be pushed to a linked git remote. Default `false`. */
  allow_push?: boolean;
  /** Collect per-request performance samples. Default `true`. */
  track_performance?: boolean;
  /** Show the internal docs panel beside objects. Default `false`. */
  use_internal_docs?: boolean;
}

/**
 * Workspace-tier middleware — the **terminal fallback** of the
 * Query → API Group → Workspace chain. Keyed by host type; each host's
 * `pre`/`post` is the default chain a host of that type inherits when it (and,
 * for queries, its API group) don't customize. Unlike the object/group tiers
 * there are **no `_customize` flags** here — workspace is always terminal, so
 * an empty list simply means "no workspace-level middleware for that host".
 */
export interface WorkspaceMiddlewareDef {
  query?: MiddlewareAttach;
  function?: MiddlewareAttach;
  task?: MiddlewareAttach;
  tool?: MiddlewareAttach;
}

/** The stored 8-key workspace middleware map (`{objType}_{phase}`). */
export interface WorkspaceMiddlewareXdo {
  function_pre: StackItemXdo[];
  function_post: StackItemXdo[];
  query_pre: StackItemXdo[];
  query_post: StackItemXdo[];
  task_pre: StackItemXdo[];
  task_post: StackItemXdo[];
  tool_pre: StackItemXdo[];
  tool_post: StackItemXdo[];
}

/**
 * One non-live datasource defined on the workspace. `label` is the datasource
 * name queries target; `color` is the editor's tint for it.
 */
export interface WorkspaceDatasourceDef {
  label: string;
  color?: string;
}

/** Editor presentation for the `live` datasource, which has no `datasources[]` entry. */
export interface WorkspaceDatasourceLiveDef {
  color?: string;
  show_banner?: boolean;
}

/** Workspace-wide defaults applied when creating new objects. */
export interface WorkspaceDefaultsDef {
  /** Primary-key type new tables get when they don't declare one. */
  db_primary_key?: "int" | "uuid";
}

/**
 * The workspace config.
 *
 * Generic ONLY in the shape of `env`, and defaulted, so `WorkspaceConfigDef`
 * still names the whole set wherever one is expected. The parameter exists so
 * the declared variable NAMES survive inference through `workspaceConfig(...)`
 * and {@link typedEnv} can type them; without it the interface's own
 * `Record<string, string>` erases them at the first assignment.
 */
/**
 * The workspace's documentation gate, as an author writes it.
 *
 * Only the gate is modeled; everything else this SDK carries verbatim, because
 * the engine's block has members Xano SDK takes no position on. The index
 * signature is what keeps a pulled workspace's unmodeled members expressible.
 */
export interface WorkspaceDocumentationDef {
  /**
   * `true` gates the hosted docs behind a token, and IS the declaration that a
   * token exists — the value lives in `xano/.secrets.json` and is substituted
   * when a bundle is built.
   */
  require_token?: boolean;
  /**
   * REFUSED. A token is a secret and this is committed source, so spelling one
   * here fails the export. Set `require_token: true` and let `xanosdk pull` store
   * the value, or supply it with `--doc-token "workspace=<value>"`.
   */
  token?: string;
  /** IP/CIDR allowlist, as the engine stores it. Carried verbatim. */
  whitelist?: unknown;
  [member: string]: unknown;
}

export interface WorkspaceConfigDef<Env extends Record<string, string> = Record<string, string>> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "workspace";
  /**
   * OPTIONAL — omit it and the workspace inherits the name `workspace("…")`
   * already gave it.
   *
   * There is exactly one config per workspace and the entry point names it, so
   * restating it here was pure duplication that every documented example got
   * wrong: `workspace("app").registerWorkspace(workspaceConfig({ history }))`
   * failed to typecheck on a field the registry already knew. Supply it only to
   * override, or when building a config with no `workspace("…")` above it.
   */
  name?: string;
  description?: string;
  canonical?: string;
  /**
   * Default storage mode for tables in this workspace: `true` stores fields as
   * JSON under each table's `xdo` column, `false` (the default) gives them real
   * Postgres columns. The source of truth a table's own `use_xdo` mirrors — keep
   * them in sync (see {@link TableDef.useXdo}).
   */
  use_xdo?: boolean;
  preferences?: WorkspacePreferences;
  /**
   * The workspace's LEGACY realtime block, carried verbatim.
   *
   * Not the realtime primitives this SDK authors — those are `realtimeServer` /
   * `realtimeChannel` / `realtimeMessage`, each its own object with its own
   * canonical. This is the older workspace-level block that predates them, and
   * Xano SDK models none of its members: whatever the engine stored is round-
   * tripped as-is, so a pulled workspace keeps it without this SDK taking a
   * position on a shape it does not author.
   *
   * Omit it. It exists so the round trip is honest, not to be authored — and
   * omitting it emits no `realtime` key, so a deploy leaves the target's stored
   * block alone rather than replacing it with the engine's empty default.
   */
  realtime?: Record<string, unknown>;
  /**
   * The workspace's public-documentation block — the gate on the hosted docs.
   *
   * OMIT IT and no `documentation` key is emitted, which leaves the target's
   * live block exactly as it is. That is the only safe default: the block is
   * all-or-nothing, so emitting a default here would clear a Private doc site's
   * token, whitelist and `require_token` on the next deploy while leaving
   * {@link WorkspaceConfigDef.swagger} on.
   *
   * The TOKEN IS A SECRET and cannot be spelled here — a literal `token` fails
   * the export. Declaring the gate is all the source does:
   *
   * ```ts
   * documentation: { require_token: true }
   * ```
   *
   * The value lives in `xano/.secrets.json`, written by `xanosdk pull` and read
   * back when a bundle is built. It is NOT a backend env var: it never reaches
   * the workspace's own `env`, and `env(...)` in a stack does not read it. A
   * declared gate with no value anywhere refuses a `deploy`
   * (`--allow-empty-doc-token=workspace` opts out) and emits no block at all on
   * every other command, so an unsupplied gate can never clear the live one.
   *
   * Members other than the token are carried verbatim; this SDK models none of
   * them, so a pulled workspace keeps whatever the engine stored.
   */
  documentation?: WorkspaceDocumentationDef;
  /** Whether the workspace publishes a Swagger/OpenAPI spec. */
  swagger?: boolean;
  /**
   * Workspace-level default middleware chains (the terminal fallback tier).
   * Emitted only when provided — a workspace config without this field leaves
   * the engine's existing workspace middleware untouched on import (consistent
   * with this kind's author-provided-subset contract).
   *
   * WHOLESALE, not partial: once set, the full 8-key `{host}_{phase}` map is
   * emitted and any host/phase you don't list is emitted empty. The workspace
   * tier has no per-key `_customize` flag, so an empty list means "no middleware"
   * — deploying `{ query: { pre: [x] } }` **clears** any UI-configured
   * `function_*`/`task_*`/`tool_*`/`query_post` middleware. Declare every
   * workspace-level chain you want to keep. Branch-tier middleware is not
   * modeled; the engine falls through absent branch middleware to this tier.
   */
  middleware?: WorkspaceMiddlewareDef;
  /**
   * Workspace-level default request history (the terminal fallback tier). A
   * scalar per object type; every type an object of that kind inherits when it
   * (and, for queries/tools, its container) doesn't customize. Unlike the
   * object/container tiers there is **no `inherit` flag** — the workspace is
   * always terminal.
   *
   * WHOLESALE, not partial: once set, the full 14-key `{objType}_enabled`/
   * `{objType}_limit` map is emitted and any type you don't list falls back to
   * its engine default (`enabled` per the kind rule, `limit:100`) — deploying
   * `{ query: 100 }` overwrites any UI-configured `function_*`/`task_*`/… values.
   * Declare every workspace-level default you want to keep. Branch-tier history
   * is not modeled; the engine falls through absent branch history to this tier.
   */
  history?: WorkspaceHistoryDef;
  /**
   * Workspace **environment variables** — the secrets/config a tenant reads at
   * request time with `env("NAME")` (→ `$env.NAME`). Authored as an ergonomic
   * name→value map; Xano SDK encodes it to the engine's persisted `env[]` array
   * of `{ name, value, market_item }`. Order is preserved.
   *
   * VALUES ARE SECRETS. Prefer sourcing them from the deploy environment rather
   * than committing literals — `env: { STRIPE_KEY: process.env.STRIPE_KEY! }` —
   * and don't commit a compiled bundle that contains real values.
   *
   * WRITE SEMANTICS DIFFER BY COMMAND, and the difference is not cosmetic:
   *
   * - `deploy` (ephemeral) REPLACES the tenant's env with this map — the
   *   workspace object is restored wholesale on import, so a key absent here is
   *   dropped, and an empty value is written as an empty string.
   * - A merge (`deploy --to <workspace|tenant:…>`, `promote`, `tenant deploy`)
   *   is ADD-ONLY, matched BY NAME. It creates names that do not yet exist on
   *   the target and does NOT update or remove ones that do — the TARGET's
   *   value wins for every name it already has. Changing a value in code and
   *   merging leaves the live value as it was.
   * - `deploy --to … --replace` replaces, but it rebuilds the whole workspace
   *   to do it. Expected consequence: the replace drops every env var the
   *   target holds that this config does NOT declare. The env set becomes
   *   exactly what is declared here, so a name set only on the target — added
   *   through the UI, or by an earlier release — is gone afterwards. The CLI
   *   names those before it runs and asks to confirm; declare the name here to
   *   keep it.
   *
   * So a value you need to CHANGE on an instance workspace cannot be changed by
   * an ordinary merge today. Omit the field entirely to leave existing env
   * untouched on every path.
   *
   * The add-only rule is what makes ONE release promotable to several
   * environments: set each target's env once, and a release cut from a dev
   * environment leaves those values alone. The gap it does not cover is a NEWLY
   * declared name — the target does not have it yet, so it is created carrying
   * whatever value the release was cut with.
   *
   * This is the SETTER — the {@link env} value helper is the READER. Distinct
   * from the built-in request-context vars (`sys.*`).
   */
  env?: Env;
  /**
   * Workspace settings (AI provider config, agent visibility). Modeled as an
   * opaque map — declare only the members you want to change; the rest are
   * filled from the engine's own default scaffold on export.
   */
  settings?: Record<string, unknown>;
  /**
   * Allow tables to carry custom SQL names distinct from their workspace names.
   * Emitted only when set — omit to leave the tenant's current setting alone.
   */
  use_custom_names?: boolean;
  /**
   * Workspace-wide defaults for newly created objects. Emitted only when set,
   * so omitting it leaves the tenant's configured defaults untouched.
   */
  defaults?: WorkspaceDefaultsDef;
  /**
   * The workspace's non-live datasources, as the workspace records them.
   * ⚠ A deploy does NOT apply this list: the import creates no datasource and
   * removes none, on any target. It is carried so a pulled workspace
   * round-trips. A datasource that requests select (`X-Data-Source`) or a
   * trigger filters on must already exist in the target workspace — create it
   * in the workspace's datasource settings; a request naming one that does not
   * exist runs on `live` or fails.
   */
  datasources?: WorkspaceDatasourceDef[];
  /** Editor presentation for the `live` datasource. Emitted only when set. */
  datasource_live?: WorkspaceDatasourceLiveDef;
  /** Accepted export warnings, workspace-wide (e.g. env names set only in the dashboard). Never emitted. */
  diagnostics?: DiagnosticsFor<"workspace">;
}

/** One persisted workspace env var (engine `env[]` element). */
export interface WorkspaceEnvXdo {
  name: string;
  value: string;
  /** Marketplace-provenance links; always empty for author-declared vars. */
  market_item: never[];
}

/**
 * The engine's empty LEGACY realtime block — what a workspace that never used the
 * older workspace-level realtime carries.
 *
 * No longer emitted when the author omits the field: omission means "leave the
 * target's block alone". It is still named here because codegen has to RECOGNIZE
 * it — a pulled workspace storing exactly this decodes to no entry at all
 * (`WORKSPACE_DEFAULTED_KEYS`), so a generated tree does not carry four lines
 * nobody wrote.
 */
export const LEGACY_REALTIME: Readonly<Record<string, unknown>> = {
  hash: "",
  mode: "",
  enabled: false,
  channels: [],
};

/**
 * The engine's default documentation block — docs open, no token, no whitelist.
 *
 * Recognized, never emitted; see {@link LEGACY_REALTIME}. This is also the exact
 * payload that made the reported defect: sent to a target whose docs were
 * Private, it cleared the token, cleared the whitelist and reset `require_token`
 * while leaving `swagger` on.
 */
export const DEFAULT_DOCUMENTATION: Readonly<Record<string, unknown>> = {
  token: "",
  whitelist: {},
  require_token: false,
};

/**
 * The engine's default preferences — what the settings form writes when nothing
 * has been touched. 174 of the 177 workspaces in the sweep store exactly this.
 *
 * Merged under whatever the author declares, for the same reason
 * {@link DEFAULT_DOCUMENTATION} is emitted whole: the round trip then matches a
 * real export rather than an invented `{}`, and codegen can leave
 * the block out of a generated tree entirely.
 */
export const DEFAULT_PREFERENCES: WorkspacePreferences = {
  allow_push: false,
  track_performance: true,
  use_internal_docs: false,
};

/**
 * The engine's default `settings` block — AI off, every provider unconfigured,
 * the free provider selected.
 *
 * `settings` is otherwise opaque to this SDK (`Record<string, unknown>`), and it
 * was encoded as `{}` when absent, which no real workspace stores. Naming the
 * scaffold is what lets a pulled workspace that never touched AI settings omit
 * the whole block instead of carrying twenty lines of empty strings — and what
 * keeps the bytes a deploy sends complete rather than relying on the engine to
 * fill them.
 *
 * An author may write just the members they care about — see
 * {@link mergeOverDefaults} — so departing from one member does not mean
 * spelling the other twenty.
 */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  ai_enabled: false,
  ai_settings: {
    providers: {
      google: { model: "", api_key: "" },
      openai: { model: "", api_key: "" },
      anthropic: { model: "", api_key: "" },
      "azure-openai": { model: "", api_key: "", base_url: "", api_version: "" },
    },
    default_provider: "free",
  },
  hide_xano_agent: false,
};

/**
 * The author's block laid over the engine's default one, member by member.
 *
 * Every workspace the engine has saved stores `preferences` and `settings`
 * WHOLE, so an author who only wants `ai_enabled: true` would otherwise have to
 * restate four provider configs to keep the bytes a deploy sends complete — and
 * a pulled workspace would carry all twenty-odd lines back into its generated
 * tree for the sake of one flag. Merging lets both sides name only the
 * departure, and codegen subtracts the same defaults on the way back out.
 *
 * Recursive because the scaffold is: `ai_settings.providers.openai.api_key` is
 * three levels down, and a shallow spread of `ai_settings` would drop the three
 * providers the author did not mention. Arrays and scalars REPLACE — only plain
 * objects merge — so a list is never half the author's and half the default's.
 */
export function mergeOverDefaults<T extends object>(defaults: T, authored: T | undefined, field = ""): T {
  return mergeOver(
    defaults as Record<string, unknown>,
    (authored ?? {}) as Record<string, unknown>,
    field,
  ) as T;
}

function mergeOver(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = out[key];
    const at = path === "" ? key : `${path}.${key}`;
    out[key] = isPlainRecord(under) && isPlainRecord(value) ? mergeOver(under, value, at) : plainClone(value, at);
  }
  return out;
}

/**
 * A copy of an authored free-form value, refused by path when JSON cannot carry
 * it. `structuredClone` threw its own `()=>42 could not be cloned.` for a
 * function or symbol — naming neither the field nor the fix — and copied a Date
 * or Map faithfully, only for the bundle to store an ISO string or `{}`.
 */
function plainClone(value: unknown, at: string): unknown {
  const found = findNonJson(value);
  if (found !== undefined) {
    const path = found.path === "" ? at : found.path.startsWith("[") ? `${at}${found.path}` : `${at}.${found.path}`;
    throw new Error(nonJsonMessage("workspaceConfig", path, found.value));
  }
  return structuredClone(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface WorkspaceConfigXdo {
  name: string;
  description: string;
  canonical: string;
  use_xdo: boolean;
  preferences: WorkspacePreferences;
  /**
   * Emitted BY PRESENCE, like the four `?=`-optional blocks below and for a
   * sharper reason: omitting either leaves a tenant's live block alone, where
   * writing the engine's empty default CLEARS a documentation gate or a legacy
   * realtime binding. See `WORKSPACE_DEFAULTED_KEYS`, which verification reads
   * so the absence compares equal rather than reading as a loss.
   */
  realtime?: Record<string, unknown>;
  documentation?: Record<string, unknown>;
  swagger: boolean;
  /** Present only when the author sets `middleware` (author-provided subset). */
  middleware?: WorkspaceMiddlewareXdo;
  /** Present only when the author sets `history` (author-provided subset). */
  history?: WorkspaceHistoryXdo;
  env: WorkspaceEnvXdo[];
  settings: Record<string, unknown>;
  /**
   * The four blocks below are `?=`-optional in the engine's workspace schema and
   * are emitted **by presence only** — written when the author sets them, absent
   * when they don't. (`datasources` is carried for round-trip only; the import
   * does not apply it — see {@link WorkspaceConfigDef.datasources}.)
   *
   * Codegen going the OTHER way does compare against the default, because the
   * engine materializes all four on save and carrying them into a pulled tree is
   * ten lines nobody wrote — see `WORKSPACE_DEFAULTED_KEYS`, which verification
   * reads too so the elision is an equivalence rather than a loss.
   */
  use_custom_names?: boolean;
  defaults?: WorkspaceDefaultsDef;
  datasources?: WorkspaceDatasourceDef[];
  datasource_live?: WorkspaceDatasourceLiveDef;
}

/**
 * Encode the author's name→value env map into the engine's persisted `env[]`
 * array, preserving insertion order. Each var carries an empty `market_item`
 * (author-declared vars have no marketplace provenance).
 */
export function encodeWorkspaceEnv(env: Record<string, string>): WorkspaceEnvXdo[] {
  return Object.entries(env).map(([name, value]: [string, unknown]) => {
    // `process.env.NOT_SET!` type-checks and is `undefined` at runtime. It was
    // written with no `value` key at all while the CLI reported the name as
    // sent EMPTY; it is now exactly that — `""`, a value the deploy supplies
    // from `xano/.env` or refuses to send unsupplied.
    if (value === undefined) value = "";
    // A number or object was written verbatim, where the engine stores text.
    if (typeof value !== "string") {
      throw new Error(
        `workspaceConfig: env "${name}" is ${value === null ? "null" : typeof value}; an env value is a ` +
          `string. Write \`String(value)\`, or \`""\` to leave it for the backend's .env to supply.`,
      );
    }
    return { name, value, market_item: [] };
  });
}

/** Encode the author's per-host middleware into the flat 8-key stored map. */
function encodeWorkspaceMiddleware(m: WorkspaceMiddlewareDef): WorkspaceMiddlewareXdo {
  return {
    function_pre: encodeMiddlewareList(m.function?.pre),
    function_post: encodeMiddlewareList(m.function?.post),
    query_pre: encodeMiddlewareList(m.query?.pre),
    query_post: encodeMiddlewareList(m.query?.post),
    task_pre: encodeMiddlewareList(m.task?.pre),
    task_post: encodeMiddlewareList(m.task?.post),
    tool_pre: encodeMiddlewareList(m.tool?.pre),
    tool_post: encodeMiddlewareList(m.tool?.post),
  };
}

/**
 * The stored `documentation` block for one authored workspace block.
 *
 * Carried verbatim: this SDK models none of the block's members beyond the gate,
 * so a pulled workspace keeps whatever the engine stored. A literal `token` is
 * carried through as authored rather than stripped here — it is refused at
 * export by `checkDocumentationTokens`, which is where every finding in a build
 * lands in one bag, so an author sees the whole set rather than fixing one and
 * re-running.
 */
function encodeWorkspaceDocumentation(doc: WorkspaceDocumentationDef): Record<string, unknown> {
  // A `token` key that carries nothing is DROPPED, so `require_token: true`
  // still reads as a declared gate. `declaresDocumentationGate` tests for the
  // key's absence, so `token: undefined` — which an author writes by spreading
  // an optional value in — would otherwise leave the block looking resolved and
  // ship a gate with no token behind it. The API-group encoder makes the same
  // decision; both scopes have to, or the two disagree on one authored shape.
  const { token, ...rest } = doc;
  return typeof token === "string" && token !== "" ? { ...rest, token } : rest;
}

export function encodeWorkspaceConfig(def: WorkspaceConfigDef): WorkspaceConfigXdo {
  // Present-but-empty is accepted. A real instance holds a workspace whose
  // stored `name` is `""` — the engine allows it — and refusing that spelling
  // made a faithful pull of it impossible to export at all, which is the SDK
  // inventing a stricter rule than the engine's.
  //
  // Absent reaches here only when nothing named the workspace at all:
  // `Xano.registerWorkspace` fills the field from the name `workspace("…")`
  // set, which is why the def type no longer demands it. The bundle
  // still needs a name, so this stays an error — it just names the fix now.
  if (def.name === undefined || def.name === null) {
    throw new Error(
      "workspace: no name. `workspaceConfig({ name })` is optional because the config " +
        'inherits the name from `workspace("…")` — so either start from `workspace("my-app")` ' +
        "or give this config an explicit `name`.",
    );
  }
  assertCanonical(`workspace "${def.name}"`, def.canonical);
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    use_xdo: def.use_xdo ?? false,
    preferences: mergeOverDefaults(DEFAULT_PREFERENCES, def.preferences, "preferences"),
    // PRESENCE-ONLY, both of them. `?? DEFAULT` here is what made the wipe
    // expressible: an author who deleted a secret-bearing block from source got
    // `{token:"", whitelist:{}, require_token:false}` sent to the target, which
    // is a Private doc site turned public with nothing said. Omission now means
    // "leave the live block alone", which is what an author deleting it meant.
    ...(def.realtime !== undefined ? { realtime: def.realtime } : {}),
    ...(def.documentation !== undefined
      ? { documentation: encodeWorkspaceDocumentation(def.documentation) }
      : {}),
    swagger: def.swagger ?? false,
    ...(def.middleware !== undefined
      ? { middleware: encodeWorkspaceMiddleware(def.middleware) }
      : {}),
    ...(def.history !== undefined ? { history: buildWorkspaceHistory(def.history) } : {}),
    env: def.env ? encodeWorkspaceEnv(def.env) : [],
    settings: mergeOverDefaults(DEFAULT_SETTINGS, def.settings, "settings"),
    // Presence-preserving: each key is written only when the author set it, and
    // each nested optional likewise, so a pulled workspace re-exports to its own
    // bytes whether or not the engine happened to store the `?=` default.
    ...(def.use_custom_names !== undefined ? { use_custom_names: def.use_custom_names } : {}),
    ...(def.defaults !== undefined ? { defaults: { ...def.defaults } } : {}),
    ...(def.datasources !== undefined
      ? { datasources: def.datasources.map((d) => ({ ...d })) }
      : {}),
    ...(def.datasource_live !== undefined ? { datasource_live: { ...def.datasource_live } } : {}),
  };
}

export const workspaceKind: ObjectKind<WorkspaceConfigDef, WorkspaceConfigXdo> = {
  name: "workspace",
  payloadKey: "workspace",
  encode: encodeWorkspaceConfig,
};
registerKind(workspaceKind);

/**
 * Declare the workspace-level config object.
 *
 * Generic ONLY over the `env` map, so the declared variable NAMES survive
 * inference and {@link typedEnv} can type them. Everything else is
 * {@link WorkspaceConfigDef} unchanged, and the returned value is still an
 * ordinary `WorkspaceConfigDef` everywhere one is expected.
 */
export function workspaceConfig<const E extends Record<string, string> = Record<string, string>>(
  def: WorkspaceConfigDef<E>,
): WorkspaceConfigDef<E> {
  return brandDef(def, "workspace");
}

/**
 * A typed reader for a workspace's OWN declared environment variables.
 *
 * `env("NAME")` takes a bare string and is checked against nothing at the call
 * site, so a misspelled name type-checks, exports, deploys, and then resolves to
 * null on the first request — the value simply is not there, and the failure
 * surfaces wherever the null lands rather than where the typo is. That is the
 * one value tag with no compile-time guard; `inp()` and `ref()` both have one.
 *
 * Hand the config to this and the declared names become properties:
 *
 * ```ts
 * const config = workspaceConfig({ env: { STRIPE_KEY: process.env.STRIPE_KEY! } });
 * const E = typedEnv(config);
 * s.api.request({ url: …, headers: { Authorization: E.STRIPE_KEY } });  // autocompletes
 * E.STRIP_KEY;                                                          // compile error
 * ```
 *
 * Each property yields a fresh `env(name)` value, identical to what the string
 * form builds — this is a typing device, not a different encoding.
 *
 * It types only what the CONFIG declares. A variable set in the dashboard and
 * never written here is real and readable; reach it with `env("NAME")` as
 * before. The export-time `stack.env-undeclared` warning makes the same
 * distinction, and for the same reason.
 */
export function typedEnv<const Names extends string>(config: {
  env?: Readonly<Record<Names, string>>;
}): { readonly [K in Names]: Value } {
  // Through `any`, `typedEnv(null)` / `typedEnv()` read `.env` off nothing.
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(
      `typedEnv() takes the workspaceConfig({ env }) it reads names from — got ${describeEntry(config)}.`,
    );
  }
  const declared = (config as { env?: unknown }).env;
  if (declared !== undefined && declared !== null && (typeof declared !== "object" || Array.isArray(declared))) {
    throw new Error(`typedEnv(): the config's \`env\` must be a { NAME: value } record — got ${describeEntry(declared)}.`);
  }
  const out = {} as { [K in Names]: Value };
  for (const name of Object.keys(config.env ?? {}) as Names[]) {
    Object.defineProperty(out, name, { get: () => env(name), enumerable: true });
  }
  return out;
}
