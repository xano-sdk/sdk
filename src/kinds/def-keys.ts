/**
 * The top-level keys each def kind reads, for the untyped caller.
 *
 * The typed surface refuses a misspelt def key; plain JavaScript, a spread
 * config or a value that crossed an `any` did not, and the key was silently
 * dropped — `agent({ tool: [t] })` exported with no tools — or, worse, read by a
 * sibling kind sharing the encoder: `agent({ instructions })` landed in the
 * toolset's MCP `instructions`. `register*` checks every def against its kind's
 * roster before encoding, naming the nearest key.
 *
 * Each roster is an object literal `satisfies Record<keyof Def, 1>`, so it
 * cannot fall behind its interface: a key added to the def without being added
 * here, or listed here without existing there, is a compile error. The extras
 * are the accessors a factory adds to its handle.
 */
import type { AddonDef } from "./addon.js";
import type { AgentDef } from "./agent.js";
import type { ApiGroupDef, ApiGroupDocumentationDef, CorsConfig } from "./api-group.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import type { CacheXdo } from "../types/xdo.js";
import type { FunctionDef } from "../function/define.js";
import type { KnowledgeDef } from "./knowledge.js";
import type { McpServerDef } from "./mcp-server.js";
import type {
  ContainerEnv, ContainerPort, ContainerResources, ContainerVolume, MicroserviceChart, MicroserviceConfig, MicroserviceContainer,
  MicroserviceDef, MicroserviceDeployment, MicroserviceIngress, MicroserviceIngressPath, MicroserviceRegistryAuth, MicroserviceVolume,
} from "./microservice.js";
import type { MiddlewareDef } from "./middleware.js";
import type { QueryDef } from "./query.js";
import type { ChannelConversationDef, ChannelDeliveryDef, ChannelPublishDef, ChannelRateLimitDef, RealtimeChannelDef } from "./realtime-channel.js";
import type { RealtimeMessageDef } from "./realtime-message.js";
import type { RealtimeServerDef } from "./realtime-server.js";
import type { TableDef, ViewDef } from "./table.js";
import type { ScheduleDef, TaskDef } from "./task.js";
import type { ToolDef } from "./toolset.js";
import type { PromptDef } from "./prompt.js";
import type { ResourceDef } from "./resource.js";
import type { TriggerDef } from "./trigger.js";
import type { WorkflowTestDef } from "./workflow-test.js";
import type { WorkspaceConfigDef, WorkspaceDefaultsDef, WorkspaceMiddlewareDef, WorkspacePreferences } from "./workspace-config.js";
import { nearestKey } from "../util/known-keys.js";
import { WORKSPACE_HISTORY_TYPES } from "./history.js";

type Roster<D> = Record<keyof D, 1>;
const keys = (roster: object, ...extra: string[]): readonly string[] => [...Object.keys(roster), ...extra];

const COMMON = { __kind: 1, name: 1, guid: 1, description: 1, tags: 1 } as const;
const STACK = { input: 1, stack: 1, response: 1, responseShape: 1, history: 1, middleware: 1 } as const;
const TOOLSET = { ...COMMON, docs: 1, history: 1, output: 1, enabled: 1, canonical: 1, tools: 1, llm: 1, diagnostics: 1 } as const;

/** Every key a def of each registry kind may carry, by kind name. */
export const DEF_KEYS: Readonly<Record<string, readonly string[]>> = {
  query: keys(
    { ...COMMON, ...STACK, verb: 1, apiGroup: 1, apiGroupId: 1, diagnostics: 1, auth: 1, docs: 1, responseType: 1,
      apiEnabled: 1, disabled: 1, cache: 1, tests: 1, example: 1 } satisfies Roster<QueryDef>,
    "getPath", "toSearchParams",
  ),
  function: keys(
    { ...COMMON, ...STACK, docs: 1, cache: 1, tests: 1, workspace: 1, diagnostics: 1 } satisfies Roster<FunctionDef>,
  ),
  task: keys(
    { ...COMMON, docs: 1, middleware: 1, history: 1, stack: 1, datasource: 1, active: 1, schedule: 1, diagnostics: 1 } satisfies Roster<TaskDef>,
  ),
  table: keys(
    { ...COMMON, auth: 1, docs: 1, __cols: 1, __row: 1, __internal: 1, install: 1, schema: 1, system: 1, idType: 1,
      useXdo: 1, index: 1, autocomplete: 1, external: 1, views: 1, seed: 1, publicSeed: 1, diagnostics: 1 } satisfies Roster<TableDef>,
  ),
  middleware: keys(
    { ...COMMON, ...STACK, docs: 1, tests: 1, resultStrategy: 1, exceptionPolicy: 1, diagnostics: 1 } satisfies Roster<MiddlewareDef>,
  ),
  addon: keys(
    { ...COMMON, input: 1, table: 1, tableAlias: 1, where: 1, sort: 1, context: 1, output: 1, cardinality: 1, group: 1,
      eval: 1, __graft: 1, diagnostics: 1 } satisfies Roster<AddonDef>,
  ),
  agent: keys(TOOLSET satisfies Roster<AgentDef>, "getCanonical"),
  mcp_server: keys(
    { ...TOOLSET, instructions: 1, spec: 1, prompts: 1, resources: 1, oauth: 1 } satisfies Roster<McpServerDef>,
    "getCanonical", "getPath", "getUrl",
  ),
  tool: keys(
    { ...COMMON, ...STACK, docs: 1, enabled: 1, instructions: 1, toolsetId: 1, diagnostics: 1, title: 1, annotations: 1,
      icons: 1, output: 1 } satisfies Roster<ToolDef>,
  ),
  prompt: keys(
    { ...COMMON, ...STACK, docs: 1, title: 1, icons: 1, diagnostics: 1 } satisfies Roster<PromptDef>,
  ),
  resource: keys(
    { ...COMMON, ...STACK, docs: 1, uri: 1, mimeType: 1, title: 1, icons: 1, annotations: 1, diagnostics: 1 } satisfies Roster<ResourceDef>,
  ),
  realtime_server: keys(
    { ...COMMON, diagnostics: 1, middleware: 1, history: 1, enabled: 1, canonical: 1 } satisfies Roster<RealtimeServerDef>,
    "getCanonical", "getPath", "getUrl",
  ),
  channel: keys(
    { ...COMMON, middleware: 1, history: 1, input: 1, active: 1, server: 1, anonymousClients: 1, presence: 1, publish: 1,
      conversation: 1, delivery: 1, rateLimit: 1, diagnostics: 1 } satisfies Roster<RealtimeChannelDef>,
    "getChannel",
  ),
  message: keys(
    { ...COMMON, ...STACK, auth: 1, disabled: 1, active: 1, server: 1, channel: 1, deliverTo: 1, diagnostics: 1 } satisfies Roster<RealtimeMessageDef>,
  ),
  knowledge: keys({ ...COMMON, enabled: 1, type: 1, mode: 1, body: 1, refs: 1, diagnostics: 1 } satisfies Roster<KnowledgeDef>),
  workflow_test: keys(
    { ...COMMON, docs: 1, stack: 1, datasource: 1, active: 1, diagnostics: 1 } satisfies Roster<WorkflowTestDef>,
  ),
  api_group: keys(
    { ...COMMON, docs: 1, middleware: 1, history: 1, canonical: 1, documentation: 1, swagger: 1, apiGroupEnabled: 1,
      cors: 1, diagnostics: 1 } satisfies Roster<ApiGroupDef>,
  ),
  microservice: keys(
    { ...COMMON, kind: 1, tenantDeploy: 1, deployment: 1, ingresses: 1, configs: 1, volumes: 1, chart: 1,
      registryAuth: 1, diagnostics: 1 } satisfies Roster<MicroserviceDef>,
  ),
  trigger: keys(
    { ...COMMON, history: 1, stack: 1, response: 1, responseShape: 1, active: 1, objType: 1, toolsetType: 1, objId: 1, hasResult: 1,
      meta: 1, diagnostics: 1 } satisfies Roster<TriggerDef>,
  ),
  workspace: keys(
    { __kind: 1, name: 1, diagnostics: 1, description: 1, middleware: 1, history: 1, canonical: 1, use_xdo: 1,
      preferences: 1, realtime: 1, documentation: 1, swagger: 1, env: 1, settings: 1, use_custom_names: 1, defaults: 1,
      datasources: 1, datasource_live: 1 } satisfies Roster<WorkspaceConfigDef>,
  ),
};

const MIDDLEWARE = keys({ pre: 1, post: 1 } satisfies Roster<MiddlewareAttach>);
const CACHE = keys({ active: 1, ttl: 1, input: 1, auth: 1, datasource: 1, ip: 1, headers: 1, env: 1 } satisfies Roster<CacheXdo>);

/**
 * The nested records each kind reads, by field path (`[]` for each entry of a
 * list): a misspelt nested key was dropped just like a top-level one —
 * `schedule: [{ startOn }]` exported with no start, `cors: { allowOrigin }` open.
 * `middleware` is checked on every kind that carries it.
 */
export const NESTED_DEF_KEYS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  query: { cache: CACHE },
  function: { cache: CACHE },
  table: {
    "views[]": keys({ name: 1, id: 1, alias: 1, hide: 1, q: 1, where: 1, sort: 1 } satisfies Roster<ViewDef>),
  },
  task: {
    "schedule[]": keys(
      { startsOn: 1, freq: 1, repeatEnabled: 1, endsOn: 1, endsEnabled: 1 } satisfies Roster<ScheduleDef>,
    ),
  },
  microservice: {
    deployment: keys({ replicas: 1, strategy: 1, docker: 1, containers: 1 } satisfies Roster<MicroserviceDeployment>),
    "deployment.containers[]": keys(
      { name: 1, image: 1, pullSecret: 1, type: 1, command: 1, args: 1, env: 1, ports: 1, resources: 1, volumes: 1 } satisfies Roster<MicroserviceContainer>,
    ),
    "deployment.containers[].env[]": keys({ name: 1, value: 1, fromEnv: 1 } satisfies Roster<ContainerEnv>),
    "deployment.containers[].ports[]": keys({ servicePort: 1, containerPort: 1 } satisfies Roster<ContainerPort>),
    "deployment.containers[].resources": keys({ cpu: 1, ram: 1 } satisfies Roster<ContainerResources>),
    "deployment.containers[].volumes[]": keys(
      { name: 1, type: 1, persistent: 1, emptyDir: 1, config: 1 } satisfies Roster<ContainerVolume>,
    ),
    "ingresses[]": keys({ name: 1, domain: 1, paths: 1 } satisfies Roster<MicroserviceIngress>),
    "ingresses[].paths[]": keys({ service: 1, path: 1 } satisfies Roster<MicroserviceIngressPath>),
    "configs[]": keys({ name: 1, type: 1, value: 1 } satisfies Roster<MicroserviceConfig>),
    "volumes[]": keys({ name: 1, size: 1, class: 1 } satisfies Roster<MicroserviceVolume>),
    chart: keys({ ref: 1, values: 1, version: 1 } satisfies Roster<MicroserviceChart>),
    registryAuth: keys({ type: 1, server: 1, dockerconfigjson: 1 } satisfies Roster<MicroserviceRegistryAuth>),
  },
  api_group: {
    cors: keys(
      { mode: 1, allowOrigins: 1, allowHeaders: 1, allowCredentials: 1, maxAge: 1, allowMethods: 1 } satisfies Roster<CorsConfig>,
    ),
    "cors.allowMethods": keys(
      { delete: 1, get: 1, head: 1, patch: 1, post: 1, put: 1 } satisfies Roster<NonNullable<CorsConfig["allowMethods"]>>,
    ),
    documentation: keys({ require_token: 1, token: 1 } satisfies Roster<ApiGroupDocumentationDef>),
  },
  channel: {
    publish: keys({ who: 1, direct: 1 } satisfies Roster<ChannelPublishDef>),
    conversation: keys({ enabled: 1, limit: 1, ttl: 1 } satisfies Roster<ChannelConversationDef>),
    delivery: keys({ guarantee: 1, perRecipient: 1 } satisfies Roster<ChannelDeliveryDef>),
    rateLimit: keys({ messagesPerMinute: 1 } satisfies Roster<ChannelRateLimitDef>),
  },
  workspace: {
    preferences: keys({ allow_push: 1, track_performance: 1, use_internal_docs: 1 } satisfies Roster<WorkspacePreferences>),
    // The workspace's own middleware is per host tier, each a `{ pre, post }`.
    middleware: keys({ query: 1, function: 1, task: 1, tool: 1 } satisfies Roster<WorkspaceMiddlewareDef>),
    "middleware.query": MIDDLEWARE,
    "middleware.function": MIDDLEWARE,
    "middleware.task": MIDDLEWARE,
    "middleware.tool": MIDDLEWARE,
    // WHOLESALE maps: a key nothing reads falls back to its default silently.
    history: WORKSPACE_HISTORY_TYPES,
    defaults: keys({ db_primary_key: 1 } satisfies Roster<WorkspaceDefaultsDef>),
  },
};

/**
 * Blocks carried verbatim, so a member this SDK does not model is kept — but a
 * key one edit from a modeled one (`enabeld`, `require_tokn`) is a typo, and is
 * refused as one.
 */
const NEAR_MISS_DEF_KEYS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  workspace: {
    realtime: ["hash", "mode", "enabled", "channels"],
    documentation: ["require_token", "token", "whitelist"],
  },
};

/** The records at `path` in `def` — one, or each entry of a `[]` list — with where each sits. */
function recordsAt(def: unknown, path: string): Array<[string, unknown]> {
  let at: Array<[string, unknown]> = [["", def]];
  for (const part of path.split(".")) {
    const list = part.endsWith("[]");
    const field = list ? part.slice(0, -2) : part;
    at = at.flatMap(([where, v]): Array<[string, unknown]> => {
      if (typeof v !== "object" || v === null) return [];
      const next = (v as Record<string, unknown>)[field];
      const label = where ? `${where}.${field}` : field;
      if (!list) return [[label, next]];
      return Array.isArray(next) ? next.map((e, i): [string, unknown] => [`${label}[${i}]`, e]) : [];
    });
  }
  return at.filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v));
}

/**
 * Refuse a key `known` does not list: `agent "helper": unknown key "tool" — did
 * you mean "tools"? …`. For the untyped caller; the typed one never gets here.
 * With `kind`, the kind's nested records ({@link NESTED_DEF_KEYS}) are held to
 * theirs too.
 */
export function assertDefKeys(owner: string, def: unknown, known: readonly string[] | undefined, kind?: string): void {
  if (known === undefined || typeof def !== "object" || def === null) return;
  refuseUnknown(owner, def, known);
  const nested: Record<string, readonly string[]> = { middleware: MIDDLEWARE, ...(kind ? NESTED_DEF_KEYS[kind] : {}) };
  for (const [path, roster] of Object.entries(nested)) {
    for (const [where, record] of recordsAt(def, path)) refuseUnknown(`${owner} \`${where}\``, record as object, roster);
  }
  for (const [path, roster] of Object.entries((kind && NEAR_MISS_DEF_KEYS[kind]) || {})) {
    for (const [where, record] of recordsAt(def, path)) {
      const typos = Object.keys(record as object).filter((k) => !roster.includes(k) && nearestKey(k, roster) !== undefined);
      if (typos.length > 0) refuseUnknown(`${owner} \`${where}\``, Object.fromEntries(typos.map((k) => [k, 1])), roster);
    }
  }
}

/** Refuse a key of `def` that `known` does not list, in the one wording every owner shares. */
export function refuseUnknown(owner: string, def: object, known: readonly string[]): void {
  for (const key of Object.keys(def)) {
    if (known.includes(key)) continue;
    const near = nearestKey(key, known) ?? known.find((k) => k.length > 3 && (key.startsWith(k) || k.startsWith(key)));
    throw new Error(
      `${owner}: unknown key "${key}"${near ? ` — did you mean "${near}"?` : "."} Nothing reads it, so it would ` +
        `not do what it says. Keys this def takes: ${known.filter((k) => !k.startsWith("__") && !/^get[A-Z]/.test(k) && k !== "token").join(", ")}.` +
        // A literal token is refused at export: it is a secret, never source.
        (known.includes("token") ? " A token is not written here — it comes from `xano/.secrets.json`." : ""),
    );
  }
}
