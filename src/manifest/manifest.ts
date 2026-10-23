/**
 * Agent-grounding manifest (DX follow-up). A machine-readable description of the
 * entire xanosdk authoring surface — object kinds, statement catalog (with field
 * schemas for the declarative statements), value constructors, and tag catalog —
 * plus a human/LLM-readable `llms.txt` renderer.
 *
 * Everything here is DERIVED from the SDK's own sources of truth (the surface
 * catalog, the generated statement specs, the kind registry, the value/tag
 * primitives), so the manifest can never drift from what the SDK can actually
 * emit. Regenerate the committed `manifest.json` / `llms.txt` with
 * `npm run manifest`; the manifest test fails if they fall out of sync.
 */
// Side-effect imports: ensure every kind + statement is registered so the
// manifest's coverage reflects the full SDK regardless of how it's loaded.
import "../kinds/all.js";
import { AGENT_SIGNUP_URL } from "../auth/agent-signup.js";
import "../statements/s.js";
import { GENERATED_SPECS } from "../statements/generated/specs.generated.js";
import { SUPERSEDED_STATEMENTS } from "../statements/superseded.js";
import { DECODE_ONLY_STATEMENTS } from "../statements/decode-only.js";
import { UNCONFIRMED_STATEMENTS, UNCONFIRMED_NOTE } from "../statements/byte-evidence.js";
import {
  PRECONDITION_ERROR_STATUS,
  PRECONDITION_ERROR_TYPES,
} from "../statements/special/precondition.js";
import { HEADER_DUPLICATES, STORAGE_ACCESS } from "../statements/special/closed-sets.js";
import type { StatementSpec } from "../statements/schema-dsl/interpret.js";
import {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  sPathOf,
} from "../statements/surfaces.js";
import { isRegisteredStatement } from "../statements/statement.js";
import { isRegisteredKind } from "../kinds/kind.js";
import { TAGS } from "../types/xdo.js";
import { LAMBDA_BINDINGS, LAMBDA_GLOBALS, LAMBDA_MODULE_GLOBALS } from "../values/lambda.js";
import type { LambdaSurface } from "../values/lambda.js";
import { FILTER_NAMES, FILTER_SPECS } from "../values/generated/filters.generated.js";
import { FIELD_METHODS } from "../fields/generated/field-methods.generated.js";
import {
  COMMANDS,
  FLAGS,
  GLOBAL_FLAGS,
  flagSpec,
  flagSummary,
  publishedFlagValues,
  selectorValues,
  visibleFlags,
} from "../emit/commands.js";
import type { ArgSpec, CommandSpec, SubcommandSpec, FlagRef, SelectorSpec } from "../emit/commands.js";
import { sourceSpellings } from "../emit/source-selector.js";

/**
 * One entry in the engine's object-kind catalog — the coverage DENOMINATOR,
 * enumerated rather than asserted as a bare number.
 *
 * The engine counts each trigger TYPE as its own object kind, while this SDK
 * models them as sub-kinds of a single `trigger` kind. A count of registered SDK
 * kinds therefore understated coverage by seven, which is why the denominator is
 * a named list now: the number is derived from entries that each say which
 * factory authors them, and an unmapped entry has to explain itself.
 */
export interface EngineObjectKind {
  /** Engine object-kind name. */
  kind: string;
  /**
   * The SDK factory that authors it, or `null` when this SDK models no kind for
   * it. Pinned in both directions against {@link KIND_DESCRIPTORS} (including
   * sub-kind factories), so neither table can drift from the other.
   */
  authorFactory: string | null;
  /** Why an unmapped kind is absent. Required exactly when `authorFactory` is null. */
  absence?: string;
}

/** A statement field, flattened from its generated spec rule. */
export interface ManifestField {
  name: string;
  /** `string` (a plain string arg), `value` (a tagged `Value`), or `comparison`. */
  type: StatementSpec["rules"][number]["type"];
  optional: boolean;
  default?: string;
  /**
   * The field's closed set of legal values, where the engine declares one. Both
   * a bare literal and the `c.text(...)` spelling are accepted, and a constant
   * outside the set is rejected at authoring time.
   */
  enum?: string[];
}

/** One statement authoring surface. */
export interface ManifestStatement {
  /** Canonical surface key (the engine schema basename), e.g. `array.filter`. */
  surface: string;
  /** Stored `mvp:` name emitted into the bundle. */
  storedName: string;
  /** Dotted accessor under `s`, e.g. `array.filter` → `s.array.filter`. */
  sPath: string;
  /** Whether the stored name has a registered factory (authorable today). */
  registered: boolean;
  /** True when generated from the engine schema (carries a field schema). */
  declarative: boolean;
  /** Whether the statement emits an `output` envelope. Declarative only. */
  output?: boolean;
  /**
   * What the statement's `as:` output variable holds — so the manifest answers
   * "what does this bind?" without falling back to prose. Curated (see
   * `STATEMENT_RESULTS`); present only for statements whose result is stable and
   * documented. Analogous to {@link ManifestFilter.result}, but structured: `name`
   * is the binding field (always `as` today, carried explicitly so the descriptor
   * is self-describing for machine consumers), `type` its value type, `note` an
   * optional caveat.
   */
  result?: { name: string; type: string; note?: string };
  /** Field schema — present for declarative statements. */
  fields?: ManifestField[];
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored — same
   * contract as {@link ManifestValue.legacy}: withheld from the per-namespace
   * catalog an agent picks from, and named-only in the legacy index (`llms/legacy.md`).
   */
  legacy?: boolean;
}

/**
 * One authoring factory within a kind that fans out into several distinct
 * root factories sharing a single encoder/payload key — today only `trigger`
 * (six `obj_type`s, one shared stored envelope). Each sub-kind is a first-class
 * root factory in its own right; the manifest lists them individually so agents
 * treat them like every other primitive.
 */
export interface ManifestSubKind {
  /** Root authoring factory export, e.g. `tableTrigger`. */
  authorFactory: string;
  /** The stored `obj_type` this factory produces, e.g. `database`. */
  objType: string;
  /** Rich "what this primitive does" descriptor, in the style of a top-level kind. */
  description: string;
  /** Built and registered, but withheld from the published catalog — see {@link ManifestKind.unpublished}. */
  unpublished?: boolean;
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored — same
   * contract as {@link ManifestValue.legacy}: withheld from the sub-kind catalog
   * and the trigger prose, and named-only in the legacy index (`llms/legacy.md`).
   *
   * Distinct from `unpublished`, which withholds a factory that is not ready.
   * A legacy factory is fully ready and fully supported; it is the *paradigm*
   * that has been superseded.
   */
  legacy?: boolean;
}

/** One top-level object kind. */
export interface ManifestKind {
  /** Stable kind name, e.g. `function`. */
  kind: string;
  /** `packageExport` payload key, e.g. `function`, `dbo`. */
  payloadKey: string;
  /** Authoring factory export, e.g. `defineFunction`, `table`. */
  authorFactory: string;
  /** One-line "what this primitive does" descriptor, surfaced in `llms.txt`. */
  description: string;
  /** `Xano` registration method, e.g. `registerFunctions`. */
  registerMethod: string;
  /** Whether the kind has a registered encoder (implemented today). */
  registered: boolean;
  /**
   * Distinct root factories that all persist under this kind's encoder/payload
   * key. When present, the `## Object kinds` catalog lists each sub-kind as its
   * own root-level entry instead of the grouped `authorFactory` line. Only
   * `trigger` uses this today.
   */
  subKinds?: ManifestSubKind[];
  /**
   * Built and registered, but deliberately withheld from the published agent
   * surface — kept out of the emitted manifest, out of `llms.txt`, and out of
   * the coverage numerator.
   *
   * This is a *release* gate, not a completeness gate. The kind still has a
   * descriptor here so the "descriptors match the live kind registry" drift
   * guard keeps covering it; it just does not ship in the catalog yet. Flip the
   * flag off to publish — nothing else needs to change.
   */
  unpublished?: boolean;
}

/** A value constructor / helper. */
export interface ManifestValue {
  name: string;
  signature: string;
  description: string;
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored.
   *
   * Kept out of the `## Values` catalog — the list an agent picks from when it
   * builds — and named-only in the legacy index (`llms/legacy.md`).
   * That split is the whole point: hiding it entirely is worse than useless,
   * because a pulled workspace can legitimately contain one, and an agent that
   * has never heard of it will "fix" what it does not recognize. Naming it
   * without a signature says "you will see this; do not reach for it."
   */
  legacy?: boolean;
}

/** One value-pipeline filter (`fl.<name>`). */
export interface ManifestFilter {
  /** Filter name, as stored in the value `filters[]` chain. */
  name: string;
  /** Dotted accessor: `fl.<name>`. */
  fl: string;
  /**
   * Whether the SDK knows this filter's exact signature.
   *
   * True for every filter with a spec — INCLUDING the zero-argument ones. A
   * filter that takes nothing has nothing to type, so `fl.abs()` is as fully
   * typed as `fl.add(value)`; counting it as untyped reported a 131/225 coverage
   * gap that never existed. Whether a filter takes arguments is `args`, which is
   * a different question and the one the catalog renders from.
   */
  typed: boolean;
  /**
   * Takes arguments the catalog declares no list for, so there is no arity to
   * enforce and no signature to print. Distinct from a filter with neither
   * `args` nor `variadic`, which takes NOTHING.
   */
  variadic?: boolean;
  /**
   * Named, typed args (richly-specified filters only). `enum` carries the exact
   * accepted spellings where the arg has a closed set — printed in place of the
   * bare word "enum", which told a reader nothing.
   */
  args?: Array<{ name: string; type: string; optional?: boolean; enum?: string[] }>;
  /** Result type (richly-specified filters only). */
  result?: string;
  /** Group, e.g. `timestamp`, `vector` (richly-specified filters only). */
  group?: string;
  /** One-line description, when known. */
  description?: string;
}

/** One field-catalog type (`f.<name>` / `input.<name>`). */
export interface ManifestFieldType {
  /** Authoring constructor name under `f` / `input`, e.g. `text`, `tableRef`. */
  name: string;
  /** The stored type string emitted into the schema, e.g. `epochms`, `blob_img`. */
  stored: string;
  /** Valid bind-method names for this type (empty = none; `{name,arg}` escape hatch only). */
  methods: string[];
  /** Present and true when the type exists under `input.` only, with no `f.` column form. */
  inputOnly?: boolean;
}

/** One CLI flag, with the effect it has. */
export interface ManifestCliFlag {
  flag: string;
  description: string;
  /** The closed set the flag takes here — the same list shell completion offers. */
  values?: string[];
  /** For a flag that takes other values too: some it takes, never the whole set. */
  examples?: string[];
}

/**
 * One backend selector slot, from its declaration in the registry: where a
 * command takes the backend it acts on, and which ones. The same declaration
 * renders `--help`, completion, and the command's refusals, so an agent reading
 * this learns exactly what the CLI will accept.
 */
export interface ManifestCliSelector {
  /** How the slot is written: `--from`, `--to`, `--on`, or the positional as `<source>`. */
  slot: string;
  role: SelectorSpec["role"];
  /** Omitted: `tracked` = what this project last deployed to; `entry` = the project's entry file; `none` = nothing, name one. */
  default: SelectorSpec["default"];
  /** Every spelling the slot accepts, rendered. */
  grammar: string;
  /** The bare kinds, completable as typed. */
  values: string[];
  /** Kinds in the grammar this command cannot serve, each with why. */
  refused?: Record<string, string>;
}

/**
 * One CLI command, DERIVED from the `COMMANDS`/`FLAGS` registry in
 * `src/emit/commands.ts` — the same table that renders `--help` and generates the
 * shell completions.
 *
 * Derived, not hand-maintained: a hand-maintained copy drifts (missing commands,
 * short flags, stale descriptions). Deriving it makes that class of drift
 * unrepresentable, which matters because `llms.txt` does not document the CLI
 * — this array and `--help` are the only two surfaces, and they are one source.
 */
export interface ManifestCliCommand {
  /** The invocation verb, e.g. `deploy`. */
  command: string;
  /** Positional argument grammar, when the command takes one. */
  args?: string;
  flags?: ManifestCliFlag[];
  /** The command's backend selector slots, when it acts on a backend. */
  selectors?: ManifestCliSelector[];
  description: string;
}

export interface Manifest {
  name: string;
  version: string;
  description: string;
  coverage: {
    /**
     * Counted over the ENGINE's object-kind catalog, where every trigger type is
     * its own kind. `unmodeled` names the shortfall so the denominator is
     * inspectable rather than a bare ratio.
     */
    objectKinds: {
      implemented: number;
      total: number;
      unmodeled: { kind: string; absence: string }[];
    };
    /**
     * `unconfirmed` names the statements built from the engine's schema alone,
     * with no stored instance behind them — the same "make the denominator
     * inspectable" move as `unmodeled` above, for a different kind of
     * shortfall. Published as `s.` paths, because that is what an agent looks a
     * statement up by. See `src/statements/byte-evidence.ts`.
     */
    statements: {
      implemented: number;
      total: number;
      /**
       * Omitted entirely when nothing is unconfirmed — an empty warning channel
       * that ships on every build teaches a reader to skip the one time it has
       * something in it.
       */
      unconfirmed?: { note: string; sPaths: string[] };
    };
    filters: { typed: number; total: number };
  };
  values: {
    constructors: ManifestValue[];
    tags: readonly string[];
  };
  objectKinds: ManifestKind[];
  fieldTypes: ManifestFieldType[];
  statements: ManifestStatement[];
  filters: ManifestFilter[];
  /** The CLI command surface (compile/export/deploy/auth/lock). Hand-maintained. */
  cli: ManifestCliCommand[];
  /**
   * Flags every command accepts. They appear in no per-command `flags` list, so
   * without this they would be undiscoverable from the manifest alone — an agent
   * reading `cli` would conclude `--json` does not exist.
   */
  cliGlobalFlags: ManifestCliFlag[];
}

/**
 * The CLI command surface, structured for programmatic agents that read
 * `manifest.json` directly (the prose walkthrough lives in `llms.txt`). There is
 * no SDK source of truth for CLI verbs, so this list is hand-maintained: keep it
 * in sync with `USAGE` / the dispatch in `src/emit/cli.ts` when commands change.
 */
/** `[{name, required}]` → the usage grammar string, e.g. `<file> [dir]`. */
function argGrammar(args: readonly { name: string; required: boolean }[] | undefined): string | undefined {
  if (args === undefined || args.length === 0) return undefined;
  return args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

/**
 * A command's flag refs → the manifest's `{flag, description}` pairs.
 *
 * Through `flagSpec`, the same resolver `--help` and shell completion use, so a
 * command's own spec override reaches the manifest too. Inlining the shared
 * registry entry instead published `--seed` for `release create` beside a
 * description saying it takes ids — an internally contradictory row, in the
 * file `llms.txt` points agents at as the full CLI surface.
 */
function flagsOf(refs: readonly FlagRef[] | undefined): ManifestCliFlag[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  return refs.map((ref) => ({ flag: flagSpec(ref), description: flagSummary(ref), ...publishedFlagValues(ref) }));
}

/** A verb's selector slots → the manifest's `selectors`, positionals first. */
function selectorsOf(
  args: readonly ArgSpec[] | undefined,
  refs: readonly FlagRef[] | undefined,
): ManifestCliSelector[] | undefined {
  const slots: Array<[string, SelectorSpec]> = [
    ...(args ?? []).flatMap((a) => (a.selector ? [[`<${a.name}>`, a.selector] as [string, SelectorSpec]] : [])),
    ...(refs ?? []).flatMap((r) =>
      typeof r !== "string" && r.selector ? [[`--${r.key}`, r.selector] as [string, SelectorSpec]] : [],
    ),
  ];
  if (slots.length === 0) return undefined;
  return slots.map(([slot, sel]) => ({
    slot,
    role: sel.role,
    default: sel.default,
    grammar: sourceSpellings(sel.accepted),
    values: selectorValues(sel),
    ...(sel.refused !== undefined ? { refused: { ...(sel.refused as Record<string, string>) } } : {}),
  }));
}

/**
 * Flatten the registry into one manifest entry per invocable verb. A command with
 * subcommands contributes one entry per subcommand (`ephemeral get`) rather than a
 * single `ephemeral list|get|delete` row, so grepping the manifest for the verb an
 * agent means to run actually finds it. Removed verbs are omitted — they exist in
 * the registry only to fail loudly with an explanation.
 */
/**
 * The flags accepted whatever the command, from the same registry `buildCli`
 * reads. Kept beside `cli` rather than repeated onto all 35 commands: they are
 * one fact, and duplicating it is how a copy drifts.
 */
function buildCliGlobalFlags(): ManifestCliFlag[] {
  return GLOBAL_FLAGS.map((key) => ({
    flag: FLAGS[key].spec,
    description: FLAGS[key].summary,
  }));
}

function buildCli(): ManifestCliCommand[] {
  const out: ManifestCliCommand[] = [];
  for (const [name, spec] of Object.entries(COMMANDS) as [string, CommandSpec][]) {
    const description =
      spec.aliasOf === undefined ? spec.summary : `${spec.summary} (alias of \`${spec.aliasOf}\`)`;
    const subs = Object.entries(spec.subcommands ?? {}) as [string, SubcommandSpec][];
    if (subs.length === 0) {
      out.push({
        command: name,
        ...(argGrammar(spec.args) !== undefined ? { args: argGrammar(spec.args)! } : {}),
        ...(flagsOf(visibleFlags(spec)) !== undefined ? { flags: flagsOf(visibleFlags(spec))! } : {}),
        ...(selectorsOf(spec.args, visibleFlags(spec)) !== undefined
          ? { selectors: selectorsOf(spec.args, visibleFlags(spec))! }
          : {}),
        description,
      });
      continue;
    }
    for (const [subName, sub] of subs) {
      // An unreleased verb is withheld from the manifest for the same reason it
      // is withheld from `--help`: this catalog is what an agent reads to learn
      // the CLI, and a command it cannot be told about yet must not appear.
      if (sub.unreleased !== undefined) continue;
      const args = argGrammar(sub.args ?? spec.args);
      const refs = sub.flags !== undefined ? visibleFlags(sub) : visibleFlags(spec);
      const flags = flagsOf(refs);
      const selectors = selectorsOf(sub.args ?? spec.args, refs);
      out.push({
        command: `${name} ${subName}`,
        ...(args !== undefined ? { args } : {}),
        ...(flags !== undefined ? { flags } : {}),
        ...(selectors !== undefined ? { selectors } : {}),
        description: sub.summary,
      });
    }
  }
  return out.sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * The implemented object kinds with their authoring + registration metadata.
 * `registered` is verified against the live kind registry at build time, and the
 * manifest test asserts payload keys match `registeredKinds()`. `mcp_server` and
 * `agent` are distinct kinds that both persist under the `toolset` payload key.
 *
 * These are XANOSDK kinds, which are not one-to-one with the engine's object
 * kinds — `trigger` covers seven of them. {@link ENGINE_OBJECT_KINDS} holds that
 * mapping, and is what coverage counts against.
 */
export const KIND_DESCRIPTORS: ReadonlyArray<Omit<ManifestKind, "registered">> = [
  { kind: "function", payloadKey: "function", authorFactory: "defineFunction", description: "Reusable server-side logic (a custom function) callable from any stack via `s.function.run`.", registerMethod: "registerFunctions" },
  { kind: "table", payloadKey: "dbo", authorFactory: "table", description: "A database table: typed columns (`f.*`), indexes, and views; the schema other kinds read and write.", registerMethod: "registerTables" },
  { kind: "query", payloadKey: "query", authorFactory: "query", description: "An HTTP API endpoint (verb + path) bound to an API group; the main request/response surface.", registerMethod: "registerQueries" },
  { kind: "api_group", payloadKey: "app", authorFactory: "apiGroup", description: "A container that groups queries under a shared base path, CORS, and swagger config.", registerMethod: "registerApiGroups" },
  {
    kind: "trigger",
    payloadKey: "trigger",
    authorFactory: "{tableTrigger,realtimeServerTrigger,realtimeChannelTrigger,mcpServerTrigger,agentTrigger,workspaceTrigger,errorTrigger}",
    description: "An event-driven handler fired by a DB write, a realtime server connection or channel join/leave/deliver, an MCP/agent connection, a branch lifecycle event, or an error — inputs are implied by type and arrive on the `t` handle.",
    registerMethod: "registerTriggers",
    subKinds: [
      { authorFactory: "tableTrigger", objType: "database", description: "Fires when rows change on a bound table (insert/update/delete/truncate). The changed row is exposed as `t.new`/`t.old`, typed to the table when a `table()` handle is bound. Config-only (no response). `search` filters rows in the DATABASE, so it uses `col(\"NEW.x\")`/`col(\"OLD.x\")`, not `t`; invalid with `truncate`, and insert/delete cannot read the absent side." },
      { authorFactory: "realtimeTrigger", objType: "workspace_realtime_channel", legacy: true, description: "the SUPERSEDED realtime trigger, against the workspace-global realtime layer — a different object from the current `channel`, despite the similar name. For a join hook use `realtimeChannelTrigger({ actions: { join: true } })`; for message handling use a `realtimeMessage()` handler, which is the equivalent of its `message` action (a message is its own object, not a trigger action)." },
      { authorFactory: "realtimeServerTrigger", objType: "realtime_server", description: "Fires when a client connects to or disconnects from a realtime server; inspect the connecting client and its permissions via `t`. Bind with `realtimeServer`. Response-bearing." },
      { authorFactory: "realtimeChannelTrigger", objType: "channel", description: "Fires when a client joins or leaves a channel; inspect the addressed channel path and the client via `t`. Bind with a `realtimeChannel()` handle (a bare path is ambiguous across servers). Response-bearing." },
      { authorFactory: "mcpServerTrigger", objType: "toolset", description: "Fires when an MCP client connects to a bound MCP server; filter its tools/prompts/resources via `t`. Response-bearing." },
      { authorFactory: "agentTrigger", objType: "toolset", description: "Fires when a client connects to a bound agent; gate or annotate its toolset via `t.toolset`/`t.tools`. Response-bearing." },
      { authorFactory: "workspaceTrigger", objType: "workspace", description: "Fires on branch lifecycle events (branch new/merge/live); inspect the from/to branch and action via `t`. Config-only." },
      { authorFactory: "errorTrigger", objType: "error", description: "Fires when an error signature is first seen, regresses, or is marked fixed; inspect the error, caller, statement, and occurrence counts via `t`. Config-only." },
    ],
  },
  { kind: "tool", payloadKey: "tool", authorFactory: "tool", description: "An agent/MCP tool: a callable capability with typed inputs an AI agent can invoke.", registerMethod: "registerTools" },
  { kind: "prompt", payloadKey: "prompt", authorFactory: "prompt", description: "An MCP prompt: typed arguments plus a stack that builds the messages an MCP client receives. Exposed by an `mcpServer`.", registerMethod: "registerPrompts" },
  { kind: "resource", payloadKey: "resource", authorFactory: "resource", description: "An MCP resource: contents an MCP client reads by URI (a literal or a `{variable}` template), produced by a stack. Exposed by an `mcpServer`.", registerMethod: "registerResources" },
  { kind: "mcp_server", payloadKey: "toolset", authorFactory: "mcpServer", description: "An MCP server exposing tools, prompts and resources to external MCP clients.", registerMethod: "registerMcpServers" },
  { kind: "agent", payloadKey: "toolset", authorFactory: "agent", description: "An AI agent: an LLM configuration plus the tools it can call. Invoke it from any stack (query/function/task/tool/trigger) with `s.ai.agent.run` — no public endpoint; the result is a rich envelope whose completion text is at `.result`.", registerMethod: "registerAgents" },
  { kind: "task", payloadKey: "task", authorFactory: "task", description: "A scheduled background job that runs a stack on a fixed interval (no cron).", registerMethod: "registerTasks" },
  { kind: "workflow_test", payloadKey: "workflow_test", authorFactory: "workflowTest", description: "An end-to-end test: a named stack with NO input and NO response that invokes other objects (`s.function.call`, `s.task.call`, `s.api.call`) and asserts on what they bind with `s.expect.*`. `datasource`: `llms/kinds-core.md`.", registerMethod: "registerWorkflowTests" },
  { kind: "middleware", payloadKey: "middleware", authorFactory: "middleware", description: "A reusable pre/post stack attached to a host (query, function, task, tool, API group, prompt, resource, realtime server/channel/message) to run before or after its own logic.", registerMethod: "registerMiddleware" },
  { kind: "addon", payloadKey: "addon", authorFactory: "addon", description: "A reusable read fragment that enriches a query result by joining related table data.", registerMethod: "registerAddons" },
  { kind: "realtime_server", payloadKey: "realtime_server", authorFactory: "realtimeServer", description: "A realtime (websocket) server: the canonical-addressed container that owns realtime channels. Off until `enabled: true`. Returns a handle with `getUrl(baseUrl)`/`getPath()` for the client's socket URL (`wss://<host>/ws/<canonical>`).", registerMethod: "registerRealtimeServers" },
  { kind: "channel", payloadKey: "channel", authorFactory: "realtimeChannel", description: "A realtime channel: a joinable path on a realtime server (`rooms/{room_id}`) with typed path params, join/publish policy, a client-visible conversation transcript, and delivery semantics. Owns message handlers. Returns a handle with `getChannel(params)` for the path a client joins.", registerMethod: "registerRealtimeChannels" },
  { kind: "message", payloadKey: "message", authorFactory: "realtimeMessage", description: "A realtime message handler: a named message type on a channel with its own typed payload and stack — the realtime analogue of a query. Pass the `realtimeChannel()` handle as `channel` and the owning server comes with it.", registerMethod: "registerRealtimeMessages" },
  { kind: "microservice", payloadKey: "microservice", authorFactory: "microservice", description: "A container workload deployed alongside the workspace, called from a stack with `s.microservice.request`. Def shapes (`builtin` containers vs a `helm` chart) and the SECRET-handling rules its config carries: `llms/statements-calls.md`.", registerMethod: "registerMicroservices" },
  {
    kind: "knowledge",
    payloadKey: "knowledge",
    authorFactory: "knowledge",
    description: "Markdown for the AIs that build the backend (never an `agent()` run): an `agents.md` of standing instructions, a `skill`, or a `doc`. The body is a markdown FILE via `knowledgeFile(\"./x.md\", import.meta.url)`; readers and `mode`: `llms/kinds-knowledge.md`.",
    registerMethod: "registerKnowledge",
  },
  { kind: "workspace", payloadKey: "workspace", authorFactory: "workspaceConfig", description: "Workspace-level configuration such as default middleware chains and request-history defaults per host kind.", registerMethod: "registerWorkspace" },
];

/**
 * The engine's full object-kind catalog, and which SDK factory authors each.
 *
 * This is the coverage denominator. Every trigger type is its own engine kind
 * even though this SDK groups them under one `trigger` kind, so the mapping is
 * to a FACTORY rather than to an SDK kind name — otherwise seven authorable
 * kinds read as unimplemented.
 *
 * An entry with `authorFactory: null` is a kind you cannot author here and
 * cannot pull into a generated tree. Each says why, in the same two categories
 * codegen's omission policy uses: *unmodeled* (a real authoring surface this SDK
 * has not built) versus *instance-owned* (records of what was done TO a
 * workspace, which are not workspace source and have nothing to author).
 */
export const ENGINE_OBJECT_KINDS: ReadonlyArray<EngineObjectKind> = [
  { kind: "addon", authorFactory: "addon" },
  { kind: "agent", authorFactory: "agent" },
  { kind: "agent_trigger", authorFactory: "agentTrigger" },
  { kind: "api_group", authorFactory: "apiGroup" },
  { kind: "branch", authorFactory: null, absence: "instance-owned: a branch is instance state, not workspace source" },
  { kind: "channel", authorFactory: "realtimeChannel" },
  { kind: "channel_trigger", authorFactory: "realtimeChannelTrigger" },
  { kind: "error_trigger", authorFactory: "errorTrigger" },
  { kind: "function", authorFactory: "defineFunction" },
  { kind: "market_item", authorFactory: null, absence: "instance-owned: marketplace provenance belongs to the instance that installed it" },
  { kind: "mcp_server", authorFactory: "mcpServer" },
  { kind: "mcp_server_trigger", authorFactory: "mcpServerTrigger" },
  { kind: "message", authorFactory: "realtimeMessage" },
  { kind: "microservice", authorFactory: "microservice" },
  { kind: "knowledge", authorFactory: "knowledge" },
  { kind: "middleware", authorFactory: "middleware" },
  { kind: "prompt", authorFactory: "prompt" },
  { kind: "query", authorFactory: "query" },
  {
    kind: "realtime_channel",
    authorFactory: null,
    absence:
      "unmodeled: the SUPERSEDED workspace-global realtime channel. Its trigger is authorable (`realtimeTrigger`) so a legacy workspace's handlers survive a pull, but the channel object itself is not — author a `realtimeServer` + `realtimeChannel` instead",
  },
  { kind: "realtime_server", authorFactory: "realtimeServer" },
  { kind: "realtime_server_trigger", authorFactory: "realtimeServerTrigger" },
  { kind: "realtime_trigger", authorFactory: "realtimeTrigger" },
  { kind: "resource", authorFactory: "resource" },
  {
    kind: "run.job",
    authorFactory: null,
    absence:
      "not authorable, on the same grounds as branch/market_item: a run is a NAMED runnable registered against an account (it carries a user and a signature), not an object a workspace bundle carries — there is no `run` section in a bundle, only an install record. Nothing here targets one either: `s.cloud.job` takes an `image` and a `command` directly, so a containerized job is declared AT THE CALL and needs no separate definition",
  },
  {
    kind: "run.service",
    authorFactory: null,
    absence:
      "not authorable, for the same reason as run.job — account-registered state rather than workspace source. A long-running container in a workspace is a `microservice()`",
  },
  { kind: "table", authorFactory: "table" },
  { kind: "table_trigger", authorFactory: "tableTrigger" },
  {
    kind: "tablemap",
    authorFactory: null,
    absence: "unmodeled: a column mapping over a table, used to shape an external schema onto it",
  },
  { kind: "task", authorFactory: "task" },
  { kind: "tool", authorFactory: "tool" },
  { kind: "workflow_test", authorFactory: "workflowTest" },
  { kind: "workspace", authorFactory: "workspaceConfig" },
  { kind: "workspace_trigger", authorFactory: "workspaceTrigger" },
];

/** Total engine object kinds — the size of the catalog above, never a literal. */
export const TOTAL_OBJECT_KINDS = ENGINE_OBJECT_KINDS.length;

/**
 * Statement-namespace notes rendered under the catalog heading, for families
 * whose surfaces are only meaningful inside a particular host object.
 */
const NAMESPACE_NOTES: Readonly<Record<string, string>> = {
  // The Elasticsearch/OpenSearch note that stood here warned that those
  // credential and target fields were "typed optional but have NO engine
  // default - supply all". They are typed REQUIRED now, so the signature a few
  // lines down says it and a call omitting one does not compile. A warning that
  // restates the type costs every reader of this section and changes nothing an
  // agent writes.
  array:
    "`by` is a `$this` expression, NOT a column name: `by: ref(\"$this.id\")` (warns `stack.array-key-constant`). A predicate's `if` binds `$this` only; `$index` only in `partition` (warns `stack.array-index-unbound`).",
  debug:
    "`s.debug.stop` is a REAL terminator: it ends the request with HTTP 200 " +
    "`{ payload, statement: \"Stop & Debug\" }` (use `s.precondition` for an error status). Also exported flat as " +
    "`die()`; there is no `s.die`.",
  "(top-level)":
    "`s.throw` raises a named error `s.try_catch` catches; uncaught, it answers HTTP 200 " +
    "`{ payload, statement: \"Throw Error\" }`, or its `status` (100–599) when it sets one. Inside `s.db.transaction` " +
    "a throw or failed precondition rolls it back.",
  expect:
    "Assertions. Use only in a `workflowTest({...})` stack, asserting on what a `.call` " +
    "bound with `as`; elsewhere a failure aborts the request with HTTP 500 and the " +
    "assertion's message (`to_equal failed - expected value 2 does not equal 1`). " +
    "`to_throw` sees only an error carrying a MESSAGE, so an empty-message failure " +
    "(`ERROR_CODE_ACCESS_DENIED`) reports \"response is ok\", and `to_be_within` EXCLUDES " +
    "both bounds — `min < expr < max`.",
  util:
    "`s.util.sleep`'s `value` is in SECONDS; a decimal is allowed (`c.decimal(0.5)` = 500 ms); a negative value returns at once. " +
    "`s.util.set_header`'s `value` is a WHOLE `\"Name: value\"` line (there is no `name` field) — `c.text(\"X-Thing: on\")`; a line with no colon sends an empty header, and a `Content-Type` line is IGNORED when the response is an object/JSON (it applies to a `c.text()` response). " +
    "`s.util.template_engine`'s `value` is a Twig template with `$var`/`$input` in scope (`\"Hello {{ $var.who }}\"`); output is NOT HTML-escaped, a missing var renders `\"\"`, and a syntax error 500s.",
  text:
    "`name` is an EXISTING variable the statement acts on. `trim`/`ltrim`/`rtrim`/`append`/`prepend` " +
    "rewrite it IN PLACE and take no `as` (a non-text var is coerced, a null reads as `\"\"`); on the " +
    "trims `value` is a SET OF CHARACTERS to strip, not a substring (`\"abcHIcba\"` trimmed by `\"abc\"` → " +
    "`\"HI\"`). The predicates (`contains`/`icontains`/`starts_with`/`istarts_with`/`ends_with`/`iends_with`) " +
    "leave `name` unchanged and bind a boolean to `as` — without `as` they compute nothing (warns `stack.predicate-unbound`); an empty or " +
    "omitted needle is `true`. An undeclared `name` 500s `Missing var entry`.",
  workflow_test:
    "Run another workflow test from inside one. Pass the `workflowTest()` def handle, " +
    "not a name.",
};

/**
 * Author factories on the PUBLISHED surface — every descriptor factory, minus
 * anything withheld by `unpublished`, and taking a kind's sub-kind factories in
 * place of its grouped brace-list.
 */
export const PUBLISHED_AUTHOR_FACTORIES: ReadonlySet<string> = new Set(
  KIND_DESCRIPTORS.filter((d) => !d.unpublished).flatMap((d) =>
    d.subKinds
      ? d.subKinds.filter((sub) => !sub.unpublished).map((sub) => sub.authorFactory)
      : [d.authorFactory],
  ),
);

/**
 * Engine kinds this SDK can author today. An `unpublished` factory is withheld
 * here exactly as it is from the catalog, so the numerator keeps meaning "what
 * an agent can reach right now".
 */
export const IMPLEMENTED_OBJECT_KINDS: ReadonlyArray<EngineObjectKind & { authorFactory: string }> =
  ENGINE_OBJECT_KINDS.filter(
    (k): k is EngineObjectKind & { authorFactory: string } =>
      k.authorFactory !== null && PUBLISHED_AUTHOR_FACTORIES.has(k.authorFactory),
  );

/**
 * `{ unconfirmed }`, or nothing at all when every statement has evidence behind
 * it — spread into `coverage.statements` so the key is absent rather than empty.
 */
function unconfirmedCoverage(
  statements: readonly ManifestStatement[],
): { unconfirmed?: { note: string; sPaths: string[] } } {
  const sPaths = statements
    .filter((s) => UNCONFIRMED_STATEMENTS.has(s.storedName))
    .map((s) => s.sPath)
    .sort();
  return sPaths.length === 0 ? {} : { unconfirmed: { note: UNCONFIRMED_NOTE, sPaths } };
}

/**
 * The shortfall, with its reason — every engine kind the published surface
 * cannot author. Derived from the same catalog as the numerator, so the two can
 * never sum to anything but the total.
 */
export function unmodeledObjectKinds(): { kind: string; absence: string }[] {
  const implemented = new Set(IMPLEMENTED_OBJECT_KINDS.map((k) => k.kind));
  return ENGINE_OBJECT_KINDS.filter((k) => !implemented.has(k.kind)).map((k) => ({
    kind: k.kind,
    absence: k.absence ?? "built but withheld from the published surface",
  }));
}

/** Value constructors / helpers exported from the package root. */
const VALUE_CONSTRUCTORS: ReadonlyArray<ManifestValue> = [
  { name: "c.text", signature: "(s: string) => Value", description: 'String constant → tag "const".' },
  { name: "c.int", signature: "(n: number | bigint | string) => Value", description: 'Integer constant → tag "const:int". The engine stores integers as STRINGS and has no 53-bit limit, so pass a string or bigint for anything past Number.MAX_SAFE_INTEGER — c.int("9223372036854775807") is exact where the number literal for it is already …808. A number that is not a safe integer THROWS rather than encoding the rounded value. For the int64 clamp of an `f.int` column see `llms/fields.md`.' },
  { name: "c.decimal", signature: "(n: number | string) => Value", description: 'Decimal constant → tag "const:decimal". Pass a string only to keep a stored spelling a number cannot reproduce (c.decimal("10.00") keeps its trailing zeros).' },
  { name: "c.blank", signature: '(tag: "const:<type>") => Value', description: 'The editor\'s UNCONFIGURED value box (stored value ""), emitted by codegen for a pulled workspace — do not author it. NOT a zero or an empty collection: the engine reads "" and "0" differently, so c.blank("const:int") ≠ c.int(0) and neither canonicalizes into the other. Valid for every constant tag except `const` and `const:obj`; their blanks are `c.text("")` and `c.obj(null)`.' },
  { name: "c.bool", signature: "(b: boolean) => Value", description: 'Boolean constant → tag "const:bool".' },
  { name: "c.null", signature: '(tag?: "const:null" | "const:obj") => Value', description: 'Null constant, stored value "null". Bare c.null() is tag "const:null". c.null("const:obj") is the OBJECT-TYPED null the engine writes into a db.* statement\'s @meta slot — different stored bytes from c.obj(null), which is the blank object (value ""), though both evaluate to null. Codegen emits whichever spelling the workspace stored; do not swap one for the other.' },
  { name: "c.obj", signature: "(o?: Json | null) => Value", description: 'Object constant → tag "const:obj". A populated one stores an empty {} carrying one `set` filter per key (a populated JSON string fails the request with ERROR_FATAL "Unable to decode."). ⚠ A ZERO-BASED numeric key is an INDEX: c.obj({"0":"a"}) evaluates to the list ["a"] ({"2":…} stays a key) — write c.array([...]) for a list, or prefix the keys ("k0") for an object; `export()` warns. c.obj() is the empty object {}. c.obj(null) is a pulled-workspace blank that evaluates to null; do not author it. Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is rejected; for a computed object use a record of values.' },
  { name: "c.array", signature: "(a: Json[]) => Value", description: 'Array constant (JSON string) → tag "const:array". Plain JSON literals only — a nested tagged value is rejected, same as c.obj.' },
  { name: "c.expression", signature: "(source: string) => Value", description: 'Xano Expression Engine source, passed through VERBATIM → tag "const:expr2". The string IS the expression: c.expression(\'"Hi, " ~ $input.name\'), c.expression("$var.price * $var.qty"). ⚠ Unvalidated: not parsed, typed (invisible to InferResponse), or renamed with refs; a typo surfaces at runtime. Use only for syntax typed surfaces lack (`~`, inline arithmetic, conditionals); otherwise prefer ref/inp/col, withFilters+fl.*, and obj() (which builds a checked expression). Not the expr() condition builder.' },
  { name: "c.expressionLegacy", signature: "(source: string) => Value", legacy: true, description: 'the older `const:expr` expression form, emitted by codegen for workspaces that still hold one — author `c.expression` instead.' },
  { name: "c.now", signature: "() => Value", description: 'Current time as epoch-ms — the engine-native const:epochms constant. Valid inline as a where/cmp operand.' },
  { name: "obj", signature: "(fields: Record<string, Value | nested>) => ObjValue<typeof fields>", description: 'Dynamic object value → tag "const:expr2" (an object-literal expression string); the dynamic sibling of c.obj.\n' +
      '  - Members: inp/ref/auth values, env()/setting()/sys.*, c.now(), c.* constants, nested records, or arrays. Each may carry a FILTER CHAIN (withFilters + fl.*), rendered as the expression pipe `$var.row|get:"a.b"`. A null-safe ref(path, { safe: true }) works in a member directly. An inner obj() nests, same bytes as a raw record.\n' +
      '  - InferResponse (through a set_var too) resolves each member like a top-level response key: `response: { user: obj({ id: ref("row.id") }) }` derives `{ user: { id: Col } }`, and a raw nested object literal (`response: { user: { id: ref("row.id") } }`, auto-wrapped through this) derives the same.\n' +
      '  - A constant record or list has two spellings that both work and render identically: bare (`{ a: 1 }`, `[]`) or `c.obj(...)`/`c.array([...])` — prefer the bare form.\n' +
      '  - Rejected: the blank `c.obj(null)` is refused here (write c.null() or c.obj()); a filter ARGUMENT that carries its own chain or is a c.now(); a DISABLED filter; the output/response/trycatch/toolset/reg tags (a type error) — set_var those first and ref() them.' },
  { name: "ref", signature: "(name: string, opts?: { safe?: boolean }) => Value", description: 'Reference a stack variable → tag "var". Pass { safe: true } for null-safe nested access — a dotted ref("owner.user_id", { safe: true }) compiles through the get filter so it resolves to null instead of raising "Unable to locate var" when the base is null.' },
  {
    name: "inp",
    signature: "(name: string) => Value",
    description:
      'Reference a function/endpoint input → tag "input". Resolves ONLY against the `input` block ' +
      'of the def it sits in — a value produced earlier in the stack is `ref("var.field")`, not ' +
      '`inp("field")`. A name that is not declared here deploys clean and fails at runtime with ' +
      'ERROR_FATAL "Unable to locate input: <name>" on every branch that reads it; `export()` warns, ' +
      'and `--strict` fails the build. Sending the name in the request does NOT rescue it. ' +
      'A dotted path drills INTO a declared input (`inp("action.amount")` needs a declared `action`). ⚠ An omitted/`null` optional input binds its EMPTY value (`""`/`0`/`false`/`[]`/`{}`; `""` for an enum), not null — only a type whose input defaults to `nullable: true` (vector, uuid, date, timestamp, file types; `llms/fields.md`) or one set `nullable: true` binds null. An omitted optional `input.geo.*` is not bound at all.',
  },
  { name: "col", signature: "(name: string) => Value", description: 'Reference a table column → tag "col".' },
  { name: "auth", signature: "(path: string) => Value", description: 'Reference the authenticated identity (auth("id") → $auth.id) → tag "auth". The PATH is required: the engine cannot read a bare auth, so auth("") throws. A token minted with extras exposes its claims at auth("extras.<key>") (auth("extras") is the whole map); a key absent from the token is a 500, not null.' },
  { name: "caught", signature: '(path?: "code" | "message" | "name" | "result") => Value', description: 'Read the caught error inside an s.try_catch CATCH arm → tag "trycatch". Valid ONLY there — it reads empty in the try/finally arms and outside the statement. Those four fields are all the engine binds; bare caught() is the whole error record. `code` is the error type: `ERROR_FATAL` for an engine error, a precondition\'s `error_type` (`ERROR_CODE_ACCESS_DENIED`, …), `ERROR_CODE_THROWN_ERROR` for `s.throw`. `message` is the error text (a precondition\'s `error`, the engine\'s, an LLM provider\'s) EXCEPT for `s.throw`, where it is the fixed "Throw Error Statement" and your value is in `result`. `name` is `s.throw`\'s `name` (empty without one), else a label (`Exception`, `Access Denied`). \u26a0 An `s.ai.agent.run` provider failure binds `result: { name: "AI_APICallError", statusCode, isRetryable, data }`; branch a fallback on `withFilters(caught("result"), fl.get("statusCode"))` (401: the key was refused). The path takes only the four names; reach deeper with `fl.get`.' },
  { name: "toolset", signature: '(path: "token" | "params" | `params.${string}`) => Value', description: 'Read a toolset-scoped binding inside a tool → tag "toolset". The engine binds two: token (the calling URL\'s token, null when absent) and params (its parameters, as an object); a dotted params.<key> reads one parameter out of that object. Bound only while a tool runs under its toolset — anywhere else it reads empty.' },
  { name: "env", signature: "(name: string) => Value", description: 'Read a WORKSPACE environment variable (set via workspaceConfig({ env }) or the dashboard) → `$env.NAME`. Compiles to tag "setting" with the plain name.\n' +
      '  - Every value is TEXT (or null), edge whitespace trimmed on read: compare a flag against c.text("true"), not c.bool(true) (under loose `=`, FLAG=false equals c.bool(true)); a numeric use needs fl.to_int/fl.to_decimal.\n' +
      '  - env("remote_ip") reads a user var named remote_ip, not the caller IP — use sys.remoteIp().\n' +
      '  - A name that does not exist resolves to NULL rather than erroring, so a typo deploys clean: prefer typedEnv(config), which turns the names that config declares into properties (E.STRIPE_KEY). Once a config declares env, export() warns stack.env-undeclared on any env() or bare setting() outside the declared set.' },
  { name: "setting", signature: "(name: string) => Value", description: 'Reference a workspace setting → tag "setting". Built-in system vars are $-prefixed settings, e.g. setting("$remote_ip"); prefer the typed sys.* accessors.' },
  { name: "sys.*", signature: "() => Value", description: 'Built-in system / request-context variables → tag "setting" ($-prefixed). Accessors: remoteIp, requestMethod, requestUri, requestQueryString, httpHeaders, requestAuthToken, apiBaseUrl, datasource, branch, tenant, release, platform, isDebugger. In XanoScript these are $env.$remote_ip etc.; sys.remoteIp() is the public-endpoint rate-limit key (auth("id") is null there). sys.httpHeaders() keys arrive Title-Cased whatever the client sent: a client sending `x-sync-secret` is read as `X-Sync-Secret`, so `get:"x-sync-secret"` is null in production — read the Title-Cased name. s.api.call sends header names the same way, so a workflow test sees what a real request delivers.' },
  { name: "filter", signature: "(name: string, ...args: Value[]) => FilterXdo", description: "Build a filter-chain entry by raw name (escape hatch)." },
  { name: "fl.*", signature: "(...args: Value[]) => FilterXdo", description: "Typed value-pipeline filters; see the `filters` catalog." },
  { name: "withFilters", signature: "(value: Value, ...filters: FilterXdo[]) => Value", description: "Attach a filter chain to a value (filters passed spread; an array is also accepted)." },
];

/**
 * The field catalog (`f.*` / `input.*`): authoring name → stored type, plus the
 * `FIELD_METHODS` key when its valid methods live under a different key (e.g.
 * `tableRef`). Methods are joined in from the generated per-type sets so the
 * manifest can never disagree with what the constructors accept.
 */
const FIELD_DESCRIPTORS: ReadonlyArray<{
  name: string;
  stored: string;
  methodKey?: string;
  inputOnly?: boolean;
}> = [
  { name: "text", stored: "text" },
  { name: "int", stored: "int" },
  { name: "decimal", stored: "decimal" },
  { name: "bool", stored: "bool" },
  { name: "uuid", stored: "uuid" },
  { name: "date", stored: "date" },
  { name: "email", stored: "email" },
  { name: "password", stored: "password" },
  { name: "json", stored: "json" },
  { name: "timestamp", stored: "epochms" },
  { name: "image", stored: "blob_img" },
  { name: "video", stored: "blob_video" },
  { name: "audio", stored: "blob_audio" },
  { name: "attachment", stored: "blob" },
  // Input-only: a raw upload is the request's bytes, not something a table holds.
  { name: "file", stored: "file", inputOnly: true },
  // Input-only: a column linking a whole table is a foreign key (tableRef).
  { name: "dbLink", stored: "<tableGuid>_mvpschema", inputOnly: true },
  { name: "geo.point", stored: "geo_point" },
  { name: "geo.multipoint", stored: "geo_multipoint" },
  { name: "geo.linestring", stored: "geo_linestring" },
  { name: "geo.multilinestring", stored: "geo_multilinestring" },
  { name: "geo.polygon", stored: "geo_polygon" },
  { name: "geo.multipolygon", stored: "geo_multipolygon" },
  { name: "enum", stored: "enum" },
  { name: "vector", stored: "vector" },
  { name: "object", stored: "obj" },
  { name: "tableRef", stored: "int", methodKey: "tableRef" },
];

/** The field-type catalog with each type's valid bind-methods joined in. */
function buildFieldTypes(): ManifestFieldType[] {
  return FIELD_DESCRIPTORS.map(({ name, stored, methodKey, inputOnly }) => ({
    name,
    stored,
    methods: Object.keys(FIELD_METHODS[methodKey ?? name] ?? {}),
    ...(inputOnly ? { inputOnly: true } : {}),
  }));
}

/** The value-pipeline filter catalog, derived from the generated filter sources. */
function buildFilters(): ManifestFilter[] {
  return FILTER_NAMES.map((name) => {
    const spec = FILTER_SPECS[name];
    // A spec IS the signature. `!!spec?.args?.length` used to stand in for it and
    // called all 94 zero-arg filters untyped — a coverage gap that was an artifact
    // of the test, not of the surface.
    const entry: ManifestFilter = { name, fl: `fl.${name}`, typed: !!spec };
    if (spec?.args?.length) entry.args = spec.args;
    // An absent `args` does NOT imply "takes nothing" — a handful of filters
    // take arguments the catalog never declared. Carrying the distinction keeps
    // the zero-argument list below honest.
    if (spec?.variadic) entry.variadic = true;
    if (spec?.result) entry.result = spec.result;
    if (spec?.group) entry.group = spec.group;
    if (spec?.description) entry.description = spec.description;
    return entry;
  });
}

const SPECS_BY_NAME = new Map(GENERATED_SPECS.map((s) => [s.name, s]));

/**
 * Stored statements that have a generated spec but whose public `s.` surface is
 * a hand-authored typed override (documented in prose above the catalog). The
 * generated bare-`Value` field signature is suppressed so the catalog renders
 * `(…) [special]` and defers to the typed entry — as it already does for the
 * hand-authored call family. The `[output]` flag is preserved.
 */
/**
 * Statement surfaces whose PARADIGM has been superseded, keyed by surface name to
 * the "use this instead" line the legacy index renders.
 *
 * Still registered, still authorable, still decoded out of a real workspace — so an
 * agent reading pulled code has to recognize them. They are withheld from the
 * per-namespace catalog and named-only in the legacy index, which is the same
 * split legacy VALUE constructors get: hiding one entirely is worse than useless,
 * because an agent that has never heard of it will "fix" what it does not
 * recognize.
 *
 * The realtime pair is the whole reason this exists at the statement level. The
 * two realtime layers use overlapping vocabulary — "channel", "realtime" — for
 * different objects, so an agent that sees both surfaces in one catalog will mix
 * them, and a mixed workspace fails at runtime rather than at compile.
 */
export const LEGACY_SURFACES: Readonly<Record<string, string>> = {
  "api.realtime_event":
    "publishes to the SUPERSEDED workspace-global realtime layer, NOT to a `realtimeChannel()` — its `channel` is a string against that layer, so pointing it at a current-layer channel path publishes into the void. Use `s.realtime.publish` instead: it names the owning `realtimeServer()`, so it addresses a real `realtimeChannel()`.",
};

export const OVERRIDDEN_SURFACES = new Set([
  "mvp:api_request",
  "mvp:streaming_api_request",
  "mvp:connect_webflow_api_request",
  "mvp:microservice_request",
]);

/**
 * What each statement's `as:` output var holds — the machine-readable companion
 * to the curated db.* "Runtime behavior" prose (and grounded in the same
 * `InferResponse` truth). Keyed by the public `surface`. Curated by design and
 * NOT exhaustive: it covers the statements whose result is stable and verified
 * (the db.* family, `security.check_password`, and the clearly-typed math/object/
 * array-predicate ops). A statement absent from this map simply has no `result`
 * in the manifest — read its `output` flag and the prose. `T` = the bound
 * `table()`'s `InferRow`. Types trace to `src/responses/infer.ts`; the db.* and
 * check_password shapes are verified against a live engine.
 */
const STATEMENT_RESULTS: Record<string, { name: string; type: string; note?: string }> = {
  // db.* — mirrors the curated "Runtime behavior" block and InferResponse.
  "db.get": { name: "as", type: "InferRow<T> | null", note: "binds null on a miss, never throws" },
  "db.add": { name: "as", type: "InferRow<T>", note: "the full inserted row incl. id/created_at" },
  "db.edit": { name: "as", type: "InferRow<T>", note: "the full post-mutation row; throws NotFound on a miss" },
  "db.patch": { name: "as", type: "InferRow<T>", note: "the full post-mutation row; throws NotFound on a miss" },
  "db.add_or_edit": { name: "as", type: "InferRow<T>", note: "upserts and never misses" },
  "db.del": { name: "as", type: "null", note: "the engine deletes and returns no value; throws NotFound on a miss" },
  "db.has": { name: "as", type: "boolean" },
  "db.query": { name: "as", type: "InferRow<T>[]", note: "a paging envelope when metadata paging is on" },
  "db.bulk.patch": { name: "as", type: "InferRow<T>[]" },
  "db.bulk.delete": { name: "as", type: "number", note: "count of deleted rows" },
  "db.increment": { name: "as", type: "InferRow<T>[] | number", note: "the updated rows, or the changed-row count with returnType \"count\"" },
  // security.check_password binds a boolean (does the plaintext match the
  // stored hash).
  "security.check_password": {
    name: "as",
    type: "boolean",
    note: "true when the plaintext matches the stored hash. ⚠ not input.password — pass input.text() plaintext. ⚠ THROWS 500 on a non-hash hash_password (Invalid password syntax.)",
  },
  // The decode/decrypt family THROWS on any failed verification rather than
  // binding a falsy result — see the "Verifying a token" recipe in
  // statements-calls.md. Doc-only notes (the decoded value's shape is unknown).
  "security.jws_decode": {
    name: "as",
    type: "unknown",
    note: "the decoded claims. ⚠ THROWS 500 ERROR_FATAL on ANY failure (bad/garbage/expired/tampered token, wrong key/signature_algorithm, failed check_claims) — wrap in s.try_catch for a 401 (statements-calls.md)",
  },
  "security.jwe_decode": {
    name: "as",
    type: "unknown",
    note: "the decoded claims. ⚠ THROWS 500 ERROR_FATAL on ANY failure (bad/expired token, wrong key/algorithm, failed check_claims) — wrap in s.try_catch for a 401 (statements-calls.md)",
  },
  "security.decrypt": {
    name: "as",
    type: "unknown",
    note: "the plaintext; takes encrypt's RAW bytes (fl.base64_decode() a stored base64 first). ⚠ THROWS 500 on a wrong key/iv or non-ciphertext — wrap in s.try_catch",
  },
  // random_bytes/encrypt bind RAW BINARY: a JSON response or text column mangles
  // it silently, and strlen counts characters not bytes. Encode before returning.
  // (encrypt's raw-output note lives on `fl.encrypt` in filters.md — the catalog
  // file is at its per-file token ceiling.)
  "security.random_bytes": {
    name: "as",
    type: "string",
    note: "RAW bytes (encrypt too) — fl.bin2hex()/fl.base64_encode() before returning or storing; raw binary mangles in a JSON/text response",
  },
  // redis/storage binds measured live: a get miss is `false`, not null.
  "redis.get": { name: "as", type: "unknown", note: "FALSE (not null) on a miss" },
  "redis.set": { name: "as", type: "boolean", note: "false when create_only meets an existing key (kept)" },
  "storage.read_file_resource": { name: "as", type: "{ name; size; mime; data: <contents> }" },
  "storage.create_attachment": {
    name: "as",
    type: "XanoFileRef",
    note:
      "the stored file VALUE ({ access, path, name, type, size, mime, meta }) — write it into an f.attachment() cell. ⚠ include_meta: true binds the file's internal RECORD instead (id, guid, sig, the storage BUCKET name): never store it as the file value or return it (warns storage.include-meta-returned). type (also optional) coerces the kind when it is image/video/audio",
  },
  // util.* — three whose UNITS, SHAPE or PHASE cost teams time, and none is
  // guessable from the signature.
  "util.geo_distance": {
    name: "as",
    type: "number",
    note: "great-circle distance in METRES (a decimal) — divide by 1000 for km. Identical points return 0",
  },
  "util.get_all_input": {
    name: "as",
    type: "unknown",
    note:
      "inside an ATTACHED middleware it is a { type, vars } envelope whose vars DIFFERS BY PHASE: pre → the request inputs; post → { status, result }, NOT the request — read the request in post with s.util.get_raw_input. ⚠ status is the STRING \"ok\" | \"exception\" (NOT an HTTP code), so store it in a text column, not f.int(); on \"exception\", result is the { code, message, payload } error and payload is set. See llms/kinds-core.md",
  },
  "util.get_env": {
    name: "as",
    type: "Record<string, string>",
    note:
      "every workspace env var (declared AND dashboard) as one { NAME: value } object, each value TEXT — so this binds every SECRET; never return it to a client or write it to a row",
  },
  "util.ip_lookup": {
    name: "as",
    type: "IpLookupResult | null",
    note:
      "NESTED, not flat: { continent: {code,name}, country: {code,name}, region: {code,name}, city: {name}, postal: {code}, location: {latitude, longitude, tz, radius} } — ref(\"geo.location.latitude\"), ref(\"geo.city.name\"); radius is KILOMETRES. ⚠ Every leaf is nullable (region/city/postal often null on a normal hit). `city` is an OBJECT: a bare ref(\"geo.city\") into a text column fails and { safe: true } does NOT help; drill to city.name. The whole var is null for an unresolvable address",
  },
  // The s.text.* predicates bind a boolean to `as` (empty/omitted needle → true).
  "text.contains": { name: "as", type: "boolean" },
  "text.icontains": { name: "as", type: "boolean" },
  "text.starts_with": { name: "as", type: "boolean" },
  "text.istarts_with": { name: "as", type: "boolean" },
  "text.ends_with": { name: "as", type: "boolean" },
  "text.iends_with": { name: "as", type: "boolean" },
  // Clearly-typed declarative ops.
  "array.every": { name: "as", type: "boolean" },
  // The `s.math.*` family takes NO `as` — it MUTATES the variable named `name`
  // in place (the engine's `output` flag on add/bitwise is an artifact; the
  // factory has no `as` param). Semantics live in llms/statements-runtime.md.
  "object.keys": { name: "as", type: "(string | number)[]", note: "an integer-like key comes back as a NUMBER (PHP coerces it), not a string" },
  "object.values": { name: "as", type: "unknown[]" },
  "object.entries": { name: "as", type: "{ key: string | number; value: unknown }[]", note: "each entry is a { key, value } OBJECT, NOT a [key, value] tuple; an integer-like key comes back as a number" },
};

/**
 * Enum members for CONTEXT fields, keyed `"<storedName>:<field>"`.
 *
 * The generated catalog harvests `enum` from the engine's runtime INPUT schemas,
 * which only cover `input`-routed fields — so a closed set declared on a context
 * field arrives as a bare `string`, and neither `manifest.json` nor the
 * `llms.txt` line rendered from it can list the legal values. `s.precondition`'s
 * `error_type` is the case that hurt: the shipped types narrow it to a union, so
 * following the docs (`error_type?: string`) and writing a plausible `"input"`
 * is a type error the docs cannot explain.
 *
 * Sourced from the SDK's own union rather than retyped, so the two cannot drift.
 */
export const CONTEXT_FIELD_ENUMS: Record<string, readonly string[]> = {
  "mvp:precondition:error_type": PRECONDITION_ERROR_TYPES,
  // `access` defaults to `public`, so a misspelling fails OPEN — the file is
  // served to the world. The members were unlisted anywhere, leaving `private`
  // inferable only from `s.storage.sign_private_url`'s existence.
  "mvp:create_attachment:access": STORAGE_ACCESS,
  "mvp:create_audio:access": STORAGE_ACCESS,
  "mvp:create_image:access": STORAGE_ACCESS,
  "mvp:create_video:access": STORAGE_ACCESS,
  "mvp:setheader:duplicates": HEADER_DUPLICATES,
};

function fieldsOf(spec: StatementSpec): ManifestField[] {
  return spec.rules.map((r) => {
    const f: ManifestField = {
      name: r.field,
      type: r.type,
      optional: r.optional || r.default !== undefined,
    };
    if (r.default !== undefined) f.default = r.default;
    const curated = CONTEXT_FIELD_ENUMS[`${spec.name}:${r.field}`];
    if (r.enum !== undefined) f.enum = r.enum;
    else if (curated) f.enum = [...curated];
    return f;
  });
}

/** Build the full authoring manifest from the SDK's sources of truth. */
export function buildManifest(opts: { version?: string } = {}): Manifest {
  // `unpublished` descriptors are dropped here, so they reach neither the
  // emitted manifest, nor `llms.txt`, nor the coverage numerator below.
  const objectKinds: ManifestKind[] = KIND_DESCRIPTORS.filter((d) => !d.unpublished).map((d) => ({
    ...d,
    registered: isRegisteredKind(d.kind),
    // A published kind can still have unpublished sub-kinds (the two realtime
    // lifecycle trigger types under `trigger`), so filter that level too.
    ...(d.subKinds ? { subKinds: d.subKinds.filter((sub) => !sub.unpublished) } : {}),
  }));

  const statements: ManifestStatement[] = STATEMENT_SURFACES.map(([surface, storedName]) => {
    const spec = SPECS_BY_NAME.get(storedName);
    const overridden = OVERRIDDEN_SURFACES.has(storedName);
    const entry: ManifestStatement = {
      surface,
      storedName,
      sPath: sPathOf(surface),
      registered: isRegisteredStatement(storedName),
      declarative: spec !== undefined && !overridden,
    };
    if (spec) {
      entry.output = spec.output ?? false;
      // Overridden surfaces defer their signature to the hand-authored prose entry.
      if (!overridden) entry.fields = fieldsOf(spec);
    }
    // Curated result descriptor — attaches to declarative AND special surfaces
    // (the db.* family is `special`, so this must run independent of `spec`).
    // `hasOwn` guards a surface name colliding with an inherited Object member,
    // mirroring the FILTER_NOTES lookup below.
    if (Object.hasOwn(STATEMENT_RESULTS, surface)) entry.result = STATEMENT_RESULTS[surface];
    if (Object.hasOwn(LEGACY_SURFACES, surface)) entry.legacy = true;
    return entry;
  });

  const filters = buildFilters();

  return {
    name: "xanosdk",
    version: opts.version ?? "0.0.0",
    description:
      "TypeScript SDK that compiles a typed Xano workspace into the importable packageExport JSON bundle.",
    coverage: {
      // Counted over the ENGINE's catalog, not over this SDK's kinds: the engine
      // has one object kind per trigger type where the SDK has one `trigger`
      // kind with sub-kinds, so counting SDK kinds reported 16/30 for a surface
      // that actually authors 23 of them.
      objectKinds: {
        implemented: IMPLEMENTED_OBJECT_KINDS.length,
        total: TOTAL_OBJECT_KINDS,
        unmodeled: unmodeledObjectKinds(),
      },
      statements: {
        implemented: statements.filter((s) => s.registered).length,
        total: TOTAL_STATEMENTS,
        // Mapped through the built entries rather than derived from the stored
        // names directly, so a name that no longer has an authoring surface
        // cannot be published as an `s.` path that does not resolve.
        ...unconfirmedCoverage(statements),
      },
      filters: { typed: filters.filter((f) => f.typed).length, total: filters.length },
    },
    values: { constructors: [...VALUE_CONSTRUCTORS], tags: TAGS },
    objectKinds,
    fieldTypes: buildFieldTypes(),
    statements,
    filters,
    cli: buildCli(),
    cliGlobalFlags: buildCliGlobalFlags(),
  };
}

/**
 * Statement fields whose default is security- or behavior-relevant and must stay
 * visible in the lean `llms.txt` — an agent that can't see the default would make a
 * wrong call. Keyed `"<sPath>:<field>"`. Every other field default is dropped from
 * `llms.txt` (it survives in `manifest.json`). Audit new statements for additions.
 *
 * `storage.create_*` default `access` to `"public"` (world-readable uploads) — the
 * worked example that motivated this carve-out: an agent shipping user uploads must
 * see the default is public, and it is not derivable from `access?: string`.
 */
const DEFAULT_KEEP = new Set<string>([
  "storage.create_image:access",
  "storage.create_attachment:access",
  "storage.create_audio:access",
  "storage.create_video:access",
]);

/**
 * The `error_type` → HTTP status mapping, grouped by status so the two 400s
 * read as one entry. Rendered rather than restated: `llms.txt` promises this
 * mapping matters, and a hand-typed copy of it could drift from the union the
 * catalog line prints.
 */
function preconditionStatusLine(): string {
  const byStatus = new Map<number, string[]>();
  for (const type of PRECONDITION_ERROR_TYPES) {
    const status = PRECONDITION_ERROR_STATUS[type];
    byStatus.set(status, [...(byStatus.get(status) ?? []), type]);
  }
  return [...byStatus]
    .sort(([a], [b]) => a - b)
    .map(([status, types]) => `${types.map((t) => `\`${t}\``).join("/")} → ${status}`)
    .join(", ");
}

const fieldLine = (f: ManifestField, sPath: string): string => {
  const keepDefault = f.default !== undefined && DEFAULT_KEEP.has(`${sPath}:${f.name}`);
  // A constrained field renders as its legal values rather than the opaque
  // `value`. This is the whole point of carrying the constraint: an agent
  // reading `connection_type?: value` has no way to know the two spellings the
  // engine accepts, and guessing a plausible third one fails only after deploy.
  const type = f.enum ? f.enum.map((v) => JSON.stringify(v)).join(" | ") : f.type;
  return `${f.name}${f.optional ? "?" : ""}: ${type}${keepDefault ? ` = ${JSON.stringify(f.default)}` : ""}`;
};

/**
 * Curated, COMPLETE one-line notes for the typed filters whose signature alone
 * underspecifies behavior. The lean `llms.txt` filter catalog renders these in
 * place of the raw source descriptions — which are dropped from the primary (they
 * are 40% name-restating and 70% truncated mid-sentence) but retained in full in
 * `manifest.json`. Keyed by bare filter name. Mirrors the OVERRIDDEN_SURFACES /
 * DEFAULT_KEEP curated-override pattern; the completeness test (llms-filters) proves
 * every load-bearing filter has a note here or an entry in SELF_EVIDENT_FILTERS.
 */
export const FILTER_NOTES: Record<string, string> = {
  // The registry-only array family. `array_find` is the dangerous one; `splice`
  // returns the opposite of what its name suggests in one of its two forms; and
  // `array_upmerge` is the only one of the family that writes INTO an element
  // rather than replacing it.
  array_find:
    "a MISS THROWS (`Unable to find element.`) rather than yielding null — use `array_has` to test first",
  array_filter: "matches by EXAMPLE (an object of key/value pairs), not by code, and compares LOOSELY",
  splice:
    "returns the REMOVED slice, not the remainder — [1,2,3,4] spliced at offset 1 length 2 yields [2,3]; with a `path` it removes in place and returns the whole value instead",
  array_upmerge: "merges the node into the FIRST matched element, and APPENDS it on a miss (an UPSERT, not update-all) — use `fl.map` to update every match; `array_replace` is first-match too but swaps the element whole and THROWS on a miss",
  array_set: "sets a DOTTED path and returns the value; a non-object piped value is replaced by an empty one",
  // A computed key is the grouping half of `index_by`: one pass over the rows,
  // then a lookup per group, with no query per group.
  get: "`path` may be a runtime value: after `fl.index_by(\"suite_id\")`, `fl.get(ref(\"suite.id\"))` returns that key's rows (null for a missing key). ⚠ the `default` applies only to a MISSING path — a key present with a `null` value stays `null`; chain `fl.first_notnull(default)` to cover both.",
  has: "`false` for a missing key and for a key whose value is `null` (unlike `fl.get`'s default, which treats a present null as present)",
  // "Direction" family — which operand is the subject is genuinely confusing.
  contains: "piped value is the subject text; the arg is the substring searched for",
  ends_with: "piped value is the subject text; the arg is the substring searched for",
  starts_with: "piped value is the subject text; the arg is the substring searched for",
  icontains: "case-insensitive; piped value is the subject, the arg is the substring",
  // The regex family REVERSES that direction, which is the whole reason it needs
  // its own note: the pattern is piped and the subject is the argument. Written
  // the other way round it reads correctly, type-checks, and answers false for
  // every input, so the note has to state the order and the symptom.
  regex_test:
    "piped value is the PATTERN (build it with `c.regex(...)`); the arg is the subject — the " +
    "REVERSE of `contains`/`starts_with`. Swapped args → always false, no error. " +
    'Write `withFilters(c.regex("^a+$"), fl.regex_test(inp("s")))` (or name the arg: ' +
    "`fl.regex_test({ subject: inp(\"s\") })`). A pattern found in the subject slot is refused at build time",
  regex_match: "piped value is the PATTERN, the arg is the subject — see `regex_test`",
  regex_match_all: "piped value is the PATTERN, the arg is the subject — see `regex_test`",
  regex_replace:
    "piped value is the PATTERN, `subject` is the text searched — see `regex_test`. The " +
    "replacement comes FIRST",
  iends_with: "case-insensitive; piped value is the subject, the arg is the substring",
  istarts_with: "case-insensitive; piped value is the subject, the arg is the substring",
  // "empty" is a specific set of values, not just null.
  filter_empty: 'keeps entries that are not empty ("", null, 0, "0", false, [], {}) — the only one of the family that drops them all',
  // The rest of the family each drop ONE strict value; the names read broader.
  filter_empty_text: 'drops only `""`; null, 0, false, [] and {} stay',
  filter_zero: "drops only the integer `0` (strict), not `\"0\"` or `0.0`",
  first_notempty: 'first value that is not empty ("", null, 0, "0", false, [], {})',
  // The `code` arg is a JS FUNCTION BODY (it must `return`), not a column path,
  // and which identifiers it can see depends on the filter — see **Lambda bodies**.
  // Build it with `lam.fn`, which makes the bindings the function's parameters.
  map: "`code` is a JS body run per element, over `$this`/`$index`/`$parent` — build it with `lam.fn`",
  filter: "`code` is a JS body run per element (keep it? true/false), over `$this`/`$index`/`$parent`",
  every: "`code` is a JS body run per element (true for all?), over `$this`/`$index`/`$parent` — returns a BOOL (`true` on an empty list)",
  some: "`code` is a JS body run per element (true for any?), over `$this`/`$index`/`$parent` — returns a BOOL (`false` on an empty list)",
  find: "`code` is a JS body run per element; returns the first ELEMENT it accepts (`null` when none)",
  findIndex: "`code` is a JS body run per element; returns the first matching INDEX as an int (`-1` when none)",
  reduce:
    "`code` is a JS body run per element; the ACCUMULATOR is `$result` (there is no `$acc`) and " +
    "`initial_value` is REQUIRED. " +
    "`initial_value` takes ANY value (an object/text accumulator, `c.obj({...})`/`c.text(\"\")`, not just an int); the result is that accumulator",
  lambda: "runs a JS body once over the piped value, which it binds as `$this` (NOT `$parent`)",
  // The one filter next to `lambda` that is NOT a lambda. It reads as one, its
  // upstream description names a `$this` that does not exist on its path, and
  // both wrong spellings can return a plausible value with HTTP 200 — so the
  // note has to say what the binding IS, not only what it isn't.
  transform:
    "`expression` is Xano Expression Engine source, NOT a JS body — no `return`, and the piped value is " +
    "`$0` (or `$$`), NOT `$this` (which is null here). `$var`/`$input`/`$env`/`$auth` resolve and filters " +
    "pipe inside it: `$0 * 2`, `$0|sort|join:\",\"`. Parenthesize a pipe inside an object literal — " +
    "`{ s: ($0|sort|join:\",\") }` — or its comma is read as the key separator and later keys vanish " +
    "silently. For JavaScript use `lambda`",
  // The sort mode is the whole behavior of this filter, and picking it wrong is
  // SILENT — every unrecognized spelling falls through to `itext`, so the array
  // comes back sorted as case-insensitive text with no error anywhere. That is
  // how "top N by score/distance/recency" comes out wrong.
  fsort:
    '`type` is the comparator: "number" (the only numeric one), "text"/"itext" (strcmp/strcasecmp), ' +
    '"natural"/"inatural" ("a2 < a10"). Default "itext"; anything else sorts as text. ' +
    "The path arg drills into each element",
  // The CSV pair reads as interchangeable and is not: only `csv_create` writes a
  // header, and `csv_encode`'s per-row column order misaligns heterogeneous rows
  // with no error at all.
  csv_encode:
    "writes NO header — values only, each row in THAT row's key order with no normalization " +
    "across rows, so rows whose keys differ in order or count silently misalign columns. " +
    "Nested cells are JSON-encoded and `false` writes empty. A piped array of SCALARS is " +
    "treated as one row. Use `csv_create` for a header",
  csv_create:
    "the header-writing counterpart to `csv_encode`: the PIPED value is the list of column " +
    "names (written as the header line) and `rows` carries the data rows",
  // A group-by whose name reads as a lookup table. The singular spelling
  // `idx[key].name` is null at runtime rather than an error.
  index_by:
    "a GROUP-BY: every value is an ARRAY of the items sharing that key, even when only one does, " +
    "so a lookup reads `idx[key][0]`. Items whose path is missing or non-scalar are dropped",
  unique:
    "with a `path`, dedupes a list of records by the value at that path and keeps the FIRST per key — " +
    "but it DROPS every element whose path is missing or null (the same rule as `index_by`), so " +
    "deduping by an optional key loses those rows",
  // Non-obvious names.
  epochms_transform: 'applies a relative shift (e.g. "+1 day") to the timestamp. ⚠ a format `strtotime` cannot parse yields `0`, and a MISTYPED one (`"+1 dya"`) a PLAUSIBLE WRONG time, both with NO error — see date-filter failure modes in `llms/statements-runtime.md`',
  unpick: "returns the object without the named keys (inverse of a pick)",
  // Binary output: a JSON response or text column mangles raw bytes silently, and
  // strlen counts CHARACTERS not bytes, so both under-count a raw-binary result.
  encrypt: "binds RAW ciphertext bytes — fl.base64_encode() before returning or storing (fl.decrypt takes the raw bytes back)",
  sha256: "the optional `raw` arg returns RAW binary, not the hex digest — fl.bin2hex()/fl.base64_encode() it before returning or storing (strlen then UNDER-COUNTS: it counts characters, not bytes); omit `raw` for hex",
  secureid_encode:
    "the operand must be a NON-NEGATIVE integer — a negative or fractional one encodes without error but `secureid_decode` returns a DIFFERENT positive int (`-3` → `13`, `-42` → `214`, `1.5` → `1`), NOT a round-trip; validate the domain before encoding",
  secureid_decode:
    "a wrong salt, or a garbage/empty id, is a 400 (`This signature is invalid.` / `Invalid input format for secureId.`), NOT null — wrap in s.try_catch to handle a miss; only the id from `secureid_encode` of a non-negative int round-trips back",
};

/**
 * Typed filters that ARE load-bearing (non-name-restating, complete source
 * description) but whose name + signature is self-evident, so they intentionally
 * carry no note. Recorded explicitly so the completeness test can prove every
 * load-bearing filter is a conscious keep-or-drop decision, not a silent gap.
 */
export const SELF_EVIDENT_FILTERS: ReadonlySet<string> = new Set([
  // Set comparisons: `_assoc` matches on keys AND values, the plain form on values only.
  "array_diff",
  "array_diff_assoc",
  "array_intersect",
  "array_intersect_assoc",
  "to_epochms",
  // Registry-only filters whose behavior IS their name (the ones that are not
  // carry a FILTER_NOTES entry instead).
  "array_has",
  "array_push_conditional",
  "clamp_min",
  "clamp_max",
  "array_fill",
  "array_fill_keys",
  "array_slice",
  "epochms_add_ms",
  "epochms_add_secs",
  "epochms_from_format",
  "range",
  "regex_quote",
  "filter_empty_text",
]);

/**
 * Render the manifest as `llms.txt` — a concise, link-free plaintext grounding
 * doc an agent can read to learn how to author a Xano SDK workspace.
 */
/**
 * The one canonical statement of the lambda binding contract.
 *
 * Generated from {@link LAMBDA_BINDINGS} — the same table the build-time guard
 * reads and the same one the live probe agreed with — so the docs cannot
 * disagree with what the SDK enforces or with what the engine does. Before this,
 * the contract was written down nowhere at all: the reporter guessed `$acc` for
 * reduce's accumulator, and nothing between the keystroke and production
 * disagreed.
 */
/** Wrap `items` into ` · `-joined lines that stay inside the doc's column width. */
function wrapList(items: readonly string[], indent: string, width = 84): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line === "" ? indent + item : `${line} · ${item}`;
    if (next.length > width && line !== "") {
      lines.push(line + " ·");
      line = indent + item;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function renderLambdaSection(): string[] {
  const lines: string[] = ["## Lambda bodies (JavaScript)", ""];
  lines.push(
    "**A lambda is an escape hatch, not a default.** Use one only when a native filter,",
    "an `expr(...)`/`obj(...)` expression, or a statement can't do the work: each call crosses a",
    "process boundary into a BOUNDED pool of lambda workers every lambda in the workspace shares.",
    "The crossing is per CALL, not per element — an iterating filter sends the body ONCE and loops on the",
    "other side, so one iterating filter over a list beats a lambda inside a stack loop.",
    "",
    "The lambda statement (`s.lambda({ as, code, timeout? })`) and eight filters run a",
    "JavaScript body. **Write the body as a FUNCTION, not a `c.text` string** (bindings are",
    "typed parameters; a wrong name is a compile error). Inline, the surface is implied by where it sits:",
    "",
    "```ts",
    "fl.map(({ $this }) => $this * 2)                                   // map's bindings, typed from the position",
    "fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })",
    "s.lambda({ as: \"total\", code: ({ $var }) => $var.subtotal * 1.2 })  // ambient only — $this is a compile error",
    "```",
    "",
    "Destructure bindings by their exact names (`({ $this })`). Refused: `(b) => b.$this`,",
    "renaming (`{ $this: x }`), nesting, defaults, rest.",
    "",
    "⚠ An inline `code:` arrow receives BINDINGS ONLY. `capture` is an option of",
    "`lam.fn`, not a field of `s.lambda` or a filter, so `capture:` beside `code:` is a type",
    "error — move the body into `lam.fn(fn, { capture })` (below).",
    "",
    "For a body built away from its call site:",
    "",
    '- `lam.fn(({ $result, $this }) => $result + $this, { surface?, capture? })` — name a `surface` to check it here, or omit it and the call site checks it.',
    '- `lam.raw("return 1", { surface })` — text, same validation.',
    '- `lam.raw(code, { surface, unchecked: true })` — sends a body that does not parse or declares a top-level `import`/`export`; skips those syntax checks only, here and at the `s.lambda` / `fl.*` site.',
    '- `lam.file("./lambdas/total.ts")` — a default-exported function in its own module (path relative to the caller), read as text at build time. NODE ONLY: `import { lam } from "@xano/sdk/node"` (isomorphic `lam` has no `file`). Only the default export\'s BODY is sent, so a value import, a second export or a top-level helper is refused — move helpers inside; `import type` / `import { type X }` are free. `@xano/sdk/lambda-globals` types the globals below program-wide: keep modules in `xano/lambdas/` (its scaffold tsconfig loads it) or `import type {} from` it under their own tsconfig.',
    "",
    "Nothing from the enclosing scope crosses: the body is sent as TEXT, so a closed-over",
    "`const rate` is undefined there (a wrong VALUE at HTTP 200, not an error). Put what the",
    "body needs in `capture`; it arrives as the SECOND parameter, emitted as a `const` prelude:",
    "",
    "```ts",
    'lam.fn(({ $this }, { capturedRate }) => $this * capturedRate, { surface: "map", capture: { capturedRate: rate } })',
    "```",
    "",
    "⚠ A capture key must NOT share a module-scope binding's name (a `.ts` loader renames one;",
    "refused at build time) — `capture: { capturedRate: rate }`, not `{ rate }`.",
    "",
    "Capture JSON data only: a function, `NaN`, a sparse/typed array or class instance (`Date`, `Map`…)",
    "is refused at build time, at any depth. Capture the plain form and rebuild in",
    "the body (`d.getTime()` → `new Date(d)`).",
    "",
    "A body is a FUNCTION BODY: it must `return` its value. Bindings by surface — an",
    "identifier outside its surface's set is undefined at runtime, and the SDK refuses",
    "it at build time whichever spelling you use:",
    "",
  );
  const ambient = LAMBDA_BINDINGS["s.lambda"];
  const tick = (x: string): string => `\`${x}\``;
  lines.push(
    `- every surface: ${ambient.map(tick).join(" · ")} (+ the ${LAMBDA_GLOBALS.map(tick).join(" / ")} globals)`,
  );
  const extras = (surface: LambdaSurface): string[] =>
    LAMBDA_BINDINGS[surface].filter((b) => !ambient.includes(b));
  const byExtras = new Map<string, string[]>();
  for (const surface of Object.keys(LAMBDA_BINDINGS) as LambdaSurface[]) {
    if (surface === "s.lambda") continue;
    const key = extras(surface).join(" ");
    byExtras.set(key, [...(byExtras.get(key) ?? []), surface]);
  }
  for (const [key, surfaces] of byExtras) {
    const label = surfaces.map((x) => tick(x.includes(".") ? x : `fl.${x}`)).join(" · ");
    lines.push(`- ${label}: + ${key.split(" ").map(tick).join(" · ")}`);
  }
  lines.push(
    `- \`s.lambda\`: ambient only — no \`$this\`, no \`$parent\`, no \`$result\`.`,
    "",
    "`$result` is `reduce`'s ACCUMULATOR (there is no `$acc`). `$this` is the element in",
    "an iterating filter and the piped value in `fl.lambda`; `$parent` is the whole array",
    "and exists only on the iterating filters. A stack variable is reached as",
    "`$var.name` — it is NOT also injected as a bare `$name`.",
    "",
    "`$auth` with no authenticated caller (a public surface, or an authed one reached without a",
    "token) is `{ id: 0, dbo: \"\" }`, not null. Test `$auth.id > 0`, not truthiness.",
    "",
    "Hazards:",
    "",
    "- ⚠ A body that THROWS or times out does not fail the request (nor reach `s.try_catch`): the",
    "  engine returns its diagnostic TEXT as the value with HTTP 200 (`\"[Line 1:Char 7] boom\"`,",
    "  `\"Lambda timed out after 1 seconds\"`; a thrown non-Error is `\" Unknown error\"` on the cloud).",
    "  Validate before consuming it. To FAIL the request: wrap the body in `try { return { ok: true,",
    "  v } } catch { return { ok: false } }`, then `s.precondition` `ref(\"r.ok\", { safe: true })` = `true`.",
    "- ⚠ An `s.lambda` whose body returns a STRING that parses as a JSON object or array binds",
    "  the DECODED value, not the string (the statement's output is cast as `json`);",
    "  scalar-looking strings (`\"123\"`, `\"true\"`) stay text, and `fl.map`/`fl.lambda` keep",
    "  the string. A body that `JSON.stringify`s a payload to sign/hash/store gets an object",
    "  back. To keep text, return it WRAPPED (`{ text }`) and read `.text`.",
    "- ⚠ `timeout` is COOPERATIVE — observed only at an `await` — so it bounds WAITING (a slow",
    "  `fetch`), not compute: a 1s `timeout` over a 3s busy-loop runs all 3s and returns",
    "  normally. Bound a loop that could run away inside the body.",
    "- ⚠ A top-level `import`/`export` is a syntax error — the body is a function body. Reach",
    "  a dependency through the PRELOADED globals below. A dynamic `import(\"…\")`/`require(\"…\")`",
    "  with a LITERAL specifier is not portable: an instance that bundles the body first",
    "  returns the TEXT `Could not resolve \"node:crypto\"` with HTTP 200.",
    "- Preloaded globals — no specifier, so these work everywhere:",
    ...wrapList(LAMBDA_MODULE_GLOBALS.map(tick), "  "),
    "  …plus `fetch`, `Buffer`, `TextEncoder`/`TextDecoder`, and the `crypto` above",
    "  (`randomUUID`, `createHmac`, `createHash`, `subtle`). `Object.keys(globalThis)`",
    "  inside a body lists whatever else a given instance carries.",
    "- An INLINE body in `xano/` that uses one of these globals does not type-check until that",
    "  file has `import type {} from \"@xano/sdk/lambda-globals\"` at the top (safe in the defs",
    "  program — it is not the frontend); or move the body to a `lam.file` module under",
    "  `xano/lambdas/`, whose scaffold tsconfig loads the types already.",
    "- ⚠ `console` output goes to the request LOG, not stdout. The logging methods (`log` ·",
    "  `error` · `warn` · `info` · `debug` · `trace`), plus `table` and `dir`, all route there;",
    "  `group`/`count`/`time`/`assert` are undefined, and CALLING one throws (error text as the",
    "  value, HTTP 200).",
    "",
    "TypeScript annotations survive in the body, and top-level `await` works.",
    "",
    "Inline and `lam.fn` bodies are stored WHITESPACE-MINIFIED on one line, so an error position",
    "(`[Line 1:Char 59]`) always says Line 1. Use `lam.file` when you want the body readable or",
    "line-accurate errors; its module text is stored as written.",
    "",
  );
  return lines;
}

/**
 * Placeholder the router carries where its navigation list goes.
 *
 * The list is built from the topic set in {@link renderDocs}, which is the only
 * place that knows what the topic set IS — so a file cannot be added without
 * appearing in the list, and the list cannot name one that does not exist.
 * Writing it by hand is how a navigation section goes stale.
 */
const NAVIGATION_SLOT = "<!--navigation-->";

/** The rendered regions, before they are assembled into files by {@link renderDocs}. */
interface RenderedSections {
  /** Everything that stays always-loaded. */
  router: string[];
  lock: string[];
  legacy: string[];
  objectKinds: string[];
  kindsCore: string[];
  /** What importing a def costs a consumer, and how to spot-check one. */
  client: string[];
  /** CLI extension packages: what they run on, and install/configure/remove. */
  toolchain: string[];
  /** Exact failure strings → the rule that produced them and where it is stated. */
  errors: string[];
  kindsAgentMcp: string[];
  kindsKnowledge: string[];
  kindsRealtime: string[];
  triggers: string[];
  stmtData: string[];
  stmtRuntime: string[];
  stmtCalls: string[];
  stmtCatalog: string[];
  values: string[];
  fields: string[];
  filters: string[];
  lambda: string[];
  tests: string[];
}

/**
 * Render every grounding region. Which file each lands in is {@link renderDocs}'s
 * decision, so the split stays in one place instead of being spread through the
 * ~900 lines of prose below.
 */
/** Saved unit tests, their assertions, and per-statement mocks. */
function renderTestsSection(): string[] {
  return [
    "## Saved unit tests",
    "",
    "Named input sets run against one object, with assertions on its response — the tests the Xano editor shows. NOT `workflowTest()`, which is a standalone object with its own stack that calls other objects.",
    "",
    "- `tests?: TestDef[]` on `query()`, `defineFunction()`, and `middleware()`. No other kind stores them.",
    "- `{ name, id?, description?, datasource?, input?, expect?, token? }`.",
    "- `name` is unique within the object and is the key a statement's `mock` resolves against; a duplicate throws.",
    "- `id` defaults to a derivation from the owning object plus the name. A pulled test carries the id Xano minted, emitted explicitly.",
    "- `datasource` defaults to `\"\"` — an EMPTY datasource. Any other value names one the engine CLONES before the run; `\"live\"` warns `test.live-datasource` on the owning def.",
    "- That empty default means **no `table({ seed })` rows exist while a unit test runs**, as for a `workflowTest()`: every `db` read misses, so `resp(\"0.id\")` fails though the deployed endpoint returns those rows. Create the rows INSIDE the run (a `defineFunction` fixture the stack calls first) or `mock` the read.",
    "- **To read `table({ seed })` rows on an EPHEMERAL**, set `datasource: \"live\"`: there it holds only the seed fixtures (plus rows `--keep-data` kept); the run's writes are dropped. `diagnostics.allow` accepts its warning. ⚠ `datasource` is STORED, not a per-run flag: a test left on `\"live\"` clones the REAL database once it runs against an instance, so clear it before you promote.",
    "- `input` is `{ <input name>: Value }` — tagged values (`c.*`, `ref`, …), never plain JS scalars.",
    "- `token` runs the test as an authenticated caller. A pull does NOT bring it back: it is an expiring credential, reported as a deliberate omission. A token is signed per instance and expires: a literal one passes only on the backend that minted it, fails `Invalid token.` anywhere else, and commits a live credential to source. Keep `token` for a throwaway local check; for `query({ auth })` logic use the `defineFunction` route under **What a `workflowTest()` run actually sees**.",
    "",
    "### Assertions: `expect.*`, not `s.expect.*`",
    "",
    "- `expect.*` builds a `{type, vars}` record stored on a `tests` entry. `s.expect.*` builds a STATEMENT for a `workflowTest()` stack. Different return types; not interchangeable.",
    "- Subject first — argument order is the assertion: `expect.to_equal(resp(), c.int(2))`.",
    "- `resp()` is the response under test; `resp(\"id\")` drills, `resp(\"a-b\")` takes the bracket escape.",
    "- Subject only: `to_be_defined`, `to_not_be_defined`, `to_be_empty`, `to_be_null`, `to_not_be_null`, `to_be_true`, `to_be_false`, `to_be_in_the_future`, `to_be_in_the_past`.",
    "- ⚠ `to_be_in_the_past`/`to_be_in_the_future` compare at WHOLE-SECOND resolution and treat the SAME second as neither — a timestamp taken during the request under test (`c.now()`, a `created_at` the endpoint just wrote) fails `to_be_in_the_past` nearly every run. Assert `expect.to_be_less_than(resp(\"ts\"), c.now())` instead (or `to_be_defined` plus a range).",
    "- Subject + operand: `to_equal`, `to_not_equal`, `to_be_greater_than`, `to_be_less_than`, `to_contain`, `to_start_with`, `to_end_with`, `to_match` (operand is a delimiter-wrapped pattern — build it with `c.regex`).",
    "- `to_be_empty` passes ONLY for `\"\"`, `[]` and `{}` — `0`, `null` and `false` FAIL it; use `to_be_null` for null and `to_equal(…, c.int(0))` for zero.",
    "- `to_equal`/`to_not_equal` compare LOOSELY: `\"5\"` equals `5`, and `5` equals `5.0`. To pin a value's TYPE, assert on a filter (`withFilters(resp(\"x\"), fl.is_text())`), not `to_equal`.",
    "- `expect.to_be_within(subject, min, max)` — both bounds EXCLUSIVE; a subject equal to either fails.",
    "- `expect.to_throw(exception?)` takes NO subject. With an argument the error message must CONTAIN that text (case-insensitive substring); with none, any error passes. `exception` is a `Value` — `expect.to_throw(c.text(\"Wrong password\"))`, not a bare string (a bare one fails to compile with TS2345).",
    "",
    "### Mocks",
    "",
    "A statement returns a value instead of doing its work, for one named test.",
    "",
    "- `s.set_var(\"x\", c.int(1), { mock: { \"adds one\": c.int(123) } })`. Every statement takes `mock`.",
    "- Keyed by TEST NAME. A name the object does not declare THROWS at encode: the engine ignores a mock whose key is not a real test id, so it would deploy clean and silently never apply.",
    "- `{ value, enabled: false }` keeps a mock stored but switched off.",
    "- A mock applies ONLY while its test runs. It changes nothing about a normal request.",
    "",
    "### `example`",
    "",
    "`example?: { input?, output? }` on `query()` — the saved request/response sample the editor records. Free-form JSON, not tagged values. A pull DOES bring it back.",
    "",
    "### What a `workflowTest()` run actually sees",
    "",
    "Isolation rules; each fails a correct test with a misleading message.",
    "",
    "- The run uses an EMPTY datasource by default (`datasource: \"\"`), so **no `table({ seed })` rows exist while it runs** (same as a unit test): a read of seeded row 1 fails with its own precondition message, not an empty-database error. Build fixtures INSIDE the test, or set `datasource: \"live\"` under the ephemeral-only rule in the first section.",
    "- `s.api.call` reports a failing endpoint by WHERE it fails, so no single assertion covers every failure. `s.function.run` raises on every failure instead.",
    "",
    "| Failure | What `as` gets | Assert with |",
    "|---|---|---|",
    "| INPUT error (missing required input, wrong type) | nothing: the call RAISES and fails the test (`Missing param: msg`); later `s.expect.*` never run | `s.expect.to_throw({ body: [s.api.call({ api, input: {}, as: \"r\" })], exception: c.text(\"Missing param\") })` |",
    "| STACK error (`s.precondition`/`guard.*`) | the envelope `{ code, message, payload }`; the run carries on | `s.expect.to_contain({ expr: ref(\"r.code\"), value: c.text(\"ERROR_CODE_ACCESS_DENIED\") })` |",
    "| `s.throw` | a codeless `{ payload, statement }`: `ref(\"r.code\")` fails `Unable to locate var` | `ref(\"r.payload\")` |",
    "",
    "- `s.expect.to_throw` catches a call only when the error carries a MESSAGE. `ERROR_CODE_ACCESS_DENIED` arrives with an empty one, so `to_throw` around an auth-refused call reports `to_throw failed - response is ok`.",
    "- `s.expect.to_throw({ body, exception? })` runs `body` in an ISOLATED var stack, so a variable bound EARLIER in the test is not visible inside it — bind what the body needs inside the body. An outer one raises `Missing var entry: <name>` there, which the test reports as `to_throw` not matching (`export()` warns). `exception` is a `Value` (`c.text(\"already exists\")`), matched as in `expect.to_throw`; omit it to accept any error.",
    "- An endpoint's `auth` gate is NOT enforced on `s.api.call`. A `query({ auth: users })` runs anyway and fails only where its stack dereferences `auth(...)`. A stack that never touches `auth(...)` runs unauthenticated and passes.",
    "- Neither `auth.token` nor an `Authorization` entry in `headers` authenticates the call — a token that answers 200 over real HTTP is refused here. To cover auth-gated logic, move the body into a `defineFunction` taking the user id and `s.function.call` that; the gate itself is not reachable from a workflow test.",
    "- Table triggers do not fire on writes made during a test run (unit or workflow); a test asserting a trigger's side effect finds 0 rows. Triggers fire only on a deployed/ephemeral instance, async after commit (`llms/triggers.md`). Test the trigger's stack directly with `s.trigger.call({ trigger, input: { new: obj({…}), old: obj({…}), action: c.text(\"insert\"), datasource: c.text(\"live\") } })` — a synthetic `new`/`old`/`action`; `datasource` is REQUIRED — then assert on what it wrote.",
    "- A failing RUN's `message` is the authored message: a `s.precondition`/`guard.*` that raised inside a `.call` reports its own text (`\"Bookings must start in the future.\"`), an `s.throw` its `name`.",
    "",
    "### Running them",
    "",
    "`npx @xano/sdk test run-all` runs the unit tests AND the `workflowTest()` objects an environment carries. It takes no entry file and compiles nothing: it runs what is DEPLOYED, so deploy before testing.",
    "",
    "- `--on <backend>` picks the backend — `--on ephemeral:<name>`, `--on local`, `--on tenant:<name>`, `--on workspace`; omitted, the one this project last deployed to (grammar: **Backends** in `llms.txt`). ⚠ `workspace` runs against the REAL database: safe only while every test keeps `datasource: \"\"`, since a stored non-empty datasource is CLONED before the run.",
    "- `npx @xano/sdk test list` shows what is there without running it; `test run \"<name>\"` runs one; an ambiguous name prints qualified forms (`function:math/happy path`, `workflow:<name>`) `run` accepts.",
    "- `--kind unit|workflow` narrows to one family. `--concurrency <n>` defaults to 1: tests share the environment database.",
    "- A failing suite exits 5; exit 6 when the suite could not be reached — retry it; a backend that can't be looked up exits 8 (see errors). Having no tests is success.",
    "- For CI: the exit code says THAT something failed, the JSON says WHICH. Progress goes to stderr; stdout carries one JSON document when not a terminal, or with `--json`. `run-all` and `run`: `{ kind, env, name, display, total, passed, failed, tests: [{ kind, name, qualified, object?, status: \"pass\"|\"fail\", message?, expectations?: [{ index, status, message? }], timing? }] }` (`message`: the first failure; `expectations`: a unit test's every expectation in order, `index` from 0; `env`: an ephemeral's or tenant's name; `name`: the backend's own, a Xano Engine's too; null if none), same keys on an empty suite. `list` is `{ kind, env, name, display, total, tests }`; `deploy --test` nests the run under `testRun`.",
    "- `npx @xano/sdk deploy ./index.ts --test` deploys and then runs the suite against what it just shipped. A failure exits 5 WITHOUT retracting the deploy — the environment is live either way.",
    "",
  ];
}

function renderSections(m: Manifest): RenderedSections {
  const lines: string[] = [];
  lines.push(`# ${m.name} v${m.version}`, "");
  lines.push(`> ${m.description}`, "");
  lines.push(
    "Xano is one platform to build, run and govern AI-built software: one WORKSPACE",
    "serves a managed PostgreSQL database, HTTP APIs, background tasks, realtime",
    "websocket channels, AI agents, MCP servers, file storage and redis. This SDK",
    "authors it in TypeScript — typed def objects registered on a",
    "`workspace(name)` — compiled to one importable bundle by `npx @xano/sdk export",
    "./xano/index.ts`, shipped live by `deploy`.",
    "",
    "Def modules execute at BUILD time only: `s.*` factories return data, and the engine",
    "runs the compiled stack per request — statements in order, a statement's `as:`",
    "naming a runtime variable, `response` the HTTP body. Every dynamic operand is a",
    "TAGGED value — `ref(\"x\")` a stack variable, `inp(\"x\")` an input, `auth(\"id\")` the",
    "caller, `c.*` a constant — resolved at request time; JS operators over them do not",
    "compute (see Gotchas). Requests share no memory — state persists in tables or redis.",
    "",
    // The shortfall by name: an agent that cannot see WHICH kinds are missing
    // will invent a factory for one. Reasons live in `manifest.json`.
    `Authorable: statement surfaces ${m.coverage.statements.implemented}/${m.coverage.statements.total}, ` +
      `filters ${m.coverage.filters.total} (${m.coverage.filters.typed} typed).`,
    `Not authorable here: ${m.coverage.objectKinds.unmodeled
      .map((k) => (k.kind === "realtime_channel" ? "realtime_channel (legacy; author realtimeServer + realtimeChannel instead)" : k.kind))
      .join(", ")} — ` +
      "these cannot be authored and do not survive a pull; reasons in `coverage.objectKinds.unmodeled`.",
    "",
    "Per-surface detail is in the topic files below: open the one whose condition matches the task.",
    "Per-entry detail (a statement's field schema with engine defaults, a filter's full argument",
    "list, the `storedName` mapping) is in the shipped `manifest.json` — do a TARGETED lookup;",
    "it is ~70k tokens, so never read it whole. A program imports it as `@xano/sdk/manifest.json`",
    "(Node ESM needs `with { type: \"json\" }`). Its top-level keys are `" +
      Object.keys(m).join("`, `") +
      "`. `statements` and `filters` are ARRAYS, not maps — SELECT, do not index:",
    "  jq '.statements[] | select(.sPath==\"db.get\")' manifest.json",
    "  jq '.filters[]    | select(.name==\"json_decode\")' manifest.json",
    `⚠ \`fields\` is null on the ${m.statements.filter((st) => st.declarative !== true).length} \`declarative: false\` statements (\`db.get\`, …):` +
      " typed wrappers whose arguments are the factory's `.d.ts` signature. Null ≠ missing.",
    `Select a statement on \`sPath\` (the \`s.*\` path you write), NOT \`surface\` (the ` +
      `XanoScript term): ${m.statements.filter((s) => s.surface !== s.sPath).length} of ${m.statements.length} differ — ` +
      "`var`→`set_var`, `break`→`foreach_break`, `foreach.remove`→`foreach_remove`, and every `expect.*`.",
    "",
    NAVIGATION_SLOT,
  );

  lines.push(
    "## Quickstart",
    "",
    "```ts",
    'import { workspace, apiGroup, query, table, input, f, ref, inp, auth, s } from "@xano/sdk";',
    "",
    "const users = table({",
    '  name: "users",',
    "  auth: true, // backs authentication",
    "  // `id` (int PK) + `created_at` (epochms) are auto-injected — don't declare them.",
    "  schema: {",
    '    email: f.email({ required: true, methods: ["trim", "lower"] }), // a unique email index is CASE-SENSITIVE — lowercase it',
    "    name: f.text(),",
    "  },",
    "  // Indexes: { type, fields: [{ name, op? }] }. `\"unique\"` is shorthand for `\"btree|unique\"`.",
    "  // A DOTTED name indexes a key inside a column (`xdo.email`); only the part before the",
    "  // first dot is checked against the schema.",
    '  index: [{ type: "unique", fields: [{ name: "email" }] }],',
    "});",
    "",
    "const posts = table({",
    '  name: "posts",',
    "  schema: {",
    "    author: f.tableRef(users), // foreign key → users (NOT `ref`)",
    "    body: f.text({ required: true }),",
    "  },",
    "});",
    "",
    'const api = apiGroup({ name: "blog", canonical: "blog" }); // canonical → the URL token',
    "",
    "const createPost = query({",
    '  name: "create_post", verb: "POST", apiGroup: api, auth: users, // the auth table',
    "  input: { body: input.text({ required: true }) },",
    "  stack: [",
    '    s.db.add({ table: posts, row: { author: auth("id"), body: inp("body") }, as: "post" }),',
    "  ],",
    '  response: ref("post"),',
    "});",
    "",
    "const listPosts = query({",
    '  name: "list_posts", verb: "GET", apiGroup: api,',
    '  stack: [s.db.query({ table: posts, sort: [{ sortBy: "created_at", dir: "desc" }], as: "rows" })],',
    '  response: ref("rows"),',
    "});",
    "",
    'export default workspace("my-blog")',
    "  .registerTables([users, posts])",
    "  .registerApiGroups([api])",
    "  .registerQueries([createPost, listPosts]);",
    "```",
    "",
    "Compile: `npx @xano/sdk export ./index.ts --out bundle.json` (or `writeBundle(app, path)`",
    "from `@xano/sdk/node` in code). The default export must be the `Xano` registry. The entry must be an",
    "ES module (Xano SDK defs are ESM-only): set `\"type\": \"module\"` in the nearest",
    "package.json or name the entry `.mts`. `npm init -y` writes `\"type\": \"commonjs\"`,",
    "which fails with a \"must be ES modules\" error until you switch it to module.",
    "",
    "Set `canonical` on every `apiGroup`. The engine mints the URL token server-side, so",
    "without one `npx @xano/sdk routes` / `getPath()` cannot resolve the group's paths until a",
    "lock exists (the export itself succeeds).",
    "\u26a0 A canonical is unique across the whole INSTANCE, not per workspace; no flag shares one.",
    "A canonical set in code is a PIN: a merge refuses (exit 2) when another workspace holds it.",
    "One only the lock minted is not pinned: the instance may replace it with a random token,",
    "and `--static` is refused when it does.",
    "",
    "Build warnings: `export()` warns on shapes that deploy but misbehave (a `bulk.update`",
    "zero-filling omitted columns, an `ignoreEmpty` on an empty operand, a `ref()` nothing",
    "binds). In CI and agent builds pass `--strict` (`emitBundle(app, { strict: true })` /",
    "`app.export({ strict: true })`): every warning becomes a hard failure. Same bundle bytes",
    "either way.",
    "Before calling the work done: `npm run typecheck`, `npx @xano/sdk export <entry> --strict`,",
    "`deploy <entry>`, then `test run-all` against what deployed.",
    "",
    "Identity: object guids derive from `(type, name)` (a query adds group + verb),",
    "so renames change identity.",
    "Every build freezes every guid + api-group/toolset canonical in a lock file beside the entry",
    "file (`xano/xano.lock` in the standard scaffold, not the project root). Commit it",
    "(`--no-lock` opts out; CI guard `--frozen-lock` fails instead of changing it).",
    "To rename an object: rename in code, export (stderr prints the exact fix-up), run",
    "`npx @xano/sdk lock rename <kind> <old> <new>`, export again — the original guid is emitted",
    "under the new name, so the engine renames in place instead of delete+create. Taking",
    "over an existing workspace: `npx @xano/sdk lock import <live-bundle.json>` first, then",
    "export. Pruning, programmatic seeding, and which commands write the lock:",
    "`llms/lock.md`.",
    "",
    "## Deploy",
    "",
    "Commands here run as `npx @xano/sdk <cmd>`: `init` → `deploy` → URL. A deploy runs the same compile pipeline as",
    "`export` (honoring `xano.lock`), imports the result, and prints the URL.",
    "⚠ Every deploy is a FULL REPLACE of its destination — objects AND records.",
    "",
    "**Backends** — one grammar for every command that names a backend:",
    "",
    "- Spellings: `workspace` | `ephemeral[:<name>]` | `local[:<name>]` (no credential) |",
    "  `tenant:<name>` | `release:<name>` | a bundle path where a file fits.",
    "- Reads `--from`, writes `--to`, `test --on`; positional on `deploy`/`pull`/`generate`/`tables`/",
    "  `impersonate`.",
    "- Omitted = the ephemeral or Xano Engine this project last deployed to, never",
    "  workspace/tenant. Exceptions: bare `deploy` always targets the Xano Engine (`--ephemeral`: an",
    "  ephemeral); `generate`/`init --from` need one.",
    "- A backend a command cannot serve is refused, typed or tracked, with the reason and the valid",
    "  spellings (`release create` refuses a Xano Engine).",
    "- `release create --from` takes a run only: no bundle path, no `release:`, and a",
    "  `tenant:` only if throwaway (`standard`/`run` refused).",
    "",
    "**Destinations** — the Xano Engine by default, real only when you say so:",
    "",
    "- `deploy [source]` → the Xano Engine on this machine (no account).",
    "  - `--ephemeral` → a NAMED, auto-expiring ephemeral (~1h; `--expires-hours` 1–24), tracked in",
    "    `./.xano/ephemeral.json`, so deploying again REFRESHES it at the same URL; if it expired or",
    "    was swept, a fresh one is created and the new URL printed.",
    "  - ⚠ Only the BACKEND URL survives a refresh: the replace clears static hosting, so",
    "    `--static` publishes a NEW host every run and the previous URL stops serving.",
    "  - Under `--keep-data`, which MERGES an env a deploy filled instead of replacing it, the static",
    "    URL survives too: rows kept, no re-seed, removed objects deleted. ⚠ Limits: a rename loses values,",
    "    a RETYPE reads unfit ones as null, env VALUES are not applied, a table trigger refuses it.",
    "    `--reset` replaces and re-seeds.",
    "- `release create <name>` cuts a release from a running source and LANDS it in your workspace.",
    "  A release records that the source came up; it is the only thing `promote`/`tenant deploy` take.",
    "  - Refused: a taken name, and one that addresses a LOCATION instead of naming (`/`, `\\`, `:`,",
    "    or a leading `.`). Every export derives its FILENAME from the name it is given, so",
    "    `release|ephemeral|workspace export` refuse those same shapes unless `--path` names the file.",
    "  - Carries EVERY table's SCHEMA either way; `--seed[=<guids>]` adds ROWS. Guids come from",
    "    `tables <backend>`; a redeploy KEEPS them.",
    "- `release transfer <name> --to-profile <profile>` copies a release to another",
    "  workspace/instance by CONTENT (tar sha256): identical → reused; same name, other",
    "  bytes → exit 2.",
    "- `promote <release>` / `tenant deploy <tenant> <release>` land it.",
    "  - `promote` adds a branch; ⚠ its TABLE edits hit live (`--allow-shared-schema-changes`).",
    "  - `tenant deploy` REPLACES: DROPS tables it lacks, CONVERTS retypes (`--seed`: rows).",
    "  - `promote` refuses a taken name/pinned slug (`SDK_IDENTITY_CONFLICT`), then EXITS NON-ZERO",
    "    if a declared object did not arrive or a pinned slug is not served. `--set-live` switches",
    "    only after that check passes; a failure leaves the previous branch serving. Extra objects",
    "    are reported; a check missing an input reports `unverified`, exit 0.",
    "  - `--expect-live <label>` (with `--set-live`) refuses if live moved; not atomic.",
    "  - `--json` on every release write: `completed` yes|no|unknown; UNKNOWN exits 9 — run",
    "    `resolveWith`, never retry blind.",
    "  - Inspect a staged branch with `workspace export --branch <label>` or",
    "    `workspace diff <entry> --branch <label>`.",
    "- \u26a0 The redis family, `s.lambda`, `s.db.direct_query`, `s.await`, async runs,",
    "  `s.microservice.request`, `s.zip.*`, the raw-file readers, Datadog and Webflow need an",
    "  INSTANCE CAPABILITY: they deploy clean and fail on the first request if the target lacks it.",
    "  `export`/`deploy` list what the bundle needs — compare it to the target yourself.",
    "- Backend SECRETS stay out of the repo: declare the NAME, value empty, in `workspaceConfig({ env })`",
    "  passed to `registerWorkspace()`; the VALUE lives in `xano/.env` — gitignored, kept across a",
    "  pull, read by every build. `--backend-env-file <path>` replaces that default (CI has",
    "  no `xano/.env`), `--env-var KEY=VALUE` beats both, and `env pull` fills the file from",
    "  a running backend — the only command that writes `xano/.env`.",
    "  ⚠ A deploy REPLACES the env set: a declared name with NO value refuses the deploy rather",
    "  than clearing the live one — `--allow-empty-env=NAME` clears it on purpose.",
    "  ONE live value, no deploy: `env set NAME` (value on stdin) / `env unset NAME`.",
    "  (`--static-env` is the other one — PUBLIC frontend config.)",
    "- A DOCUMENTATION token is a secret too, in a SECOND ignored file: source declares only the",
    "  gate — `documentation: { require_token: true }` on `workspaceConfig` or an `apiGroup` — and",
    "  the value lives in `xano/.secrets.json`, keyed by the object it gates. A literal `token`",
    "  FAILS the export. `pull` writes that file and every build reads it back;",
    "  `secrets fill` MINTS one per gate that has none — a gate you AUTHORED has no value",
    "  to pull. CI, which does not have the file, passes `--secrets-file <path>` or",
    "  `--doc-token \"<scope>=<value>\"`",
    "  (scope = `workspace`, or the group's NAME).",
    "  \u26a0 OMISSION IS OPPOSITE PER SCOPE: off `workspaceConfig` the target's gate is left alone;",
    "  off an `apiGroup` it is CLEARED (an absent key there is written as the engine default). An",
    "  unsupplied gate refuses a `deploy` and fails the export for a publishing group.",
    "- `deploy --to workspace|tenant:<name>` skips the release flow to merge a LOCAL",
    "  build in, keeping the checks that need one (`--dry-run`, `--prune`, loss warnings) and",
    "  leaving nothing to roll back to. Prefer the release path.",
    "  ⚠ Branches scope LOGIC: tables and microservices are shared by EVERY branch, so a",
    "  schema change reaches production on any branch — refused without",
    "  `--allow-shared-schema-changes` — and dropping a column destroys its data.",
    "  ⚠ `--replace` CLEARS BY WORKSPACE, NOT BY BRANCH: every non-live branch goes, with the",
    "  saved versions that would restore one — unrecoverable. Refused without",
    "  `--allow-branch-deletion`; `--yes` does not imply it. The default merge leaves them alone.",
    "- `workspace reset-tables <entry> --table <guid>` puts NAMED tables back to their",
    "  compiled `table({ seed })` rows, touching no other table. Dry run unless `--write`.",
    "  ⚠ ROWS BEFORE LOGIC: rows are workspace-shared like schema, so they reach production when",
    "  applied, even while the logic reading them is staged. Reset rows FIRST, then `promote`.",
    "- `pull` refreshes THIS project from a backend: rewrites decoded files,",
    "  keeps yours, lists and confirms (`--yes`).",
    "- `generate <source>`: the decoded tree ONLY, no project.",
    "- `status` names the env this project last deployed to, its URL and its expiry.",
    "",
    "**Frontend wiring.** `--static <dir>` (or `publish <dir>`) injects the env's backend URL as",
    "`window.XANO_HOST` into EVERY html document in the build, before the app bundle runs,",
    "so the frontend needs no rebuild to target an env. How to read it, local dev, verifying",
    "the inject, and displaying a stored file: `llms/client.md`.",
    "⚠ A static host serves its files verbatim, so everything injected is PUBLIC — base",
    "URLs and publishable keys only, never secrets. Secrets go in backend env, read",
    "server-side via `env(name)`.",
    "⚠ `preflight` uses the deploy credential unless `XANO_VALIDATE_INSTANCE` /",
    "`XANO_VALIDATE_TOKEN` (+ optional `XANO_VALIDATE_WORKSPACE_ID`) are set.",
    "",
    "**Full CLI surface:** `npx @xano/sdk <command> --help` — every command, flag, default and accepted",
    "backend; `manifest.json` carries the same in its `cli` array.",
    "**Style:** reach statements through the `s` namespace (`s.db.add`, `s.math.add`, …).",
    "The flat aliases (`dbAdd`, `setVar`, …) are identical in output; prefer `s.*`.",
    "",
  );

  lines.push(
    "## Gotchas",
    "",
    "Non-obvious authoring rules:",
    "",
    "### Values and references",
    "",
    "- **No callback builder.** Flat def-objects + `register*`, not",
    "  `workspace(w => w.table(...))`. `workspace(name)` returns a named `new Xano()`;",
    "  tables are `table({ schema: { col: f.text() } })`.",
    "- **Foreign key is `f.tableRef(table)`, not `ref`.** `ref` = stack var (`as:` output),",
    "  `inp` = input, `col` = table column (in `db.query` `where`), `auth(\"id\")` = the caller,",
    "  `c.*` = a constant; `f.tableRef` is the column constructor.",
    "- **Tagged values are DATA — a JS template literal cannot compose them.** `${ref(...)}`",
    "  (or `\"a\" + ref(...)`) stringifies the tag object at BUILD time: ``c.text(`Hi ${ref(\"u.name\")}`)``",
    "  type-checks and encodes the literal text `Hi [object Object]`, served verbatim.",
    "  `export()` warns; `--strict` fails. Compose at RUNTIME:",
    "  `withFilters(c.text(\"Hi \"), fl.concat(ref(\"u.name\")))`, an `obj({...})`/record member,",
    "  or `c.expression('\"Hi, \" ~ $var.u.name')`.",
    "- **Declare inputs with `input.<type>()`, read them with `inp(\"name\")`.** `inp()`",
    "  resolves ONLY against this def's own `input` block — a value produced earlier in",
    "  the stack is `ref(\"var.field\")`, not `inp(\"field\")`. An undeclared name fails at",
    "  runtime with `Unable to locate input` (`export()` warns).",
    "- **`get_input`/`get_raw_input` read the whole payload**, not one named input",
    "  (args are `{ as?, encoding?, excludeMiddleware? }` — no `name`). For a single",
    "  input use `inp(\"name\")`.",
    "- **A `where` is a comparison, never a value.** To match every row, omit `where`. A value",
    "  `where` — `c.bool(true)`, a text clause, or one built at run time (`inp(\"clause\")`,",
    "  `ref(\"built_where\")`) — throws at build: the engine reads a filter only as a comparison",
    "  tree and runs anything else over EVERY row. Bind run-time values as operands instead:",
    "  `expr(col(\"status\"), \"=\", inp(\"status\"))`.",
    "",
    "### Tables and columns",
    "",
    "- **System columns are auto-injected.** `id` + `created_at` are prepended to",
    "  every table (`system: true` by default); declaring them by hand is redundant.",
    '  `id` is an `int` PK by default; pass `idType: "uuid"` on the table for a uuid key.',
    "  Both are valid targets wherever a column name is accepted — `db.query` `sort`/",
    "  `output`, a `db.get`/`edit`/`del` `fieldName`, etc. (the column-name type is",
    "  `keyof schema | \"id\" | \"created_at\"`), and both appear in `InferRow<typeof table>`.",
    "- **A column named `run` is reserved.** The table deploys and reads back fine, then",
    "  EVERY `s.db.add` into it 400s — at any column type, with or without a value — and",
    "  the error names the column while complaining about the VALUE. Use `run_id`. Exact,",
    "  case-sensitive, one name: `Run`/`runs`/`run_id` are fine. `--strict` fails on it.",
    "- **An input named `run` is reserved when a call passes it**: the callee gets",
    "  defaults or a 400. HTTP binds it fine. `--strict` fails on it.",
    "- **Numeric columns lose money quietly.** A normalized table's `f.decimal` reads",
    "  `0.12345678` back as `0.12346`; `f.int` saturates at `9223372036854775807`",
    "  instead of failing, both at HTTP 200. Hold money as a count of the smallest unit;",
    "  exact bounds: `llms/fields.md`.",
    "- **Self-referencing tables** need the bare-name form: inside `tweets`'s own",
    '  schema, write `f.tableRef("tweets", { type: "int" })` — the `const tweets`',
    "  handle isn't assigned yet, so the handle form throws \"used before declaration\".",
    "- **Seed a table's starting rows with `table({ seed })`.** Rows typed against the",
    "  schema, inline (`seed: [{ name: \"…\" }]`) or from a file (`seedFile(\"./seed.json\",",
    "  import.meta.url)`). Only `deploy` ships them, and a re-deploy re-seeds cleanly. Never",
    "  put secrets in `seed`. Row shape, `id` pinning, and the file rules: `llms/fields.md`.",
    "- **`f.password()` defaults to `access: \"internal\"`, so `db.get` does NOT return it.**",
    "  A login stack that reads `ref(\"u.password\")` after a plain `db.get` fails at runtime",
    "  with `Unable to locate var: u.password` — the column is simply absent from the row.",
    "  Name it in the read's `output` to pull it: `s.db.get({ table: users, fieldName: \"email\",",
    "  fieldValue: inp(\"email\"), output: [\"id\", \"email\", \"password\"], as: \"u\" })`, then",
    "  `s.security.check_password`. `output` OVERRIDES column visibility — it is the only way to",
    "  read an `internal` column, and `export()` warns when a stack reads one a `db.get` did not",
    "  return.",
    "- **Don't take a password through `input.password` on login — it double-hashes.**",
    "  An `f.password()` column hashes on write, and `input.password` *also* hashes the",
    "  submission on bind, so `s.security.check_password` compares two different hashes",
    "  and a correct password always fails (`ok:false` on a found row). Take the submitted",
    "  password as `input.text()` on both signup and login and pass the plaintext straight",
    "  to `check_password` (which does the comparison hash itself). `export()` warns.",
    "",
    "### Reading and writing rows",
    "",
    "- **DB reads are field-match, not `where`-expr.** `db.get`/`db.edit`/`db.del`/",
    "  `db.has`/`db.patch` match exactly ONE field: `{ fieldName, fieldValue }` (`fieldName`",
    "  defaults to the PK `id`); there is no composite match. Only `db.query` takes a",
    "  `where`/`additionalWhere` `expr(...)`; writes (`db.add`/`db.edit`/`db.add_or_edit`) take a",
    "  `row`/`data`. For an `(a, b)` existence/fetch (e.g. dedupe a `(habit, date)` check-in), use",
    "  `db.query({ where: [expr(col(\"habit\"), \"=\", ...), expr(col(\"date\"), \"=\", ...)], as })`",
    "  (a `where` array is ANDed) and branch on the result. Signatures: `llms/statements-data.md`.",
    "- **Drilling into a maybe-null `db.get` result 500s — use `ref(path, { safe: true })`.**",
    "  `db.get` binds `null` on a no-match, but a nested `ref(\"owner.user_id\")` raises a runtime",
    "  \"Unable to locate var\" (HTTP 500) when `owner` is null — an ownership guard throws instead",
    "  of failing cleanly (same for a `single` `db.query`; warns `stack.drill-maybe-null`). Two correct shapes:",
    "  - Guard existence first — `guard.found(\"owner\")` (a 404 precondition) — then drill WITHOUT `safe`.",
    "  - Or drill null-safe inside an EXPRESSION or `obj()` operand:",
    "    `expr(ref(\"owner.user_id\", { safe: true }), \"=\", auth(\"id\"))` yields `null` (the guard",
    "    reads `false`) instead of 500ing. Works inside `obj({...})` too — no `s.set_var` hoist needed.",
    "  ⚠ EXPRESSION and `obj()` operands ONLY — never a `db.*` match argument. `null` is not a",
    "  legal `fieldValue`/`id`, so a chained get (fetch the child row, then its parent to check",
    "  the owner) fails with HTTP 400 `Missing param: field_value` one statement BEFORE the guard.",
    "  There guarding existence first is MANDATORY. `export()` warns on a safe ref in that position.",
    "  ⚠ That is for a base that EXISTS and may be null. If the base binds nothing at all (a typo),",
    "  `{ safe: true }` buries the bug as a silent `null` — `export()` warns with a did-you-mean;",
    "  fix the name instead.",
    "- **`output` selects from what the statement BINDS, and a PAGED `db.query` binds the",
    "  envelope.** With `metadata: true` (the DEFAULT), the roots are `items.<column>` plus the",
    "  counters you want kept: `output: [\"itemsReceived\", \"curPage\", \"items.id\", \"items.title\"]`.",
    "  A bare column list there matches no envelope key, so ALL of them are dropped and the",
    "  endpoint answers `[]` at HTTP 200 with no error — and a `response` reading",
    "  `ref(\"rows.items\")` then dies with `Unable to locate var: rows.items`. Prefix the columns,",
    "  or set `metadata: false` inside `paging` to select the rows directly.",
    "  `export()` warns; `--strict` fails.",
    "",
    "### Stacks and calls",
    "",
    "- **Block specials nest a `body`, not a `stack`.** `s.for`/`s.foreach`/",
    "  `s.while`/`s.switch`/`s.try_catch`/`s.db.transaction`/`s.expect.to_throw`",
    "  take their sub-stack as `body` (`try`/`catch`/`finally` for `try_catch`);",
    "  `s.group(body)` and `s.util.post_process(body)` take it **positionally**.",
    "  `s.for` is **count-bounded** (`{ as, count: <Value>, body }`), not from/to. See the",
    "  authored signatures in `llms/statements-data.md`.",
    "- **`s.api.call` / `s.task.call` / `s.trigger.call` / `s.workflow_test.call` are",
    "  WORKFLOW-TEST ONLY.** Outside a `workflowTest({...})` stack the engine cannot reach",
    "  the target, so one in a query/function/task deploys clean and then answers the first",
    "  real request with `ERROR_FATAL: <Type> does not exist: <type>:<n>`. The failure is not per",
    "  host kind: the same call inside a function that a query runs fails the same way.",
    "  `export()` refuses them. `s.function.call`, `s.tool.call`, `s.middleware.call` and",
    "  `s.addon.call` run anywhere, as does `s.function.run`. To share logic, put it in a",
    "  `defineFunction` and `s.function.run` it — NOT `s.function.call`, which binds a failing",
    "  target's error envelope instead of raising.",
    "- **`expect.*` is a unit-test assertion; `s.expect.*` is a workflow-test statement.**",
    "  A statement's `mock` is keyed by TEST NAME; an undeclared name throws. See `llms/tests.md`.",
    "- **A helper returning `Statement[]` widens the stack and kills `InferResponse`.**",
    "  Spreading `...requireX()` where the helper is typed `Statement[]` drops the stack's TUPLE",
    "  type, so EVERY `ref()`/`as` in that stack — even ones after the spread — resolves to",
    "  `unknown` and the response types as `StackTupleWidened`. Nothing fails at the helper; it",
    "  surfaces where the response is consumed, often a frontend typecheck. Fix: return",
    "  `statements(s.a(...), s.b(...))` — its tuple survives the spread. A helper that builds",
    "  its array in a LOOP cannot be a tuple; declare `responseShape` on the query there.",
    "- **Build regex-filter patterns with `c.regex(body, flags?)`, never `c.text`.**",
    "  The regex filters (`regex_test`/`regex_match`/`regex_replace`/…) are PHP `preg_*`: the",
    "  piped value is the PATTERN and must be delimiter-wrapped, and the ARGUMENT is the subject.",
    "  Correct: `withFilters(c.regex(/^[a-z-]+$/i), fl.regex_test(inp(\"slug\")))`.",
    "  - A bare `c.text(\"^…$\")` is an invalid pattern that matches *nothing* for every input, so",
    "    a precondition on it rejects all values. `c.regex(body, \"i\")` (or a JS `RegExp`) wraps + escapes it.",
    "  - Reversed (subject piped, pattern in the argument) type-checks and",
    "    answers false for EVERY input, so an `if (matches) reject` guard admits what it refuses.",
    "  - `withFilters` throws on both: a bare `c.text` pattern at ANY position in the chain (a",
    "    normalizer in front does not add delimiters) and a pattern in the subject slot.",
    "    `s.expect.to_match` is the same PATTERN slot, refused both ways. A `ref`/`inp` pattern is",
    "    passed through untouched. `export()` warns on a reversed pair in stored bytes.",
    "  - Prefer a native typed input (`input.email`) over hand-rolled validation.",
    "- **An `auth()`-keyed limiter FAILS the request on any host with no caller identity —**",
    "  **at every tier.** `s.redis.ratelimit({ key: withFilters(c.text(\"rl:\"), fl.concat(auth(\"id\"))), error: c.text(\"…\") })`",
    "  is the per-user form, and a public query, a task, or a function has no caller identity.",
    "  It does not degrade to one shared bucket: on a public endpoint the FIRST call 403s,",
    "  under `max`, and the host never runs. Key off `sys.remoteIp()` there. Attaching it",
    "  at `apiGroup({ middleware })` or the workspace tier inherits the same failure onto",
    "  every member endpoint. Export warns, naming the tier.",
    "",
    "### Identity, build, and deploy",
    "",
    "- **Same-name siblings collide — queries excepted: their identity carries group + verb.**",
    "  Two functions (or tables, toolsets, …) sharing a name derive ONE guid and `export()`",
    "  throws — give them DISTINCT names. A QUERY",
    "  derives from `(api group, verb, name)`, the engine's own uniqueness: `GET items` +",
    "  `POST items`, and `items` across two groups, coexist, and the lock keys the same",
    "  composed identity (`query:blog|GET|items`) — changing a query's verb or group",
    "  changes its identity. An explicit `guid` on a colliding pair clears the throw but",
    "  is NOT a lasting fix: a lock entry cannot hold two guids, so `export --lock`",
    "  refuses the pair (`export()` warns even unlocked); it is for pinning identity",
    "  across a rename, not for sharing a name.",
    "- **`export()` vs `emitBundle()` vs `writeBundle()`:** `export()` returns the object,",
    "  `emitBundle()` the JSON, `writeBundle(app, path)` writes `export`'s file. All",
    "  three run the SAME build-time checks, INCLUDING seed validation of a literal `seed: [...]`",
    "  array (row shape, unknown column, coercion, enum membership, the all-or-nothing `id`",
    "  rule). A DEFERRED seed — a thunk (`() => import(\"./seed.json\")`) or `seedFile()` — is",
    "  checked only by the `export`/`deploy` CLI path. Only `deploy` ships seed rows.",
    "  - Entry points: the `node:fs` writers (`writeBundle`/`writeArtifact`) and lock-file I/O",
    "    import from `@xano/sdk/node`, NOT the browser-safe `@xano/sdk` entry (a frontend",
    "    imports from it; request types come from `routes.gen.ts`). `@xano/sdk/internal` is the",
    "    compiler machinery, never needed to author. READING a bundle back is `@xano/sdk/bundle`",
    "    — a statement walker (`2.if.0` paths), a structural hash, `mvp:*` catalog, `tableRefOf`.",
    "- **Intra-workspace imports use `.js` specifiers** (`../tables/links.js`), not",
    "  extensionless — the defs compile under `moduleResolution: bundler`. Add the `.js`.",
    "- **Agents authenticate with env vars — never `npx @xano/sdk login`.** `login` blocks on a",
    "  browser consent no agent can complete. Set all three of `$XANO_INSTANCE_URL`,",
    "  `$XANO_WORKSPACE_ID`, `$XANO_META_TOKEN` and run `deploy`/`promote` directly: no disk, no",
    "  rotation, so it survives repeated runs.",
    "  - Not signed in: ask the human whether they have a Xano account; never guess. No: sign",
    `    them up via ${AGENT_SIGNUP_URL}; it returns this triple once they confirm by email. Yes: the`,
    "    human runs `login`.",
    "  - The triple outranks every other credential (`--config`, `$XANO_PROFILE` and",
    "    `$XANO_REFRESH_TOKEN` included, each named on stderr when displaced). Setting SOME of the",
    "    three is a hard error, so a misspelled secret cannot fall through to whatever credential",
    "    the runner has. An explicit `--profile` against it is a hard error too, not a displacement.",
    "  - On disk: `npx @xano/sdk profile add <name> --instance … --workspace-id <n>` reads the token",
    "    from piped stdin, else PROMPTS (a flag would reach the process list); the instance must accept it.",
    "    `auth.json` holds a map of named profiles, selected by `--profile <name>`.",
    "    `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID` also authenticate, but the refresh token is single-use (it ROTATES).",
    "- **Event-driven objects run once deployed.** A `task` (scheduled), an `mcpServer`, and",
    "  every trigger — `tableTrigger` included — run on every deploy target, the Xano Engine and",
    "  an ephemeral alike. Test an event-driven design (screen-on-insert, scheduled cleanup, MCP",
    "  tool call) by deploying it and letting it run.",
    "",
  );

  const objectKinds: string[] = [];
  objectKinds.push("## Object kinds", "");
  objectKinds.push(
    "### Choosing a kind",
    "",
    "Choose by who or what starts the work.",
    "",
    "- **Logic other code calls** → `defineFunction`, run with `s.function.run`. A `query` is the only kind an HTTP client reaches by verb + path; a `tool` is what an `agent()` or an MCP client calls. Logic serving two callers (an endpoint AND a tool) lives in one function both call.",
    "- **Work on a timer** → `task` (fixed interval, no cron). **Work a request starts but does not wait for** → `s.function.run({ fn, runtime: { mode: \"async-shared\" } })`, which binds a job id, not the result (collect with `s.await`). **Work that follows a row change** → `tableTrigger`: it fires on every write to the table, whichever stack writes it (except a trigger's own), so the same side effect in one endpoint's stack misses every other write path. It runs after commit, async — validation belongs in the writing stack (`llms/triggers.md`).",
    "- **The same steps before or after many objects** (an auth check, a rate limit, logging) → `middleware`, attached per host (`middleware: { pre, post }` on a query, function, task, tool, API group, prompt, resource, or realtime server/channel/message) or to every host of a kind with `workspaceConfig({ middleware: { query, function, task, tool } })` — not a function call repeated at the top of each stack.",
    "- **Related rows on returned rows** → an `addon` attached to the read through its `addon: [{ addon, as, input }]` option (`db.query`/`get`/`add`/`edit`/`patch`), merged onto each row under `as` and typed in `InferResponse` — not a second read plus a loop that stitches rows together.",
    "- **AI.** An LLM running inside the backend → `agent()`, started from a stack with `s.ai.agent.run`; it has no public endpoint. An external AI client (Claude, Cursor, any MCP client) calling the backend → `mcpServer()`. Standing instructions for Xano's own builder AI → `knowledge()` (who reads it: `llms/kinds-knowledge.md`). The actions either one calls → `tool()`. What an MCP server serves besides tools (`prompt()`, `resource()`) and when each fits: `llms/kinds-agent-mcp.md`.",
    "- **Pushing to connected clients** → `realtimeServer` → `realtimeChannel` → `realtimeMessage` (the handler for a frame a client sends — the realtime analogue of a query). A server-side push from any stack is `s.realtime.publish`; a client polling a `query` is the substitute this replaces.",
    "- **Code the typed surface cannot express** → a lambda (`s.lambda`, `fl.lambda`) for a short JavaScript body, LAST, after native filters and expressions (`llms/lambda.md`); a `microservice` for a long-running container or another language; `s.api.request` for a service that already has an HTTP API.",
    "- **Tests** → `tests` on a `query`/`defineFunction`/`middleware` for that one object's input → output; a `workflowTest` for a flow across objects (`s.function.call`, `s.api.call`, `s.task.call`) asserted with `s.expect.*`.",
    "- **Reacting to the platform** → `errorTrigger` (an error signature first seen, regressing, or marked fixed) and `workspaceTrigger` (branch new/merge/live). What one connection to an MCP server, agent, realtime server or channel may see or do → that object's connection trigger.",
    "",
  );
  objectKinds.push(
    "Composing a workspace from modules: `registerTables(modules.flatMap((m) => m.tables))` does NOT typecheck — `flatMap` (and `.concat()`) binds its element type to the FIRST element, so later tables are checked against that one table's schema; the error names two unrelated columns, not the cause. Pass an array LITERAL (`registerTables([...a.tables, ...b.tables])`), or annotate the module array with the wide aliases `AnyTableDef` / `AnyQueryDef` / `AnyFunctionDef` / `AnyAddonDef`. Widening loses nothing: typing lives on the `table()`/`query()` handle passed to `s.db.*`.",
    "",
  );
  for (const k of m.objectKinds) {
    if (k.subKinds && k.subKinds.length > 0) {
      // Fan a multi-factory kind out into one root-level line per sub-kind so
      // each reads as a first-class primitive (they share one payload key +
      // register method, discriminated by `obj_type`).
      for (const sub of k.subKinds) {
        // Legacy sub-kinds are withheld here and named in the legacy index instead.
        if (sub.legacy) continue;
        objectKinds.push(
          `- ${k.kind} (${sub.objType}): \`${sub.authorFactory}\` → \`Xano.${k.registerMethod}\` → payload \`${k.payloadKey}\` — ${sub.description}`,
        );
      }
    } else {
      objectKinds.push(`- ${k.kind}: \`${k.authorFactory}\` → \`Xano.${k.registerMethod}\` → payload \`${k.payloadKey}\` — ${k.description}`);
    }
  }
  objectKinds.push("");

  // Curated def-object shapes for the high-traffic authorable kinds plus the
  // `expr`/`response` helpers. These are hand-authored interfaces (not in the
  // generated statement specs), so — like the specials block above — they're
  // maintained from the `*Def` interfaces in `src/kinds/` + `src/responses/`.
  // Def shapes split by access pattern: the core kinds nearly every workspace
  // touches, against the agent/MCP, realtime, and trigger surfaces a minority do.
  const kindsCore: string[] = [
    "## Object def shapes",
    "",
    "The def-object passed to each factory. `?` = optional. `input` is keyed by",
    "input name (`input.<type>(opts?)`); `stack` is `Statement[]` (`s.*`); `response`",
    "is a `ResponseDef` (see **Responses** below). Object identity is `guid?` —",
    "omit it and it derives from `name` (for a query, from group + verb + name; set it",
    "to survive a rename).",
    "",
    "- `defineFunction({ name, guid?, description?, docs?, workspace?, input?, stack?, response?, tests? })`",
    "- `query({ name, verb, apiGroup?, guid?, auth?, input?, stack?, response?, responseType?, apiEnabled?, disabled?, cache?, description?, docs?, tests?, example? })` — a `cache` setting turns caching on unless `active: false`",
    "  - `verb`: `\"GET\" | \"POST\" | \"PUT\" | \"PATCH\" | \"DELETE\" | \"HEAD\"` (required), UPPERCASE. Anything else (e.g. lowercase `\"post\"`) makes `query()` THROW — Xano would store NULL, a null verb serves as GET, and the verb you meant 404s `Unable to locate request.`",
    "  - `apiGroup`: an `apiGroup()` def handle (or its name) — binds by guid, stable across syncs. Raw numeric `apiGroupId?` is the escape hatch and wins if both given.",
    "  - `auth`: `false` (no auth) or an auth-table id; `responseType`: `\"standard\" | \"stream\"` (default `standard`) — any other spelling THROWS (Xano would store NULL and buffer it as `standard`). ⚠ `s.api.stream` does nothing unless `responseType: \"stream\"`: in a `standard` query its chunk is SILENTLY DROPPED (no warning) and the normal `response` is served. Paired, each `s.api.stream({ value })` call emits ONE Server-Sent Event — the wire is `Content-Type: text/event-stream`, a `data: <json of value>` line per event, with an `id:` line that is a MILLISECOND TIMESTAMP and is NOT unique (ids repeat within a ms, so `Last-Event-ID` resume is unreliable). The query's own `response` is not sent in `stream` mode. Consumer recipe (`EventSource`/`fetch`): `llms/client.md`.",
    "  - `name` is the endpoint PATH within the group.",
    "    - A `{param}` segment is a URL PATH PARAM bound to the input of the same name, and segments chain: `name: \"blog/{slug}/review/{review_id}\"` + `input: { slug: input.text(), review_id: input.int() }`. Read it with `inp(\"slug\")` like any other input.",
    "    - Every `{param}` MUST have a matching input or `query()` THROWS — Xano would treat an unbound marker as literal route text.",
    "    - A `{param}` need NOT be a whole segment (`\"blog/post-{slug}\"` routes fine), but its type must fit one segment (no object/list/json/file/geo/vector); there are no wildcards or patterns. `required: true` is NOT demanded.",
    "    - An input a `GET`/`DELETE`/`HEAD` looks ONE ROW up by (`s.db.get`/by-field edit/patch/delete; not `has` or an email/token/code) belongs in the path — `export()` warns `query.path-segment-candidate`: `getPath()` types STATIC. A segment is any value naming WHICH resource is wanted (`\"shop/{country}\"`); one that NARROWS A LIST (`s.db.query`) stays a query param. Intended? `diagnostics: { allow: [code] }` on the query (any def, for its own advisories) accepts it under `--strict`.",
    "    - Routes are matched FIRST-FIT in creation order, and a literal gets NO precedence over a `{param}`: `\"runs/{id}\"` (a text `id`) created before `\"runs/trend\"` answers `GET /runs/trend` itself. Two routes in one group and verb that one request path can match are REFUSED at `export()` (`query.route-shadowed`) — reordering `registerQueries` cannot fix it, since a release keeps an existing route first. Make the paths disjoint (`\"runs/by-id/{id}\"`), or declare a numeric param `input.int({ required: true })` (or `decimal`): only a REQUIRED int/decimal segment matches digits only — an OPTIONAL one matches any text, so `input.int()` still takes `trend`.",
    "    - Inputs absent from the path are ordinary query-string/body params.",
    "    - Name charset is ONLY `A-Za-z0-9_-/{}`, max 200: a `.` (`\"export.zip\"`) THROWS — Xano would store an EMPTY name that deploys clean then 404s. Use `\"export_zip\"` and set the extension in the response headers.",
    "  - **Client recipe:** `q.getPath({ params: { slug: \"hello\" } })` → `/api:<canonical>/blog/hello` — never interpolate by hand.",
    "    - `getPath` percent-encodes each value (so `?`/`#`/spaces stay in their segment) and throws on what encoding cannot contain: a `/`, and a segment that becomes `.`/`..` as sent (a URL parser drops those before routing, addressing a different endpoint).",
    "    - The keys are typed from the literal `name`, so a typo is a compile error.",
    "    - `q.toSearchParams(input)` drops GET path params (free `query.toSearchParams` keeps them); lists send `k[]=a&k[]=b` (`k=a&k=b` binds only `b`).",
    "  - Browser bundle cost, the `routes.gen.ts` alternative (paths and request types), and spot-checking a def from Node: `llms/client.md`.",
    "- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors?, middleware? })` — a query container; queries bind to it via their `apiGroup`. `canonical` holds only letters, digits, `_` and `-` (it is the `<canonical>` of `/api:<canonical>`); anything else THROWS at build.",
    "  - `documentation?`: `{ require_token? }` — the gate on this group's hosted docs; `swagger: true` publishes the docs. `require_token: true` IS the declaration; the token lives in `xano/.secrets.json` under this group's guid.",
    "    - The block is ALWAYS emitted: an absent key is written as the engine default on import, so omitting it CLEARS an existing gate (the opposite of the `workspaceConfig` rule).",
    "    - ⚠ `require_token` gates them only alongside a non-empty token: `swagger: true` with no gate makes the whole group readable by anyone with the URL — export warns once per build and `--strict` fails; `diagnostics: { allow: [\"api-group.docs-public\"] }` accepts it.",
    "    - A declared gate with NO token drops the block, clearing the gate: export FAILS under `swagger: true`, and with `swagger` off warns and completes.",
    "    - A literal `token` FAILS the export.",
    "  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.",
    "    - `mode?`: `\"default\"` (the default) | `\"custom\"` | `\"disabled\"`, lowercase — a fourth value THROWS at export (`apiGroup()` itself does not check); otherwise Xano DROPS THE WHOLE API GROUP on import (deploy succeeds, every query 404s). ⚠ Every OTHER field applies only under `\"custom\"`: `\"default\"` serves a FIXED permissive policy (any origin, `allow-headers: *`, `allow-credentials: true`, `max-age: 86400`) and ignores the block, so setting `maxAge`/`allowCredentials`/`allowHeaders` alone changes nothing. `\"disabled\"` sends no CORS headers at all, so every browser call fails.",
    "    - ⚠ Under `\"custom\"`, `allowOrigins` is matched as EXACT strings (scheme+host+port, no wildcard or subdomain expansion) and `\"*\"` is compared as a literal origin — it matches NOTHING. An unmatched origin gets no `access-control-*` headers at all, so the browser call fails while export, deploy and the preflight look fine. Name each origin, or use `mode: \"default\"` for any-origin. `allowMethods` gates the REAL response too: a verb left off gets no CORS headers back even though its preflight passes. Export warns on an empty origin list, a `\"*\"` entry, and a policy with no method enabled; a non-origin entry (trailing `/`, path) is refused.",
    "- Tasks, workflow tests, middleware and tools below (agents and MCP servers: `llms/kinds-agent-mcp.md`) share the envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.",
    "- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`). `active?` defaults `true`; `active: false` deploys it parked.",
    "  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`. `startsOn`/`endsOn` are **timestamp strings** validated at encode time — `\"2026-01-01T00:00:00Z\"`, or the space-separated `\"2026-01-01 00:00:00+0000\"` a pulled workspace carries — never epoch numbers, and never zoneless; `freq` is the repeat interval **in SECONDS** (omitted ⇒ runs ONCE) — spell it `every(\"15m\")`, a compile-time duration-to-seconds helper (`s`/`m`/`h`/`d`/`w`, terms concatenate). No cron, no timezone — a fixed-offset `startsOn` drifts an hour at each DST change; for a local time run hourly, gated on the local hour `withFilters(c.now(), fl.epochms_date(\"G\", \"America/New_York\"))`. `repeatEnabled?`/`endsEnabled?` follow whether `freq`/`endsOn` is set and are recovery-only — state one to reproduce a stored gate left OFF. Runs on every deploy target (`llms.txt` Gotchas).",
    "- `workflowTest({ name, guid?, description?, docs?, datasource?, active?, tags?, stack? })` — an end-to-end test. NO `input`/`response`: `.call` something with an `as`, then assert on that var — `s.function.call({ fn, input, as: \"r\" })`, `s.expect.to_equal({ expr: ref(\"r\"), value: c.int(42) })`. `s.expect.*` belongs here — it is not inert elsewhere (a failure 500s the request), so treat one in a query/function/task as a mistake to remove. `active?` defaults `true`; `active: false` parks the test — `test run-all`/`deploy --test` SKIP it (reported `status: \"skipped\"`, never failing the suite), `test list` shows it `inactive`, and `test run \"<name>\"` still runs it. Chain tests with `s.workflow_test.call({ workflowTest: <def handle>, as: \"child\" })` then `s.expect.to_be_null({ expr: ref(\"child\") })`, or a failing child passes the parent.",
    "  - `datasource?`: Default `\"\"` is an EMPTY datasource (recommended), not \"no datasource\". Any non-empty name is CLONED before EVERY run — against production-sized data, slow enough to fail the run; `\"live\"` warns at compile time. On an EPHEMERAL, `\"live\"` holds only the seed fixtures (plus rows a `--keep-data` deploy kept): the way to read `table({ seed })` rows — a small clone, dropped after the run. ⚠ The value is STORED, so clear it before you promote or the same test clones the real database.",
    "- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response?, responseShape?, tests? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`. ⚠ `input` ENCODES but an ATTACHED middleware never has it bound — the host request binds its own inputs, so `inp()` inside pre/post fails at runtime with `Unable to locate input` and a declared default does not stand in (`export()` warns). Read the request body with `s.util.get_all_input` instead; it yields a `{ type, vars }` envelope whose `vars` DIFFERS BY PHASE: `pre` → the request inputs (`payload.vars.<field>`); `post` → `{ status, result }`, the host's outcome (`payload.vars.result.<field>`; plus `payload` on an error). A request field read in `post` 500s after the host already ran (`export()` warns); read the request there with `s.util.get_raw_input`. `s.middleware.call` is the one path that DOES bind the declared map.",
    "  - `resultStrategy?`: `\"merge\" | \"replace\"` (default `merge`) — how the middleware `response` folds into its phase's accumulator: in `post` the host's RESULT (changes what the CALLER receives), in `pre` the host's REQUEST INPUTS (changes what the HOST receives). `merge` folds key-by-key, `replace` substitutes wholesale; the next entry in the chain sees the updated value. `pre` + `replace` DISCARDS every caller input the middleware does not re-emit; reading a discarded input 500s, even one declared `required: false` (defaulting already ran).",
    "  - `exceptionPolicy?`: `\"silent\" | \"rethrow\" | \"critical\"` (default `\"rethrow\"` — a throw ABORTS the request and surfaces the authored error/status). `\"silent\"` swallows the throw and admits the request; never use it on a guard. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain.",
    "- `tool({ name, guid?, description?, instructions?, docs?, enabled?, title?, annotations?, icons?, output?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`. Name charset as a query's (`A-Za-z0-9_-/{}`, max 200). `instructions` is the description the MODEL/client sees (MCP `description`, agent-tool description) and what a connection trigger rewrites; it REPLACES `description`, which shows only when `instructions` is empty (both set warns `tool.description-shadowed`). `title`/`annotations`/`icons`/`output` are MCP metadata (`llms/kinds-agent-mcp.md`).",
    "- An addon is a single table-bound db query, NOT a statement stack: `addon({ name, table, tableAlias?, where?, sort?, output: [cols], cardinality?: \"single\"|\"list\"|\"count\"|\"exists\"|\"aggregate\", group?, eval?, input?, context? })`, registered via `registerAddons([...])`.",
    "  - `table` auto-fills the `context.dbo` binding. ⚠ Never author `table: null` — that is a BROKEN table-less addon returning nothing; `codegen` emits it only for an already-broken pulled object.",
    "  - `tableAlias` is its SQL alias (`context.dbo.as`), qualifying `where`/`sort` columns (`col(\"merchant.id\")`).",
    "  - `where`/`sort` take the same surface as `s.db.query`; `where` encodes `context.search`, `sort` encodes `context.return.list.sort` (`return.single.sort` with `cardinality: \"single\"`) and is refused with `count`/`exists`. `where` is the predicate binding the addon to the parent row — `expr(col(\"id\"), \"=\", inp(\"user_id\"))`.",
    "  - `cardinality` shapes the result (`context.return.type`, omitted for the `\"list\"` default). Rarer context (`eval`/`bind`/`lock`) stays raw `context` passthrough.",
    "  - End to end — define, register, attach:",
    "    ```ts",
    "    const author = addon({ name: \"author\", table: users, input: { user_id: input.int() }, where: expr(col(\"id\"), \"=\", inp(\"user_id\")), output: [\"id\", \"display_name\"], cardinality: \"single\" });",
    "    workspace(\"forum\").registerAddons([author]); // plus the tables/queries",
    "    s.db.query({ table: threads, addon: [{ addon: author, as: \"_author\", input: { user_id: out(\"author_id\") } }], as: \"rows\" }) // rows[]._author: { id, display_name }",
    "    ```",
    "### Responses",
    "",
    "The `response?` field (on functions, queries, tools, middleware, and",
    "response-bearing triggers) maps to the stored `result[]`:",
    "",
    "- `ResponseDef = Value | Record<string, Value>`.",
    "- A single `Value` → one unnamed result item: `response: ref(\"rows\")`.",
    "- A record → one named item per key: `response: { user: ref(\"u\"), token: ref(\"t\") }`.",
    "- Omitted → empty `result[]` (no response body).",
    "",
    "### Expressions (`expr`)",
    "",
    "`expr(left, op, right)` builds the comparison used by every condition/`where`",
    "surface — `s.conditional`/`s.while` `when` (incl. each `elif` branch), and",
    "`db.query` `where`/`additionalWhere` (and the search triggers) — one shared tree.",
    "",
    "- `op`: `=`/`==`/`!=` LOOSE (`null = 0` holds); `===`/`!==` STRICT; `>` `<` `>=` `<=`. Null check: `cond.isNull`.",
    "- `left`/`right` are `Value`s — `col(\"x\")` (a table column, `db.*` statements only), `ref`, `inp`, `auth(...)`, or `c.*`.",
    "- For the full operator set (`in`/`like`/`ilike`/`between`/`contains`/`overlaps`/`@>`/`~`/`search`/…)",
    "  use `cmp(left, op, right, { ignoreEmpty? })`; compose nested boolean logic with `and(...)`/`or(...)`.",
    "- ⚠ The wider `cmp` operators are DATABASE-only (`where`, table view filter, db trigger",
    "  `search`). A RUNTIME condition — `s.conditional`/`elif`, `s.while`, `s.precondition`,",
    "  `array.*` `if` — takes the `expr` set only; the rest are refused at build time because",
    "  deployed they fail the request with `Invalid op: <op>` on that branch, usually a guard.",
    "  `cond.*` builds the filter-then-compare form that DOES run there, and handles the operand",
    "  direction (the engine's `in` filter pipes the ARRAY, the reverse of `contains`): `cond.in`,",
    "  `notIn`, `contains`/`icontains`/`notContains`, `startsWith`/`endsWith` (+ `i` forms),",
    "  `empty`/`notEmpty`, `isNull`/`notNull`, `between(v, lo, hi)`, `has(obj, path)`, `count(v, n)`.",
    "  Each returns a `Comparison`, usable anywhere `expr(...)` is.",
    "- A condition/`where` accepts a single `expr(...)`/`cmp(...)`, an `and()`/`or()` group, an array of",
    "  those (ANDed). `s.conditional`/`s.while`/`s.switch`, `db.query`,",
    "  `precondition`, and the `array.*` predicates all take the same TREE shape (operators per above).",
    "- ⚠ `mixed(a, { or: b }, { and: c })` reproduces a container whose terms do NOT all join the",
    "  same way — pulled workspaces contain it. **Do not author it** (export warns `condition.mixed`). The",
    "  stored form does not record the grouping, and the two places it can appear disagree: a",
    "  branch (`s.conditional`/`s.while`/`precondition`) folds terms strictly left to right, so",
    "  `a OR b AND c` is `(a OR b) AND c`, while a `db.query` filter applies the engine's",
    "  AND-before-OR precedence and selects `a OR (b AND c)`. Write `and(or(a, b), c)` or",
    "  `or(a, and(b, c))` — each says one reading in every context. Pulls report these as",
    "  `ambiguous-condition`.",
    "- A **filtered** operand (`withFilters(...)`) works inline in any condition/`where` (conditional,",
    "  while, `db.query`/addon, …) — e.g. `cmp(withFilters(col(\"title\"), fl.trim()), \"=\", inp(\"q\"))`.",
    "- **Compose a rule set as SIBLINGS, not a folded chain.** `and(...rules)` takes any",
    "  number of terms and encodes flat; `rules.reduce((acc, r) => and(acc, r))` nests one",
    "  container per rule, which costs quadratic bytes (512 terms: 394 KiB flat, 21 MiB",
    "  folded) and is refused past 128 levels. Mixed joins: `and(or(...anyOf), ...allOf)`.",
    '- e.g. `db.query({ table: posts, where: expr(col("author"), "=", auth("id")), as: "rows" })`.',
    "",
  ];

  const kindsKnowledge: string[] = [
    "- `knowledge({ name, description?, type?, mode?, enabled?, body, refs?, guid?, tags? })` — markdown shared by every AI that builds the backend. Xano's own AI reads it before it acts: the workspace's builder agent, and outside agents reading the workspace through the Meta API or MCP. A local coding agent reads the same `.md` files in the repo; deploy and `pull` keep the copies in sync. It does NOT reach an `agent()` run by `s.ai.agent.run`, whatever its `type` or `mode`: put what such an agent must know in its `llm.systemPrompt`. Takes `registerKnowledge`.",
    "  - `body` (REQUIRED): `knowledgeFile(\"./runbook.md\", import.meta.url)` — a path to a real markdown FILE. There is no inline-string form. The path resolves relative to the MODULE THAT DECLARES the item (not the working directory or the workspace entry), via the required `import.meta.url`.",
    "  - `refs?`: `knowledgeDir(\"./runbook\", import.meta.url)` — a directory whose WHOLE tree ships, recursively, paths preserved: UTF-8 text only (else refused; binary `.DS_Store` skipped), symlinks not followed. Keep the body OUT of it, or it ships as a reference file.",
    "  - `type?`: `\"skill\"` (default) | `\"doc\"` | `\"agents.md\"`. `skill` and `doc` differ in how they are filed, not in what an agent receives.",
    "  - `mode?`: `\"auto\"` (default) | `\"always\"` | `\"referenced\"`.",
    "  - `enabled?` defaults `true`. A disabled item is stored and never reaches an agent.",
    "",
    "### What reaches the agent",
    "",
    "- `type: \"agents.md\"` — full body on EVERY turn, whatever `mode` says. At most ONE per workspace; a second is an export error. Setting `mode` on one warns, because nothing reads it.",
    "- `mode: \"always\"` — full body on every turn.",
    "- `mode: \"referenced\"` — full body only on turns whose message names the item (bare name or `@name`).",
    "- `mode: \"auto\"` — name and `description` only; the agent loads the body when a request matches.",
    "- Reference files are never injected wholesale — an agent searches them on demand. That is what makes a large `mode: \"auto\"` item cheap.",
    "- ⚠ `mode: \"always\"` costs the full body on every request (nothing in the types flags it). For an `auto` item `description` is ALL the agent sees until it decides to load the body, so write it to be matched against a request rather than as a title.",
    "- `name` takes letters, digits, space, and `/` `_` `-` `{` `}` `.`; anything else is an export error.",
  ];

  /** Toolchain modules: only a project that installs one needs this. */
  const toolchain: string[] = [
    "**Toolchain modules** extend the CLI, not the workspace — nothing to register in",
    "`xano/index.ts`. An installed one runs on `export` and `deploy` (after the compile,",
    "before the upload) and is verified, never rewritten, under `--frozen-lock`. Config",
    'lives in this project\'s `package.json` `"xanosdk"` block, keyed by package name.',
    "",
    "- `marketplace install <pkg>` is not just `npm install`: it asks the module its questions",
    "  and writes that block plus the `.gitattributes` lines it contributes. It also adds the",
    "  module's non-SDK peers (e.g. `zod`) as direct dependencies.",
    "- A module that arrived any other way (a plain `npm install`, a merged PR) is configured by",
    "  running that same command on it; until then `export`/`deploy` report it unconfigured and it runs on",
    "  shipped defaults.",
    "- `marketplace reinstall <pkg>` re-asks with the current settings as the defaults and",
    "  re-enables a disabled one.",
    "- `marketplace remove <pkg>` drops block, lines and dependency together. A plain",
    "  `npm uninstall` leaves the block, and a package it names that is no longer installed",
    "  fails every `--frozen-lock` run.",
    "",
    "**A module's section of `xano/routes.gen.ts`.** A module with a `routesManifest` hook (types:",
    "`@xano/sdk/plugin`) writes a block between `// xanosdk:begin <pkg>` and `// xanosdk:end <pkg>`",
    "after the core sections, on every write of the file (`routes --emit`, `xano:routes`, `pull`,",
    "`generate`, `marketplace install|reinstall|remove`). Edits inside the block are overwritten.",
    "The hook is synchronous and pure: given",
    "the request inputs under the manifest's keys and its config, it returns `{ imports?, source }`,",
    "imports as bare package names (`@xano/sdk*`, relative and `node:` are refused). A module that",
    "fails to load or throws leaves its previous block as it was, with a warning naming it, and the",
    "core sections still refresh; under `routes --emit --strict` it is fatal. `@xano-sdk/zod`",
    "(`npx @xano/sdk marketplace install zod`) is one: it adds `ROUTE_SCHEMAS` and its siblings.",
  ];

  const client: string[] = [
    "Importing a def into a browser bundle or a Node script — for `getPath()`, `getUrl()`, `verb`, or `InferResponse` — runs its factory calls; these are the costs and the checks.",
    "",
    "- **Client bundle size / tree-shaking.** `@xano/sdk` is `sideEffects: false` and pulls",
    "  no Node built-ins, so a bundler drops unused SDK exports. But importing a **def** for its",
    "  `getPath()`/`verb`/`getUrl()`/`getChannel()` also pulls whatever its `stack` references:",
    "  the `s.*`/`c.*` factory CALLS run at module load to BUILD it. Types are free.",
    "  The first def costs **~267 kB minified (~65 kB gzipped)**; the floor is the RUNTIME, not the def:",
    "  each further def adds ~2 kB, so splitting or trimming defs does not help.",
    "  Fix: `npx @xano/sdk routes <entry> --emit xano/routes.gen.ts` (`paths` is an accepted alias) — verbs, paths, and sockets as",
    "  plain data importing NOTHING, still compile-checked: `routePath(\"GET blog/{slug}\", { slug })`, `routeQuery(\"GET search\", input)` (the GET query string, path params dropped),",
    "  `channelPath(\"rooms/{room_id}\", { room_id })`, `socketUrl(\"chat\", baseUrl)` (tenant base",
    "  URLs lifted to `wss://h/ws/<tenant>:<canonical>`), `mcpUrl(\"notes_mcp\", baseUrl)` (an MCP",
    "  server's address to show a user or hand a client; browser JS cannot call it). A rename is a type error, not a 404.",
    "- **Request types without the def.** `routes.gen.ts` also exports types-only `RouteInputs`,",
    "  `ChannelInputs`, `MessageInputs` (and `MessageName`), keyed like `ROUTES`, `CHANNELS`, and",
    "  `\"<channel key> <message name>\"`: `type NewListing = RouteInputs[\"POST listings\"]`. A",
    "  frontend types bodies, channel params and payloads from these, not `InferInput` on a def;",
    "  keep `InferInput` in code that already imports defs. They match `InferInput`, except a",
    "  `dbLink` input is the linked table's columns, and an `input.file()` a `Blob`",
    "  (multipart). Responses",
    "  are not in the file: `InferResponse` on an `import type` of the def.",
    "  Runtime validation: `npx @xano/sdk marketplace install zod` adds `@xano-sdk/zod`, which writes",
    "  `ROUTE_SCHEMAS`/`CHANNEL_SCHEMAS`/`MESSAGE_SCHEMAS` into the file under the same keys, each",
    "  checked against its type at typecheck; the file then imports `zod`, never `@xano/sdk`.",
    "- **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack), import the def and read",
    "  `getPath()`/`verb` directly. From Node, run a REAL file with `tsx <file.ts>` **from inside the project root**.",
    "  Not `tsx -e \"import …\"` (mis-resolves the package `exports` map → ERR_PACKAGE_PATH_NOT_EXPORTED),",
    "  not bare `node file.ts` (cannot resolve the `.js`-specifier intra-workspace imports), and not from",
    "  outside the project root (the `@xano/sdk` specifier does not resolve).",
    "",
    "**Reading the injected backend URL.**",
    "",
    "- `npx @xano/sdk deploy <entry> --static <dir>` writes the deployed env's URL into every html",
    "  document. A prerendered build serves a different one per route; a route without the global",
    "  renders fine while every call goes to the wrong origin.",
    "- Read it at runtime with a build-time fallback:",
    "  const HOST = (typeof window !== 'undefined' && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;",
    "- The scaffold's `lib/api.ts` types it (`interface Window { XANO_HOST?: string }` — `undefined` in dev)",
    "  and exports this as a `string`, `XANO_HOST`; outside a scaffold declare the global yourself.",
    "- In LOCAL DEV there is no injected global, so the fallback answers: set `VITE_XANO_HOST` in a",
    "  `.env.local` beside `.env.example` at the PROJECT ROOT. The scaffold's vite config sets `envDir`",
    "  there (its `root` is `frontend/`, and Vite resolves `.env` files against `root`); without it the",
    "  var reads as undefined, the host falls back to '', and every call 404s off the dev server.",
    "- It is injected in bracket form — `window[\"XANO_HOST\"]=\"…\"` — so grepping a deploy for",
    "  `window.XANO_HOST` matches nothing. Grep the bare `XANO_HOST` token.",
    "",
    "**Frontend without the backend.** `npx @xano/sdk publish <dir> [--to <backend>]` uploads an",
    "already-built directory and nothing else — no compile, no import (scaffold script",
    "`npm run xano:deploy:frontend`). A Xano Engine (`--to local`, or bare after a local",
    "deploy) serves it, server half included, at `http://<prefix>.localhost:<port>`.",
    "The injected `XANO_HOST` is the DESTINATION's URL, so one build published to two",
    "destinations serves two different documents. `--release <name>` checks only that the",
    "release exists; `--branch <label>` (workspace only) refuses unless that label is LIVE —",
    "a label match, not a content comparison. `--json` reports `published` and `verified` separately.",
    "",
    "**Server-rendered SvelteKit.** `adapter()` from `@xano/sdk/sveltekit` (needs `esbuild`) writes",
    "the static half at the build's root plus a server half in `.xano-ssr/`. A Xano Engine renders every",
    "path that is not a file through it (`load` reads the engine's own URL as `XANO_HOST` from",
    "`$env/dynamic/private`; a rendered page gets the deploy's `window.XANO_HOST` too). Any other host",
    "is not sent `.xano-ssr/`: it serves the static half and answers other paths with the `404.html`",
    "shell, where a route with a server `load` fails (no `__data.json`). A scaffolded project configures",
    "SvelteKit in `vite.config.ts`'s `sveltekit({ adapter })`, where `svelte.config.js` is ignored.",
    "⚠ `.xano-ssr/server.js` inlines `$env/static/private` values; it is never served (`/.xano-ssr/` answers 404).",
    "",
    "**Displaying a stored file.** A file column comes back as `{ path, name, type, size, mime,",
    "meta, access, url }` — `mime` is the exact media type (`image/png`), `type` only the coarse",
    "kind (`image`). Do not use its `url`: on a tenant-scoped environment it addresses the",
    "instance host without the `/tenant/<name>` segment and 404s (a broken `<img>`; API",
    "assertions still pass). Build the URL from `path`: `fileUrl(row.avatar, HOST)` returns `null`",
    "for an absent file and is correct on an ephemeral and an instance workspace alike.",
    "",
    "**Consuming a streaming response.** A `responseType: \"stream\"` query emits Server-Sent Events —",
    "`Content-Type: text/event-stream`, one `data: <json>` frame per `s.api.stream({ value })` call,",
    "each with an `id:` line that is a millisecond timestamp (ids REPEAT within a ms, so do not rely on",
    "`Last-Event-ID` for exactly-once resume). The query's own `response` is not sent. Read it with",
    "`EventSource`:",
    "  const es = new EventSource(`${HOST}/api:<canonical>/stream/basic`);",
    "  es.onmessage = (e) => { const chunk = JSON.parse(e.data); /* … */ };",
    "  es.onerror = () => es.close();  // EventSource is GET-only and reconnects on its own",
    "For POST or auth headers, a `fetch` + `response.body.getReader()` loop instead, splitting the text",
    "on the blank-line (`\\n\\n`) frame delimiter and stripping the `data: ` prefix. There is no typed",
    "client helper for the stream body, and `InferResponse` does not describe it.",
    "**Error responses.** A failed request answers a JSON envelope `{ code, message, payload }`:",
    "`if (!res.ok) { const { code, message, payload } = await res.json(); … }`. `code` is an",
    "`ERROR_CODE_*` string (`ERROR_FATAL` for an engine error), `message` the human text (⚠ EMPTY",
    "on a `db` NotFound), `payload` a precondition's structured detail (`\"\"`/absent otherwise).",
    "The `error_type` → HTTP status and `code` mapping is in `llms/fields.md`.",
  ];

  const errors: string[] = [
    "### Request-time (deployed) failures",
    "",
    "- `Unable to locate input: <name>` — `inp()` names an undeclared input, or an attached middleware reads its own `input` (never bound). Declare it; a stack value is `ref(\"var.field\")`; middleware reads the body with `s.util.get_all_input`. `llms.txt`; `llms/kinds-core.md`.",
    "- `Unable to locate var: <a.b>` (HTTP 500) — a dotted `ref` into a null base (a `db.get` miss), or a column absent from the row (`f.password` is `internal`). Guard existence first, or use the null-safe `safe` option; name the column in `output`. In a `post` middleware, `<var>.vars` from `s.util.get_all_input` holds `{ status, result }` (plus `payload` on an error), not the request. `llms.txt`; `llms/kinds-core.md`.",
    "- `Missing var entry: <name>` inside `s.expect.to_throw` — the body runs in an isolated var stack; bind what it needs inside the body. `llms/tests.md`.",
    "- `Missing param: field_value` (HTTP 400) — a `db.*` match argument resolved to `null` (a safe ref, a nullable foreign key). Guard existence before the lookup; an optional FK stores `0` and is read with field-match `db.get`. `llms.txt`; `llms/fields.md`.",
    "- `Value is less than the minimum value of 1` (HTTP 400) — a `db.get` given `0` in an editor-authored workspace (SDK field-match `db.get` answers 200 + null). `llms/statements-data.md`.",
    "- `Invalid op: <op>` — a `cmp` operator (`in`, `like`, …) in a RUNTIME condition, which takes the `expr` set only; write `or(expr(...), expr(...))`. `llms/kinds-core.md`.",
    "- `Unsupported param format` / `Unsupported parameter reference` — an aggregate or `eval` `name` that is not a bare column, or a bare `eval` name for a joined column. `llms/statements-data.md`.",
    "- `ParseError: Invalid value for param` (HTTP 400) — `contains`/`@>`/`overlaps` on a text column (use `includes`, for scalar text only: a list column 500s), or a joined column qualified without `tableAlias`. `llms/statements-data.md`.",
    "- `ERROR_FATAL: <Type> does not exist: <type>:<n>` — `s.api.call`/`s.task.call`/`s.trigger.call`/`s.workflow_test.call` outside a workflow test; share logic via `defineFunction` + `s.function.run`. `llms.txt`.",
    "- `ERROR_FATAL \"Unable to decode.\"` — a populated JSON string where the engine expects `c.obj`'s form; write `c.obj({...})` or `obj({...})`. `llms/values.md`.",
    "- `ERROR_FATAL \"Invalid zip\"` on `s.zip.view_contents`/`extract` of an uploaded `input.file` — the CLIENT-supplied Content-Type was not `application/zip` (the bytes are not checked; curl's `-F` default is `application/octet-stream`). Send `new File([…], \"x.zip\", { type: \"application/zip\" })`. A wrong password (`Extraction failed (wrong password?)`) and a non-zip both 500 — wrap the call in `s.try_catch`. `llms/statements-runtime.md`.",
    "- `ERROR_FATAL \"Infinite recursion detected. Please fix.\"` — `s.function.run`/`.call` nested past ~25 deep in one request (the engine's variable-stack limit), even for correct bounded recursion. Recurse iteratively (`s.while` over an explicit list) or batch. `llms/statements-calls.md`.",
    "- `Precondition failed.` in place of your message — `error` was a bare string; pass `c.text(\"…\")`. `llms/fields.md`.",
    "- `Param: token - Text filter requires an integer, float, string or boolean value` — `s.api.call` `auth.token` given a tagged `Value`; it must be a bare string. `llms/statements-calls.md`.",
    "- Every `s.db.add` into one table 400s naming a column while complaining about its VALUE — the column is named `run`. `llms.txt`.",
    "- HTTP 200 with an EMPTY body where `0` was expected — a bare `returnType: \"count\"` of zero can answer either; wrap it as `{ count: ref(\"n\") }`. `llms/statements-data.md`.",
    "- HTTP 200 with `[]` from a `db.query` that matches rows — a paged query (`metadata: true`, the default) whose `output` names bare columns; the selection applies to the ENVELOPE, so prefix them (`items.<column>`) or set `metadata: false` inside `paging`. `llms.txt`; `llms/statements-data.md`.",
    "- Every field mapped off an `s.api.request` result reads `null` — the upstream answered an error (a 403 for a missing `User-Agent` is the common one) and its body arrived as ordinary `response.result`; send a `User-Agent` and gate on `response.status`. `llms/statements-calls.md`.",
    "- A lambda returns error TEXT with HTTP 200 (`Could not resolve \"node:crypto\"`, an undefined-binding message) — the body threw; use the preloaded globals, the surface's bindings, and `capture`. `llms/lambda.md`.",
    "- `Unable to locate request.` (404) on an endpoint that deployed — a lowercase verb, a `.` in the name, or a CORS `mode` typo that dropped the whole API group. `llms/kinds-core.md`.",
    "- A browser call fails on a missing `access-control-allow-origin` while deploy looks fine — CORS `mode: \"custom\"` with `\"*\"` or an unmatched origin. `llms/kinds-core.md`.",
    "- `ERROR_FATAL` `The free model is not available in this process.` — an `xano-free` agent run on a Xano Engine; it runs only on Xano's cloud. `llms/kinds-agent-mcp.md`.",
    "- `Not supported. Please upgrade your Xano instance.` (HTTP 403) — a capability the instance lacks; on the Xano Engine on this machine, every `s.storage.sign_private_url` answers it. Test it with `deploy --ephemeral`. `llms/fields.md`.",
    "- An MCP `tools/call` answers `isError: true` with `Unable to get successful response from executing tool` — the tool's run failed without a usable `{code, message}`, and the authored message is dropped. Common cause: a tool reading `auth()` behind an entry naming no auth table (`export()` warns `toolset.tool-reads-auth-ungated`); wrap it `{ tool: <handle>, auth: <auth table> }`. `llms/kinds-agent-mcp.md`.",
    "- A websocket is closed right after the handshake — a refused `connect` gate: an empty/falsy return, a crash, or a gating trigger with no `response`. `llms/triggers.md`.",
    "- `to_throw failed - response is ok` around an auth-refused call — `ERROR_CODE_ACCESS_DENIED` carries no message; the auth gate is not reachable from a workflow test. `llms/tests.md`.",
    "- Output reads `Hi [object Object]` — a tagged value inside a JS template literal; compose at runtime with `withFilters` + `fl.concat`. `llms.txt`.",
    "",
    "### Build-time and tooling failures",
    "",
    "- `export --strict` fails on a warning whose shape is meant (a fixture pinning a hazard) — accept it on ITS def only: add `diagnostics: { allow: [\"<code>\"] }`, which takes any warning code that def raised, on any def kind (warnings only, never an error). Accepted warnings are still listed: `export({ accepted: [] })`, `--json` `accepted[]`. An allowed code the def no longer raises warns `diagnostics.allow-unused`.",
    "- `must be ES modules` — package.json says `\"type\": \"commonjs\"`; set `\"type\": \"module\"`. `llms.txt` Quickstart.",
    "- A response types as `StackTupleWidened` — a `Statement[]` helper was spread into the stack; return `statements(...)`. `llms.txt`; `llms/statements-runtime.md`.",
    "- `ERR_PACKAGE_PATH_NOT_EXPORTED` — `tsx -e \"import …\"`, or running from outside the project root; run a real file with `tsx <file.ts>` from the root. `llms/client.md`.",
    "- `Missing statement: mvp:placeholder` on import — an unconfigured slot in a pulled tree; replace it with the statement it stands in for. `llms/legacy.md`.",
    "- A CLI command reports `could not reach <url>: fetch failed (<code>)` — blocked egress, not a bad credential; fix it before `npx @xano/sdk login`, which rotates a single-use refresh token.",
    "",
    "### CLI failure documents",
    "",
    "A CLI command that fails under `--json` or piped (unless stdout carries data) writes `{ ok: false, error: { code, message, exitCode, details?, suggestion? } }` to stdout, as does a failed release write. Codes:",
    "",
    "| `code` | `details` |",
    "|---|---|",
    "| `SDK_SEED_IN_STATIC` | `details.leaks[]` → `publicSeed` |",
    "| `SDK_EXPORT_INVALID` | `details.diagnostics[]`, `--strict` too |",
    "| `SDK_LIVE_BRANCH_MISMATCH` | `details.conflictsWith` |",
    "| `SDK_CREDENTIAL_REJECTED` | `{ profile, credentialType, instance, workspaceId, signIn }`; ids null on a refused env refresh |",
    "| `SDK_WORKSPACE_CHANGED` | `details.objects`: objects edited in Xano since the last sync. Pull first or deploy `--overwrite`. |",
    "| `SDK_USAGE` | `details.reason: \"needs-confirmation\"`: run its `Re-run as` |",
    "| `SDK_DRIFT`, `SDK_BRANCH_TAKEN`, `SDK_BRANCH_LIVE`, `SDK_RELEASE_NAME_TAKEN`, `SDK_RELEASE_FILES_NOT_CARRIED`, `SDK_IDENTITY_CONFLICT`, `SDK_KIND_CONFLICT`, `SDK_PRUNE_OUT_OF_SCOPE`, `SDK_IMPORT_REFUSED`, `SDK_SHARED_SCHEMA_CHANGE`, `SDK_CONSTRAINT_VIOLATION`, `SDK_ERROR` | — |",
    "",
    "- Landing refusal `details.refused`: identityConflict, renamePending, kindConflict, uniqueViolation, tableTrigger, importInProgress, importRefused, pruneOutOfScope.",
    "- `warnings[]` / `details.warnings` / `accepted[]` entries: `{ code, message, subject? }` (`subject`: the def's `{ kind, name }`).",
    "- Backend documents add `selector` and `workspaceId`.",
    "",
    "### CLI exit codes",
    "",
    "A failure document's `exitCode` matches.",
    "",
    "| Code | Meaning | Next step |",
    "|---|---|---|",
    "| 0 | Success, and a `delete` of a missing name (`alreadyGone`). | — |",
    "| 1 | A usage error (a missing local file included), a refused request, or anything not listed. | Read the message. |",
    "| 2 | Ran and disagreed: `preflight` failed, `workspace diff` differed, `promote`, a release or an import did not land as sent or hit a conflict, the `init --from`/`pull` round-trip check failed, a lock or branch-label conflict, or `init` could not install its dependencies or an add-on (scaffolded anyway). | Fix what it reports. |",
    "| 3 | `deploy --static`: the backend landed, the static site did not. | Deploy the site again. |",
    "| 4 | `deploy --require-microservices`: a microservice was not ready in time. The backend landed. | Check the microservice. |",
    "| 5 | `test` / `deploy --test`: the suite ran and a test failed. A deploy is not retracted. | Fix the test or the code. |",
    "| 6 | `test`, `deploy --test`: the suite could not be reached. | Check the backend; rerun. |",
    "| 7 | `upgrade --check`: an upgrade is available. | `npx @xano/sdk upgrade`. |",
    "| 8 | A named backend could not be addressed (or a named release, profile, branch, test, module, lock entry, `--seed` guid or Xano Engine version is missing): gone, expired, unreachable, a stopped Xano Engine, or a busy import. | Retry, or redeploy. |",
    "| 9 | A write whose outcome is unknown, Ctrl-C during a write included. | Read the target's state before retrying. |",
    "| 130 | Ctrl-C outside a write or install. | — |",
  ];

  const kindsAgentMcp: string[] = [
    "- An MCP server serves THREE primitives, and each reaches the client differently: a `tool()` is an action the MODEL calls (it may write); a `resource()` is read-only context the client APPLICATION lists and attaches by `uri` (reference docs, a schema, one record through a `{variable}` template); a `prompt()` is a message template with arguments the USER picks by name. Context a session opens with is a `resource()`; a workflow a user starts by name is a `prompt()`; data the model must fetch on its own mid-task stays a `tool()`, since a client shows the model only the resources attached to the conversation. Register each kind (`registerTools`/`registerPrompts`/`registerResources`) and list it on the server.",
    "- `mcpServer({ name, guid?, description?, instructions?, docs?, enabled?, canonical?, spec?, tags?, history?, tools?, prompts?, resources?, oauth?, llm?, output? })` — an MCP toolset. `llm?`/`output?` are the same blocks `agent()` takes and are usually absent. Returns a handle with `getPath()`/`getUrl(baseUrl)` for the Streamable-HTTP endpoint — `getUrl` is NOT idempotent, a `baseUrl` already carrying an `/x2/mcp/<…>/stream` path THROWS, so resolve ONCE from the instance base URL. Fires on an ephemeral. A TENANT rides AFTER the prefix (`/x2/mcp/tenant/<tenant>/<canonical>/<token>/stream`), not as a base-URL segment: `getUrl` LIFTS a `/tenant/<name>` out of the base and re-places it there, so `getUrl(window.XANO_HOST)` is correct as-is; concatenating them by hand builds an unregistered route that 404s. Pass `{ tenant }` when the base URL cannot name it (a tenant on its own domain).",
    "  - ⚠ The endpoint is CORS-open (serves every browser `Origin`; preflight `204`, `access-control-allow-origin: *`); per-tool `auth`/`oauth` is the only gate.",
    "  - `tools?`: a `ToolsetToolEntry[]`. Pass the `tool()` HANDLES directly (`tools: [saveNote]`); use the `{ tool, enabled?, auth?, type?, resourceUri?, toolMeta? }` wrapper when an entry needs more. `type: \"resource\"` (+ a required `resourceUri`) publishes a tool as an MCP resource — prefer a `resource()` listed in `resources`; `toolMeta` is extra metadata on a tool entry. `resourceUri` only with `type: \"resource\"`, `toolMeta` only with `type: \"tool\"`; the wrong one is refused. `auth` names an auth **table** (a `table({ auth: true })` handle or its name) — per-tool, and the only gate there is. ⚠ It is also what gives the tool a CALLER, on an `agent()` and an MCP server alike. `auth()` inside a tool whose entry names no table does NOT return null: the run binds `{\"code\":\"ERROR_FATAL\",\"message\":\"\"}`. On an `agent()` the model reads that as a successful tool result and reports success while nothing is written; over an MCP server's `tools/call` the client instead gets an `isError: true` tool error with the generic text `Unable to get successful response from executing tool`. Either way the write never happens and a caller token does not rescue it — the ENTRY supplies identity. Spell it `{ tool: saveNote, auth: users }`; `export()` warns. An entry naming no tool THROWS at export; a deliberate raw `id: 0` warns and carries through.",
    "  - `prompts?` / `resources?`: `prompt()` / `resource()` HANDLES (or names), or a `{ prompt, enabled?, auth? }` / `{ resource, enabled?, auth? }` wrapper. `auth` names the auth table and is what gives the stack a caller: a prompt/resource reading `auth()` behind an entry with none answers every `prompts/get` / `resources/read` with `-32603 \"Access Denied\"` (`export()` warns `toolset.primitive-reads-auth-ungated`). Listing one target twice THROWS; two resources with one `uri` on one server fail `export()` (`mcp.resource-uri-duplicate`). MCP-server only — `agent()` takes tools only.",
    "  - `history?` is the server tier for its tools, prompts AND resources alike; an object's own `history` wins. The workspace tier (`workspaceConfig({ history })`) has `prompt` and `resource` keys, both default on.",
    "  - `oauth?`: per-server sign-in; omit and nothing changes. Union on `mode`; `authTable` (REQUIRED, auth `table()` handle or name) is whose row the signed-in user is — `auth()` on the whole server, `t.auth` in its trigger. Hosted (the platform is the authorization server): `{ mode: \"hosted\", authTable, loginUrl }` — clients are sent to `loginUrl` (YOUR page, which is also the consent screen) with `mcp_request`; show `s.mcp.oauth.request`, sign the user in, then your endpoint calls `s.mcp.oauth.complete` with their `decision` and the page redirects to the URL it binds. External (your IdP issues tokens): `{ mode: \"external\", authTable, issuer, column, audience?, audienceAck?, claim?, claimAck?, preset?, allowedClientIds? }` — token `claim` (default `sub`) matched against `column`; `preset` is `auth0|clerk|workos|entra|okta|cognito|generic`. `loginUrl`/`issuer`/`audience` take `env(\"NAME\")` (resolved per environment).",
    "    - `export()` FAILS: hosted without `loginUrl` (`mcp.oauth-hosted-incomplete`); external without `issuer`/`column` (`mcp.oauth-external-incomplete`); `preset: \"clerk\"` without `allowedClientIds` (`mcp.oauth-preset-client-ids`); `claim` other than `sub`/`oid`/`email` without `claimAck` (`mcp.oauth-claim-unacked` — users can edit it at most providers). Unknown `mode`/`preset` THROWS, as do `consent`/`branding`/`trustedClients` (not options).",
    "- `prompt({ name, guid?, description?, docs?, title?, icons?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — an MCP prompt; takes `registerPrompts`. `input` is the prompt's arguments (each field's `description`/`required`/enum `values` reach the client; enum values also answer completion requests). `response`: a text value is ONE user message; a list of `{ role: \"user\" | \"assistant\", content }` is sent in order, `content` a string or an MCP content block: `s.set_var(\"m\", obj({ list: [obj({ role: c.text(\"user\"), content: ref(\"body\") })] }))`, `response: ref(\"m.list\")`. Without `response` or a top-level `s.return`, `prompts/get` fails.",
    "- `resource({ name, uri, guid?, description?, docs?, mimeType?, title?, icons?, annotations?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — an MCP resource; takes `registerResources`. Clients address it by `uri`, never `name`.",
    "  - `uri`: a literal (`\"docs://readme\"`, no `input`) or an RFC 6570 LEVEL-1 template (`\"orders://{region}/{order_id}\"`). It must start with a scheme; each `{variable}` is letters/digits/`_`, one per brace pair, never two adjacent. `input` must be EXACTLY the template's variables, each a single `text`/`int`/`decimal`/`bool`/`enum`/`email`/`uuid` — anything else THROWS. A value that does not convert is refused before the stack runs.",
    "  - `response`: a string is returned as text; non-UTF-8 content (a file, binary) as a base64 blob. `mimeType?` omitted → derived from what the stack returns.",
    "  - Not found: a resource has no built-in miss path. Returning a `db.get` result straight through on a miss is an EMPTY SUCCESS — the client attaches an empty document (`text: \"\"`, `mimeType: \"text/plain\"`), not an error. Gate it: `s.precondition({ expr: expr(ref(\"note\"), \"!=\", c.null()), error_type: \"notfound\", error: c.text(\"no such note\") })` gives a real `resources/read` error (JSON-RPC `-32602`), but ⚠ the AUTHORED message is dropped — the client sees only the generic `Not Found` (unlike a `tool()` precondition).",
    "  - `annotations?`: `{ audience?: (\"user\" | \"assistant\")[], priority?: 0..1, lastModified?: ISO 8601 string }`.",
    "- MCP metadata, on `tool`/`prompt`/`resource`: `title?` (display name clients show instead of `name`); `icons?: { src, mimeType?, sizes?, theme? }[]` — `src` is `https:` (≤ 2048 chars), a base64 `data:` URI of PNG/JPEG/WebP (≤ 64 KiB), or `hostedFile(\"./icon.png\", import.meta.url)`, a repo file served at each backend's own absolute URL (a pull keeps the `/vault/…` path); SVG, `http:` and every other scheme THROW; `mimeType` is `image/png|jpeg|webp`, `sizes` a list (`[\"48x48\"]`, `[\"any\"]`), `theme` `light|dark`. Tool only: `annotations?: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` — hints; an unset one is derived by the platform — and `output?`, a structured-output schema in the `input` grammar: a returned plain object then reaches the client as `structuredContent` plus a text copy, and a result that does not match is a tool error naming the field.",
    "- `s.mcp.elicit({ key, message, input?, as? })` — ask the MCP client's user mid-call; binds `{ action: \"accept\" | \"decline\" | \"cancel\", content? }` (`content` only on accept, keyed by the `input` field names). `key`: a stable name unique in the stack; `message`: string or value. `input` is the form: a FLAT set of `text`/`email`/`date`/`int`/`decimal`/`bool`/`enum` fields (an enum may be a list); nested objects, files, JSON, timestamps, `password` and `sensitive` fields THROW. Works in tool, prompt and resource stacks.",
    "  - ⚠ The WHOLE stack re-runs from the top when the user answers — everything BEFORE an elicit runs once per round trip, so ASK FIRST, then act. A write before an elicit (`s.db.*` writes, raw SQL, a non-GET `s.api.request`, `s.util.send_email`, `s.function.run`/`.call`, `s.tool.call`) makes `export()` warn `mcp.write-before-elicit`; accept a deliberate one per def with `diagnostics: { allow: [\"mcp.write-before-elicit\"] }`. An elicit inside `s.db.transaction` commits the transaction's earlier writes on every round trip.",
    "  - Input is collected only from clients on MCP `2026-07-28` or later that declare form elicitation. Every other caller — an older client, a debug run, an agent, a workflow test — gets `{ action: \"cancel\" }` and the stack carries on, so ALWAYS handle `cancel`. Inside an async function run, `s.mcp.elicit` is a runtime error.",
    "- `s.mcp.progress({ progress, total?, message? })` — report progress to a client that asked for it (a no-op otherwise); values never go backwards (a lower `progress` is sent as the last one).",
    "- `s.mcp.oauth.complete({ request, decision, unsafe_user_id?, as? })` — run by the endpoint your `loginUrl` page calls after sign-in; `request` is the page's `mcp_request`. Signs in the CALLER (`auth()`, an `authTable` row whose session token is under 10 minutes old) and binds the single-use URL (text) to redirect to. `decision` (`\"approve\" | \"deny\"`, REQUIRED) is what the user chose on your page. ⚠ `unsafe_user_id` names the row directly, skipping the caller checks — anyone reaching that endpoint signs in as that user.",
    "- `s.mcp.oauth.request({ request, as? })` — a pending sign-in's verified details for your `loginUrl` page to show before the user approves: `{ client_name, client_logo, callback_host, client_verified, server_name }`. Does not consume it.",
    "- `s.mcp.oauth.revoke({ mcp_server, user_id? | grant_id? | all?, as? })` — end hosted sign-ins on a server: EXACTLY ONE of `user_id`, `grant_id`, `all: c.bool(true)`, else `export()` fails (`mcp.oauth-revoke-target`). Binds `{ revoked }`.",
    "- `agent({ name, guid?, description?, docs?, enabled?, canonical?, tags?, history?, llm, tools?, output? })` — an LLM orchestrator. No top-level `instructions`/`prompt`/`spec` — the prompt lives under `llm`. Invoke from a stack with `s.ai.agent.run({ agent, args })`.",
    "  - `llm` (REQUIRED): typed provider settings, a discriminated union on `type` (`\"xano-free\" | \"anthropic\" | \"openai\" | \"google-genai\"`). Shared fields: `systemPrompt?`, `maxSteps?` (default `5`), and `prompt?` XOR `messages?` (mutually exclusive; both is a type error and throws); plus provider fields (`apiKey?`, `model?`, `temperature?`, `reasoningEffort?`, …). String fields accept Twig placeholders — `{{ $args.x }}` for run inputs (the `args` of `s.ai.agent.run`), `{{ $env.NAME }}` for env vars.",
    "  - `xano-free` runs only on Xano's cloud: on the Xano Engine on this machine a run fails `ERROR_FATAL` `The free model is not available in this process.` — use a keyed provider there.",
    "  - `tools?`: same `ToolsetToolEntry[]` as `mcpServer` — bare `tool()` handles, or a `{ tool, enabled?, auth? }` wrapper when one needs `enabled`/`auth`. A tool reading `auth()` needs the wrapper naming its auth table (see `mcpServer`'s `tools?`).",
    "  - `output?`: `{ schema: Record<string, input.*>, enabled? }` — structured-output schema. With `tools`, the run executes them first, then shapes its answer into the schema. `schema` is a named-field record authored with the `input.*` catalog, exactly like a `defineFunction`/`query` `input:` map. e.g. `output: { schema: { priority: input.enum([\"low\",\"high\"]), summary: input.text() } }`. When you pass the agent *handle* to `s.ai.agent.run({ agent })`, `.result` is typed from this schema; `resultShape` only overrides that, or types an agent referenced by bare name.",
    "  - **Run + read recipe (`s.ai.agent.run`):** bind the run to a var (`s.ai.agent.run({ agent, args, as: \"run\" })`) — it produces a rich envelope, and the completion is at **`.result`**. Read one structured field with a dotted ref (`response: ref(\"run.result.priority\")`) or the whole completion (`ref(\"run.result\")`, typed from `output.schema`). `args` is a plain object of run inputs (`{ topic: inp(\"topic\") }` — raw literals are fine, e.g. `{ max_steps: 3 }`) surfaced to the agent as `{{ $args.topic }}`. `.toolCalls` is the FINAL step's calls only (often `[]`); every call is a `.steps[].content[]` entry of `type: \"tool-call\"`. `allowToolExecution` defaults to true. ⚠ `c.bool(false)` does not hide the tools: the model still emits a call, the call never executes, and the run ends with an empty `result` (warns `stack.agent-tools-off`).",
    "  - **Marketplace:** for chat history, use `@xano-sdk/chatbot`; for vector RAG, use `@xano-sdk/vector` (`tools: [vector.searchTool]`). Find add-ons with `npx @xano/sdk marketplace search <q>`.",
    "- Both kinds persist under the `toolset` payload key, so a same-name `agent` + `mcpServer` pair derives ONE guid and `export()` throws — give them distinct names.",
  ];

  const kindsRealtime: string[] = [
    "- **Realtime** — the only three-level chain: `realtimeServer` owns `realtimeChannel`s, which own `realtimeMessage` handlers. Pass the HANDLE, not a name (a channel path is unique only within its server).",
    "  - `realtimeServer({ name, guid?, description?, enabled?, canonical?, tags?, history? , middleware? })` — the container.",
    "    - `enabled` defaults to **false** — the one `enabled` in the SDK that does.",
    "    - An enabled server with no active channel still refuses the handshake.",
    "  - `realtimeChannel({ name, server, guid?, description?, active?, input?, anonymousClients?, presence?, publish?, conversation?, delivery?, rateLimit?, tags?, history?, middleware? })`",
    "    - `name` is a PATH (`\"lobby\"`, `\"rooms/{room_id}\"`); `input` types its `{param}` segments, NOT the payload. Every `{param}` MUST have a matching input, and that input must be a SCALAR and not a list (`json`/`object`/`array: true` have no URL form), or `realtimeChannel()` THROWS. `required: true` is NOT checked and not needed (segment counts must match, so the segment is always present at join). Name charset as query (`A-Za-z0-9_-/{}`, max 200); `realtimeMessage` is narrower — no `/` or `{}`.",
    "    - Matching is STRICT: a literal segment beats a param (`rooms/lobby` and `rooms/{room_id}` coexist); segment counts must be EQUAL (`rooms/{room_id}` does NOT match `rooms/42/edit`); literals are CASE-SENSITIVE; an empty segment is REJECTED, not collapsed (a leading/trailing/doubled `/` matches nothing). `realtimeChannel()` refuses it and a partial-segment `{param}`; `getChannel()` a value outside `[A-Za-z0-9_-]`.",
    "    - An INACTIVE channel reports the same error as a nonexistent one — deactivating leaks nothing.",
    "    - `middleware?: { pre?, post? }` is the CONTAINER tier, on the channel and on the server alike — the default chain every message inherits, the same shape an api group has. Full chain: message -> channel -> server -> branch/workspace, mirroring `history`. ⚠ It cannot GUARD: a middleware that throws fails open (below).",
    "    - `anonymousClients` also gates CONNECT: a tokenless socket connects only if an active channel of its server sets it (no server flag); each channel admits its own join.",
    "    - `publish?: { who?: \"nobody\"|\"anyone\"|\"authenticated\", direct? }` — `who` defaults to `nobody`: nobody can publish until you set it. `direct` (default false) allows DIRECT messages — a frame whose `options.to = { dbo_id, row_id }` addresses one USER (`dbo_id` = the auth table's id as `s.realtime.get_session` reports it, `row_id` = the user's row id) and reaches every socket of theirs on the channel, no one else; the sender gets a receipt `{ delivered_local, direct: true }`. `direct` REPLACES `who` for such a frame rather than adding to it (`direct: true` with `who: \"nobody\"` delivers direct messages and refuses broadcasts); an anonymous sender is refused. A direct message is never stored in the transcript or the `at_least_once` stream, so an offline user never gets it. ⚠ An `options.to` naming no usable identity is sent as an ordinary broadcast to the whole channel where `who` admits the sender.",
    "    - `conversation?: { enabled?, limit?, ttl? }` — the client-visible TRANSCRIPT replayed to a joiner (distinct from `history`, which is execution history). ⚠ `limit` DEFAULTS TO 0 AND 0 MEANS OFF: `{ enabled: true }` alone records nothing and replays nothing, silently — always pass `limit`. `ttl` is an IDLE expiry of the WHOLE transcript, refreshed by every write (an active channel never ages out; a silent one loses all of it at once) — NOT a per-message age cap.",
    "    - `delivery?: { guarantee?: \"at_most_once\"|\"at_least_once\", perRecipient? }` — `perRecipient` is independent of the guarantee, is a NO-OP unless the channel declares a `deliver` trigger, and costs a stack PER RECIPIENT PER MESSAGE. Per-viewer redaction needs BOTH HALVES — this flag AND an active `deliver` trigger bound to the channel — and with either missing the payload is delivered UNCHANGED to everyone; `export()` warns on each half alone.",
    "    - `rateLimit?: { messagesPerMinute? }` — 0 = unlimited, checked BEFORE the handler runs. A COST guardrail, not a security control: an anonymous client is bucketed per CONNECTION (reconnecting resets it), and it fails OPEN when its store is down.",
    "  - `realtimeMessage({ name, channel, server?, guid?, description?, active?, auth?, deliverTo?, input?, middleware?, stack?, response?, responseShape?, history?, disabled?, tags? })` — the invocable unit (the realtime analogue of a query).",
    "    - `input` types the message PAYLOAD. `server` is required only when `channel` is a bare path.",
    "    - `deliverTo?`: `\"channel\"` (default) | `\"sender\"` | `\"others\"` | `\"explicit\"`. ⚠ `\"explicit\"` still delivers to NOBODY — nothing selects recipients from inside a handler, and `s.realtime.publish` (which originates an event INTO a channel) is not a substitute.",
    "    - Only `\"channel\"`/`\"others\"` fan out AND are RECORDED in the `conversation` transcript — a `\"sender\"` response is invisible to every future joiner.",
    "  - **Both input surfaces read as ordinary inputs:** `inp(\"body\")` for a payload field, `inp(\"room_id\")` for the channel's `{room_id}`. No session lookup, no frame parsing.",
    "    - A path param is bound ONCE at join and read from the connection thereafter, never from the frame — a sender cannot claim a room it did not join.",
    "  - `s.realtime.get_session({ as })` — the CALLER's realtime session for the current frame. FLAT shape:",
    "    - `authenticated` bool · `client_id` text (the AUTHED ROW ID as text, `\"\"` anonymous) · `dbo_id` int (the auth TABLE's id, `0` anonymous) · `socket_id` int (transport id) · `channel` text (resolved path, `\"\"` in a server trigger) · `params` object (bound path params, `{}` when none — `ref(\"session.params.room_id\")`) · `extras` object · `opened_at` decimal · `token_error` text|null (`\"expired\"`/`\"invalid\"` when the client SENT a token that did not authenticate — it connected anonymously; `null` otherwise).",
    "      - `dbo_id` is NOT the user's row id — look the caller up by `client_id`. A gate keyed on `dbo_id` typechecks, finds no user, and refuses EVERYONE.",
    "    - Works in a realtime MESSAGE stack and in CHANNEL and SERVER trigger stacks; off that path it degrades to an anonymous session.",
    "    - For a path param prefer `inp(\"room_id\")` in a MESSAGE; a lifecycle TRIGGER has only the session. Reach for the session when you need the CONNECTION (identity/extras) — \"who is this sender\" on an anonymous-client channel.",
    "    - Three unrelated things are called a client id: `session.client_id` (app-facing identity), `session.socket_id` (transport), and a frame's `options.client_id` (the at_least_once cursor handle). Conflating the first and last breaks at_least_once for anonymous clients.",
    "  - `s.realtime.publish({ server, channel, data, message?, authTable?, authId? })` — the PUSH direction: originate a server-authored event onto a channel from ANY stack, no client frame first.",
    "    - `server` is the handle or its NAME (resolved by name, not guid); `channel` is the FILLED-IN path (`channel.getChannel({ room_id: 42 })`), never the template — a constant still carrying `{param}` THROWS at author time, and a constant `server`/`channel` naming nothing this workspace registers WARNS at export.",
    "    - A PER-ROW path whose id is only known at runtime is built as a value, not with `getChannel()` (which needs the id at author time): `withFilters(c.text(\"rooms/\"), fl.concat(ref(\"room.id\")))`, or `s.set_var` + `s.text.prepend`. A computed `channel`/`server` — a `ref`/`inp`, or a constant carrying a filter chain — is left alone by the export check.",
    "    - DELIVERY-ONLY — fanned out as-is; does NOT invoke a `realtimeMessage()` handler even when `message` names one (a channel `deliver` trigger still runs).",
    "    - SERVER-AUTHORITATIVE — bypasses `publish.who`, which governs CLIENTS. Authorize in your own stack.",
    "    - ⚠ FAIL-SOFT — a missing/disabled server or dead bus is swallowed engine-side, so a mis-targeted publish is SILENT with no result to check.",
    "    - `authTable`/`authId` are ASSERTED attribution on the frame — not a credential, nothing validates them. They land in `_meta.as`, NOT in `payload`.",
    "  - `s.realtime.kick({ server, channel, authTable, authId, reason? })` — remove one user from one channel: every socket of `authTable`/`authId` (the identity is REQUIRED) leaves the FILLED-IN `channel` path, on every node, through the same steps as a client `leave` (the `leave` trigger, a `presence_leave`), and receives `{ action: \"leave\", channel, payload: { left: true, kicked: true, reason } }`. The socket stays CONNECTED and keeps its other channels. Call it wherever you revoke a membership the `join` gate admitted.",
    "    - NOT fail-soft (unlike `publish`): an unknown server, a missing identity, or a dead bus FAILS the stack — a kick that silently did nothing would leave the member subscribed.",
    "  - **Client recipe (derive, never hardcode):**",
    "    - `server.getUrl(baseUrl)` → `wss://<host>/ws/<canonical>` — accepts the `https://…` instance base URL and normalizes the scheme. `channel.getChannel({ room_id: 42 })` → `\"rooms/42\"`, the path that goes in a frame's `channel` field. Both throw rather than guess. A canonical is minted by `npx @xano/sdk export <entry> --lock`.",
    "    - Auth is a bearer token passed as the websocket SUBPROTOCOL: `new WebSocket(url, token)`. No token = an anonymous client, admitted only where `anonymousClients: true`. ⚠ An INVALID, tampered, or EXPIRED token still connects — ANONYMOUSLY, with no error and no close (presence lists it `authenticated: false`) — and says why: `session.token_error` is `\"expired\"` or `\"invalid\"`, and a refusal the socket meets for being anonymous names the token: `{ message: \"Your token has expired. Reconnect with a fresh token.\", token_error: \"expired\", reason: \"Anonymous clients cannot join this channel\" }`. On an error frame carrying `token_error`, refresh the token and reconnect. For a hard refusal at connect, gate with a `realtimeServerTrigger` `connect` (`allowed: session.token_error == null`, or `session.authenticated` → a 4401 close).",
    "    - Frames are JSON `{ action: \"join\"|\"leave\"|\"broadcast\"|\"ack\"|\"ping\"|\"presence\", channel, type?, payload?, options?, id? }`. `broadcast` REQUIRES `type`: a `realtimeMessage` of that channel, else refused `Unknown message type`. You must `join` before you may `broadcast`, and the server's context is ready only a moment after `open` — an immediate first frame is refused.",
    "    - `options` is `{ to?, client_id?, channel? }` — `to: { dbo_id, row_id }` makes the frame a direct message (needs `publish.direct`), `client_id` is the at-least-once cursor handle, and `options.channel` WINS over a top-level `channel`.",
    "    - ⚠ KEEP THE SOCKET ALIVE: an idle connection is REAPED after ~10 minutes. A LISTEN-ONLY client (a feed or dashboard that joins and rarely publishes) MUST send `{ action: \"ping\" }` (answered `pong`) or any frame periodically or it silently drops.",
    "    - Server frames: `join` (ack `{ joined: true, params }`, + `cursor`/`resumed` on at_least_once) · `message` · `replay` · `broadcast` · `presence_full`|`presence_join`|`presence_leave` · `conversation_start`|`conversation_end` (replayed frames flagged `conversation: true`) · `pong` · `ack` · `error`. An `s.realtime.publish` frame also carries `_meta`: `{ injected: true }` (asserted marker for a server-authored event vs a relayed peer), plus `as: { dbo_id, row_id }` from `authTable`/`authId`.",
    "    - `broadcast` is a RECEIPT to the sender, not a delivery confirmation: `payload.delivered_local` counts recipients on the ANSWERING NODE ONLY, not the channel. It also carries `id` on at_least_once and `dropped: true` when the handler returned null.",
    "    - `error` carries `payload.message`, plus `code`/`limit`/`retry_after` when rate limited. `rate_limited` is the only code — do not switch on `code`.",
    "    - An `error` is a per-frame refusal, NOT a disconnect — EXCEPT a failed handshake and a REFUSED `connect` trigger, which each send one and then CLOSE with code 4401.",
    "  - **Tenant instances (isolated DB):** a tenant's realtime objects live in the TENANT's database, so both the socket and the HTTP half of a client must name the tenant. No request header is required for either.",
    "    - Socket: `server.getUrl(base, { tenant })` → `/ws/<tenant>:<canonical>` — the colon form is socket-only; HTTP gives the tenant its own segment (`https://<host>/tenant/<tenant>/api:<canonical>/…`). ⚠ A bare canonical on a tenant host resolves against the INSTANCE workspace instead.",
    "    - `getUrl` TRANSLATES a tenant base URL: pass the `https://<host>/tenant/<name>` that `npx @xano/sdk status` prints (and deploy injects as `window.XANO_HOST`) and the tenant is LIFTED into the socket form, so `getUrl(window.XANO_HOST)` needs no `{ tenant }`; a conflicting `{ tenant }` alongside it throws.",
    "    - `getUrl`/`socketUrl` are NOT idempotent — a `baseUrl` that already carries a `/ws/<…>` path THROWS. Resolve ONCE from the http(s) base; never feed a result back in.",
    "    - Still pass `{ tenant }` explicitly for a tenant on its OWN DOMAIN — the hostname carries it for HTTP, but there is nothing in the URL for the socket to lift.",
    "    - Tokens are tenant-scoped (audience `<tenant>:<license>`, not the bare license), so one minted through the instance workspace is REJECTED by a tenant's realtime server — authenticate and dial through the same tenant.",
    "  - **Presence frames** (a `presence: true` channel only):",
    "    - `presence_full` carries `payload.members`, an ARRAY: it INCLUDES the receiver, at join (first joiner: itself) and on a re-request. `presence_join`/`presence_leave` carry a single `payload.member`. `members` is in NO guaranteed order (not join order): sort it yourself if order matters.",
    "    - A member is `{ id, dbo_id, authenticated, extras, joined_at }`: `id` the auth row id as a string (`\"0\"` anonymous), `dbo_id` the auth table's id (`0` anonymous), `extras` the connection's extras (`[]` if none), `joined_at` epoch SECONDS.",
    "    - Render `presence_full`, then apply deltas. One member per authenticated identity (a second tab fires no `presence_join`); anonymous ones all have `id` `\"0\"`, never collapsed.",
    "    - Join order: `join` ack → `presence_full` → (others get `presence_join`) → conversation replay → `replay` frames.",
    "    - A joined client re-requests it with `{ action: \"presence\", channel }`, answered to the SENDER only; a socket that never joined is REFUSED.",
    "  - **Conversation frames** — the transcript hydrates the client (no hydration endpoint); editable or moderated content needs one of the two shapes below.",
    "    - On a `conversation` channel the replay is PUSHED automatically at join, unasked: `conversation_start` (`payload.count`) → the last `limit` messages, each a normal `action: \"message\"` frame carrying its ORIGINAL `type` and `payload` plus `conversation: true` and the original `ts` → `conversation_end`.",
    "    - The POST-HANDLER broadcast payload IS the stored transcript row — a handler must broadcast everything the UI needs to render a past message (author name, id, `created_at`). Nothing else is replayed.",
    "    - The transcript is a capped ring (`limit`, `ttl`), not storage: persist to a table only for durability, search, or reads beyond it.",
    "    - ⚠ APPEND-ONLY: the transcript records EVERY fanned-out frame — `s.realtime.publish` frames included, not only `\"channel\"`/`\"others\"` handler returns — and no entry can be edited or removed. A message deleted or EDITED in the DB is still replayed to every later joiner: both its original and any edited broadcast stay in the ring until `limit`/`ttl` evicts them, including across a `--keep-data` redeploy — so for editable/moderated content the transcript LEAKS retracted bodies. An ephemeral `deliverTo: \"others\"` frame (a typing indicator) also takes a ring slot, so a busy signal evicts real messages.",
    "    - Two safe shapes for editable/moderated chat: (a) turn `conversation` OFF, hydrate the initial view from a table endpoint, and keep the socket for live frames only; or (b) keep bodies OUT of the frames — publish ids only and read current bodies from a table — and put ephemeral signals (typing) on a SEPARATE channel with no `conversation`.",
    "  - **`delivery.guarantee: \"at_least_once\"` is a CLIENT CONTRACT, not just a channel setting.**",
    "    - The client must ACK what it receives — `{ action: \"ack\", channel, id }`, confirmed by `{ action: \"ack\", channel, payload: { cursor } }`.",
    "    - ⚠ An ANONYMOUS client must ALSO send a durable `options.client_id` in its JOIN frame (once; later acks need not repeat it). WITHOUT one it has no cursor, its acks are SILENTLY IGNORED, and it degrades to at_most_once. An AUTHENTICATED client is keyed by identity and needs no `client_id`.",
    "    - The missed gap arrives after join as `replay` frames, oldest-first, each with an `id` to ack. A first join gets `cursor: \"0\"`: the WHOLE retained stream replays, repeating a `conversation` transcript.",
    "    - DISTINCT from the conversation transcript: `conversation_*` is the SHARED \"what was said before I arrived\", `replay` is the PER-CLIENT \"what I missed while disconnected\". Both may be on.",
    "    - How far back `replay` reaches is sized by `conversation.ttl` (here a REAL per-message age cut, and it BEATS `limit`), else `conversation.limit`, else 1000 — even on a channel with no transcript enabled.",
    "  - **What a message handler RETURNS decides delivery:**",
    "    - A returned value fans out per `deliverTo` and becomes the transcript row.",
    "    - Returning NULL delivers NOTHING — the supported way to veto a message (the sender is told `dropped: true`).",
    "    - A payload REJECTED by the declared `input` also delivers nothing; the detail goes ONLY to the sender.",
    "    - ⚠ A handler that CRASHES FAILS OPEN — a failed `s.precondition`/`guard.*` (even in an `s.function.run` target), a throwing middleware, a runtime error: the sender's ORIGINAL, UNVALIDATED payload is broadcast unchanged (`s.throw` DROPS it). To veto, set the response var to `c.null()`.",
    "",
  ];

  const triggers: string[] = [
    "### Triggers",
    "",
    "A trigger has no user-declared `input`: its inputs are **implied by type** and arrive through the typed",
    "**stack handle** `t`, so `stack` is a callback — `stack: (t) => [...]` (a plain list works when it",
    "reads none; `response` likewise). `t` exposes exactly that trigger type's inputs; a wrong name is a",
    "compile error. The seven trigger types are",
    "distinct root factories (not a namespace): `{tableTrigger, realtimeServerTrigger,",
    "realtimeChannelTrigger, mcpServerTrigger, agentTrigger, workspaceTrigger,",
    "errorTrigger}({ name, guid?, description?, active?, tags?, history?, ... })`.",
    "`history` is per trigger (omit to inherit the workspace's `history.trigger`, default",
    "off); a trigger's own failure reaches the error log only while it is on.",
    "",
    "- `tableTrigger({ name, table?, datasources?, actions?: {insert?,update?,delete?,truncate?}, stack })` — database/table trigger. `t.new` / `t.old` are the row **after** / **before** the change; `t.action` (`insert|update|delete|truncate`), `t.datasource`. Bind `table` to a `table()` handle and `t.new(\"col\")` / `t.old(\"col\")` are typed to that row (misspelled column = compile error). ⚠ Insert's `old` and delete's `new` are `{}`, not null, and drilling one (`t.old(\"col\")`) RAISES and aborts the run — branch on `t.action` with an `s.conditional`. Config-only (no response). ⚠ A table trigger runs AFTER the write COMMITS, from an event queue, so it is NOT the usual in-transaction trigger: it CANNOT veto the write (a top-level `s.precondition`/`s.throw` fails only inside the trigger — visible via an `errorTrigger` when history is on, never to the writing request, which already answered 200 with the row stored) and its own edits do NOT reach that request's response (a `slug` it computes lands on the row a moment later, not in the POST body). Validate in the WRITING stack or a shared `defineFunction`; use the trigger only for after-the-fact side effects. ⚠ Writes made WHILE a trigger runs fire NO table triggers (the runner disables them for the whole stack), on the SAME or any OTHER table — so a trigger may safely edit its own table (no loop), but triggers do NOT chain: a trigger on `orders` that writes `stock` fires no `stock` trigger. Chain by calling the follow-up logic as a `defineFunction`.",
    "- `realtimeServerTrigger({ name, realtimeServer, actions?: {connect?,disconnect?}, stack?, response?, responseShape? })` — realtime SERVER lifecycle (a client connecting to / disconnecting from the server, not a message). Inputs: `t.action` (`connect|disconnect`), `t.realtime_server`, `t.client`. Bind `realtimeServer` to a `realtimeServer()` handle (or its name).",
    "  - `connect` GATES the connection — a denial sends an `error` and CLOSES the socket with code 4401 before it is ever ready. Same return shape as a channel `join` below (EMPTY/FALSY DENIES — including a gating trigger with NO `response`, which refuses every client).",
    "  - A CRASH DENIES too. Failure is a LOCKOUT, not a breach (an unguarded drill into a null `db.get` raises → everyone refused).",
    "  - Gating is OPT-IN: a server with no `connect` trigger accepts every connection.",
    "  - `disconnect` is OBSERVATIONAL (return ignored, throws swallowed).",
    "  - Both are SERVER-scoped, so `s.realtime.get_session` works but carries no channel path and no bound params.",
    "- `realtimeChannelTrigger({ name, channel, actions?: {join?,leave?,deliver?}, stack?, response?, responseShape? })` — realtime CHANNEL lifecycle. Inputs: `t.action` (`join|leave|deliver`), `t.channel`, `t.payload`, `t.client`. Bind `channel` to a `realtimeChannel()` handle — a bare path is NOT accepted (it is unique only within its server). Each action has its own return posture:",
    "  - `join` GATES the join (it runs before membership) — return `{ allowed: c.bool(true) }` (optional `reason` reaches the client) or any truthy value to admit, and an EMPTY OR FALSY RETURN DENIES, so a stack that just falls through — or a gating trigger with NO `response` — refuses everyone, and a CRASH DENIES too. ONCE the object carries an `allowed` key admission needs STRICTLY `true` — `1`/`\"yes\"` there DENIES. Compute it as `c.expression(\"…\")` or a `ref()` to a `set_var` boolean (`expr()` is not a `response` value). This is the inverse of a crashing message, which still delivers, and of `deliver`. ⚠ It runs ONCE: revoking access later (a deleted membership row) does NOT unsubscribe the open socket. Evict it from the endpoint that revokes the membership with `s.realtime.kick` (`llms/kinds-realtime.md`).",
    "  - A lifecycle trigger's inputs are PINNED to those four, so a channel PATH PARAM is NOT among them — `inp(\"room_id\")` RAISES, which crashes the gate and so REFUSES every client; take the param from `s.realtime.get_session` (`ref(\"session.params.room_id\")`). ⚠ It is RAW TEXT — path params are not validated or coerced at join (`rooms/abc` joins an `input.int()` channel; `session.params.room_id` is `\"42\"`, a string), so a numeric gate must CAST it (`fl.to_int()`) and refuse a non-numeric value itself. The declared type is enforced only when a MESSAGE reads `inp(...)`, per frame, after the join.",
    "  - A gate establishes NO auth: `auth(\"id\")` reads 0 when authenticated, `ref(\"auth.id\")` raises — identity is `t.client(\"permissions.row_id\")` or the session. A SERVER connect/disconnect has no channel, so no params at all.",
    "  - `leave` is OBSERVATIONAL (return ignored, throws swallowed).",
    "  - `deliver` GATES delivery PER RECIPIENT — the per-viewer redaction tool, a stack per recipient per message. ⚠ It runs only when the channel sets `delivery.perRecipient` (`llms/kinds-realtime.md`); without it every subscriber receives the UNREDACTED payload, with no error.",
    "  - ⚠ `deliver`'s return values do not read like a filter: ONLY an explicit NULL drops the message for that recipient; an OBJECT replaces that recipient's payload; anything else — including `false`, `0`, `\"\"` — delivers it unchanged, as does a crash. Return null, not `false`, to suppress.",
    "  - The delivered payload arrives NESTED, so read `t.payload(\"<field>\")`, and `t.client` is the SENDER while `s.realtime.get_session` describes the RECIPIENT this run is for.",
    "- `mcpServerTrigger({ name, mcpServer, stack?, response?, responseShape? })` / `agentTrigger({ name, agent, stack?, response?, responseShape? })` — toolset connection. Bind with the `mcpServer()`/`agent()` def handle (or its name) — it resolves to the toolset guid at export. Raw numeric `objId` is a rarely-right escape hatch; binding nothing deploys a trigger that never fires. Inputs: `t.toolset` (`t.toolset(\"name\")`), `t.tools`; an MCP server's also `t.prompts`/`t.resources`: return one filtered to narrow what the connection lists, omit it to list all — but ⚠ a keyed response MUST keep `toolset` and `tools` (omitting either breaks the server for every client) — and `t.auth`, the signed-in user `{dbo, id, extras}` when the server has `oauth` (null otherwise). Response-bearing; the default returns every list input.",
    "- `workspaceTrigger({ name, actions?: {branch_live?,branch_merge?,branch_new?}, stack? })` — branch lifecycle. Inputs: `t.to_branch`, `t.from_branch`, `t.action`. Config-only.",
    "- `errorTrigger({ name, stack? })` — error-signature trigger. Inputs: `t.event` (`new|regression|fixed`), `t.id`, `t.signature`, `t.error` (`t.error(\"code\")`/`t.error(\"message\")`), `t.caller`, `t.statement`, `t.actor`, `t.count`, `t.first_seen`, `t.last_seen`, `t.fixed_at`. Config-only.",
    "",
  ];

  const filters: string[] = [];
  const fields: string[] = [];
  const values: string[] = [];
  values.push("## Values", "");
  for (const v of m.values.constructors) {
    if (v.legacy) continue;
    values.push(`- \`${v.name}${v.signature}\` — ${v.description}`);
  }
  // `const:encoded` is a stored form `c.text` writes on its own; manifest.json lists it.
  values.push("", `Tags: ${m.values.tags.filter((t) => t !== "const:encoded").join(", ")}.`, "");

  fields.push("## Fields", "");
  fields.push(
    "Author table columns + function/API inputs with the typed catalog: `f.<type>(opts?)`",
    "for columns, `input.<type>(opts?)` for inputs. Common opts: `required`, `nullable`,",
    "`default`, `description`, `access` (a read omits `\"internal\"` columns, returns `\"private\"` ones; `InferRow`",
    "is the full row, both kept), `sensitive` (masks the input's value in request logs; a read still RETURNS a sensitive column — `access: \"internal\"` keeps it out).",
    "⚠ On a column, `required` is not a write-time constraint: `db.add`/`edit` store a null, `\"\"`, or (after a `trim` method) whitespace-only value at HTTP 200 — it only shapes the seed write-shape, the typed row, and the editor. Enforce presence on the input (`input.*({ required: true })` plus a non-empty check — a `min: 1` method or an `s.precondition`).",
    "⚠ An `f.date` COLUMN does not validate the written value: an invalid calendar date ROLLS OVER into a different valid one (`\"2020-13-45\"` stores `\"2021-02-14\"`) instead of failing, so a value arriving through `input.text`/`input.json` or a computed var is silently corrupted. Validate at the boundary with `input.date` (it rejects the same string with a 400).",
    "**`nullable` defaults per type**: `true` for `f.vector`, `f.uuid`, every `f.geo.*` and every",
    "file type (`f.image`/`f.video`/`f.audio`/`f.attachment`); `false` for the rest. Inputs add",
    "date, timestamp and file, so an omitted one binds `null`",
    "(a `required` one still accepts an explicit `null`). Pass `nullable` to override.",
    "⚠ Except `input.geo.*`: an omitted optional geo input is not bound at all, so `inp(\"p\")` 500s `Unable to locate input: p`. Mark it `required: true`, or read it only inside an `s.conditional` that a sibling flag gates.",
    "An empty default becomes NULL only when",
    "nullable, so a non-null `f.vector(8)` column fails to create (`''` is not a vector).",
    "**`f.geo.*` values are `{ type, data }`, not GeoJSON.** The same shape goes in and comes",
    "back. `type` per column: `point` → `\"point\"`, `data` `{ lng, lat }`; `multipoint` → `\"points\"`,",
    "`linestring` → `\"path\"`, `polygon` → `\"poly\"` (ring closed for you), `data` `[{ lng, lat }, …]`;",
    "`multilinestring` → `\"paths\"`, `multipolygon` → `\"polys\"`, `data` `[[{ lng, lat }, …], …]`.",
    "Any other spelling (`\"multipoint\"`, `\"linestring\"`, `\"Point\"`) 400s `Only strings are supported for:`.",
    "Raw WKT text (`c.text(\"POINT(1 2)\")`) is accepted on write too, but a COLUMN read never returns one.",
    "⚠ An `input.geo.*` is the exception: `inp(\"p\")` inside the stack reads back as WKT TEXT (`\"POINT(10 20)\"`), NOT the `{ type, data }` you POSTed — it becomes `{ type, data }` only once WRITTEN to a geo column and read back. So `InferResponse` of a bare `inp()` of a geo input is wrong (it types `{ type, data }`); treat a bound geo input as a `string`.",
    "`methods` (validators/transforms, names per type below): `\"trim\"`, `\"min:8\"`",
    "(a text arg keeps its `:`: `\"startsWith:https://\"`), or `{ name, arg }` — for unlisted names and `pattern`'s error text.",
    "`f.json({children})` declares the nested shape stored INSIDE a json column — an ARRAY of",
    "`{name, type, methods?, children?}`, order-significant, distinct from the `FieldMap` that",
    "`f.object` takes positionally. Omit it for an unstructured json column.",
    "`f.enum(values)`/`f.vector(size)`/`f.object(children)`/`f.tableRef(table)` take a",
    "positional payload before opts — and still accept the standard `FieldOptions` after it",
    "(e.g. `f.tableRef(users, { required: true })` — only `min`/`max` are listed as tableRef",
    "methods below, but `required`/`nullable`/`description`/… apply like any field).",
    "`f.enum([])`/`input.enum([])` (a pulled enum with no options) brands the column `never`; `InferRow` surfaces it as `undefined`.",
    "⚠ An `f.enum` column refuses a non-member (400) but STORES `\"\"`, which an omitted optional",
    "`input.text`/`input.enum` binds, overriding the `default`; `InferRow` types it members `| \"\"`. Declare that input `nullable: true` (omitted → `null` → the default).",
    "An **OPTIONAL foreign key wants a `0` sentinel, not `nullable: true`**. `f.tableRef` to an int-keyed table stores",
    "an `int`, and a null in it is unqueryable: `null` is never a legal `fieldValue`/`id`, so",
    "`s.db.get`/`edit`/`del` on that column answer HTTP 400 `Missing param: field_value` rather",
    "than matching nothing. Declare `f.tableRef(users, { required: true, default: 0 })` for",
    "\"not set yet\" — `s.db.get({ fieldName: \"driver\", fieldValue: c.int(0) })` matches no row and",
    "binds `null`, which is the answer the null was reaching for. `export()` warns on a literal",
    "`c.null()` in that slot. A uuid-keyed ref stays nullable even when `required` (a non-null one defaults to `\"\"`, which no insert accepts).",
    "An `f.vector(size)` column is SEARCHED through `s.db.query`'s `eval` pipeline, not through",
    "any `SearchOp`: give the table `index: [{ type: \"vector\", fields: [{ name: \"embedding\", op:",
    "\"vector_cosine_ops\" }] }]`, then rank with a distance filter + a sort on its alias (see",
    "`s.db.query` → `eval`).",
    "`{ array: true }` makes any `f.*` scalar a **list column** — `f.text({ array: true })`",
    "surfaces as `string[]` in `InferRow<typeof table>`.",
    "Filter one to rows containing a value with `contains`/`overlaps` and a LIST operand (NOT a",
    "scalar — `llms/statements-data.md`).",
    "**Seed a table's starting rows with `table({ seed })`.** `seed` takes rows",
    "typed against the table's schema as a WRITE shape (a column without",
    "`required: true`, and the system columns, may be omitted; `null` needs",
    "`nullable: true`) — inline (`seed: [{ name: \"…\" }]`), a FILE",
    "(`seed: seedFile(\"./seed.json\", import.meta.url)`; path resolves against the DECLARING",
    "file), or a thunk (`seed: () => import(\"./seed.json\")`, async ok, `.default` unwrapped).",
    "Inline rows are TYPED against the schema at compile time; a `seedFile`/thunk seed is",
    "not — `npx @xano/sdk export`/`deploy` validates it, naming the row index and column.",
    "Timestamp seeds: epoch ms, `Date`, ISO 8601 date, or date-time with `Z`/offset; else THROWS.",
    "Int seeds: whole, in int64 (past 2^53: a string).",
    "⚠ Prefer `seedFile` for a file: a thunk's `import()` sits in",
    "YOUR module, so a bundler emits the JSON as a served chunk. Never put secrets",
    "in `seed`. `deploy --static` REFUSES a build carrying internal/sensitive seed values;",
    "declare public ones (demo logins) on the table: `publicSeed: [\"password\"]`.",
    "A replacing deploy re-seeds cleanly; `--keep-data` writes no seed rows.",
    "`seed` is evaluated on EVERY build, so a computed value (`Date.now()`) is fine:",
    "the lock records no seed data.",
    "A FILE column seeds from a repo file: `logo: hostedFile(\"./logo.png\", import.meta.url)`;",
    "the row stores each backend's own copy. A wrong-kind file or a non-file column THROWS.",
    "A release carries no file bytes: `release create` refuses such rows and icons.",
    "Omit `id` and rows auto-number `1..N` (int PK) or take",
    "a stable derived uuid (uuid PK); supplying `id` pins it (and",
    "resets an int sequence past the max). All-or-nothing — mixing explicit and",
    "omitted `id` throws. A `system:false` PK is the author's to supply. Pinning is",
    "`seed`-only — `s.db.bulk.add` DROPS `id` unless `allowIdField: true`. ⚠ After a deploy, the FIRST insert into an UNSEEDED int-keyed table gets `id: 2`, not 1 (a seeded table continues correctly from its max) — so a test or fixture must not assume the first inserted row is `id: 1`.",
    "**`use_xdo` storage mode.** Workspace setting (`registerWorkspace({ use_xdo })`,",
    "default `false`): `true` stores fields as JSON in the `xdo` column (+ `gin(xdo)` index),",
    "`false` real columns.",
    "Tables inherit it; override with `table({ useXdo })`; a merge refuses to switch a populated table.",
    "A **column `default` must stay within the BMP** — a 4-byte character (codepoint > U+FFFF,",
    "e.g. an emoji) is rejected at export; put such a value on an `input.<type>({ default })`.",
    "`input.*` mirrors `f.*` — every column type below is",
    "a legal input (scalars, files `input.image/video/audio/attachment`, `input.geo.*`,",
    "`input.vector(size)`, `input.tableRef(table)`, `input.object(children)`).",
    "Input-only: `input.dbLink(table)` expands into one input per column of the linked table;",
    "read them by column name (`inp(\"email\")`), not by the entry's own name.",
    "`hidden: [\"created_at\"]` drops columns from that expansion.",
    "`input.list(element)` for arrays — wrap any element constructor, e.g.",
    "`input.list(input.text())` or `input.list(input.object({ id: f.int() }))`.",
    "**A file reaches a column in two steps.** `input.file` is the RAW upload (the request's",
    "multipart/base64 bytes) and cannot be written to a file column directly: store it first —",
    "`s.storage.create_image({ as: \"img\", value: inp(\"avatar\"), access: \"public\" })`",
    "(read the upload with `inp`; `ref(\"input.avatar\")` spells a stack VARIABLE named",
    "`input` and fails the request with `Missing var entry: input`) — then write",
    "`ref(\"img\")` into the `f.image()` cell with `s.db.add`/`edit`. `access` defaults to",
    "`\"public\"` (a guessable URL): pass `\"private\"` and hand out `s.storage.sign_private_url`",
    "results for anything user-scoped. `create_video`/`create_audio`/`create_attachment` are",
    "the same shape for the other file columns, each fed `input.file` (`input.image`/… 400s an upload).",
    "⚠ A WRONG-KIND upload to `create_image`/`create_audio`/`create_video` (text sent as an image, or a `.txt` renamed `.png`) fails the request with HTTP 500 `ERROR_FATAL` (`Invalid file extension.` / `This resource is not a valid image.`), not a 4xx. Guard it: wrap the store in `s.try_catch`, or precondition the upload's extension/mime first.",
    "**An empty file column is a stored null that `where` does not see as null.** `expr(col(\"file\"), \"!=\", c.null())`",
    "matches EVERY row, and `= c.null()` matches none. Compare a key inside the file instead:",
    "`expr(col(\"file.path\"), \"!=\", c.null())` keeps only the rows holding a file.",
    "**Typed inputs validate/coerce on bind, before your stack runs** — so reach for the",
    "specific type instead of hand-rolling checks. `input.email({ required: true })` rejects a",
    "malformed address with a 400 (and trims; add `methods: [\"lower\"]` to downcase) — no",
    "`regex_matches` needed; `input.int`/`input.decimal`/`input.uuid`/`input.enum([...])`/`input.date`",
    "likewise reject or coerce bad input at the boundary. Drop to `input.text` + `s.precondition`",
    "only for rules no type expresses.",
    "⚠ `input.int` COERCES by TRUNCATION, not refusal: a fractional number binds its integer part",
    "at HTTP 200 (`1.7` → `1`, `2.9` → `2`), where `\"abc\"` gets a 400. When a fraction must be",
    "refused rather than silently floored, take `input.decimal` and check it with `s.precondition`.",
    "⚠ `input.url` is NOT one of them — there is no engine `url` type, so it stores as `text`",
    "and validates NOTHING: a `javascript:`/`data:` URL type-checks, imports, and binds. When the value gets navigated",
    "to, check the scheme in the stack. It is INPUT ONLY — there is no `f.url` column.",
    "⚠ `input.timestamp` binds epoch MILLISECONDS. A number is taken as ms as-is, so epoch",
    "SECONDS (`date +%s`) bind in January 1970 with no error. An ISO-8601 string keeps its",
    "offset but DROPS fractional seconds (`\"…T19:30:00.123Z\"` binds `…:00.000`). Send epoch ms",
    "(`Date.now()`, `getTime()`) whenever sub-second precision matters.",
    "⚠ `input.list` does NOT reject a non-array: one value binds as a ONE-item list (`\"a\"` →",
    "`[\"a\"]`); a non-JSON string given to an `input.object` binds an object of its",
    "children's DEFAULTS, so `input.list(input.object({...}))` given `\"notalist\"` binds",
    "`[{ name: \"\", … }]` with a 200 (a list `min` passes: one item). A string starting with `[`",
    "is parsed as JSON with NO element check. To enforce the shape, mark an object child",
    "`required: true` (the default-filled object then 400s with its param path); check the rest",
    "with `s.precondition`.",
    "⚠ `s.precondition`'s `error` must be a TAGGED value — `c.text(\"…\")`, not a bare string (warns `stack.precondition-bare-error`).",
    "A bare string is replaced by the generic \"Precondition failed.\"; the status from `error_type` still applies.",
    `\`error_type\` is how a stack sets a FAILURE status: ${preconditionStatusLine()}.`,
    "A failed request answers a JSON envelope `{ code, message, payload }`: `code` is the",
    "`ERROR_CODE_*` string for the `error_type` (`badrequest` → `ERROR_CODE_BAD_REQUEST`,",
    "`accessdenied` → `ERROR_CODE_ACCESS_DENIED`, `notfound` → `ERROR_CODE_NOT_FOUND`, …;",
    "`standard`/an uncaught engine error → `ERROR_FATAL`). `message` is the `error` text.",
    "`payload` is `s.precondition`'s optional structured detail (`obj({...})`), client-visible;",
    "it is `\"\"` when a precondition sets none and the key is ABSENT entirely on engine errors.",
    "⚠ A `db.edit`/`db.del` NotFound carries an EMPTY `message` (just `{code:\"ERROR_CODE_NOT_FOUND\"}`),",
    "so a `catch` that re-raises `fl.concat(caught(\"message\"))` yields only its prefix and an",
    "`expect.to_throw(c.text(...))` can never match it — re-raise with your own `error` text.",
    "⚠ An uncaught `s.throw` (including one inside a function run with `s.function.run`):",
    "- answers HTTP **200** with `{ payload, statement: \"Throw Error\" }`, so `res.ok` is true — UNLESS it",
    "  sets `status`: `s.throw({ name: \"NOT_ALLOWED\", value: c.text(\"no access\"), status: 403 })`",
    "  answers 403 with that body (`status` is a whole number, 100–599).",
    "- The status applies only when nothing catches the throw; a caught throw leaves the response status alone.",
    "- The body carries `value` as `payload` and never the `name`.",
    "- For the `{ code, message, payload }` envelope, fail with `s.precondition` or `guard.require` instead.",
    "",
    "For any other status — and for a redirect — use `respond.*`, which is sugar over",
    "`s.util.set_header` (that statement reaches the status line): `respond.status(201)`,",
    "`respond.redirect(url, { status?: 301|302|303|307 })` (a TUPLE — spread it; a `Location`",
    "alone does NOT redirect), and `respond.header(name, value)`. Position in the stack does not",
    "matter, a later status wins, and a FAILING `precondition` still wins over anything set",
    "before it. ⚠ `204` answers with an empty body whatever `response` says. ⚠ `respond.status`",
    "REFUSES `308`/`425`/`451`/`102`/`103` (they would answer 200, nothing reported); use 301, 429 and 403 instead.",
    "Normalizing transforms run on bind too — put `trim`/`lower`/`upper` on the input's `methods`",
    "so `inp(\"name\")` reads already-normalized; don't reroll `var $x = inp(\"name\")|trim` in the stack.",
    "⚠ `f.decimal`'s size depends on the table's layout; it takes no precision or scale option.",
    "On a normalized table (`useXdo: false`, the default) it is FIXED: 5 decimal places out",
    "of 14 total digits. `0.12345678` written and re-read is `0.12346` (`-0.000004` → `0`),",
    "and the rounding is silent at HTTP 200 — for a scalar `s.db.add`'s `as` output carries the",
    "STORED value, not the cell you sent, so comparing the two detects the loss; for a list",
    "(`array: true`) it is the unrounded list you sent, so only a re-read shows it. Rounding happens BEFORE",
    "the size is checked, so a magnitude needing 10 digits left of the point AFTER rounding 500s",
    "`ERROR_FATAL` `SQL Error: 0`, naming neither column nor value: `999999999.5` stores,",
    "`999999999.999999` does not. On a `useXdo: true` table it is a JSON number with no 5dp",
    "rounding (`0.123456789` reads back `0.123456789`). On either layout, for anything finer than 5dp",
    "store an integer count of the smallest unit (cents, satoshis) in an `f.int`.",
    "⚠ `f.int` is a SIGNED 64-bit column — `-9223372036854775808` to `9223372036854775807` —",
    "and past the ceiling it CLAMPS instead of failing: `9223372036854775808` and",
    "`18446744073709551615` both store as `9223372036854775807`, at HTTP 200 with no error, so",
    "an overflowed count reads back as a plausible number. The response carries every digit, but",
    "`JSON.parse` (so `res.json()`) rounds past `9007199254740991` — read a count that large as",
    "text or BigInt. `c.int()` refuses an unsafe number literal, so pass the string.",
    "",
  );
  for (const ft of m.fieldTypes) {
    const stored = ft.stored !== ft.name.replace(/^geo\./, "") ? ` (stored \`${ft.stored}\`)` : "";
    const methods = ft.methods.length ? ` — methods: ${ft.methods.join(", ")}` : "";
    // An input-only type has NO `f.` form; naming it `f.<name>` would document a
    // constructor that does not exist.
    const ns = ft.inputOnly ? "input" : "f";
    const only = ft.inputOnly ? " — INPUT ONLY (no `f.` form)" : "";
    fields.push(`- \`${ns}.${ft.name}\`${stored}${methods}${only}`);
  }
  fields.push("");

  filters.push("## Filters", "");
  filters.push(
    "Attach to a value with `withFilters(v, fl.name(...))` — the value `filters[]`",
    "pipeline. Filters are passed spread (canonical); the array form",
    "`withFilters(v, [fl.a(), fl.b()])` is also accepted. Every filter is typed. Arity:",
    "",
    "- A declared argument list (the catalog below) is an EXACT count, not a floor: passing more",
    "  THROWS, in the type and at runtime.",
    "- Seven declared filters take more: `concat` (trailing separator), `index_by` (trailing list",
    "  flag), `get` (trailing variable map), `array_merge`/`array_merge_recursive` (any number of",
    "  arrays), `jwe_encode`, `jwe_decode`.",
    "- A filter with NO declared list is called `fl.<name>()`; passing an argument is a compile",
    "  error. The variadic filters at the end of the catalog take undeclared arguments and are",
    "  not arity-checked.",
    "- Past any of these — a filter the catalog under-declares, or more than a",
    "  zero-argument filter's `()` accepts — use the untyped `filter(\"name\", …)`.",
    "",
    "A typed filter also accepts one object of NAMED arguments (`fl.add({ value: 1 })`); a key",
    "the filter does not declare throws rather than being dropped.",
    "A bare JS **scalar** — string, number or boolean — is accepted in ANY `fl.*` argument and",
    "wrapped as a constant (`fl.get(\"a.b\", 0)` ≡ `fl.get(c.text(\"a.b\"), c.int(0))`). Build an",
    "object or array with `c.obj`/`c.array`. Any argument also takes a runtime value (`inp`, `ref`,",
    "a `withFilters` chain); inside `obj()`/`expr()` an argument cannot carry its own filter",
    "chain — compute it in a prior `set_var`. Arg types below are ENGINE types, not JS types.",
    "`fl.add`/`fl.sub`/`fl.mul` keep an INT when both operands are ints (`2 × 3` is `6`) and give",
    "a decimal when either is one; an int pipeline needs no `fl.to_int()`. `fl.div` is an int only",
    "when it divides exactly.",
    "To add to a numeric column (counter, stock, balance), use `s.db.increment`",
    "(`llms/statements-data.md`) — one atomic UPDATE. A pipeline read-modify-write is NOT",
    "atomic (concurrent writers lose updates), and `col(\"clicks\")` does NOT resolve to the",
    "stored value inside a `db.edit` `row` (it is `null`; `null + 1` aborts): `db.get` the row",
    "`as: \"current\"`, then `withFilters(ref(\"current.clicks\"), fl.add(c.int(1)))`.",
    "⚠ NULL operands, by filter:",
    "- Text filters (`trim`/`upper`/`strlen`/`to_int`/…) pass null through (`strlen(null)` is `null`;",
    "  `strlen` of a non-string is `null` too, not a length).",
    "- Arithmetic treats null as `0` (`null|add:1` → `1`).",
    "- `fl.concat` on a null or list base returns `\"\"` and SILENTLY DROPS its argument",
    "  (`null|concat:\"x\"` → `\"\"`). Default the base first:",
    "  `withFilters(inp(\"middle\"), fl.first_notnull(c.text(\"\")), fl.concat(\"x\"))`.",
    "- `fl.split` of null is `[\"\"]`.",
    "",
    "⚠ `fl.trim`/`ltrim`/`rtrim` (and the `s.text.*` trims) take `mask` as a SET OF CHARACTERS, not a",
    "substring. It is a PHP MASK, so `\"a..c\"` means the RANGE a-c, not the three characters `a`, `.`, `c`.",
    "",
  );
  // Split on whether there are ARGUMENTS to render, not on `typed` — every filter
  // is typed, and a zero-arg one has no signature worth a bullet.
  const argFilters = m.filters.filter((fl) => fl.args?.length);
  for (const fl of argFilters) {
    // An enumerated arg prints its MEMBERS, not the word "enum". Printing the
    // word made the accepted set expensive to learn: it was discoverable only
    // by trying spellings against a live engine, and the one that behaves
    // differently from the rest is not guessable.
    const sig = (fl.args ?? [])
      .map((a) => {
        const type = a.enum?.length ? a.enum.map((m) => JSON.stringify(m)).join("|") : a.type;
        return `${a.name}${a.optional ? "?" : ""}: ${type}`;
      })
      .join(", ");
    const ret = fl.result ? `: ${fl.result}` : "";
    // Signature-first: render only a curated note (complete, non-truncated) where the
    // signature underspecifies; the raw source description is dropped from the primary
    // but retained in manifest.json. `hasOwn` guards against a filter name colliding with
    // an inherited Object member (e.g. "constructor").
    const note = Object.hasOwn(FILTER_NOTES, fl.name) ? FILTER_NOTES[fl.name] : undefined;
    filters.push(`- \`${fl.fl}(${sig})${ret}\`${note ? ` — ${note}` : ""}`);
  }
  // Grouped by operand type: a flat list hid that `reverse` is a list filter,
  // and on text it answers the text unchanged rather than an error.
  const zeroArgByGroup = new Map<string, string[]>();
  for (const fl of m.filters.filter((fl) => !fl.args?.length && !fl.variadic)) {
    const group = fl.group ?? "other";
    zeroArgByGroup.set(group, [...(zeroArgByGroup.get(group) ?? []), fl.name]);
  }
  const zeroArg = [...zeroArgByGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, names]) => `${group}: ${names.join(", ")}`);
  const variadic = m.filters.filter((fl) => fl.variadic).map((fl) => fl.name);
  filters.push(
    "",
    `Zero-argument filters, by operand type: ${zeroArg.join("; ")}.`,
    "`fl.reverse()` reverses a list only: on a text value it answers the text UNCHANGED, with no error.",
    "An unknown `timezone` (a typo, `+05:30`, `PDT`) silently means UTC. A literal warns at export; take a runtime zone as an `input.enum`.",
    "`fl.to_bool()` is NOT a truthiness cast: it accepts only the boolean vocabulary — `true`/`1`/`\"1\"`/`\"true\"`/`\"on\"`/`\"yes\"` and `false`/`0`/`\"0\"`/`\"false\"`/`\"off\"`/`\"\"` — and ANY other value 400s `ERROR_CODE_INPUT_ERROR` \"Invalid boolean input.\". For a truthiness cast pipe `fl.ne(c.int(0))`.",
    "",
    `Variadic filters — they take arguments, but no declared list, so the count is not checked: ${variadic.join(", ")}.`,
    "",
  );

  const lambda: string[] = renderLambdaSection();

  lines.push("## Statements", "");
  lines.push(
    "Reachable through the `s` namespace: `s.<path>({...})`. Declarative statements",
    "take one typed args object (field names match the engine); every surface's field",
    "signature is in `llms/statements-catalog.md`. Specials (`[special]`) are",
    "hand-authored: control flow is below, the rest are in the `llms/statements-*` topic files.",
    "Fields marked `value` take a `Value` (`c.*`/`ref`/`inp`); `comparison` takes an",
    "`expr(...)`. A `→ as: <type>` suffix names what the statement's `as:` output var",
    "holds (curated, not exhaustive — absence means read the `[output]` flag and prose).",
    "`ignored(...)` around an `input`-routed `value` field stores it but SKIPS it at runtime: the",
    "engine records `<name>:ignore` and the parameter takes its default. Distinct from an empty",
    "value and from omitting the field (no entry stored). Mostly seen on a pulled workspace. On a",
    "`context`-routed field (the `s.math.*`/`s.text.append` mutation family) `ignored(...)` THROWS:",
    "there is no slot for the flag.",
    "",
  );

  // Curated signatures for the high-traffic specials — the ones whose args can't
  // be read off the per-namespace `(…)` listing. Authored from the arg
  // interfaces in `src/statements/special/` so an llms.txt-only agent can call
  // them without the .d.ts.
  lines.push(
    "### Specials — authored signatures",
    "",
    "Control flow & blocks (each nests a sub-stack; block specials name it `body`):",
    "",
    "- `s.set_var(name, value)` · `s.update_var(name, value)` · `s.return(value)` · `s.comment(text)` — positional.",
    "- **Every** statement takes `disabled?`/`description?` — annotations on the stack item, not args: `disabled: true` is Xano's \"disable step\" (kept in the stack, skipped at runtime), `description` the note beside it. Inline on object-arg factories; a trailing object on the positional ones (`s.set_var(\"x\", v, { disabled: true })`).",
    "- **Statements with an `as`** also take `asFilters?` — `fl.*` filters on the RESULT as it binds, in order, same slot as `disabled`: `s.set_var(\"x\", v, { asFilters: [fl.trim(), fl.lower()] })`. Saves a follow-up `set_var`. Throws without an `as`. The bound variable is RETYPED by the chain (`db.query` + `[fl.count()]` → `number`); filters whose result the engine declares as `any` (`get`, `set`, `json_decode`, …) fold to `unknown`.",
    "- `s.conditional({ when, then, elif?, else? })` — if/elif/else. `when` is a condition (`expr`/`cmp`/`and`/`or`); `elif` is an ordered `[{ when, then }]` (each an else-if branch); `then`/`else` are `Statement[]`.",
    "- `s.for({ as, count, body })` — **count-bounded** loop (`as` is the index), NOT from/to; `count` is a `Value`, not a bare number.",
    "- `s.foreach({ as, list, body })` — iterate `list`; `as` is the current item.",
    "- `s.while({ when, body })` — `when` is a condition (`expr`/`cmp`/`and`/`or`).",
    "- `s.switch({ on, cases: [{ when, body, break? }], default? })` — multi-way branch on a subject `Value` `on`; each `case`'s `when` is a literal `Value` matched against `on` (NOT a comparison — use `s.conditional` for `<`/`>`/ranges). ⚠ **Omitting `break: true` FALLS THROUGH** — the matched case also runs every LATER case body. Type-checks clean; only `export --strict` catches it.",
    "- `s.try_catch({ try, catch?, finally? })` — three `Statement[]` blocks.",
    "- `s.group(body)` / `s.util.post_process(body)` — take a `Statement[]` **positionally**.",
    "- `s.foreach_break()` / `s.foreach_continue()` / `s.foreach_remove()` — nullary loop control.",
    "- `s.expect.to_throw({ body, exception? })` — `body` is the statements expected to raise; `exception` is a `Value`, not a bare string.",
    "",
  );

  // The rest of the authored signatures, split on the sub-block boundaries the
  // doc already had. Control flow above stays inline — nearly every workspace
  // uses it — while these are reached only when that surface is in play.
  const stmtData: string[] = [
    "Array blocks (an `if`/`transform` is applied per item):",
    "",
    "- `s.array.map({ source, as?, transform? })` — `transform` is either a per-item `Value` expression (each item maps to that value) or a **record of values** (each item maps to an object with those keys), or a list of `{ key, value }` pairs, for a key computed per item or two rows sharing one. Use `ref(\"$this\")` for the item and `ref(\"$index\")` for its position. A `transform` value, filter arguments included, can read `ref(\"$this.<path>\")` and any outer stack variable or input. These are THIS statement's own bindings, in a value expression — not the JavaScript lambda contract (see **Lambda bodies**), which binds a different set per surface and is written with `lam.fn`.",
    "- `s.array.union({ source, with, as?, transform? })` — set-union two arrays. `with` is REQUIRED; omitted → `Unable to locate input: `. `transform` is a per-item DEDUPE KEY over `$this`, not a map: the result keeps the original items, first occurrence wins (`transform: ref(\"$this.id\")` unions records by `id`).",
    "- **Array predicates** (`s.array.filter`/`filter_count`/`find`/`find_index`/`has`/`every`/`partition`) share one shape: `{ expr, if, as }`. The `if` comparison reads the current item as `ref(\"$this\")` (or `ref(\"$this.<path>\")`) and resolves any outer var/input; `$index` is bound ONLY inside `partition`, not the others. Results: `filter` → the matching list; `filter_count` → an int; `find` → the item or `null` on a miss; `find_index` → the index or `-1` on a miss (on an OBJECT source it returns the matching KEY, e.g. `\"x\"`); `has` → a bool; `every` → a bool, `true` on `[]`; `partition` → `{ \"true\": [...], \"false\": [...] }` (STRING keys). ⚠ An OBJECT source iterates its VALUES (keys dropped from `filter`'s result), and a null, omitted or scalar source behaves like `[]`. The predicate uses the engine's LOOSE comparison, so `\"abc\" > 3` and `\"1\" = 1` are both true.",
    "- **Set ops** `s.array.difference`/`intersection` take `{ expr, value, by?, as }` (`s.array.union`'s shape is the bullet above). All three compare STRICTLY (`\"3\"` ≠ `3`), unlike the predicates — and they DEDUPE the source: `[1,1,2,\"3\"]` − `[3]` → `[1,2,\"3\"]`, `[1,2,2,3]` ∪ `[3,4]` → `[1,2,3,4]`. Without `by`, records compare whole; `by` is a `$this` expression (`by: ref(\"$this.id\")`), not a column name.",
    "- `s.array.group_by({ expr, by?, as })` binds an OBJECT keyed by each item's `by` value (a missing key read with `{ safe: true }` groups under `\"\"`). ⚠ WITHOUT `by` on a list of records it 500s (`Cannot access offset of type array on array`) — always pass `by` for records.",
    "- **In-place array mutators** `s.array.push`/`unshift`/`merge`/`pop`/`shift` take `{ name, value? }` and REWRITE the var named `name` (no `as`); `name` may be a dotted path (`\"o.items\"`). `pop`/`shift` on `[]` bind `null`. ⚠ `push` of a LIST appends it as ONE element (`[…, [9,9]]`) where `merge` SPREADS it in; `push` onto a scalar var throws, and onto an object var it adds numeric keys.",
    "- `s.object.keys`/`values`/`entries({ value, as })` on `{}`, null, an omitted var or a string all bind `[]`; on a LIST they treat the indexes as keys. `entries` yields `{ key, value }` OBJECTS (not `[key, value]` tuples), and an integer-like key comes back as a NUMBER (PHP coerces it), for all three.",
    "",
    "DB reads/writes (`table` is a def handle or name; `fieldName` defaults to the",
    "primary key `id`):",
    "",
    "- `s.db.get({ table, fieldName?, fieldValue, lock?, output?, as? })` — one row by field match; `output` restricts returned columns (and overrides column visibility — it can pull `internal` columns like a password hash).",
    "- `s.db.has({ table, fieldName?, fieldValue, as? })` — existence test.",
    "- `s.db.del({ table, fieldName?, fieldValue, as? })` — delete by field match.",
    "- `s.db.add({ table, row?, data?, output?, as? })` — insert; `row` is a partial keyed by column.",
    "  - A row CELL takes a tagged `Value`, a nested object of sub-keys, or a bare JS literal typed against that column: `row: { is_hidden: true, notes: \"…\" }` encodes exactly as `{ is_hidden: c.bool(true), notes: c.text(\"…\") }`. The tag comes from the COLUMN, not the literal — `10` on an `f.decimal()` column is `const:decimal`, not `const:int` — so a literal contradicting its column is a compile error on a `f.*`-schema table (`{ is_hidden: \"yes\" }` on an `f.bool()` column) and throws at encode on a raw-`ColumnDef[]` one. An `f.enum()` column keeps its member union. A column with no literal form — obj/json/list/geo/vector/file — still needs `c.obj`/`c.array`.",
    "  - `null` is accepted on EVERY column at encode and encodes `const:null`; a column's `nullable` is not consulted there. ⚠ The engine does not refuse it either: on a NON-NULLABLE column an explicit `null` is the SAME as omitting the key — it stores the column's `default`, else the type's zero value (`\"\"`/`0`/`false`/…). Only a `nullable: true` column STORES null.",
    "  - Omitting a key on `add` writes the column's type default — declared `default` if set, `[]` for a list, `{}` for obj/json, else `null`, which is EMITTED, not what the row holds: a `nullable` column keeps `null`, a non-nullable one lands on its type's zero value (`\"\"`, `0`, `false`). ⚠ Except `f.date`: it stores TODAY's date, absent from `add`'s `as` — make an optional date `nullable: true`. On `edit` an omitted key keeps its stored value.",
    "  - An `f.password()` cell takes the PLAINTEXT — the column hashes on write, so a pre-hashed value, or a hashing filter on the cell, stores a hash of a hash that `security.check_password` can never match.",
    "  - A `table({ seed })` cell hashes the same way: the import writes the plaintext through the column's own rules, so a seeded credential matches under `security.check_password` exactly as an added one does. Seeded credentials work as fixtures; their plaintext is committed to the repo.",
    "- `s.db.edit({ table, fieldName?, fieldValue, row?, data?, output?, as? })` — update by field match.",
    "- `s.db.patch({ table, fieldName?, fieldValue, data, output?, as? })` — merge a partial. ⚠ Unlike `db.edit`'s `row`, `data` is a single object `Value` — write `obj({ unread: c.int(0) })`, not the column-keyed record `row` takes. ⚠ A json/object column value is DEEP-merged key by key, not replaced: patching `{ meta: { k: 1 } }` onto `meta = { origin: \"WA\" }` stores `{ origin: \"WA\", k: 1 }`, so a patch can NEVER drop a key from a json column — use `db.edit` with `row: { meta: … }` to replace one wholesale.",
    "- `output` on `db.get`/`add`/`edit`/`patch` restricts the columns of the RETURNED row only — on a write it does not change",
    "  what is written. Not offered on `db.del`/`db.has` (their result is a scalar) or on",
    "  `db.add_or_edit` (no output envelope).",
    "- `s.db.add_or_edit({ table, fieldName?, fieldValue, row?, data?, as? })` — upsert.",
    "- `s.db.query({ table, where?, additionalWhere?, bind?, sort?, paging?, external?, returnType?, distinct?, eval?, output?, lock?, addon?, as? })` — search.",
    "  - `where` / `additionalWhere` — `expr(...)` or an `expr[]` (ANDed); never a value. Rides `context.search`.",
    "    - ⚠ `ignoreEmpty` DROPS the predicate when the operand is empty (not zero rows). \"Empty\" is PHP `empty()` — `null`, `\"\"`, `\"0\"`, `0`, `false`, `[]`:",
    "      - `0`/`false` also drop it: an optional numeric/bool filter can't match zero or false (`max_price=0` returns the whole table), and an omitted `input.int()`/`input.bool()` binds `0`/`false`. Use `ignoreEmpty` only for an optional TEXT/LIST filter; for a number/bool use a `nullable: true` input + `s.conditional` on `!= null`.",
    "      - On `in` an empty list returns the UNFILTERED set, so never scope to permitted ids with it (a `bulk.delete` only it scopes throws).",
    "      - `not in` an empty list is the mirror trap, matching NO rows, so an exclusion filter returns nothing when nothing is excluded — guard both empty cases.",
    "    - For the full operator set use `cmp(left, op, right, { ignoreEmpty? })` — `op`: `in`/`not in`/`like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… plus the `expr` comparisons. Database-only — a runtime condition takes the `expr` set only.",
    "    - ⚠ `like`/`ilike` take the operand as the PATTERN, verbatim: a bare term matches only an exact whole-string equal, and the endpoint answers HTTP 200 with zero rows, no error. For substring matching use `includes`/`not includes`, which wrap the operand in `%…%` themselves and match case-INSENSITIVELY. Prefer them over a hand-built `\"%\" + term + \"%\"`, which is non-empty even for an empty term and so defeats `ignoreEmpty`; `includes` composes with it. `contains`/`@>`/`overlaps` are JSON/array containment, not text — on a text column they 400 `ParseError: Invalid value for param`.",
    "    - **Filter a LIST column** (`f.text({ array: true })`) to rows that hold a value — the \"posts tagged X\" query — with `contains`/`overlaps` and a LIST on the right. ⚠ A SCALAR on the right 400s `Invalid value for param` every request, whether a literal (`c.text(\"x\")`) or a scalar-typed `inp(\"tag\")`/`ref()` (`export()` warns `db.filter-operand-invalid`) — wrap the single value in a list first. For an OPTIONAL value add `fl.filter_empty_text` so an omitted one matches nothing (not `[\"\"]`, which `array_push` would leave): `s.set_var(\"tag_list\", withFilters(c.array([]), fl.array_push(inp(\"tag\")), fl.filter_empty_text()))` then `cmp(col(\"tags\"), \"contains\", ref(\"tag_list\"), { ignoreEmpty: true })`. (`in` cannot take the list column on the RIGHT — one side must be a scalar.)",
    "    - Compose nested boolean logic with `and(...)` / `or(...)` groups (also available on `addon()` `where`).",
    "    - An operand may be a bare value (`col`/`inp`/`ref`/`auth`/`c.*`) OR a **filtered** value (`withFilters(...)`) inline — the engine compiles the string and arithmetic filters (`trim`, `concat`, `upper`, `lower`, …) into the SQL.",
    "    - ⚠ The REQUEST-TIME timestamp filters have no SQL form and kill the request with a bare fatal naming nothing: `epochms_transform`, `epochms_add_ms`, `epochms_add_secs`, `epochms_date`, `epochms_from_format`. For a relative cutoff use the SQL-side family instead (`qf.epochms_add_day(7)`, `qf.epochms_sub_month(1)`, `qf.epochms_year(\"UTC\")`, …) — or compute it in an earlier `s.set_var` and `ref()` that. `export --strict` reports it; a bare `c.now()` operand is always fine.",
    "  - `bind: [{ table, as?, join?, where? }]` — joins (`context.bind[]`). `join` defaults to `\"inner\"`. `as` defaults to the table name; two joins to the same table need distinct aliases.",
    "    - ⚠ In `where`/`sort`/`eval` a JOINED column takes a dotted path (`col(\"team_row.id\")`); THIS query's own columns stay **bare** (`col(\"team\")`). Qualifying your own by table name needs `tableAlias` (same rule as `aggregate`); without it the engine 400s `ParseError: Invalid value for param` naming the OTHER operand, so export throws.",
    "    - `bind: [{ table: team, as: \"team_row\", join: \"left\", where: expr(col(\"team\"), \"=\", col(\"team_row.id\")) }]`",
    "    - `bind: [{ expand: \"blog.categories\", as: \"cat\" }]` joins one row per element of a LIST column already in the query; read it as `col(\"cat.<key>\")`.",
    "    - ⚠ A join does NOT put the joined table's columns on the returned row — with or without a `bind`, a row is the QUERIED table's columns, which is what `InferResponse` types. There is no `row.team_row`. To read a joined column, PROJECT it with an `eval` whose `name` is the dotted path: `eval: [{ name: \"team_row.name\", as: \"team_name\" }]` puts `team_name` on the row and on the inferred type. A bare `name` there is `Unsupported parameter reference` at runtime (it qualifies to the base table), and a dotted joined column in `output` is dropped with no error.",
    "  - `returnType` — `\"list\"` (default) | `\"single\"` | `\"count\"` | `\"exists\"` | `\"stream\"` | `\"aggregate\"`. Drives `context.return.type` AND the `InferResponse` shape: `count`→`number`, `exists`→`boolean`, `single`→`Row|null`, `stream`→ a cursor only `s.foreach` reads (returned, it serves `\"@stream\"`; warns `db.stream-returned`), `list`→`Row[]`/envelope, `aggregate`→rows keyed by the `aggregate.group`/`eval` aliases. ⚠ A bare `count` of ZERO has no reliable shape: it answers `0` or an EMPTY body (a client JSON parse error). Wrap it: `response: { count: ref(\"n\") }`.",
    "  - `eval: [{ name, as, filters? }]` — computed columns (`context.eval[]`). Each `as` grafts onto the row in `InferResponse` as `unknown`, or as the joined column for an unfiltered `<bind as>.<col>` (`| null` under `left`); shadowing a real column throws. ⚠ `output` is applied to the eval columns too: with a non-empty `output`, LIST the alias there (`output: [\"id\", \"<alias>\"]`) or the engine drops it from the result (`export()` warns `db.eval-unselected`; an ADDON alias survives an omitting `output`, an eval alias does not). Write `name` **bare** (`\"embedding\"`) — it is alias-qualified on emit exactly like `aggregate` (a bare eval name is `Unsupported param format` at runtime), and the statement declares the alias it used. An `as` alias is `sort`able in the SAME query. ⚠ An eval over a LIST column (`f.text({ array: true })`) is PER-ELEMENT (the engine unnests the column), so its `filters` must START with an AGGREGATE (`qf.count()` for the element count, `qf.to_list()`, …): a non-aggregate first filter like `qf.array_length()` 500s `Aggregate filter must be processed first` at request time, with no export warning.",
    "    - An `eval`/`sort`/`where` filter pipeline compiles to **SQL**: `trim`/`lower`/`concat` work there too, plus a DIFFERENT registry than `fl.*`: the vector family, geo `distance`/`within`/`covers`, `search_rank`, the timestamp family, the aggregators. Build these with **`qf.*`** — `filters: [qf.vector_cos_distance(inp(\"q\"))]` — which emits the same `{ name, arg }` step with the name, the argument COUNT and any enumerated argument checked at the call site. `qf` carries what the engine registers: the per-part extractors take a timezone (`qf.epochms_month(\"UTC\")`), `qf.round`'s precision is required, `qf.time`'s part is an enum. `QUERY_FILTER_NAMES`/`QUERY_AGGREGATE_NAMES` list the set; the raw `{ name, arg }` form still works for anything `qf` does not carry (`vector_distance`, which has no registered engine class).",
    "    - **Vector similarity search** — the ONLY way to query an `f.vector` column (no `SearchOp` does distance). `eval: [{ name: \"embedding\", as: \"distance\", filters: [qf.vector_cos_distance(inp(\"q\"))] }]` + `sort: [{ sortBy: \"distance\", dir: \"asc\" }]` ranks in the DATABASE over the column's index. Match the filter to the index `op` (`vector_cos_distance`↔`vector_cosine_ops`, `vector_l2_distance`↔`vector_l2_ops`, `vector_l1_distance`↔`vector_l1_ops`, `vector_inner_product`↔`vector_ip_ops`); `vector_cos_similarity` is the inverse, so sort it `desc`. The same filter on a `where` operand cuts off BY distance instead of by row count.",
    "    - **Full-text search** — query a `type: \"search\"` index by the `name` you gave it, spelled as a column `\"$<name>\"`: `where: cmp(col(\"$ft\"), \"search\", inp(\"q\"))`, rank with `eval: [{ name: \"$ft\", as: \"rank\", filters: [qf.search_rank(inp(\"q\"))] }]` + `sort: [{ sortBy: \"rank\", dir: \"desc\" }]` (the field `priority` weights the rank). ⚠ A `\"search\"` cmp on a PLAIN column (`col(\"title\")`, no `$`) 500s, and an UNNAMED search index can't be referenced at all (warns `table.search-index-unnamed`).",
    "  - `aggregate: { group?, eval?, sort?, paging? }` (with `returnType:\"aggregate\"`) builds `context.return.aggregate`. `group`/`eval` are `{ name, as, filters? }`, an aggregator like `sum`/`count` riding `filters`. Some aggregators resolve ONLY here, not in a runtime value pipeline: `count_distinct`, `median`, `to_list`/`to_distinct_list` (each with `_asc`/`_desc`), and `vector_distance`. ⚠ `avg` over a group whose values are ALL null returns `0`, not `null` (an unrated item reads as rated zero); a group with SOME nulls correctly averages only the non-nulls.",
    "    - ⚠ Write each `name` as a **bare** column (`\"status\"`). It is alias-qualified to `\"<alias>.status\"` on emit — the engine rejects an unqualified column in an aggregate with `Unsupported param format`. ⚠ A JOINED column cannot be named here (refused at build): project it with a query `eval` (`{ name: \"pr.name\", as: \"pname\" }`) and name that alias BARE (`group: [{ name: \"pname\", as: \"pname\" }]`).",
    "    - It qualifies with `tableAlias`, else the table's name, and the statement declares that alias (`context.dbo.as`) itself.",
    "  - `sort: [{ sortBy: <col>, dir?: \"asc\"|\"desc\"|\"rand\" }]` and `paging: { page?, per_page?, offset?, totals?, metadata?, search?, sort? }` ride `context.return.list`.",
    "    - ⚠ `paging` with a page/per_page/offset field and `metadata` on (the DEFAULT) wraps the result in an envelope `{ items: Row[], curPage, nextPage, prevPage, offset, perPage, itemsReceived }` — plus `itemsTotal`/`pageTotal` when `totals: true` — instead of a bare `Row[]`. `InferResponse` reflects it. `paging: { metadata: false }` keeps the bare array.",
    "    - \u26a0 Under the ENVELOPE, `output` selects from the envelope, not the row: write `output: [\"itemsReceived\", \"curPage\", \"items.id\", \"items.title\"]`. A bare column list matches no envelope key, so every key is dropped and the response is `[]` at HTTP 200 with no error (and `ref(\"<var>.items\")` then fails on a var that is gone). With `metadata: false` the statement binds the rows, so bare columns are the right form there. `export()` warns on a row-rooted selection under an envelope; `--strict` fails it.",
    "    - Read `nextPage` (`number|null`) as the typed has-next signal.",
    "    - **Input-bound paging:** `page`/`per_page`/`offset` also accept a `Value` (`inp(\"page\")`), riding `context.simpleExternal` while the static block stays the engine gate (`enabled:true`). `paging.search`/`sort` are `Value` dynamic overrides.",
    "    - A `search`/`sort`-only `paging` (no numeric field) does NOT paginate.",
    "  - `external: { value, permissions? }` — the whole paging config as one value (forces the gate on). It falls back to input-bound `paging` when it resolves empty, so supplying both is valid.",
    "  - `distinct` — `\"auto\"` (default) | `\"yes\"` | `\"no\"`, riding `context.return.<list|stream>.distinct`.",
    "- `s.db.truncate({ table, reset?, as? })` · `s.db.schema({ table, path, as? })`.",
    "- `s.db.direct_query({ sql, responseType?, args?, parser?, as? })` — `sql` is a **raw string** (not a `Value`); binds go in `args: Value[]`. `parser: \"template_engine\"` renders the body as a template first — how a query interpolates a column or table name a bound arg cannot carry; omit it for the default.",
    "  - Template placeholders are Twig over the request scope: `{{ $input.name }}` for an input, `{{ $var.name }}` for a stack variable. ⚠ A BARE `{{ name }}` renders as the empty string — HTTP 200, no error, a query that silently ran with a blank where the value belonged. A bound `?` arg carries a VALUE without the template at all.",
    "  - ⚠ A table's PHYSICAL name is **not stable across deploys**. A deploy is a full replace that recreates every table, so the id in its name changes on every deploy. Never store, cache, hardcode or fixture one: resolve it from `information_schema` inside the same request that uses it.",
    "- `s.db.external.<engine>.direct_query({ sql, connectionString, responseType?, args?, parser?, as? })` — same shape against an EXTERNAL database; `<engine>` is `postgres`/`mysql`/`mssql`/`oracle`/`snowflake`. `connectionString` is a `Value` — reach for `env(...)`, not a literal — stored as `context.connection_string_flex`. A bare string stores `context.connection_string` instead (an env-var name unless it looks like a URL); each form round-trips as itself.",
    "- `s.db.transaction({ body })` — run a `Statement[]` atomically. It returns nothing, so it takes no `as`: read what the body binds. An `s.return` in the body ends the WHOLE stack with that value, and the writes before it commit. ⚠ Atomic, not exclusive: a check-then-insert DOUBLE-BOOKS under concurrency (`lock: true` on the check locks only rows it returns). First lock a shared PARENT row: `s.db.get({ table: rooms, fieldValue: inp(\"room_id\"), lock: true, as: \"room\" })`.",
    "  - The body shares the enclosing stack: a variable it binds (`as: \"order\"` on an `s.db.add`) is still bound AFTER the transaction.",
    "- `s.db.bulk.add({ table, items, allowIdField?, as? })` / `s.db.bulk.update` / `s.db.bulk.patch` — `items` is an array `Value`.",
    "  - ⚠ `bulk.add` **drops `id` on every row unless `allowIdField: true`** (silently, next sequence value instead) — the opposite of `seed`, where `id` pins. Rows referenced by a foreign key need `allowIdField: true`; literal `items` carrying `id` without it throw. `bulk.update`/`patch` keep `id` (their match key). A unique violation rolls back the WHOLE batch: 500 \"SQL Error: 23505, UNIQUE VIOLATION\".",
    "  - ⚠ **`bulk.update` is a whole-row REPLACE: every column an item OMITS is zeroed** (`\"\"`/`0`/`null`), HTTP 200, no error — `{ id: 7, status: \"done\" }` blanks the rest of row 7. It also resets `created_at`. **Use `s.db.bulk.patch`** for the partial write \"update these rows\" means. `export()` warns on a STATIC `items` missing columns (`--strict` fails); a `ref`/`inp` `items` is uninspectable.",
    "- `s.db.bulk.delete({ table, where?, allRows?, as? })` — deletes rows by a `context.search` filter. `where` is the same surface as `s.db.query` (`expr(...)`/`cmp(...)`, `and(...)`/`or(...)` groups, an array of those ANDed) and encodes through the identical `{expression:[…]}` search shape. ⚠ A filter that constrains nothing (missing, empty, or `x OR and()`) deletes **every** row, so it **throws**: pass the filter, or `allRows: true` for a deliberate wipe (both together also throw). `allRows` emits the empty search the engine requires and returns the deleted count; reach for `s.db.truncate({ table, reset: true })` when the id sequence should restart too.",
    "- `s.db.increment({ table, where, fieldName, value, returnType?, output?, addon?, as? })` — adds `value` (a number or `Value`; negative decrements) to one `int`/`decimal` column on every row `where` matches, in ONE atomic locked UPDATE. **Use it for counters, stock, balances and tallies**: `db.get` → math → `db.edit` loses updates under concurrency, and so do `db.bulk.patch`/`update`. A guard in `where` (`expr(col(\"stock\"), \">=\", c.int(1))`) is re-checked under the row lock. To guard one column against ANOTHER of the same row (`used < max_uses`), set `tableAlias` on the statement and qualify the RIGHT operand with it (`expr(col(\"used\"), \"<\", col(\"cpn.max_uses\"))` with `tableAlias: \"cpn\"`) (a bare right-hand column throws at export). `returnType: \"count\"` binds the changed-row count instead of the rows, and then takes no `output`/`addon`.",
    "  - ⚠ A `where` that constrains nothing (missing, empty, or `x OR and()`) changes NO rows and **throws**. A null stored value counts as 0. A fractional `value` on an `int` column, a non-numeric or list column, the `id` key, and a result that overflows the column are rejected with no rows changed.",
    "",
  ];

  const stmtRuntime: string[] = [
    "Runtime behavior (what the `as:` output holds, and misses):",
    "",
    "- `db.get` binds **`null`** when no row matches (it does NOT throw); null-check it. On a hit it binds the **full row**. (`db.has` is the boolean existence test.)",
    "- `db.edit` binds the **full, post-mutation row**. `db.add` binds the **full inserted row**, including the auto-assigned `id` and `created_at`. `db.del` **binds `null`**, not the deleted row.",
    "- Unlike `db.get`, `db.edit` and `db.del` **throw** `NotFound` (HTTP 404) when no row matches the field. `db.add` throws on a unique-constraint violation: HTTP 500 `ERROR_FATAL` \"Duplicate record detected…\", earlier writes kept. No error type is 409.",
    "- `s.try_catch` catches it — and `s.precondition`/`guard.*` failures, answering 200 (`caught(\"code\")`: `ERROR_CODE_NOT_FOUND`, …) — so re-raise with an `s.precondition` in `catch` to keep a status.",
    "- No partial unique index: NULLs never collide, so null the key (or delete the row) to free it. ⚠ A unique-index column that may be ABSENT must be `nullable: true` — a NON-nullable column stores an omitted/null cell as its zero value (`\"\"`/`0`), which is NOT null and DOES collide, so only ONE row can omit it (the second 500s `Duplicate record detected`). An \"optional composite key\" needs the columns `nullable: true`.",
    "- **`InferResponse<typeof query>`** derives an endpoint's response type. It resolves object-literal responses to those keys; a `response: ref(\"x\")` returning a variable bound by a TOP-LEVEL db op on a `table()` resolves to that op's result:",
    "  | statement | resolves to | on a miss |",
    "  |---|---|---|",
    "  | `db.add` / `db.edit` / `db.patch` / `db.add_or_edit` | `Row` (the full written row, non-nullable) | throws — `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`; `add_or_edit` upserts and never misses |",
    "  | `db.get` | `Row \\| null` | binds `null` rather than throwing |",
    "  | `db.query` / `db.bulk.patch` | `Row[]` | — |",
    "  | `db.has` | `boolean` | — |",
    "  | `db.bulk.delete` | `number` (count) | — |",
    "  | `db.increment` | `Row[]` (updated rows), or `number` with `returnType: \"count\"` | `[]` / `0` |",
    "  | `db.del`, `db.bulk.add`/`bulk.update`, raw `direct_query` | `unknown` (untyped; `bulk.add` binds the new ids, `bulk.update` the rows) | — |",
    "  - A `get`/`query` `output: [...]` selection narrows to a `Pick` (still `| null` for `get`). A dotted `ref(\"row.col\")` into a `db.get` row types `Col` (a miss 500s); `ref(path, { safe: true })` types `Col | null`.",
    "  - A value reshaped by a lambda, or a variable built by control flow, also resolves to `unknown`.",
    "  - A CALL binds the TARGET's response type: `s.function.call`/`s.function.run`/`s.api.call`/`s.tool.call` given a def HANDLE brand their `as` with `InferResponse` of the target, so `ref(\"out.field\")` types to that field. What the target resolves to is what propagates — declare `responseShape` on the TARGET to fix every caller at once. A target named by STRING has no def to read and stays `unknown`; an async `s.function.run` binds its job id (`string`), not the result.",
    "  - In an object-literal response the KEYS are always known; a `c.*` constant VALUE types like an `s.set_var` of it (`{ success: c.bool(true) }` → `{ success: boolean }`).",
    "  - A NESTED member resolves to any depth, in either spelling — `{ user: obj({ id: ref(\"row.id\") }) }` and the raw literal `{ user: { id: ref(\"row.id\") } }` both derive `{ user: { id: Col } }`. A raw scalar NESTED member types itself (`{ stats: { count: 3 } }` → `{ stats: { count: number } }`), but a TOP-LEVEL member must be a `Value` — a bare scalar there (`{ count: 3 }`) is a type error and `query()` throws at load, so write `{ count: c.int(3) }`.",
    "  - Runs on every response-bearing kind — `query`, `defineFunction`, `realtimeMessage`, `tool`, `middleware`, and the response-bearing triggers — each of which also accepts `responseShape`. A trigger builds its stack and response through CALLBACKS (`stack: (t) => [...]`), and the trace follows through them.",
    "  - The FIRST move for any `unknown`: declare `responseShape` on the def (`responseShape: null as InferRow<typeof t> | null`) — available on EVERY kind listed above, `query` included; the declaration ALWAYS overrides derivation. The shapes that never derive, and the one line that closes each: rows built in `s.lambda` (JS is opaque to the walk) → `responseShape: [] as Row[]`; a var bound ONLY inside branches → `responseShape` (a branch/case/loop/`try`/`catch` re-binding unions in; one in EVERY branch replaces); a call whose target is named by STRING → give the TARGET a `responseShape` (a handle then carries it) or declare it here.",
    "  - An `s.set_var` holding a `c.*` CONSTANT brands its binding with that constant's JS type, so `ref(\"n\")` after `s.set_var(\"n\", c.int(1))` resolves to `number` (widened: `c.bool(false)` → `boolean`; `s.update_var` re-binds). A filter chain — the value's own or `asFilters` — then retypes it (`[fl.to_int()]` → `number`). A bare `ref`/`inp` stays `unknown`.",
    "  - ⚠ A var bound ONLY inside a branch body — an `s.conditional` `then`/`else`/`elif`, an `s.switch` case, a loop body (`s.for`/`s.foreach`) that ran zero times, or an `s.try_catch` `try` — does NOT exist when that path is skipped, so a later `ref` to it 500s `Missing var entry: <name>` (NOT null). `{ safe: true }` does NOT suppress it (it has no effect on a bare, dot-free name), and export warns `stack.var-conditionally-bound`. Declare the var on the ENCLOSING path first: `s.set_var(\"x\", c.null())` before the block.",
    "  - ⚠ A hand-written `s.precondition` does not narrow the STATIC type. One (or a conditional) proving a `db.get` row non-null leaves `InferResponse` at `Row | null`. `guard.found(\"row\")` DOES narrow: it emits the same non-null check (404) and drops `| null` from `row` — whole, dotted, and addon grafts alike — after it. `guard.owner` narrows the same way. Reach for `responseShape` only when neither fits.",
    "  - ⚠ `InferResponse` reads the `response` field ALONE — an `s.return(value)` ANYWHERE in the stack (an early cache hit, an idempotent replay, a `respond.status(409)` + `s.return` fast path) is INVISIBLE to it, including ones nested in `s.conditional`/`switch`/`foreach`/`try`. So the type covers only the fall-through `response`, and a typed client misses every early body. Declare `responseShape` as the UNION of every body the endpoint can serve: `responseShape: null as { value: number } | { cached: boolean }` (without one, export warns `response.return-outside-type`).",
    "  - ⚠ A `resultStrategy: \"replace\"` middleware attached `post` reshapes the endpoint's output at runtime, which the static walk cannot see. Declare `responseShape` when a post middleware rewrites the response. A `merge` one makes a LIST response an index-keyed object; its keys are not inferred.",
    "  - ⚠ **Spreading a `Statement[]` helper into a stack kills the whole walk.** `...myHelper()` where the helper returns `Statement[]` widens the stack's TUPLE type, and EVERY `as` in that stack — including ones declared after the spread — stops resolving. The response then types as `StackTupleWidened`. Fix: return `statements(s.a(...), s.b(...))` from the helper (preserves the tuple). A helper that builds its array in a LOOP cannot be a tuple; declare `responseShape` there.",
    "- **Addons** enrich returned rows. `db.query`/`get`/`add`/`edit`/`patch` accept `addon: [{ addon, as, input?, output?, children? }]`; `db.add_or_edit`/`del`/`has`/`truncate` take no `addon`.",
    "  - `addon` is the target (name or def handle). `as` is the destination on the row — a bare alias (`\"_user\"`) or a dotted `offset.alias`, authored relative to a row. Under a metadata paging envelope the `items[]` offset is prefixed automatically; writing it yourself is tolerated and not double-prefixed.",
    "  - `envelope: true` grafts once onto a paged query's envelope instead of each row.",
    "  - `input` maps addon inputs — bind a parent-row column with `out(col)`. `output` restricts addon columns. `children` nests addons onto each graft element (typed).",
    "  - The DEFINITION side — the `addon({...})` factory and `registerAddons` — is a def shape in `llms/kinds-core.md`.",
    "  - Attaching a typed `addon({ table, output })` handle merges its alias (the last `as` segment) onto the row in `InferResponse`: an OPTIONAL `{cols}` for `single` (absent, not null, on no match), `{cols}[]` for `list`, `number` for `count`, `boolean` for `exists`, and for `aggregate` an array keyed by the `group`/`eval` aliases — ONE optional object when `eval` has no `group` (`unknown` values; `unknown` when neither is declared).",
    "  - An attachment-level `output` narrows an object/array graft further. A bare-NAME reference grafts `unknown` — narrow it at the call site.",
    "  - ⚠ An alias that shadows an existing column on the queried table throws at build time; rename with a `_` prefix.",
    "- **Middleware attachment** runs a reusable `middleware({...})` before/after a host's own stack. Distinct from `s.middleware.call` (inline invoke).",
    "  - Attach with the host's `middleware: { pre, post }` field on `query`/`function`/`task`/`tool`/`apiGroup` (NOT triggers): each phase is an ordered list of middleware refs (def handle or name), or `{ middleware, active: false }` to keep an entry disabled.",
    "  - Providing a phase **overrides** it (sets the stored `pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain — the engine resolves Query → API Group → Workspace at request time (override, not merge; the API-Group tier applies to queries — functions/tasks/tools have no API-group binding and inherit straight from the workspace).",
    "  - Prefer a def handle over a bare name when the middleware pins an explicit `guid`.",
    "  - `exceptionPolicy` governs what a **throw** in the middleware stack does to the request. `\"rethrow\"` is the **default** — the throw aborts the request and surfaces the authored `error`/status (a tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs. `\"silent\"` swallows the throw, so a guard set to it is **not enforced** — advisory middleware only. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain.",
    "  - `pre: middleware.clear()` (an empty list) overrides with nothing — stop inheriting.",
    "  - Workspace-level defaults are the terminal tier: `workspaceConfig({ middleware: { query: { pre }, function, task, tool } })` emits the flat `{host}_{phase}` map (no `_customize` flags) — setting it replaces the whole workspace map, so unlisted hosts are cleared; omit the field to leave existing workspace middleware untouched.",
    "- **Middleware request context.** A `pre` middleware runs **after** auth resolution, so `auth()` is available inside the middleware when the host is authenticated (its `auth` names an auth table); on a public host there is no caller identity for it to resolve.",
    "  - A rate limit keyed by `auth(\"id\")` is per-user on an authenticated endpoint; on a public endpoint `auth()` cannot resolve, so the request FAILS with a 403 on the first call, under `max`, with the host never running.",
    "  - `export()` **warns** (never blocks) when a middleware whose stack references `auth()` reaches a host where `auth()` may be null — a `query` with no auth table, a `task` (scheduled, never authenticated), or a `function`/`tool` (whose auth is caller-dependent). An authenticated query (its own `auth` table set) is skipped.",
    "  - Inherited attachment (API group, workspace tier) warns too.",
    "- **Rate-limit recipe (the canonical middleware).** Author it with `s.redis.ratelimit` and a **composite key** built via the filter chain — `\"prefix\" + auth(\"id\")` does not exist, you build the key: `middleware({ name: \"write_rl\", exceptionPolicy: \"rethrow\", stack: [ s.redis.ratelimit({ key: withFilters(c.text(\"rl:write:\"), fl.concat(auth(\"id\"))), max: c.int(10), ttl: c.int(30), error: c.text(\"Too fast.\") }) ] })`.",
    "  - The default `exceptionPolicy: \"rethrow\"` aborts a tripped limit with HTTP 429; `\"silent\"` lets the over-limit request through. Without `error` it never aborts — the request always runs on (`export()` warns) — but the bound value is NOT constant `false`: it binds `true` while the caller is under `max` and `false` once over (branch on it with that polarity).",
    "  - Attach it with `middleware: { pre: [writeRl] }` on an **authenticated** host; on a public host key off `sys.remoteIp()`.",
    "  - **Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same* key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the key (fold in the host/action name) for an independent limit per host.",
    "- **Redis (`s.redis.*`) semantics.** ⚠ `set` REFUSES a null or `\"\"` `data` with HTTP 400 `Missing param: data`, so you cannot negative-cache an empty/absent result — store a sentinel (`c.text(\"__none__\")`) instead. A stored `false` reads back from `get` as `false`, INDISTINGUISHABLE from a miss — use `has` to tell them apart. `ttl: 0` means FOREVER (no expiry); a NEGATIVE `ttl` is a 500 `Unable to store data in cache`. `incr`/`decr` on a missing key start at 0 and bind the new value (a negative `by` works). List ops: `push`/`unshift` bind the new LENGTH; `pop`/`shift` bind one element, or a list with `count` (last-first, `pop count 2` → `[5,4]`); on an empty or missing key they bind `false` (not null); `count` on a missing key is `0`, `range` is `[]` (and `range` with no start/stop is the whole list); `remove` with no `count` drops EVERY occurrence, with `count` it binds the number removed. `keys({ search })` is a GLOB binding the full key names. Objects and lists round-trip through `set`/`get` and the list ops.",
    "- **File resources** — the value the `s.storage.*` and `s.zip.*` statements pass BETWEEN each other. A file resource is a short-lived (~24 h) TOKEN, not storage. PRODUCED by `inp(\"file\")` (an `input.file`), `s.storage.create_file_resource`, `s.zip.create_archive`, and an extract entry's `.resource`. CONSUMED by `s.storage.read_file_resource`, the `s.storage.create_*` statements, and `s.zip.add_to_archive`/`view_contents`/`extract`. ⚠ A STORED file is NOT one: a `f.attachment()` cell / a `create_attachment` result / a cell's `url` passed to `read_file_resource` or `s.zip.*` 500s `Invalid file resource` — a stored file's bytes are not readable back through these. ⚠ `s.zip.extract` binds `[{ name, size, last_modified, resource }]`; pass the entry's `.resource` (`ref(\"extracted.0.resource\")`) to `read_file_resource`, NOT the entry itself (500). ⚠ In a RESPONSE a file resource serializes as an opaque token STRING, not an object, and it EXPIRES — persisting one in a table/redis looks fine and breaks later. `read_file_resource` binds `{ name, size, mime, data }` where `data` is RAW bytes — `fl.base64_encode()` it in the stack before a JSON response (which mangles raw binary). `create_file_resource` refuses a `/` in `filename` (400 `Invalid characters detected.`), though a `zip.add_to_archive` ENTRY name accepts `dir/b.txt`.",
    "- **Zip archives (`s.zip.*`)** — build then PERSIST. `s.zip.create_archive({ filename, password?, password_encryption?, as: \"zip\" })` binds an archive handle; `s.zip.add_to_archive`/`delete_from_archive` bind NOTHING and MUTATE the var passed as `zip` IN PLACE (loop over files, `create_file_resource` each, then `add_to_archive({ file: ref(\"res\"), filename, zip: ref(\"zip\") })`). ⚠ `view_contents`/`extract` on an archive with NO entries 500s (`Invalid or uninitialized Zip object` / `Fatal Error`) — guard a possibly-empty export with a count check. `view_contents` binds `[{ name, size, last_modified }]`, `extract` `[{ name, size, last_modified, resource }]` (the `.resource` is a file resource; see **File resources**). PERSIST the archive with `s.storage.create_attachment({ value: ref(\"zip\") })` (a bare file resource in a response expires). `password` with no `password_encryption` writes standard ZipCrypto; `AES-256` writes method 99, which macOS `unzip` cannot read; the password is per-entry and checked on extract. `delete_from_archive` of a name not in the archive is a silent no-op. ⚠ `create_archive` needs a PAID (non-free) instance. (Uploaded archives must arrive as Content-Type `application/zip` — see `llms/errors.md`.)",
    "- **`s.math.*` MUTATES a variable in place** — `s.math.add`/`sub`/`mul`/`div`/`mod`/`bitwise.*` take `{ name, value }` and REWRITE the existing var `name` (declare it with `s.set_var` first; an undeclared `name` 500s `Missing var entry`). There is NO `as` — the catalog's `[output]` on `add`/`bitwise.*` is an engine artifact, the result is the mutated var. Numeric TEXT coerces (`\"5\" + 3` → `8`) and a null var acts as `0`; a non-numeric operand (`true`, `\"abc\"`, a list) 500s `Numbers are required for mathematical operations`. `div` of int/int yields a DECIMAL unless it divides exactly (`7/2` → `3.5`, `6/3` → `2`); `div`/`mod` by `0` is a catchable `ERROR_FATAL` (`Division by zero`/`Modulo by zero`). Integer overflow past signed-64-bit SILENTLY becomes a float (`9223372036854775807 + 1` → `9.22e18`), losing exactness; `bitwise.*` truncate a decimal operand and use two's complement on negatives. Same rules on the `fl.*` equivalents.",
    "- **`s.math.mod` / `fl.mod` is INTEGER modulo** — unlike its siblings `add`/`sub`/`mul`/`div`, which handle decimals exactly, `mod` TRUNCATES both operands toward zero before the remainder, so a decimal modulo returns WRONG data at HTTP 200: `c.decimal(5.5) mod c.decimal(2.5)` → `1` (the true remainder is `0.5`), and the sign follows the dividend (`-7 mod 3 = -1`). A divisor with `|x| < 1` truncates to 0 and 500s `Modulo by zero`. `c.expression(\"5.5 % 2.5\")` and `withFilters(…, fl.mod(2.5))` do the same (engine-wide PHP `%`). For a REAL decimal remainder compute `a - b*floor(a/b)` with the decimal `div`/`mul`/`sub`, or a lambda.",
    "- **Math failure modes** (`fl.*` aggregates and arithmetic, same engine as `s.math.*`). ⚠ On an EMPTY list the aggregates DISAGREE: `fl.sum` → `0`, `fl.product` → `1`, `fl.min`/`fl.max` → `null`, but `fl.avg` 500s `Infinite value` (an `avg` over a filtered list that comes back empty fails the whole request) — guard it with `fl.count()` or a conditional. `fl.ln(0)` raises a catchable `ERROR_FATAL` `Infinite value`. ⚠ A NaN or ±INF result does NOT raise: `fl.sqrt`/`fl.ln`/`fl.log`/`fl.log10` of a NEGATIVE, `fl.pow` of a negative base to a fractional power or past the float range, `fl.acos`/`fl.asin` outside [-1, 1], `fl.acosh` below 1, `fl.atanh` at or beyond ±1. A response carrying one serializes to nothing and answers HTTP 200 with an EMPTY body (a JSON client throws on parse, far from the cause), so guard the operand's domain with an `s.conditional` BEFORE the filter. `fl.number_format` on a text value 500s.",
    "- **Date filter failure modes** — the request-time date filters fail QUIETLY on null/empty/unparseable input. A NULL or omitted timestamp reads as epoch 0, so `fl.epochms_date` formats it as `1970-01-01 …` and `fl.epochms_transform` shifts from 1970 — GUARD a nullable timestamp (`s.conditional` on `= null`) before formatting. `fl.epochms_from_format` returns `\"\"` on a parse MISS (treat `\"\"` as failure) and a numeric STRING (not an int) on a hit. `fl.to_epochms` binds `0` for `\"\"` but 400s `Invalid timestamp format.` on non-empty garbage (the one that fails the request, not silently). `fl.epochms_transform` quirks: `llms/filters.md`.",
    "",
    "- **Request history** controls per-object execution capture (the request/task/trigger debugger). Authored as a single scalar `history` field on any primitive: `false` off, `true` on at the default capture depth, a number = capture depth (how many statement executions are recorded per history record — NOT record retention), `\"all\"` unlimited.",
    "  - **Omit `history` to inherit** — the engine resolves object → container → workspace at request time (a query inherits from its API group, a tool from its toolset envelope, everything else straight from the workspace). Any authored value stops inheriting for that object.",
    "  - Per-kind defaults (when inheriting): query/task/tool capture ON, function/trigger/middleware OFF; default depth 100.",
    "  - Container tiers are authorable too — `apiGroup({ history })` sets the `query_*` default its queries inherit, and an agent/mcp_server/toolset `history` sets the `tool_*` default its tools inherit.",
    "  - Workspace-level defaults are the terminal tier: `workspaceConfig({ history: { query, function, task, tool, trigger, middleware } })` emits the flat `{objType}_enabled`/`{objType}_limit` map (no inherit flag) — setting it is wholesale (unlisted types fall back to their engine default), so declare every default you want to keep; omit the field to leave existing workspace history untouched.",
    "",
    "- **Workspace environment variables** set a tenant's env vars through the workspace object: `workspaceConfig({ env: { STRIPE_KEY: \"\", APP_BASE_URL: \"\" } })`, passed to `registerWorkspace()` — unattached, it declares nothing. Author them as a name→value MAP, declaring each NAME with an EMPTY value. Read a var back with `env(\"NAME\")` (→ `$env.NAME`), which compiles to tag \"setting\" with the plain name.",
    "  - Values are SECRETS and do NOT belong here: they live in `xano/.env`, which is gitignored and survives a `npx @xano/sdk pull`, and every command that compiles a bundle reads it with no flag. Fill it by hand from `xano/.env.example`, or run `npx @xano/sdk env pull`. CI passes `--backend-env-file <path>` or `--env-var KEY=VALUE` instead. A compiled bundle carries the values in cleartext — don't commit one.",
    "  - What a deploy sends is the RESOLVED map (the declared names, then ONE file — `xano/.env`, or `--backend-env-file <path>` which REPLACES it, never both — then `--env-var`), not the literal object written here. `deploy` REPLACES the tenant's env with it, so a declared name with no value anywhere REFUSES the deploy rather than clearing the live value — fill the name in rather than putting the value back in source, and reach for `--allow-empty-env=NAME` only when clearing is what you mean.",
    "  - A merge (`deploy --to`) is ADD-ONLY for env, matched BY NAME — it creates names the target lacks but does NOT update or remove ones it has, so the target's value wins. A release carries no env values, so a NEW name reads null after `promote`/`tenant deploy` until `env set` (both name it first). A `--replace` deploy DROPS every env var the target holds that the config does not declare (named, and confirmed, before it runs). Omit `env` entirely to leave existing env untouched. The separate `settings` field is a plain object.",
    "",
    "- **Workspace documentation** gates the workspace's hosted docs: `workspaceConfig({ documentation: { require_token: true } })`. `require_token: true` IS the declaration that a token exists; the value lives in `xano/.secrets.json`, keyed by the object it gates rather than by a name, and a literal `token` FAILS the export. It is NOT a backend env var — `env()` cannot read it. Other members are carried verbatim.",
    "  - ⚠ OMIT the block and NO `documentation` key is emitted, leaving the target's live block as it is; the `realtime` block follows the same rule. An `apiGroup`'s `documentation` follows the OPPOSITE rule — see its def shape.",
    "  - A declared gate with no token emits no block at all and REFUSES a `deploy`; `--allow-empty-doc-token=<scope>` clears that gate deliberately (scope = `workspace`, or an API group's NAME). `npx @xano/sdk pull` writes `xano/.secrets.json`, and `--no-secrets` writes none.",
    "",
  ];

  // Lock-lifecycle detail relocated from the router's Quickstart and Deploy
  // sections: the universal rule (opt in early, commit, rename via the printed
  // fix-up) stays always-loaded, and the fix-up mechanics an agent only needs
  // mid-rename/prune/import live here.
  const lock: string[] = [
    "## Lock file",
    "",
    "`xano.lock` pins each object's guid and each api-group/toolset canonical, so renames",
    "stay renames (guids otherwise derive from `(type, name)`; a query's from `(api group,",
    "verb, name)`). Committed. A composed entry is keyed by that identity —",
    "`query:<group>|<verb>|<name>`, `channel:<server>|<path>`, `message:<server>|<path>|<name>`",
    "— its guid's seed; a bare `query:<name>` key is rewritten to the composed form by the next locked export.",
    "",
    "- `npx @xano/sdk lock rename <kind> <old> <new>` — `kind` is the SDK kind (`table`, `apiGroup`) or stored key (`dbo`).",
    "  Run it when `export` names it after a rename in code (it prints the command); the next export emits the original guid under the new name.",
    "  Reads the `index.ts` beside the lock (or `--entry`); refused while `<old>` is still exported. Composed names go in full; renaming a parent moves them.",
    "- `npx @xano/sdk lock prune <entry-file> [keys…] --yes` — drops orphaned entries. Finding orphans",
    "  RUNS the entry's module scope (env assertions included); `--identity-only --yes <key>…`",
    "  prunes named keys (`table:users`) with no evaluation and no orphan check.",
    "- `npx @xano/sdk lock import <live-bundle.json> [--yes]` — seed the lock from a `workspace export`",
    "  to take over an existing workspace (a compiled bundle is refused).",
    "- Every lock subcommand accepts `--lock=<path>`; from outside the lock's directory pass it.",
    "- Merge conflict: keep both sides; two keys on one guid → `lock rename` onto the kept",
    "  name, or `lock prune --identity-only --yes` the other.",
    "- Programmatic use: call `seedLockOverrides(readLockFile(path))` BEFORE importing any def",
    "  module — references bake guids at import time; `writeBundle` refuses an unseeded lock.",
    "",
    "### Writers and readers",
    "",
    "- `export`/`deploy`/`release`/`preflight` of an ENTRY FILE update the lock; `compile`/`routes` only READ.",
    "- `--no-lock` builds without one (names derive guids, the instance invents public URLs, no `--prune`);",
    "  REFUSED over a parseable lock.",
    "- A DEPLOY or a RELEASE writes back only `landed`: what this project LANDED on each destination",
    "  (ephemerals: `.xano/ephemeral.json`). `--prune` deletes only that, never a merely exported name;",
    "  no record there, no prune until one landing. Commit the lock.",
    "- A `deploy` (`--replace` too) PRESERVES the archive's guids, so the lock still describes the rebuilt workspace.",
    "",
    "### CI",
    "",
    "- `--frozen-lock` fails (`SDK_DRIFT`) instead of changing the lock, and fails while the lock carries",
    "  an entry no exported object matches. A plain `export` only warns and writes that entry down, after",
    "  which a rename and a deletion look the same. Resolve it with `lock rename` or `lock prune`, or",
    "  accept them with `--allow-lock-orphans` when they are the not-yet-ported half of an adopted workspace.",
    "- `export --check` implies `--frozen-lock` and writes nothing — no bundle, no lock — so it",
    "  reads no `xano/.env` or `.secrets.json` and refuses the flags that supply them. `npm run xano:check` runs it,",
    "  so CI needs no secrets.",
    "- With no lock at all, either flag fails only when the source has identities to record (an empty workspace passes).",
    "",
  ];

  const stmtCalls: string[] = [
    "Auth & calls:",
    "",
    "- `s.security.create_auth_token({ table, id, extras?, expiration?, as? })` — `extras` defaults to `{}`, `expiration` (seconds, a `Value`: `c.int(3600)`) to 86400 (`c.int(0)` = never). ⚠ Feeding `expiration` from an OPTIONAL int input mints a NEVER-expiring token when the client omits it: an omitted optional int binds `0`, and `0` means never — so `expiration: inp(\"ttl\")` with an optional `ttl` silently issues permanent credentials. Declare `input.int({ default: 86400 })`, or leave `expiration` out in an `s.conditional` else branch when the input is null.",
    "- **Marketplace first:** `@xano-sdk/auth` registers a complete auth surface — signup/login/me endpoints plus their `user`/`account`/`event_log` tables — via `registerAuth(ws, { canonical: \"authn\" })`. Authentication only, not authorization. Inspect with `npx @xano/sdk marketplace details @xano-sdk/auth --prompt`.",
    "- **The auth loop end to end** — what that module implements; author it directly for a custom flow. An auth TABLE (`table({ auth: true })`) backs identity; a PUBLIC login query verifies and mints a token; every protected query names that table as `auth:` and reads the caller with `auth(...)`.",
    "  - Signup: `s.db.add({ table: users, row: { email: inp(\"email\"), password: inp(\"password\") } })` — the `f.password()` column hashes on write; take the submission as `input.text()` on signup AND login (a password input double-hashes; `llms.txt` Gotchas).",
    "  - Login: `s.db.get({ table: users, fieldName: \"email\", fieldValue: inp(\"email\"), output: [\"id\", \"password\"], as: \"u\" })` — the `output` naming `password` is REQUIRED (the column is `access: \"internal\"` and absent from the row otherwise) → `s.precondition({ expr: expr(ref(\"u\", { safe: true }), \"!=\", c.null()), error: c.text(\"Invalid email or password.\"), error_type: \"unauthorized\" })` → `s.security.check_password({ text_password: inp(\"password\"), hash_password: ref(\"u.password\"), as: \"ok\" })` → precondition on `ok`, same error → `s.security.create_auth_token({ table: users, id: ref(\"u.id\"), as: \"token\" })` → `response: { token: ref(\"token\") }`. ⚠ One error for both: a 404/401 split enumerates accounts.",
    "  - Client: send it as an `Authorization: Bearer <token>` header. A `query({ auth: users })` refuses a request without a valid one before its stack runs; inside the stack `auth(\"id\")` is the caller's row id (`response: { id: auth(\"id\") }` is the whole `me` endpoint). ⚠ The gate is STATELESS: it checks only the token's SIGNATURE and EXPIRY, never that the row still exists. A DELETED or disabled user's token keeps passing every `auth:` query until it expires (24 h by default), and `create_auth_token` mints for ANY id, so `auth(\"id\")` can name a row that is gone — reads and ownership writes then serve or create rows for a ghost user. There is NO revocation; a short `expiration` is the only lever. Where it matters, verify the row exists: `s.db.get({ table: users, fieldValue: auth(\"id\"), as: \"__actor\" })` → `guard.found(\"__actor\", { errorType: \"unauthorized\" })` (`guard.role` already does this, answering 401 `Not signed in.`).",
    "  - Claims: a token minted with `extras` is read back as `auth(\"extras.<key>\")` (`auth(\"extras\")` is the whole map). ⚠ A key ABSENT from the token (an older token, or one minted without it) is a 500 `Unable to locate auth: extras.<key>`, not null — mint the same keys every time. And claims are a SNAPSHOT frozen at mint: a role change does not reach existing tokens, so authorize off the row (`guard.role`) when the value can change, not off a claim.",
    "- **Authorization, on top of that.** `guard.role(users, \"admin\")` and `guard.owner(\"note\", \"user_id\")` each return a fixed-arity TUPLE of statements — spread them (`stack: [...guard.role(users, \"admin\"), …]`).",
    "  - `guard.role(table, role | roles[], { field?, as?, errorType?, message?, missingErrorType?, missingMessage? })` — fetches the caller's own row by `auth(\"id\")` into `__actor`, asserts it EXISTS (401), then asserts its `role` is in the set (403). Roles type from the enum column; an unknown role or `field` throws. The existence step matters: a role check on a null actor row is not reliably false.",
    "  - `guard.owner(rowVar, ownerField = \"user_id\", { … })` — asserts the row bound to `rowVar` is non-null (404), THEN compares its owner column to `auth(\"id\")` (also 404). Drilling before the existence check is a 500, not a denial: `db.get` binds `null` on a miss and `ref(\"note.user_id\")` against it raises `Unable to locate var`. Takes the var NAME and the column separately; a dotted path is refused.",
    "  - `guard.found(rowVar, { errorType?, message? })` — ONE statement: asserts the row bound to `rowVar` is non-null (404, `\"Not found.\"`), and NARROWS it — after it, `InferResponse` drops the `| null` from `rowVar`. `guard.owner`'s existence step is this statement.",
    "  - `guard.require(condition, { errorType?, message? })` for anything else — same shape, and it defaults to 403 where a bare `s.precondition` defaults to `standard`, i.e. **500**.",
    "- `s.security.create_uuid({ as? })` — bind a fresh UUID (v4). Takes nothing else. There is NO `create_guid` (internal, unpushable).",
    "- **Receiving a webhook** — no `auth`, no declared `input` (the signature covers the raw bytes): `s.util.get_raw_input({ encoding: \"none\", as: \"raw\" })` → `s.set_var(\"mac\", withFilters(ref(\"raw\"), fl.hmac_sha256(env(\"WH_SECRET\"))))` → `s.set_var(\"sig\", withFilters(sys.httpHeaders(), fl.get(\"X-Signature\")))` (Title-Cased) → an `s.precondition` (`error_type: \"unauthorized\"`) comparing the two TIMING-SAFELY by HMACing both again — `expr(withFilters(ref(\"sig\"), fl.hmac_sha256(env(\"WH_SECRET\"))), \"=\", withFilters(ref(\"mac\"), fl.hmac_sha256(env(\"WH_SECRET\"))))` — BEFORE `fl.json_decode()` reads `raw`. Claim the event id with `s.redis.set({ …, create_only: c.bool(true) })` and answer 200 to a replay.",
    "- **Verifying a token (JWS/JWE)** — ⚠ `s.security.jws_decode`/`jwe_decode`/`decrypt`/`check_password` THROW a 500 `ERROR_FATAL` on EVERY failure (a tampered/garbage/empty/wrong-key token, a wrong `signature_algorithm`, an expired token `The token expired.`, a failed `check_claims` `Invalid value for claim: <k>`, a bad `decrypt` key/iv, a non-hash to `check_password`), NOT a falsy result — so a bare decode answers 500 for every bad token where 401 is wanted. Wrap it: `s.try_catch({ try: [s.security.jws_decode({ token: inp(\"token\"), key: env(\"JWT_SECRET\"), signature_algorithm: \"HS256\", check_claims: obj({ role: c.text(\"admin\") }), as: \"claims\" })], catch: [s.precondition({ expr: expr(c.bool(true), \"=\", c.bool(false)), error_type: \"unauthorized\", error: c.text(\"Invalid token.\") })] })` — a good token binds `claims` and runs on; any failure lands in `catch`, which raises a clean 401. `check_claims` is an object of EXACT-match claims; `exp`/`nbf` are checked automatically.",
    "- **`s.security.*` defaults are WEAK — pass them explicitly** (the catalog prints none; these are the engine's). `encrypt`/`decrypt` default `algorithm` to `aes-128-cbc`, so a 32-byte key is CUT to 16 (AES-128, not -256) — pass `algorithm: \"aes-256-cbc\"`. AES keys are NOT length-checked (a short key is zero-padded and still encrypts at 200), and a non-string `data` 500s — `fl.json_encode` an object first. `jws_encode`/`jwe_encode` default `ttl: 0`, which mints a token with NO `exp` claim (it NEVER expires) — set a `ttl` in seconds. `create_rsa_key` defaults `bits: 1024`, below the 2048 minimum — pass `bits: 2048`+. `random_bytes` defaults `length: 1`; `random_number` bounds are INCLUSIVE and `min > max` 500s; `create_password` with a `character_count` below the required classes 500s.",
    "- `s.function.run({ fn, input?, as?, runtime? })` / `s.function.call({ fn, input?, as? })` — run another function.",
    "  - **Inputs:** `input` is keyed by the target's input names (an undeclared one is a type and export error, a mistyped `c.*` constant a type error; generic over `fn`, pass `Record<string, Value>`; `2` binds an int — `c.decimal(2)` for a decimal).",
    "  - ⚠ **The two DIFFER ON FAILURE.** `s.function.run` RAISES — a `precondition`/500 in the target propagates, so the caller fails with that status, and an uncaught `s.throw` in it answers with its `status` (200 without one). `s.function.call` does NOT raise OUTSIDE a workflow test: it BINDS the error envelope `{ code, message, payload }` to `as` (still typed as the SUCCESS shape, so the mismatch is silent) and the stack answers 200 carrying it. Use `s.function.run` whenever a failing target must stop the caller; reach for `s.function.call` only to INSPECT a possible failure (branch on `ref(\"r.code\")` before trusting the result). INSIDE a workflow test `s.function.call` DOES raise, like `s.api.call`/`s.task.call`.",
    "  - ⚠ **Omitted inputs:** `s.function.run` binds an input it OMITS from the CALLING def's same-named declared input — an endpoint declaring `discount` hands `?discount=100` through, or `0` when the client sends none. An endpoint/tool/prompt declaring NO inputs binds it from the raw request. `ignored()` always takes the target's default. Pass inputs explicitly (`statement.omitted-input` warns).",
    "  - ⚠ Forwarding a caller's OPTIONAL input (`input: { b: inp(\"b\") }`) passes its EMPTY value (`0`/`\"\"`) when the client omits it, NOT 'absent', so the TARGET's `default` never applies and you get wrong data at 200; declare the caller's input `nullable: true` (an omitted one then binds `null`, which DOES take the target's default) or repeat the default on the caller.",
    "  - ⚠ **Depth:** calls nest at most ~25 deep per request (the engine's variable-stack limit); deeper, including legitimate bounded recursion (a tree walk, factorial, self-paginating call), fails with HTTP 500 `Infinite recursion detected` — recurse iteratively (`s.while` over an explicit list) or batch.",
    "  - `runtime?` runs it in the BACKGROUND: `{ mode: \"async-shared\" }` or `{ mode: \"async-dedicated\", cpu?, memory?, timeout?, maxRetry? }` (resources read at dedicated only). Omit `runtime` for a normal call; same on `s.ai.agent.run`.",
    "    - An async run keeps its caller: `auth()` inside it is the dispatching request's, and from a public endpoint it has none.",
    "    - An async call DOES NOT return the result — it dispatches and continues, and `as` binds the job id (a UUID `string`). Collect with `s.await({ ids, timeout, as })`, binding `{ \"<jobId>\": result }` (read each with `fl.get(ref(\"<idVar>\"))`); a too-short `timeout` or unknown id is a 500 `Async timeout`, no partial result.",
    "    - ⚠ `s.await` NEVER RAISES for a FAILED job (only the timeout/unknown-id case 500s) — a crashed job's slot holds the error envelope in place of the result, served at HTTP 200, and `try_catch` cannot see it. Read each slot (`fl.get(ref(\"<idVar>\"))`) and treat a present `code`/`statement`/`state` as a failure before trusting the result:",
    "      - `{ code, message, payload }` for a precondition/engine error",
    "      - `{ payload, statement }` for `s.throw` (no `code`)",
    "      - `{ state: \"terminated\" }` for one stopped by `terminate`",
    "    - ⚠ `ids` is a single `Value`, so a bare `[ref(\"j1\"), ref(\"j2\")]` fails `tsc` — pass one id as `ref(\"j1\")`, or a list by building it first: `s.set_var(\"ids\", obj({ list: [ref(\"j1\"), ref(\"j2\")] }))` then `s.await({ ids: ref(\"ids.list\"), timeout: c.int(10), as })`.",
    "    - Defaults: `ids` omitted → `{}` at once, `timeout` 10s; awaiting the same id twice returns the same result. `terminate: c.true()` asks every still-outstanding job to STOP at its next statement boundary when the await times out (its slot then reads `{ state: \"terminated\" }`); the await still throws `Async timeout`.",
    "- `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an endpoint. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).",
    "  - `api` takes the `query()` def HANDLE (or a `{ name, guid }` pair) — a bare name is refused (identity = api group + verb + name).",
    "  - `headers` REPLACES the request headers the callee sees and takes the same shapes as `s.api.request`'s, or one `Value`.",
    "  - `auth` is `{ token, ignoreExpiration? }`: `token` must be a BARE STRING — a tagged `Value` deploys clean and then fails the run with `Param: token - Text filter requires an integer, float, string or boolean value`.",
    "  - Neither slot authenticates the call; see `llms/tests.md` for what a workflow-test run actually sees.",
    "- `s.api.request({ url, method?, params?, headers?, timeout?, follow_location?, verify_host?, verify_peer?, ca_certificate?, certificate?, certificate_pass?, private_key?, private_key_pass?, description?, output?, as? })` — external HTTP request (`mvp:api_request`). Ergonomic types, each also accepting a dynamic `Value`:",
    "  - `method` suggests the 8 verbs (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH/QUERY). QUERY (RFC 10008) is the safe method that sends `params` as its body.",
    "  - `params` a plain JSON object **or** a FLAT record whose values are tagged `Value`s (`{ count: ref(\"count\") }`, each lifted via a `set` filter — the same record-of-values shape `response: { key: value }` takes); a tagged value NESTED inside an object or array THROWS at encode, so wrap a structured body in `obj({...})`, which encodes any depth as one `const:expr2` (→ query string for GET/HEAD/OPTIONS, body otherwise).",
    "  - `headers` a `{ \"Name\": value }` record whose values may be tagged (`{ \"x-api-key\": env(\"KEY\") }`, each pair joined to a `\"Name: value\"` line) **or** a `string[]` of full header lines — prefer a header over a `?key=` query param for a credential — a URL reaches access logs and proxies.",
    "  - \u26a0 Neither spelling is envelope-safe: the `as` envelope's `request` half mirrors `url`, `params` AND `headers`, so never return it raw from a credentialed request \u2014 read `response.result`.",
    "  - A NAME outside the header-token charset is refused, and a LITERAL value (string or `c.text`) carrying CR/LF/NUL is refused; a value may hold `:` and spaces (`Bearer a: b` is a valid value). A TAGGED value cannot be checked at build time, so strip CRLF from caller-controlled input before this slot. Literal pairs are emitted before computed ones, whatever the key order.",
    "  - No `User-Agent` is sent unless `headers` carries one. An API requiring one answers **403** as ordinary `response.result` (no throw; every mapped field reads `null`). Send one (`headers: { \"User-Agent\": c.text(\"my-app\") }`) and gate on `ref(\"<var>.response.status\")` = 200 with `s.precondition`.",
    "  - A transport failure (timeout, DNS) does not throw — `s.try_catch` never catches it: `response.status` is `0`, with `response.error` set. Retry on `status == 0 || status >= 500`; a bare `status < 500` check treats a transport failure (status 0) as success.",
    "  - `timeout` a `number` in seconds (1–86400), and `follow_location`/`verify_host`/`verify_peer` booleans.",
    "  - `description` and `output` filters ride the envelope. Cert pairings (certificate↔private_key, ca_certificate→verify_peer) are checked at build time when provable.",
    "  - The `as` result is typed as the `{request, response}` envelope (`response.status: number`, `response.result: unknown`), so `InferResponse` resolves a `ref` to it. Same typed result on `webflow.request` and `microservice.request`.",
    "- `s.stream.from_request({ url, method?, …tls, as? })` — streaming external HTTP request (`mvp:streaming_api_request`); same typed field surface as `s.api.request` (no description/output envelope). `url` is REQUIRED.",
    "- `s.util.send_email({ to?, subject, message, from?, cc?, bcc?, reply_to?, service_provider?, api_key?, scheduled_at?, as? })` — send email from the stack. `subject` and `message` are required at runtime, and so are `to` and `from` with `\"resend\"`. Use it over a hand-rolled `s.api.request` to a mail provider.",
    "  - `service_provider: \"xano\"` — the built-in mailer: needs NO `api_key` and no configuration, and does not require a verified sender. ⚠ It delivers ONLY to the workspace owner: `to`/`cc`/`bcc`/`reply_to`/`scheduled_at` are ignored and `from` is fixed — alerts to yourself, never mail to a user.",
    "  - `service_provider: \"resend\"` — mail to any recipient; pass the key as `api_key: env(\"RESEND_API_KEY\")`.",
    "  - ⚠ A failed send does NOT raise: `as` binds `{ status: \"error\", error }` (success binds `status: \"success\"`). Branch on `ref(\"<as>.status\")`.",
    "- `s.webflow.request({ path, method?, …tls, as? })` — Webflow API request (`mvp:connect_webflow_api_request`); like `s.api.request` but addressed by `path` (host is engine-supplied), and `path` is REQUIRED — the engine rejects an empty one. No `headers`: the engine builds its own from the workspace's Webflow connection and ignores an authored value.",
    "- `s.task.call({ task, as? })` — runs the task's stack once, now; takes NO `input` (a task declares none). `as` binds the task's `s.return` value (null without one), which is how a `workflowTest` asserts a task has a result. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).",
    "- `s.tool.call` / `s.trigger.call` / `s.middleware.call` / `s.addon.call` — same `{ <target>, input?, as? }` shape against the named kind. `s.trigger.call` is WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`); the other three run from any stack, but `s.tool.call` passes NO caller: `auth()` in the tool fails ACCESS_DENIED. ⚠ Like `s.function.call`, a FAILING tool never raises: its error envelope binds to `as` at 200; `s.function.run` a shared function to stop the caller.",
    "  - `s.trigger.call`'s `input` is UNTYPED and must carry the inputs the target trigger reads, which the `t` accessor names: a `tableTrigger` needs `action` (`\"insert\"`/`\"edit\"`/`\"delete\"`), `datasource` (REQUIRED — without it the run fails `Missing param: datasource`), and `new`/`old` row objects; a misspelled key type-checks and is just ignored.",
    "- `s.action.call({ actionId, input?, registry?, as? })` / `s.action.package.call({ traceId, versionId, slug, input?, registry?, as? })` — invoke an installed action. Ids are SUPPLIED, never derived from a name: an action is installed onto the instance, so its identity is assigned at install and differs per instance — read them off a call in a pulled workspace. The package form needs all three parts: pass them together; any subset addresses nothing. `registry` is the action's own settings, `input` the per-call arguments.",
    "- `s.cloud.job({ image, command, args?, secret?, template?, await?, as? })` — launch a containerized job. `image`/`command` are REQUIRED; omitted → `Missing param`. ⚠ `await` is SECONDS (default 60), not a boolean.",
    "- `s.cloud.job.status({ id, as? })` · `s.cloud.job.await({ ids, timeout, as? })` — poll one job, or block on several (`ids` a list `Value`, `timeout` in seconds; both required).",
    "",
    "Microservices (the `microservice()` def and the statement that calls it):",
    "",
    "- `microservice({ name, kind, … })` — two mutually exclusive shapes via `kind`: `builtin` declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and `helm` points at a chart and its `values` — passing both throws.",
    "  - Unstable API — every export of a workspace declaring one prints a notice saying so.",
    "  - `configs`/`volumes` are typed and `@deprecated` but NOT deployable: the engine rejects an import carrying either, so `export()` fails the build rather than letting the deploy fatal.",
    "  - Put a value the workload reads in a container's `env`, and storage in a container's own `volumes` (`emptyDir`/`persistent`/`config`).",
    "  - Container names are free-form — they need not match the microservice name, which is what a stack addresses.",
    "- ⚠ Secrets are copied verbatim: `chart.values` and `registryAuth.dockerconfigjson` are carried into the bundle, and into a pulled tree. `process.env.X` in the def is NOT a way out: it resolves at EXPORT and writes the literal in.",
    "  - Reference a `workspaceConfig({ env })` var instead and only the NAME travels — the engine substitutes at DEPLOY. Two spellings: `env: [{ name: \"API_KEY\", fromEnv: \"STRIPE_SECRET\" }]` on a builtin container (`value`/`fromEnv` exclusive; both → build error), or `${env.NAME}` inside a helm `chart.values` (a VALUE at any depth, never a key). A name the workspace does not define FAILS the deploy rather than resolving blank.",
    "  - `registryAuth.dockerconfigjson` has NO such form: either leave it unset and pull a public image, or treat the bundle and any tree pulled from it as secret material — out of git, or rotate after. Export prints a notice per microservice carrying a literal; `--strict` does not fail on it.",
    "- `s.microservice.request({ host, path, port?, method?, params?, headers?, timeout?, follow_location?, as? })` — in-cluster microservice call (`mvp:microservice_request`); no TLS fields.",
    "  - ONLY `host`+`path` required; the rest default to the engine's values (`GET`/`{}`/`[]`/`10`/`true`), always emitted.",
    "  - Pass the `microservice()` DEF as `host` — it binds by NAME (how the engine resolves it), so a rename fixes every call site and the port is checked before deploy.",
    "  - `port?` folds into `host` as `\"name:port\"`: a def exposing ONE `servicePort` resolves automatically, SEVERAL requires it.",
    "  - A raw `\"name:port\"` string works, unvalidated, and is the only way to reach an instance-level microservice.",
    "  - `tenantDeploy: \"manual\"` on the def imports the row without starting the workload.",
    "- `s.workflow_test.call({ workflowTest, datasource?, as? })` — run another workflow test from inside one, which is the only place it runs (see Gotchas in `llms.txt`). NO `input`; `datasource?` has the kind's clone caveat.",
    "",
  ];

  // Group by top-level namespace segment for readability. Legacy surfaces are
  // withheld here and named in the legacy index instead.
  //
  // A namespace whose statements are only meaningful in a particular HOST gets a
  // one-line note under its heading. The catalog is otherwise a flat list of
  // reachable surfaces, which reads as "callable anywhere" — true of nearly every
  // family, and wrong for the ones below.
  const groups = new Map<string, ManifestStatement[]>();
  for (const s of m.statements) {
    if (s.legacy) continue;
    const ns = s.sPath.includes(".") ? s.sPath.slice(0, s.sPath.indexOf(".")) : "(top-level)";
    (groups.get(ns) ?? groups.set(ns, []).get(ns)!).push(s);
  }
    const stmtCatalog: string[] = [
    "`[special]`: hand-written signature (`llms.txt` Specials, `llms/statements-*`). " +
      "`[output]`: the engine's output flag; in-place mutators carrying it (`s.math.add`, `bitwise.*`) still take no `as`.",
    "",
  ];
  for (const ns of [...groups.keys()].sort()) {
    stmtCatalog.push(`### ${ns}`, "");
    const note = NAMESPACE_NOTES[ns];
    if (note) stmtCatalog.push(note, "");
    for (const s of groups.get(ns)!) {
      const call = `s.${s.sPath}`;
      const flags = [s.declarative ? null : "special", s.registered ? null : "unregistered", s.output ? "output" : null]
        .filter(Boolean)
        .join(", ");
      const flagSuffix = flags ? ` [${flags}]` : "";
      // Signature-first: the engine `storedName` is dropped (agents author `s.path`,
      // never `mvp:*`; it survives in manifest.json). Declarative statements keep the
      // field signature inline (defaults dropped except DEFAULT_KEEP); specials carry
      // no field schema in the listing — their real signature lives in the Specials
      // block / def-shapes / `.d.ts` — so they render as a terse discovery pointer.
      // The `as:` output binding, when curated — `→ as: <type> (<note>)`.
      const resultSuffix = s.result
        ? ` → ${s.result.name}: ${s.result.type}${s.result.note ? ` (${s.result.note})` : ""}`
        : "";
      if (s.fields) {
        const args = s.fields.map((f) => fieldLine(f, s.sPath)).join("; ");
        stmtCatalog.push(`- \`${call}({ ${args} })\`${flagSuffix}${resultSuffix}`);
      } else {
        stmtCatalog.push(`- \`${call}\`${flagSuffix}${resultSuffix}`);
      }
    }
    stmtCatalog.push("");
  }

  const legacy: string[] = [];
  // The legacy index: named, never specified. Everything here is supported and
  // still decodes out of a real workspace, so an agent reading pulled code has
  // to be able to recognize it — but nothing here should ever be chosen for new
  // code, so it carries no signature, no options, and no example to copy.
  //
  // Three surfaces feed it — values, statements, and trigger factories — because
  // a superseded paradigm does not confine itself to one layer of the SDK. The
  // realtime pair is the case that forced the generalization: the same paradigm
  // shows up as a trigger factory AND as a statement, and naming only one of them
  // leaves the other looking current.
  const legacyValues = m.values.constructors.filter((v) => v.legacy);
  const legacyStatements = m.statements.filter((s) => s.legacy);
  const legacyFactories = m.objectKinds.flatMap((k) => (k.subKinds ?? []).filter((sub) => sub.legacy));
  if (legacyValues.length + legacyStatements.length + legacyFactories.length + SUPERSEDED_STATEMENTS.size + DECODE_ONLY_STATEMENTS.size > 0) {
    legacy.push(
      // The heading the topic file drops in favor of its own title; kept so the
      // block reads as a section wherever it is rendered from.
      "## Legacy",
      "",
      "Shapes codegen emits when it decodes an existing workspace, all supported.",
      "**Do not author these.** They are listed by name only so you recognize them",
      "in pulled code rather than \"fixing\" them; each line names what to use instead.",
      "",
      "\"realtime\" and \"channel\" name objects in both lists: a matching name does NOT mean",
      "the same object; check which list it came from.",
      "",
    );
    for (const v of legacyValues) legacy.push(`- \`${v.name}\` — ${v.description}`);
    for (const f of legacyFactories) legacy.push(`- \`${f.authorFactory}()\` — ${f.description}`);
    for (const s of legacyStatements) {
      legacy.push(`- \`s.${s.sPath}\` — ${LEGACY_SURFACES[s.surface]}`);
    }
    // Retired statements, and retired VERSIONS of versioned families. These have
    // no `s.` surface at all — only the latest of each family is authorable — so a
    // pulled workspace holding one shows it as `raw({ name: "<stored>", … })`.
    // Named here for the same reason as everything else in this index: an agent
    // that has never heard of one will try to "fix" what it does not recognize,
    // and the fix would be wrong, because the replacement stores a different shape.
    const retired = [...SUPERSEDED_STATEMENTS.entries()];
    if (retired.length > 0) {
      legacy.push("");
      legacy.push(
        "Retired statements and statement VERSIONS — no `s.` surface exists. Pulled code shows",
        "them as `raw({ name: \"…\" })` and they keep running as stored, so leave them; author",
        "the replacement only for NEW code. Never swap one for the other — the stored shapes differ.",
        "",
      );
      for (const [stored, successor] of retired) {
        legacy.push(successor ? `- \`${stored}\` → \`${successor}\`` : `- \`${stored}\` — retired, no replacement`);
      }
    }
    // Statements the engine WRITES but will not read back. Split from the
    // retired versions above because the instruction is the opposite one: a
    // retired version keeps running as stored and must be LEFT ALONE, while one
    // of these makes the workspace un-deployable and must be REPLACED.
    const decodeOnly = [...DECODE_ONLY_STATEMENTS.entries()];
    if (decodeOnly.length > 0) {
      legacy.push("");
      legacy.push(
        "Statements the engine writes but will NOT import back — no `s.` surface exists, and",
        "unlike the retired versions above these must be FIXED, not left alone. Pulled code shows",
        "them as `raw({ name: \"…\" })`; `export()` refuses any bundle that still contains one.",
        "",
      );
      for (const [stored, reason] of decodeOnly) legacy.push(`- \`${stored}\` — ${reason}.`);
    }
    legacy.push("");
  }

  // Relocated from the router's Gotchas. Not a legacy PARADIGM, but read under
  // exactly this file's condition — the reader has a pulled tree in front of
  // them — and the router is a fixed budget that every task pays whether or not
  // it ever sees pulled code. Appended rather than prepended so `## Legacy`
  // stays the body's first line, which is the one `dropLeadingHeading` eats.
  legacy.push(
    "## Reading a pulled tree",
    "",
    "`codegen` emits objects as FACTORY calls (`table({...})`, `query({...})`, …) — the form",
    "you author by hand — so inference survives the round trip.",
    "Three shapes read differently and must not be \"fixed\": a trigger its factory cannot",
    "reproduce (its target outside the pulled tree, or `meta` it cannot write) stays",
    "`{...} satisfies TriggerDef`; a",
    "statement the catalog cannot model round-trips verbatim through `raw()`",
    "(`@xano/sdk/codegen`); and an object ALREADY EMPTY upstream decodes to a def with",
    "no `stack`, reported as `empty-source` — faithful, not a decode failure. Workspace env",
    "var VALUES go to `xano/.env` (owner-only, gitignored); `xano/workspace.ts` declares each as `\"\"`.",
    "",
    "Markers for stored shapes the checks refuse — keep them, not for new code:",
    "`uncheckedAs: true`, `lam.raw(body, { unchecked: true })`, `rawWhere([...])` from",
    "`@xano/sdk/codegen` (view filter), `\"key\" as never` (a key the target dropped; remove once declared).",
    "",
  );

  return {
    router: lines,
    lock,
    legacy,
    objectKinds,
    kindsCore,
    client,
    toolchain,
    errors,
    kindsAgentMcp,
    kindsKnowledge,
    kindsRealtime,
    triggers,
    stmtData,
    stmtRuntime,
    stmtCalls,
    stmtCatalog,
    values,
    fields,
    filters,
    lambda,
    tests: renderTestsSection(),
  };
}

/** Repo-relative path of the always-loaded grounding router. */
export const LLMS_TXT = "llms.txt";

/**
 * Repo-relative path of the whole grounding surface in one file.
 *
 * The `llms.txt` convention's companion, and here it is also the compatibility
 * path: anything that ingested the single large doc before the split still has
 * one file to read. Nothing in this repo reads it, and no agent should — the
 * router plus one topic file is a fraction of the tokens — but the package is
 * published, and it costs nothing to keep since it is generated.
 */
export const LLMS_FULL_TXT = "llms-full.txt";

/**
 * A topic file: the title, the condition under which an agent should open it,
 * and the body.
 *
 * The trigger is the load-bearing part. A file an agent cannot tell it needs is
 * worse than the same text inline — it costs the router a line and delivers
 * nothing — so the trigger states a condition on the TASK ("the workspace
 * defines an agent"), never a restatement of the filename.
 */
interface Topic {
  path: string;
  title: string;
  readWhen: string;
  body: string[];
  /**
   * Drop the body's first line, which is the section heading it carried inside
   * the router — the file's title says that now, and keeping both reads as an
   * empty section wrapping the real one.
   *
   * Explicit rather than inferred from "does the body start with a heading":
   * the statement catalog opens with `### (top-level)`, a namespace heading and
   * not a section title, and inferring silently ate it.
   */
  dropLeadingHeading?: boolean;
}

/** Render one topic file: title, trigger, then the relocated body. */
function renderTopic(t: Topic): string {
  const body = [...t.body];
  if (t.dropLeadingHeading) {
    body.shift();
    while (body.length > 0 && body[0] === "") body.shift();
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return [`# ${t.title}`, "", `> ${t.readWhen}`, "", ...body, ""].join("\n");
}

/**
 * Every committed grounding artifact, as repo-relative path → content.
 *
 * The map is the seam the grounding surface is split across: the router at
 * {@link LLMS_TXT} is what an agent always loads, and later entries are topic
 * files it reads only when the surface they cover is in play. Callers write
 * whatever the map holds rather than naming files individually, so a new
 * artifact is picked up by the writer and by the drift guard without either
 * needing to learn about it.
 *
 * Pure function of the manifest, like every other artifact here — regenerating
 * is deterministic and the committed files are asserted against a fresh render.
 */
export function renderDocs(m: Manifest): Map<string, string> {
  const s = renderSections(m);

  const topics: Topic[] = [
    {
      path: "llms/object-kinds.md",
      title: "Object kinds",
      readWhen:
        "Read when deciding WHAT to build — every authorable primitive, what each is, and which factory + register method builds it. Also when `register*` will not typecheck an array built by `.flatMap()`/`.concat()`.",
      body: s.objectKinds,
      dropLeadingHeading: true,
    },
    {
      path: "llms/kinds-core.md",
      title: "Core def shapes",
      readWhen:
        "Read when authoring a function, query, api group, task, workflow test, middleware, tool, or addon — and for the `response` and `expr` shapes every one of them uses.",
      body: s.kindsCore,
      dropLeadingHeading: true,
    },
    {
      path: "llms/client.md",
      title: "Consuming defs from a client",
      readWhen:
        "Read when a frontend calls the deployed backend or imports a def — request types and zod schemas without the import, its cost, `window.XANO_HOST`, local dev, file URLs, a Node spot-check.",
      body: s.client,
    },
    {
      path: "llms/toolchain.md",
      title: "Toolchain modules",
      readWhen:
        "Read when `package.json` has a `\"xanosdk\"` block or you run `npx @xano/sdk marketplace`.",
      body: s.toolchain,
    },
    {
      path: "llms/errors.md",
      title: "Error index",
      readWhen:
        "Read when a request, test, build, or pull fails with a message you did not write — the string, its cause, and where the fix is.",
      body: s.errors,
    },
    {
      path: "llms/tests.md",
      title: "Saved unit tests, assertions, and mocks",
      readWhen:
        "Read when authoring a `workflowTest()` stack, when a query/function/middleware carries `tests`, when a statement needs a `mock`, or when running a deployed environment's tests.",
      body: s.tests,
      dropLeadingHeading: true,
    },
    {
      path: "llms/kinds-agent-mcp.md",
      title: "Agent and MCP def shapes",
      readWhen: "Read when building an MCP server (tools, prompts, resources) or an `agent()`.",
      body: s.kindsAgentMcp,
    },
    {
      path: "llms/kinds-knowledge.md",
      title: "Knowledge def shape",
      readWhen:
        "Read when the workspace defines a `knowledge()` item.",
      body: s.kindsKnowledge,
    },
    {
      path: "llms/kinds-realtime.md",
      title: "Realtime def shapes",
      readWhen:
        "Read when the workspace defines a `realtimeServer()`, `realtimeChannel()`, or `realtimeMessage()` handler.",
      body: s.kindsRealtime,
    },
    {
      path: "llms/triggers.md",
      title: "Triggers",
      readWhen:
        "Read when authoring any trigger. A trigger's `stack` is a callback rather than the plain array every other kind takes, so the shape does not carry over.",
      body: s.triggers,
      dropLeadingHeading: true,
    },
    {
      path: "llms/statements-data.md",
      title: "Array and database statements",
      readWhen:
        "Read when the stack reads or writes rows (`s.db.*`), or transforms an array in place (`s.array.map`, `s.array.union`).",
      body: s.stmtData,
    },
    {
      path: "llms/statements-runtime.md",
      title: "Statement runtime behavior",
      readWhen:
        "Read when you need to know what a statement's `as:` output holds, or why a bound variable is not the shape expected.",
      body: s.stmtRuntime,
    },
    {
      path: "llms/statements-calls.md",
      title: "Auth, cross-object calls, and microservices",
      readWhen:
        "Read when the stack authenticates or verifies a webhook (recipes here), calls another object (`s.function.run`, `s.api.request`, `s.tool.call`), sends email (`s.util.send_email`), or reaches a microservice.",
      body: s.stmtCalls,
    },
    {
      path: "llms/values.md",
      title: "Value catalog",
      readWhen:
        "Read when you need a literal, a reference, or a tag you have not used before — `c.*`, `ref`, `inp`, `auth`, `col`, and what each one encodes to.",
      body: s.values,
      dropLeadingHeading: true,
    },
    {
      path: "llms/fields.md",
      title: "Column and input types",
      readWhen:
        "Read when declaring a table column (`f.*`) or a function/query input (`input.*`) — a type's options and methods, and the `s.precondition` error/status contract. Also `table({ seed })` rows and `use_xdo`.",
      body: s.fields,
      dropLeadingHeading: true,
    },
    {
      path: "llms/filters.md",
      title: "Filter catalog",
      readWhen:
        "Read when piping a value through `fl.*` — the full catalog with each filter's argument types.",
      body: s.filters,
      dropLeadingHeading: true,
    },
    {
      path: "llms/lambda.md",
      title: "Lambda bodies (JavaScript)",
      readWhen:
        "Read when writing a JavaScript body, or weighing whether to reach for one at all — `lam.fn`, `fl.lambda`, `fl.reduce`, `s.lambda`; each surface binds a different set of identifiers.",
      body: s.lambda,
      dropLeadingHeading: true,
    },
    {
      path: "llms/lock.md",
      title: "Lock file",
      readWhen:
        "Read when a `xano.lock` exists or should — renaming/pruning/importing identities, seeding the lock programmatically, or asking which commands write it.",
      body: s.lock,
      dropLeadingHeading: true,
    },
    {
      path: "llms/legacy.md",
      title: "Legacy paradigms and retired statements",
      readWhen:
        "Read when the code was PULLED from an existing Xano instance — how a codegen'd tree reads, the shapes in it that must not be \"fixed\", and any `raw({ name: \"mvp:…\" })`, `realtimeTrigger()`, or name the catalogs do not list.",
      body: s.legacy,
      dropLeadingHeading: true,
    },
    {
      path: "llms/statements-catalog.md",
      title: "Statement catalog",
      readWhen:
        "Read for the field signature of a specific statement — every surface, grouped by `s.*` namespace.",
      body: s.stmtCatalog,
    },
  ];

  const nav = [
    "## Topic files",
    "",
    "Paths are relative to this file (`node_modules/@xano/sdk/` once installed), so a",
    "plain file read resolves them at the version you have.",
    `\`${LLMS_FULL_TXT}\` is everything concatenated — one fetch for a reader that cannot open files.`,
    "",
    ...topics.map((t) => `- [${t.title}](${t.path}): ${t.readWhen}`),
    "",
  ];

  const slot = s.router.indexOf(NAVIGATION_SLOT);
  if (slot === -1) throw new Error(`the router lost its ${NAVIGATION_SLOT} placeholder`);
  const router = [...s.router.slice(0, slot), ...nav, ...s.router.slice(slot + 1)];

  const docs = new Map<string, string>([[LLMS_TXT, router.join("\n")]]);
  for (const t of topics) docs.set(t.path, renderTopic(t));

  // Router first, then the topic files in the order the navigation lists them,
  // so the one-file form reads in the same order an agent would open them.
  docs.set(
    LLMS_FULL_TXT,
    [docs.get(LLMS_TXT) ?? "", ...topics.map((t) => docs.get(t.path) ?? "")].join("\n"),
  );
  return docs;
}

/** The router alone, for callers that want it without the rest of the set. */
export function renderLlmsTxt(m: Manifest): string {
  const txt = renderDocs(m).get(LLMS_TXT);
  if (txt === undefined) throw new Error(`renderDocs emitted no ${LLMS_TXT}`);
  return txt;
}
