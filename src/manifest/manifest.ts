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
      { authorFactory: "realtimeTrigger", objType: "workspace_realtime_channel", legacy: true, description: "the SUPERSEDED realtime trigger, against the workspace-global realtime layer — a different object from the current `channel`, despite the similar name. For a join hook use `realtimeChannelTrigger({ actions: { join: true } })`; for message handling use a `realtimeMessage()` handler, which is the current equivalent of its `message` action (a message is an authored unit now, not a trigger action)." },
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
  { kind: "task", payloadKey: "task", authorFactory: "task", description: "A scheduled background job (cron/interval) that runs a stack on a timer.", registerMethod: "registerTasks" },
  { kind: "workflow_test", payloadKey: "workflow_test", authorFactory: "workflowTest", description: "An end-to-end test: a named stack with NO input and NO response that invokes other objects (`s.function.call`, `s.task.call`, `s.api.call`) and asserts on what they bind with `s.expect.*`. `datasource` defaults to `\"\"` (an EMPTY datasource, recommended); naming one CLONES it before every run — see `llms/kinds-core.md`.", registerMethod: "registerWorkflowTests" },
  { kind: "middleware", payloadKey: "middleware", authorFactory: "middleware", description: "A reusable pre/post stack attached to a query/function/task/tool/API group to run before or after its own logic.", registerMethod: "registerMiddleware" },
  { kind: "addon", payloadKey: "addon", authorFactory: "addon", description: "A reusable read fragment that enriches a query result by joining related table data.", registerMethod: "registerAddons" },
  { kind: "realtime_server", payloadKey: "realtime_server", authorFactory: "realtimeServer", description: "A realtime (websocket) server: the canonical-addressed container that owns realtime channels. Off until `enabled: true`. Returns a handle with `getUrl(baseUrl)`/`getPath()` for the client's socket URL (`wss://<host>/ws/<canonical>`).", registerMethod: "registerRealtimeServers" },
  { kind: "channel", payloadKey: "channel", authorFactory: "realtimeChannel", description: "A realtime channel: a joinable path on a realtime server (`rooms/{room_id}`) with typed path params, join/publish policy, a client-visible conversation transcript, and delivery semantics. Owns message handlers. Returns a handle with `getChannel(params)` for the path a client joins.", registerMethod: "registerRealtimeChannels" },
  { kind: "message", payloadKey: "message", authorFactory: "realtimeMessage", description: "A realtime message handler: a named message type on a channel with its own typed payload and stack — the realtime analogue of a query. Pass the `realtimeChannel()` handle as `channel` and the owning server comes with it.", registerMethod: "registerRealtimeMessages" },
  { kind: "microservice", payloadKey: "microservice", authorFactory: "microservice", description: "A container workload deployed alongside the workspace, called from a stack with `s.microservice.request`. Def shapes (`builtin` containers vs a `helm` chart) and the SECRET-handling rules its config carries: `llms/statements-calls.md`.", registerMethod: "registerMicroservices" },
  {
    kind: "knowledge",
    payloadKey: "knowledge",
    authorFactory: "knowledge",
    description: "Markdown Xano's own AI (the builder agent, and Meta API / MCP readers) reads before it acts — never an `agent()` run — an `agents.md` of standing instructions, a `skill`, or a `doc`. The body is a real markdown FILE via `knowledgeFile(\"./x.md\", import.meta.url)`, and `mode` decides how much of it reaches the agent.",
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
  debug:
    "`s.debug.stop` is a REAL terminator despite the namespace: it ends the request with an " +
    "error value. Also exported flat as `die()`; there is no `s.die`.",
  "(top-level)":
    "`s.throw` raises a named error `s.try_catch` catches; uncaught, it answers HTTP 200 " +
    "`{ payload, statement: \"Throw Error\" }` (`s.precondition` sets a status). Inside `s.db.transaction` " +
    "a throw or failed precondition rolls it back.",
  expect:
    "Assertions. **Put them in a `workflowTest({...})` stack** — assert on what a `.call` " +
    "bound with `as`. They are NOT inert elsewhere: a failure aborts the stack, so an " +
    "`s.expect.*` in a `query`/`function`/`task` fails the request with HTTP 500 and the " +
    "assertion's message (`to_equal failed - expected value 2 does not equal 1`) — remove it. " +
    "`to_throw` sees only an error carrying a MESSAGE, so an empty-message failure " +
    "(`ERROR_CODE_ACCESS_DENIED`) reports \"response is ok\", and `to_be_within` EXCLUDES " +
    "both bounds — `min < expr < max` — while `s.security.random_number`'s are inclusive.",
  util: "`s.util.sleep`'s `value` is in SECONDS; a decimal is allowed (`c.decimal(0.5)` = 500 ms).",
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
  { name: "c.int", signature: "(n: number | bigint | string) => Value", description: 'Integer constant → tag "const:int". The engine stores integers as STRINGS and has no 53-bit limit, so pass a string or bigint for anything past Number.MAX_SAFE_INTEGER — c.int("9223372036854775807") is exact where the number literal for it is already …808. A number that is not a safe integer THROWS rather than encoding the rounded value. The VALUE encodes at any width, but an `f.int` COLUMN is signed 64-bit and CLAMPS past its ceiling rather than failing — see `llms/fields.md`.' },
  { name: "c.decimal", signature: "(n: number | string) => Value", description: 'Decimal constant → tag "const:decimal". Pass a string only to keep a stored spelling a number cannot reproduce (c.decimal("10.00") keeps its trailing zeros).' },
  { name: "c.blank", signature: '(tag: "const:<type>") => Value', description: 'The editor\'s UNCONFIGURED value box (stored value ""), emitted by codegen for a pulled workspace — do not author it. NOT a zero or an empty collection: the engine reads "" and "0" differently, so c.blank("const:int") ≠ c.int(0) and neither canonicalizes into the other. Constant tags except const/const:obj, whose blanks are c.text("")/c.obj(null).' },
  { name: "c.bool", signature: "(b: boolean) => Value", description: 'Boolean constant → tag "const:bool".' },
  { name: "c.null", signature: '(tag?: "const:null" | "const:obj") => Value', description: 'Null constant, stored value "null". Bare c.null() is tag "const:null". c.null("const:obj") is the OBJECT-TYPED null the engine writes into a db.* statement\'s @meta slot — different stored bytes from c.obj(null), which is the blank object (value ""), though both evaluate to null. Codegen emits whichever spelling the workspace stored; do not swap one for the other.' },
  { name: "c.obj", signature: "(o?: Json | null) => Value", description: 'Object constant → tag "const:obj". A populated one stores an empty {} carrying one `set` filter per key — the editor\'s form, and the only populated form the engine reads back (a populated JSON string arrives truncated and fails the request with ERROR_FATAL "Unable to decode."). ⚠ a ZERO-BASED numeric key is an INDEX in the engine\'s data model, so c.obj({"0":"a"}) evaluates to the list ["a"] (a non-zero-based one like {"2":…} survives as a key) — that is the platform, not this encoding. Write c.array([...]) for a list, or prefix the keys ("k0") for an object; `export()` warns. No argument = the empty object {} — use this one. Explicit null = the legacy blank form the engine evaluates to null, NOT {}; it exists only so a pulled workspace round-trips, do not author it. Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is rejected; for a computed object response use a record of values, not c.obj.' },
  { name: "c.array", signature: "(a: Json[]) => Value", description: 'Array constant (JSON string) → tag "const:array". Plain JSON literals only — a nested tagged value is rejected, same as c.obj.' },
  { name: "c.expression", signature: "(source: string) => Value", description: 'Xano Expression Engine source, passed through VERBATIM → tag "const:expr2". The string IS the expression: c.expression(\'"Hi, " ~ $input.name\'), c.expression("$var.price * $var.qty"). ⚠️ NOT VALIDATED — never parsed or type-checked, invisible to InferResponse, and untouched by a rename that updates every typed ref(); a typo surfaces at runtime or as a wrong answer. Use it ONLY for syntax the typed surfaces cannot express (~ concatenation, inline arithmetic, conditionals) — prefer ref/inp/col, withFilters+fl.*, and obj() (which BUILDS a checked expression). Not the expr() condition builder.' },
  { name: "c.expressionLegacy", signature: "(source: string) => Value", legacy: true, description: 'the older `const:expr` expression form, emitted by codegen for workspaces that still hold one — author `c.expression` instead.' },
  { name: "c.now", signature: "() => Value", description: 'Current time as epoch-ms — the engine-native const:epochms constant (no filter). Valid inline as a where/cmp operand. For cutoff math (cutoff = now - max_age) either compare inline or, for reuse/readability, hoist it into an s.set_var and compare against the var.' },
  { name: "obj", signature: "(fields: Record<string, Value | nested>) => ObjValue<typeof fields>", description: 'Dynamic object value → tag "const:expr2" (an object-literal expression string). The dynamic sibling of c.obj: members may be inp/ref/auth values, env()/setting()/sys.*, c.now(), c.* constants, nested records, or arrays — and each member may carry a FILTER CHAIN (withFilters + fl.*), which renders as the expression pipe `$var.row|get:"a.b"`. A null-safe ref(path, { safe: true }) works inside an obj() member directly. The member record rides the return type, so InferResponse (through a set_var too) resolves each member like a top-level response key — `response: { user: obj({ id: ref("row.id") }) }` derives `{ user: { id: Col | null } }`, and a raw nested object literal (`response: { user: { id: ref("row.id") } }`, auto-wrapped through this) derives the same. A constant record or list has two spellings that both work and render identically: bare (`{ a: 1 }`, `[]`) or `c.obj(...)`/`c.array([...])` — prefer the bare form. An inner obj() nests, same bytes as a raw record. The legacy blank `c.obj(null)` is refused here (it evaluates to null, not {}) — write c.null() or c.obj(). Still rejected: a filter ARGUMENT that carries its own chain or is a c.now() (a trailing | binds to the whole value, not one argument, and c.now() needs one), a DISABLED filter (an expression string cannot record that), and the output/response/trycatch/toolset/reg tags (a type error) — set_var those first and ref() them.' },
  { name: "ref", signature: "(name: string, opts?: { safe?: boolean }) => Value", description: 'Reference a stack variable → tag "var". Pass { safe: true } for null-safe nested access — a dotted ref("owner.user_id", { safe: true }) compiles through the get filter so it resolves to null instead of raising "Unable to locate var" when the base is null.' },
  {
    name: "inp",
    signature: "(name: string) => Value",
    description:
      'Reference a function/endpoint input → tag "input". Resolves ONLY against the `input` block ' +
      'of the def it sits in — a value produced earlier in the stack is `ref("var.field")`, not ' +
      '`inp("field")`. A name that is not declared here deploys clean and fails at runtime with ' +
      'ERROR_FATAL "Unable to locate input: <name>" on every branch that reads it; `export()` warns, ' +
      'and `--strict` fails the build. Sending the name in the request does NOT rescue it — an ' +
      'undeclared input is never bound, so the call fails identically with the value present. ' +
      'A dotted path drills INTO a declared input (`inp("action.amount")` needs a declared `action`).',
  },
  { name: "col", signature: "(name: string) => Value", description: 'Reference a table column → tag "col".' },
  { name: "auth", signature: "(path?: string) => Value", description: 'Reference the authenticated identity (auth("id") → $auth.id) → tag "auth".' },
  { name: "caught", signature: '(path?: "code" | "message" | "name" | "result") => Value', description: 'Read the caught error inside an s.try_catch CATCH arm → tag "trycatch". Valid ONLY there — it reads empty in the try/finally arms and outside the statement. Those four fields are all the engine binds (result is the attached payload); bare caught() is the whole error record. \u26a0 For an ENGINE-raised exception only `code` and `name` are populated; for an `s.throw`, `message` is the fixed string "Throw Error Statement" and your text is in `result`. So `caught("name")` is useful in both cases and `caught("message")` in NEITHER.' },
  { name: "toolset", signature: '(path: "token" | "params" | `params.${string}`) => Value', description: 'Read a toolset-scoped binding inside a tool → tag "toolset". The engine binds two: token (the calling URL\'s token, null when absent) and params (its parameters, as an object); a dotted params.<key> reads one parameter out of that object. Bound only while a tool runs under its toolset — anywhere else it reads empty.' },
  { name: "env", signature: "(name: string) => Value", description: 'Read a WORKSPACE environment variable (set via workspaceConfig({ env }) or the dashboard) → `$env.NAME`. Compiles to tag "setting" with the plain name. env("remote_ip") reads a user var named remote_ip, not the caller IP — use sys.remoteIp() for that. A name that does not exist resolves to NULL rather than erroring, so a typo deploys clean and fails downstream of the value: prefer typedEnv(config), which turns the names that config declares into properties (E.STRIPE_KEY), and export() warns stack.env-undeclared on any env() or bare setting() outside the declared set once a config declares env at all.' },
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
    note: "true when the plaintext matches the stored hash. ⚠ input.password double-hashes — pass input.text() plaintext",
  },
  // redis/storage binds measured live: a get miss is `false`, not null.
  "redis.get": { name: "as", type: "unknown", note: "FALSE (not null) on a miss" },
  "redis.set": { name: "as", type: "boolean", note: "false when create_only meets an existing key (kept)" },
  "storage.read_file_resource": { name: "as", type: "{ name; size; mime; data: <contents> }" },
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
      "inside an ATTACHED middleware it is a { type, vars } envelope whose vars DIFFERS BY PHASE: pre → the request inputs; post → { status, result } (plus payload on an error), NOT the request — read the request in post with s.util.get_raw_input. See llms/kinds-core.md",
  },
  "util.ip_lookup": {
    name: "as",
    type: "IpLookupResult | null",
    note:
      "NESTED, not flat: { continent: {code,name}, country: {code,name}, region: {code,name}, city: {name}, postal: {code}, location: {latitude, longitude, tz, radius} } — ref(\"geo.location.latitude\"), ref(\"geo.city.name\"); radius is KILOMETRES. ⚠ Every leaf is nullable (region/city/postal often null on a normal hit). `city` is an OBJECT: a bare ref(\"geo.city\") into a text column fails and { safe: true } does NOT help; drill to city.name. The whole var is null for an unresolvable address",
  },
  // Clearly-typed declarative ops.
  "array.every": { name: "as", type: "boolean" },
  "math.add": { name: "as", type: "number" },
  "math.bitwise.and": { name: "as", type: "number" },
  "math.bitwise.or": { name: "as", type: "number" },
  "math.bitwise.xor": { name: "as", type: "number" },
  "object.keys": { name: "as", type: "string[]" },
  "object.values": { name: "as", type: "unknown[]" },
  "object.entries": { name: "as", type: "[string, unknown][]" },
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
  array_upmerge: "merges the node INTO each matched element; `array_replace` swaps the element whole",
  array_set: "sets a DOTTED path and returns the value; a non-object piped value is replaced by an empty one",
  // A computed key is the grouping half of `index_by`: one pass over the rows,
  // then a lookup per group, with no query per group.
  get: "`path` may be a runtime value: after `fl.index_by(\"suite_id\")`, `fl.get(ref(\"suite.id\"))` returns that key's rows (null for a missing key)",
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
    "REVERSE of `contains`/`starts_with`. Swapped, it answers false for every input with no error, " +
    'so write `withFilters(c.regex("^a+$"), fl.regex_test(inp("s")))` (or name the arg: ' +
    "`fl.regex_test({ subject: inp(\"s\") })`). A pattern found in the subject slot is refused at build time",
  regex_match: "piped value is the PATTERN, the arg is the subject — see `regex_test`",
  regex_match_all: "piped value is the PATTERN, the arg is the subject — see `regex_test`",
  regex_replace:
    "piped value is the PATTERN, `subject` is the text searched — see `regex_test`. The " +
    "replacement comes FIRST",
  iends_with: "case-insensitive; piped value is the subject, the arg is the substring",
  istarts_with: "case-insensitive; piped value is the subject, the arg is the substring",
  // "empty" is a specific set of values, not just null.
  filter_empty: 'keeps entries that are not empty ("", null, 0, "0", false, [], {})',
  first_notempty: 'first value that is not empty ("", null, 0, "0", false, [], {})',
  // The `code` arg is a JS FUNCTION BODY (it must `return`), not a column path,
  // and which identifiers it can see depends on the filter — see **Lambda bodies**.
  // Build it with `lam.fn`, which makes the bindings the function's parameters.
  map: "`code` is a JS body run per element, over `$this`/`$index`/`$parent` — build it with `lam.fn`",
  filter: "`code` is a JS body run per element (keep it? true/false), over `$this`/`$index`/`$parent`",
  every: "`code` is a JS body run per element (true for all?), over `$this`/`$index`/`$parent`",
  some: "`code` is a JS body run per element (true for any?), over `$this`/`$index`/`$parent`",
  find: "`code` is a JS body run per element; returns the first element it accepts",
  findIndex: "`code` is a JS body run per element; returns the first matching index",
  reduce:
    "`code` is a JS body run per element; the ACCUMULATOR is `$result` (there is no `$acc`) and " +
    "`initial_value` is REQUIRED — omitting it would slot the code as the initial value",
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
    '`type` is the comparator, and ONLY "number" compares numerically — "text"/"itext" ' +
    'are strcmp/strcasecmp, "natural"/"inatural" are the human-readable "a2 < a10" ' +
    'orderings. Default "itext". Anything else silently sorts as text, so a numeric ' +
    'sort MUST spell "number"; the path arg drills into each element',
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
  // Non-obvious names.
  epochms_transform: 'applies a relative shift (e.g. "+1 day") to the timestamp',
  unpick: "returns the object without the named keys (inverse of a pick)",
};

/**
 * Typed filters that ARE load-bearing (non-name-restating, complete source
 * description) but whose name + signature is self-evident, so they intentionally
 * carry no note. Recorded explicitly so the completeness test can prove every
 * load-bearing filter is a conscious keep-or-drop decision, not a silent gap.
 */
export const SELF_EVIDENT_FILTERS: ReadonlySet<string> = new Set([
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
    "**A lambda is an escape hatch, not a default.** The body runs outside the request's own",
    "runtime, and a workspace has a BOUNDED pool of lambda workers every lambda in it shares",
    "— so a call both crosses a process boundary and draws on a workspace-wide resource.",
    "Reach for one only when the typed surface cannot express the work: if a native filter,",
    "an `expr(...)`/`obj(...)` expression, or a plain statement can, use that. The crossing",
    "is per CALL, not per element — an iterating filter sends the body ONCE and loops on the",
    "other side, so one body over a whole list beats one called from inside a stack loop.",
    "",
    "The lambda statement (`s.lambda({ as, code, timeout? })`) and eight filters run a",
    "JavaScript body. **Write the body as a FUNCTION, not a `c.text` string** — the",
    "bindings are its parameters, so the editor supplies them and a wrong name is a",
    "compile error instead of a wrong value at runtime. Write it inline and the surface",
    "is implied by where it sits; nothing names one:",
    "",
    "```ts",
    "fl.map(({ $this }) => $this * 2)                                   // map's bindings, typed from the position",
    "fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })",
    "s.lambda({ as: \"total\", code: ({ $var }) => $var.subtotal * 1.2 })  // ambient only — $this is a compile error",
    "```",
    "",
    "The parameters are a fiction — only the BODY is sent, and the engine injects the",
    "bindings as free identifiers — so DESTRUCTURE them as named: `(b) => b.$this`,",
    "`{ $this: x }`, nesting, a default or rest are undefined there (refused).",
    "",
    "⚠ An inline `code:` arrow receives BINDINGS ONLY. `capture` is an option of",
    "`lam.fn`, not a field of `s.lambda` or a filter, so `capture:` beside `code:` is a type",
    "error — the fix is to relocate the body, not to drop the field: `lam.fn(fn, { capture })` (below).",
    "",
    "For a body built away from its call site:",
    "",
    '- `lam.fn(({ $result, $this }) => $result + $this, { surface?, capture? })` — name a `surface` to check it here, or omit it and the call site checks it.',
    '- `lam.raw("return 1", { surface })` — text, same validation.',
    '- `lam.raw(code, { surface, unchecked: true })` — sends a body that does not parse or declares a top-level `import`/`export` (a fixture pinning the engine\'s syntax-error answer, or a pulled body); skips those syntax checks only, here and at the `s.lambda` / `fl.*` site.',
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
    "⚠ A capture key must NOT share its name with a module-scope binding: a `.ts` loader",
    "renames one of two same-named bindings, so the body reads `rate2` while the prelude",
    "declares `rate` (refused at build time). `capture: { capturedRate: rate }` is the safe form.",
    "",
    "Capture JSON data only: a function, `NaN`, a sparse/typed array or class instance (`Date`, `Map`…)",
    "is refused at build time, at any depth. Capture the plain form and rebuild in",
    "the body (`d.getTime()` → `new Date(d)`). The captured type flows into the second parameter.",
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
    "Four hazards and the dependency route, all live-verified:",
    "",
    "- ⚠ A body that THROWS does not fail the request: the engine returns its diagnostic",
    "  TEXT as the value with HTTP 200, so the failure reads as bad data. Validate before",
    "  consuming a lambda result numerically, and prefer a `lam.*` body, which cannot fail",
    "  this way for a binding reason.",
    "- ⚠ `timeout` is COOPERATIVE — observed only at an `await` — so it bounds WAITING (a slow",
    "  `fetch`), not compute: a 1s `timeout` over a 3s busy-loop runs all 3s and returns",
    "  normally. Bound a loop that could run away inside the body.",
    "- ⚠ A top-level `import`/`export` is a syntax error — the body is a function body. Reach",
    "  a dependency through the PRELOADED globals below. A dynamic `import(\"…\")`/`require(\"…\")`",
    "  with a LITERAL specifier is not portable: an instance that bundles the body first",
    "  returns the TEXT `Could not resolve \"node:crypto\"` with HTTP 200.",
    "- Preloaded globals, live-probed — no specifier, so these work everywhere:",
    ...wrapList(LAMBDA_MODULE_GLOBALS.map(tick), "  "),
    "  …plus `fetch`, `Buffer`, `TextEncoder`/`TextDecoder`, and the `crypto` above",
    "  (`randomUUID`, `createHmac`, `createHash`, `subtle`). `Object.keys(globalThis)`",
    "  inside a body lists whatever else a given instance carries.",
    "- ⚠ `console` output goes to the request LOG, not stdout. `log` · `error` · `warn` ·",
    "  `info` · `debug` · `trace` all route there; any other `console` method is undefined,",
    "  and CALLING it throws (error text as the value, HTTP 200).",
    "",
    "TypeScript annotations survive in the body, and top-level `await` works.",
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
    "- ⚠ That empty default means **no `table({ seed })` rows exist while a unit test runs**, exactly as for a `workflowTest()` — every `db` read misses, so `resp(\"0.id\")` fails though the deployed endpoint returns those rows. **To read `table({ seed })` rows on an EPHEMERAL**, set `datasource: \"live\"`: there it holds only the seed fixtures (plus rows `--keep-data` kept); the run's writes are dropped. `diagnostics.allow` accepts its warning. ⚠ `datasource` is STORED, not a per-run flag — a test left on `\"live\"` clones the REAL database once it runs against an instance, so clear it before you promote. Otherwise create the rows INSIDE the run (a `defineFunction` fixture the stack calls first) or `mock` the read.",
    "- `input` is `{ <input name>: Value }` — tagged values (`c.*`, `ref`, …), never plain JS scalars.",
    "- `token` runs the test as an authenticated caller. A pull does NOT bring it back: it is an expiring credential, reported as a deliberate omission.",
    "",
    "### Assertions: `expect.*`, not `s.expect.*`",
    "",
    "- `expect.*` builds a `{type, vars}` record stored on a `tests` entry. `s.expect.*` builds a STATEMENT for a `workflowTest()` stack. Different return types; not interchangeable.",
    "- Subject first — argument order is the assertion: `expect.to_equal(resp(), c.int(2))`.",
    "- `resp()` is the response under test; `resp(\"id\")` drills, `resp(\"a-b\")` takes the bracket escape.",
    "- Subject only: `to_be_defined`, `to_not_be_defined`, `to_be_empty`, `to_be_null`, `to_not_be_null`, `to_be_true`, `to_be_false`, `to_be_in_the_future`, `to_be_in_the_past`.",
    "- Subject + operand: `to_equal`, `to_not_equal`, `to_be_greater_than`, `to_be_less_than`, `to_contain`, `to_start_with`, `to_end_with`, `to_match` (operand is a delimiter-wrapped pattern — build it with `c.regex`).",
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
    "The run is isolated in ways that make a correct test fail for reasons the failure message does not name.",
    "",
    "- The run uses an EMPTY datasource by default (`datasource: \"\"`), so **no `table({ seed })` rows exist while it runs** (same as a unit test, above): a read of seeded row 1 fails with its own precondition message, not an empty-database error. Build fixtures INSIDE the test, or set `datasource: \"live\"` under the ephemeral-only rule above.",
    "- `s.api.call` does NOT raise when the endpoint answers with an error. It BINDS the error envelope (`{code, message}`) to its `as` and carries on, so a later `s.expect.to_be_defined({ expr: ref(\"r.field\") })` reports the ASSERTION while the real failure was the call, four statements up. Assert on the envelope — `s.expect.to_contain({ expr: ref(\"r.code\"), value: c.text(\"ERROR_CODE_INPUT_ERROR\") })` — when a call may fail. `s.function.run` raises instead; the two disagree.",
    "- `s.expect.to_throw({ body, exception? })` runs `body` in an ISOLATED var stack, so a variable bound EARLIER in the test is not visible inside it — bind what the body needs inside the body. An outer one raises `Missing var entry: <name>` there, which the test reports as `to_throw` not matching (`export()` warns). `exception` is a `Value` whose text the raised message must CONTAIN (`c.text(\"already exists\")`, not a bare string); omit it to accept any error.",
    "- `s.expect.to_throw` catches such a call only when the error carries a MESSAGE. `ERROR_CODE_ACCESS_DENIED` arrives with an empty one, so `to_throw` around an auth-refused call reports `to_throw failed - response is ok` — which reads as a broken auth gate on a gate that works.",
    "- An endpoint's `auth` gate is NOT enforced on `s.api.call`. A `query({ auth: users })` runs anyway and fails only where its stack dereferences `auth(...)`. A stack that never touches `auth(...)` runs unauthenticated and passes.",
    "- Neither `auth.token` nor an `Authorization` entry in `headers` authenticates the call — a token that answers 200 over real HTTP is refused here. To cover auth-gated logic, move the body into a `defineFunction` taking the user id and `s.function.call` that; the gate itself is not reachable from a workflow test.",
    "",
    "### Running them",
    "",
    "`xanosdk test run-all` runs the unit tests AND the `workflowTest()` objects an environment carries. It takes no entry file and compiles nothing: it runs what is DEPLOYED, so deploy before testing.",
    "",
    "- `--on <backend>` picks the backend — `--on ephemeral:<name>`, `--on local`, `--on tenant:<name>`, `--on workspace`; omitted, the one this project last deployed to (grammar: **Backends** in `llms.txt`). ⚠ `workspace` runs against the REAL database: safe only while every test keeps `datasource: \"\"`, since a stored non-empty datasource is CLONED before the run.",
    "- `xanosdk test list` shows what is there without running it; `test run \"<name>\"` runs one; an ambiguous name prints qualified forms (`function:math/happy path`, `workflow:<name>`) `run` accepts.",
    "- `--kind unit|workflow` narrows to one family. `--concurrency <n>` defaults to 1: tests share the environment database.",
    "- A failing suite exits 5; exit 6 when the suite could not be reached — retry it; a backend that can't be looked up exits 8 (see errors). Having no tests is success.",
    "- For CI: the exit code says THAT something failed, the JSON says WHICH. Progress goes to stderr; stdout carries one JSON document when not a terminal, or with `--json`. `run-all` and `run`: `{ kind, env, name, display, total, passed, failed, tests: [{ kind, name, qualified, object?, status: \"pass\"|\"fail\", message?, expectations?: [{ index, status, message? }], timing? }] }` (`message`: the first failure; `expectations`: a unit test's every expectation in order, `index` from 0; `env`: an ephemeral's or tenant's name; `name`: the backend's own, a Xano Engine's too; null if none), same keys on an empty suite. `list` is `{ kind, env, name, display, total, tests }`; `deploy --test` nests the run under `testRun`.",
    "- `xanosdk deploy ./index.ts --test` deploys and then runs the suite against what it just shipped. A failure exits 5 WITHOUT retracting the deploy — the environment is live either way.",
    "",
  ];
}

function renderSections(m: Manifest): RenderedSections {
  const lines: string[] = [];
  lines.push(`# ${m.name} v${m.version}`, "");
  lines.push(`> ${m.description}`, "");
  lines.push(
    "Xano is a hosted backend platform: one WORKSPACE serves a managed PostgreSQL",
    "database, HTTP API endpoints, background tasks, realtime websocket channels, AI",
    "agents and MCP servers, file storage, and redis. This SDK authors that workspace in",
    "TypeScript — typed def objects registered on a `workspace(name)` — compiled to one",
    "importable bundle by `xanosdk export ./xano/index.ts`, shipped live by `xanosdk deploy`.",
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
    `Not authorable here: ${m.coverage.objectKinds.unmodeled.map((k) => k.kind).join(", ")} — ` +
      "these cannot be authored and do not survive a pull; reasons in `coverage.objectKinds.unmodeled`.",
    "",
    "This file is the whole always-read surface: the mental model, the deploy contract,",
    "every cross-cutting gotcha, and control flow. Per-surface detail lives in the topic files listed",
    "below — open the one whose condition matches the task, skip the rest. For",
    "exhaustive per-entry detail in NEITHER — a statement's field schema with engine",
    "defaults, a filter's full argument list, the `storedName` mapping — do a TARGETED",
    "lookup in the shipped `manifest.json` (a program imports it as",
    "`@xano/sdk/manifest.json`, needing `with { type: \"json\" }` in Node ESM;",
    "it is ~70k tokens, so never read it whole). Its top-level keys are `" +
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
    "Authoring is **declarative def-objects** passed to factories — there is no",
    "callback/chaining builder.",
    "",
    "```ts",
    'import { workspace, apiGroup, query, table, input, f, ref, inp, auth, s } from "@xano/sdk";',
    "",
    "const users = table({",
    '  name: "users",',
    "  auth: true, // backs authentication",
    "  // `id` (int PK) + `created_at` (epochms) are auto-injected — don't declare them.",
    "  schema: {",
    "    email: f.email({ required: true }),",
    "    name: f.text(),",
    "  },",
    "  // Indexes: { type, fields: [{ name, op? }] }. `\"unique\"` is shorthand for `\"btree|unique\"`.",
    "  // A DOTTED name indexes a key inside a column (`xdo.email`); only the part before the",
    "  // first dot is checked against the schema.",
    '  index: [{ type: "unique", fields: [{ name: "email" }] }],  // also: btree, hash, gin, search, gist, vector',
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
    "Compile: `xanosdk export ./index.ts --out bundle.json` (or `writeBundle(app, path)`",
    "from `@xano/sdk/node` in code). The default export must be the `Xano` registry. The entry must be an",
    "ES module (Xano SDK defs are ESM-only): set `\"type\": \"module\"` in the nearest",
    "package.json or name the entry `.mts`. `npm init -y` writes `\"type\": \"commonjs\"`,",
    "which fails with a \"must be ES modules\" error until you switch it to module.",
    "",
    "Set `canonical` on every `apiGroup`. The engine mints the URL token server-side, so",
    "without one a group's client paths are unresolvable until a lock exists: the bundle",
    "exports fine and `xanosdk routes` / `getPath()` then fail on the very queries it just",
    "built. An explicit `canonical` resolves them from the source alone.",
    "\u26a0 A canonical is unique across the whole INSTANCE, not per workspace \u2014 two",
    "workspaces cannot serve the same one, and no flag shares it. One set in code is a PIN:",
    "a merge refuses (exit 2) when another workspace holds it. One the lock minted is a",
    "preference the instance may keep or replace with a random token, and `--static` is",
    "refused when it does.",
    "",
    "Build warnings: `export()` prints the shapes that deploy clean and then do the wrong",
    "thing (a `bulk.update` zero-filling omitted columns, an `ignoreEmpty` on an empty",
    "operand, a `ref()` nothing binds). Each has a legitimate use, so each only warns —",
    "but nothing fails on a message no one reads, so in CI and in unattended agent builds",
    "pass `--strict` (`emitBundle(app, { strict: true })` / `app.export({ strict: true })`):",
    "every warning becomes a hard failure. Same bundle bytes either way.",
    "Before calling the work done: `npm run typecheck`, `xanosdk export <entry> --strict`,",
    "`xanosdk deploy <entry>`, then `xanosdk test run-all` against what deployed.",
    "",
    "Identity: object guids derive from `(type, name)` — a query's from `(api group,",
    "verb, name)` — so renames change identity.",
    "EVERY build freezes every guid + api-group/toolset canonical in a lock file",
    "BESIDE THE ENTRY FILE — `xano/xano.lock` for the standard scaffold,",
    "NOT the project root — which you COMMIT (`--no-lock` opts out; CI guard",
    "`--frozen-lock` fails instead of changing it).",
    "To rename an object: rename in code, export (stderr prints the exact fix-up), run",
    "`xanosdk lock rename <kind> <old> <new>`, export again — the original guid is emitted",
    "under the new name, so the engine renames in place instead of delete+create. Taking",
    "over an existing workspace: `xanosdk lock import <live-bundle.json>` first, then",
    "export. Pruning, programmatic seeding, and which commands write the lock:",
    "`llms/lock.md`.",
    "",
    "## Deploy",
    "",
    "`xanosdk init` → `xanosdk deploy` → URL. A deploy runs the same compile pipeline as",
    "`export` (honoring `xano.lock`), imports the result, and prints the URL.",
    "⚠ Every deploy is a FULL REPLACE of its destination — objects AND records.",
    "",
    "**Backends** — one grammar: `workspace` | `ephemeral[:<name>]` | `local[:<name>]`",
    "(no credential) | `tenant:<name>` | `release:<name>` | a bundle path where a file fits. Reads",
    "`--from`, writes `--to`, `test --on`; positional on `deploy`/`pull`/`generate`/`tables`/",
    "`impersonate`. Omitted = the ephemeral or Xano Engine this project last deployed to, never",
    "workspace/tenant; bare `deploy` compiles onto the Xano Engine instead (`--ephemeral`: an",
    "ephemeral), and `generate`/`init --from` need one. A refusal, typed or tracked,",
    "names the reason and the spellings (`release create` refuses a Xano Engine).",
    "`release create --from` records a run: no bundle path, no `release:`,",
    "and a `tenant:` only if throwaway (`standard`/`run` refused).",
    "",
    "**Destinations** — the Xano Engine by default, real only when you say so:",
    "",
    "- `xanosdk deploy [source]` → the Xano Engine on this machine (no account). `--ephemeral` → a NAMED, auto-expiring ephemeral (~1h; `--expires-hours`",
    "  1–24), tracked in `./.xano/ephemeral.json`, so deploying again REFRESHES it at the same",
    "  URL; if it expired or was swept, a fresh one is created and the new URL called out.",
    "  ⚠ Only the BACKEND URL survives a refresh — the replace clears static hosting, so",
    "  `--static` publishes a NEW host every run and the previous URL stops serving",
    "  (not under `--keep-data`, which MERGES an env a deploy filled: rows kept, no re-seed,",
    "  removed objects deleted; ⚠ a rename loses values, a RETYPE reads unfit ones as null, env",
    "  VALUES are not applied, a table trigger refuses it — `--reset` replaces and re-seeds).",
    "- `xanosdk release create <name>` cuts from a running source and LANDS in your workspace",
    "  — the record that it came up, and the only thing `promote`/`tenant deploy` take. A",
    "  taken name is refused, and so is one that addresses a LOCATION instead of naming: `/`,",
    "  `\\`, `:`, or a leading `.`. Every export derives its FILENAME from the name it is given,",
    "  so `release|ephemeral|workspace export` refuse those same shapes unless `--path` names",
    "  the file. Carries EVERY table's SCHEMA either way; `--seed[=<guids>]` adds",
    "  ROWS — guids from `xanosdk tables <backend>`; a redeploy KEEPS them.",
    "- `xanosdk release transfer <name> --to-profile <profile>` copies a release to another",
    "  workspace/instance by CONTENT (tar sha256): identical → reused; same name, other",
    "  bytes → exit 2.",
    "- `xanosdk promote <release>` / `xanosdk tenant deploy <tenant> <release>` land it.",
    "  `promote` adds a branch; ⚠ its TABLE edits hit live",
    "  (`--allow-shared-schema-changes`). `tenant deploy` REPLACES: DROPS tables it lacks,",
    "  CONVERTS retypes (`--seed`: rows).",
    "  `promote` refuses a taken name/pinned slug (`SDK_IDENTITY_CONFLICT`), then",
    "  EXITS NON-ZERO if a declared object did not arrive or a pinned slug is not served;",
    "  `--set-live` waits on that (previous branch serving). Extra objects: reported;",
    "  a check missing an input reports `unverified`, exit 0. `--json` on every release write:",
    "  `completed` yes|no|unknown; UNKNOWN exits 9 — run `resolveWith`, never retry blind.",
    "  `--expect-live <label>` (with `--set-live`) refuses if live moved; not atomic. Inspect a staged branch with",
    "  `workspace export --branch <label>` or `workspace diff <entry> --branch <label>`.",
    "  \u26a0 The redis family, `s.lambda`, `s.db.direct_query`, `s.await`, `s.microservice.request`,",
    "  `s.zip.*`, the raw-file readers, Datadog and Webflow need an INSTANCE CAPABILITY: they",
    "  deploy clean and fail on the first request if the target lacks it. `export`/`deploy` list",
    "  what the bundle needs — compare it to the target yourself.",
    "- Backend SECRETS stay out of the repo: declare the NAME, value empty, in `workspaceConfig({ env })`",
    "  passed to `registerWorkspace()`; the VALUE lives in `xano/.env` — gitignored, kept across a",
    "  pull, read by every build. `--backend-env-file <path>` replaces that default (CI has",
    "  no `xano/.env`), `--env-var KEY=VALUE` beats both, and `xanosdk env pull` fills the file from",
    "  a running backend — the only command that writes `xano/.env`.",
    "  ⚠ A deploy REPLACES the env set: a declared name with NO value refuses the deploy rather",
    "  than clearing the live one — `--allow-empty-env=NAME` clears it on purpose.",
    "  ONE live value, no deploy: `xanosdk env set NAME` (value on stdin) / `env unset NAME`.",
    "  (`--static-env` is the other one — PUBLIC frontend config.)",
    "- A DOCUMENTATION token is a secret too, in a SECOND ignored file: source declares only the",
    "  gate — `documentation: { require_token: true }` on `workspaceConfig` or an `apiGroup` — and",
    "  the value lives in `xano/.secrets.json`, keyed by the object it gates. A literal `token`",
    "  FAILS the export. `xanosdk pull` writes that file and every build reads it back;",
    "  `xanosdk secrets fill` MINTS one per gate that has none — a gate you AUTHORED has no value",
    "  to pull. CI, which does not have the file, passes `--secrets-file <path>` or",
    "  `--doc-token \"<scope>=<value>\"`",
    "  (scope = `workspace`, or the group's NAME).",
    "  \u26a0 OMISSION IS OPPOSITE PER SCOPE: off `workspaceConfig` the target's gate is left alone;",
    "  off an `apiGroup` it is CLEARED (an absent key there is written as the engine default). An",
    "  unsupplied gate refuses a `deploy` and fails the export for a publishing group.",
    "- `xanosdk deploy --to workspace|tenant:<name>` skips the release flow to merge a LOCAL",
    "  build in, keeping the checks that need one (`--dry-run`, `--prune`, loss warnings) and",
    "  leaving nothing to roll back to. Prefer the release path.",
    "  ⚠ Branches scope LOGIC: tables and microservices are shared by EVERY branch, so a",
    "  schema change reaches production on any branch — refused without",
    "  `--allow-shared-schema-changes` — and dropping a column destroys its data.",
    "  ⚠ `--replace` CLEARS BY WORKSPACE, NOT BY BRANCH: every non-live branch goes, with the",
    "  saved versions that would restore one — unrecoverable. Refused without",
    "  `--allow-branch-deletion`; `--yes` does not imply it. The default merge leaves them alone.",
    "- `xanosdk workspace reset-tables <entry> --table <guid>` puts NAMED tables back to their",
    "  compiled `table({ seed })` rows, touching no other table. Dry run unless `--write`.",
    "  ⚠ ROWS BEFORE LOGIC: rows are workspace-shared like schema, so they reach production when",
    "  applied even while the logic reading them is staged — no ordering makes a half-data change",
    "  atomic. Reset rows FIRST, then `promote`: new rows under old logic break only a feature",
    "  being removed; new logic over old rows breaks the one you are shipping.",
    "- `xanosdk pull` refreshes THIS project from a backend: rewrites decoded files,",
    "  keeps yours, lists and confirms (`--yes`).",
    "- `xanosdk generate <source>`: the decoded tree ONLY, no project.",
    "- `xanosdk status` names the env this project last deployed to, its URL and its expiry.",
    "",
    "**Frontend wiring.** `--static <dir>` (or `xanosdk publish <dir>`) injects the env's backend URL as",
    "`window.XANO_HOST` into EVERY html document in the build, before the app bundle runs,",
    "so the frontend needs no rebuild to target an env. How to read it, local dev, verifying",
    "the inject, and displaying a stored file: `llms/client.md`.",
    "⚠ A static host serves its files verbatim, so everything injected is PUBLIC — base",
    "URLs and publishable keys only, never secrets. Secrets go in backend env, read",
    "server-side via `env(name)`.",
    "⚠ `xanosdk preflight` uses the deploy credential unless `XANO_VALIDATE_INSTANCE` /",
    "`XANO_VALIDATE_TOKEN` (+ optional `XANO_VALIDATE_WORKSPACE_ID`) are set.",
    "",
    "**Full CLI surface:** `xanosdk <command> --help` — every command, flag, default and accepted",
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
    "- **Reference-helper picker:** `ref` = stack var (`as:` output), `inp` = input,",
    "  `col` = table column (in `db.query` `where`), `auth(\"id\")` = the caller,",
    "  `c.*` = a constant. Pick by what you're pointing at.",
    "- **Foreign key is `f.tableRef(table)`, not `ref`.** `ref(name)` references a",
    "  stack variable (a value); `f.tableRef` is the column constructor.",
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
    "- **To match every row, omit `where` — never pass a constant.** `where: c.bool(true)` is",
    "  not \"no filter\": a bare scalar literal states no condition and the engine reads the",
    "  resulting `context.search` as garbage, so it throws. An absent `where` is how \"every",
    "  row\" is spelled. A raw `Value` `where` stays the escape hatch for a clause built",
    "  elsewhere — `inp(\"clause\")`, `ref(\"built_where\")`, or `c.text(\"id > 0\")`.",
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
    "  instead of failing. Both at HTTP 200 and plausible on read, so it surfaces as",
    "  arithmetic that stops reconciling. Hold money as a count of the smallest unit;",
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
    "  `db.has`/`db.patch` match one field: `{ fieldName, fieldValue }` (`fieldName`",
    "  defaults to the PK `id`). Only `db.query` takes a `where`/`additionalWhere`",
    "  `expr(...)`; writes (`db.add`/`db.edit`/`db.add_or_edit`) take a `row`/`data`.",
    "  Signatures: `llms/statements-data.md`.",
    "- **Single-field only — no composite match.** These ops match exactly ONE field;",
    "  there is no two-field form (the engine's by-field lookup takes a single",
    "  predicate). For a `(a, b)` existence/fetch — e.g. dedupe a `(habit, date)`",
    "  check-in — use `db.query({ where: [expr(col(\"habit\"), \"=\", ...), expr(col(\"date\"), \"=\", ...)], as })`",
    "  (a `where` array is ANDed) and branch on the result, rather than pushing the",
    "  check to the client.",
    "- **Drilling into a maybe-null `db.get` result 500s — use `ref(path, { safe: true })`.**",
    "  `db.get` binds `null` on a no-match, but a nested `ref(\"owner.user_id\")` raises a runtime",
    "  \"Unable to locate var\" (HTTP 500) when `owner` is null — an ownership guard throws instead",
    "  of failing cleanly. Two correct shapes:",
    "  - Guard existence first — `s.precondition({ expr: expr(ref(\"owner\"), \"!=\", c.null()),",
    "    error_type: \"notfound\", error: c.text(\"Not found.\") })` — then drill WITHOUT `safe`.",
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
    "  real request with `ERROR_FATAL: <Type> does not exist: <type>:<n>` — and not per",
    "  host kind, the same call fails identically from a function a query runs.",
    "  `export()` refuses them. `s.function.call`, `s.tool.call`, `s.middleware.call` and",
    "  `s.addon.call` run anywhere, as does `s.function.run` (the ordinary function",
    "  invocation). To share logic between endpoints, put it in a `defineFunction` and",
    "  `s.function.run` it from both.",
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
    "  - A bare `c.text(\"^…$\")` is an invalid pattern that matches *nothing* for every input,",
    "    so a precondition on it silently rejects all values. `c.regex(body, \"i\")` wraps +",
    "    escapes it for you (a JS `RegExp` too: `c.regex(/^…$/i)`).",
    "  - Reversed — subject piped, pattern in the argument — reads correctly, type-checks, and",
    "    answers false for EVERY input, so an `if (matches) reject` guard admits what it refuses.",
    "  - Build time refuses both: `withFilters` throws on a bare `c.text` pattern from ANY position",
    "    in the chain (a normalizer in front of the regex filter is refused too; nothing upstream",
    "    adds the delimiters) and on a pattern found in the subject slot; `s.expect.to_match` is the",
    "    same PATTERN slot, refused both ways; a `ref`/`inp` pattern is passed through untouched.",
    "    `export()` warns on a reversed pair in stored bytes.",
    "  - Better still: a native typed input (`input.email`) over hand-rolled validation.",
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
    "  Guids derive from `(type, name)`, so two functions (or tables, toolsets, …) sharing",
    "  a name derive ONE guid and `export()` throws — give them DISTINCT names. A QUERY",
    "  derives from `(api group, verb, name)`, the engine's own uniqueness: `GET items` +",
    "  `POST items`, and `items` across two groups, coexist, and the lock keys the same",
    "  composed identity (`query:blog|GET|items`) — changing a query's verb or group",
    "  changes its identity. An explicit `guid` on a colliding pair clears the throw but",
    "  is NOT a lasting fix: a lock entry cannot hold two guids, so `export --lock`",
    "  refuses the pair (`export()` warns even unlocked); it is for pinning identity",
    "  across a rename, not for sharing a name.",
    "- **`export()` vs `emitBundle()` vs `writeBundle()`:** `export()` returns the object,",
    "  `emitBundle()` the JSON, `writeBundle(app, path)` writes `xanosdk export`'s file. All",
    "  three run the SAME build-time checks, INCLUDING seed validation of a literal `seed: [...]`",
    "  array (row shape, unknown column, coercion, enum membership, the all-or-nothing `id`",
    "  rule). A DEFERRED seed — a thunk (`() => import(\"./seed.json\")`) or `seedFile()` — is",
    "  checked only by the `xanosdk export`/`deploy` CLI path. Only `deploy` ships seed rows.",
    "  - Entry points: the `node:fs` writers (`writeBundle`/`writeArtifact`) and lock-file I/O",
    "    import from `@xano/sdk/node`, NOT the browser-safe `@xano/sdk` entry (a frontend",
    "    imports from it; request types come from `routes.gen.ts`). `@xano/sdk/internal` is the",
    "    compiler machinery, never needed to author. READING a bundle back is `@xano/sdk/bundle`",
    "    — a statement walker (`2.if.0` paths), a structural hash, `mvp:*` catalog, `tableRefOf`.",
    "- **Intra-workspace imports use `.js` specifiers** (`../tables/links.js`), not",
    "  extensionless — the defs compile under `moduleResolution: bundler`. Add the `.js`.",
    "- **Agents authenticate with env vars — never `xanosdk login`.** `login` blocks on a",
    "  browser consent no agent can complete. Set all three of `$XANO_INSTANCE_URL`,",
    "  `$XANO_WORKSPACE_ID`, `$XANO_META_TOKEN` and run `deploy`/`promote` directly: no disk, no",
    "  rotation, so it survives repeated runs.",
    "  - The triple outranks every other credential (`--config`, `$XANO_PROFILE` and",
    "    `$XANO_REFRESH_TOKEN` included, each named on stderr when displaced). Setting SOME of the",
    "    three is a hard error, so a misspelled secret cannot fall through to whatever credential",
    "    the runner has. An explicit `--profile` against it is a hard error too, not a displacement.",
    "  - On disk: `xanosdk profile add <name> --instance … --workspace-id <n>` reads the token",
    "    from piped stdin, else PROMPTS (a flag would reach the process list); the instance must accept it.",
    "    `auth.json` holds a map of named profiles, selected by `--profile <name>`. The older",
    "    `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID` pair still works but ROTATES: single-use.",
    "- **Event-driven objects fire on an EPHEMERAL.** A `task` (scheduled), an `mcpServer`,",
    "  and every trigger — `tableTrigger` included — run normally on an ephemeral env, which",
    "  is where `deploy` sends them. So test an event-driven design (screen-on-insert, cron",
    "  cleanup, MCP tool call) by deploying it and letting it run.",
    "",
  );

  const objectKinds: string[] = [];
  objectKinds.push("## Object kinds", "");
  objectKinds.push("Author with the factory, register on the Xano instance, lands under the payload key. Each line ends with a one-liner on what the primitive is.", "");
  objectKinds.push(
    "⚠ Composing a workspace from independently-authored modules: `register*` takes its defs however they arrive, but `modules.flatMap((m) => m.tables)` does NOT typecheck. `Array.prototype.flatMap` binds its element type to the FIRST element, so every later module's tables are checked against that one table's schema — the error compares two unrelated column names and mentions neither `flatMap` nor the cause. `.concat()` collapses the same way. Two spellings work: pass an array LITERAL (`registerTables([...a.tables, ...b.tables])` — spreads are fine, TypeScript infers the union across every element at once), or annotate the module array with the wide aliases `AnyTableDef` / `AnyQueryDef` / `AnyFunctionDef` / `AnyAddonDef`, exported for exactly the four def types whose generics can collapse this way. Widening the array costs nothing: the typing you need lives on the `table()`/`query()` handle you hold and pass to `s.db.*`, and is never read back off the registered array.",
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
    "  - `verb`: `\"GET\" | \"POST\" | \"PUT\" | \"PATCH\" | \"DELETE\" | \"HEAD\"` (required), UPPERCASE. Anything else — most often a lowercase `\"post\"` — makes `query()` THROW, because Xano does NOT reject it: it stores the verb as NULL, a null verb serves as GET, and the endpoint then answers on the wrong method while the one you meant 404s `Unable to locate request.`",
    "  - `apiGroup`: an `apiGroup()` def handle (or its name) — binds by guid, stable across syncs. Raw numeric `apiGroupId?` is the escape hatch and wins if both given.",
    "  - `auth`: `false` (no auth) or an auth-table id; `responseType`: `\"standard\" | \"stream\"` (default `standard`) — any other spelling THROWS, since Xano stores an unrecognized one as NULL and a null buffers as `standard`, so a misspelled stream quietly does not stream.",
    "  - `name` is the endpoint PATH within the group.",
    "    - A `{param}` segment is a URL PATH PARAM bound to the input of the same name, and segments chain: `name: \"blog/{slug}/review/{review_id}\"` + `input: { slug: input.text(), review_id: input.int() }`. Read it with `inp(\"slug\")` like any other input.",
    "    - Every `{param}` MUST have a matching input or `query()` THROWS — Xano treats an unbound marker as inert route text, so the endpoint would answer on the path and see nothing.",
    "    - A `{param}` need NOT be a whole segment (`\"blog/post-{slug}\"` routes fine), but its type must fit one segment (no object/list/json/file/geo/vector); there are no wildcards or patterns. `required: true` is NOT demanded (the engine's editor leaves path inputs unmarked).",
    "    - An input a `GET`/`DELETE`/`HEAD` looks ONE ROW up by (`s.db.get`/by-field edit/patch/delete; not `has` or an email/token/code) belongs in the path — `export()` warns `query.path-segment-candidate`: `getPath()` types STATIC. A segment is any value naming WHICH resource is wanted (`\"shop/{country}\"`); one that NARROWS A LIST (`s.db.query`) stays a query param. Intended? `diagnostics: { allow: [code] }` on the query (any def, for its own advisories) accepts it under `--strict`.",
    "    - Routes are matched FIRST-FIT in creation order, and a literal gets NO precedence over a `{param}`: `\"runs/{id}\"` (a text `id`) created before `\"runs/trend\"` answers `GET /runs/trend` itself. Two routes in one group and verb that one request path can match are REFUSED at `export()` (`query.route-shadowed`) — reordering `registerQueries` cannot fix it, since a release keeps an existing route first. Make the paths disjoint (`\"runs/by-id/{id}\"`), or declare a numeric param `input.int({ required: true })` (or `decimal`): only a REQUIRED int/decimal segment matches digits only — an OPTIONAL one matches any text, so `input.int()` still takes `trend`.",
    "    - Inputs absent from the path are ordinary query-string/body params.",
    "    - Name charset is ONLY `A-Za-z0-9_-/{}`, max 200: a `.` (`\"export.zip\"`) is NOT rejected by Xano — it stores an EMPTY name that deploys clean then 404s forever, so `query()` THROWS. Use `\"export_zip\"` and set the extension in the response headers.",
    "  - **Client recipe:** `q.getPath({ params: { slug: \"hello\" } })` → `/api:<canonical>/blog/hello` — never interpolate by hand.",
    "    - `getPath` percent-encodes each value (so `?`/`#`/spaces stay in their segment) and throws on what encoding cannot contain: a `/`, and a segment that becomes `.`/`..` as sent (a URL parser drops those before routing, addressing a different endpoint).",
    "    - The keys are typed from the literal `name`, so a typo is a compile error.",
    "    - `q.toSearchParams(input)` drops GET path params (free `query.toSearchParams` keeps them); lists send `k[]=a&k[]=b` (`k=a&k=b` binds only `b`).",
    "  - Browser bundle cost, the `routes.gen.ts` alternative (paths and request types), and spot-checking a def from Node: `llms/client.md`.",
    "- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors?, middleware? })` — a query container; queries bind to it via their `apiGroup`. `canonical` holds only letters, digits, `_` and `-` (it is the `<canonical>` of `/api:<canonical>`); anything else THROWS at build.",
    "  - `documentation?`: `{ require_token? }` — the gate on this group's hosted docs. `require_token: true` IS the declaration; the token lives in `xano/.secrets.json` under this group's guid, and a literal `token` FAILS the export. ⚠ ALWAYS emitted, present or not: an absent key is written as the engine default on import, so omitting the block CLEARS an existing gate (the opposite of the `workspaceConfig` rule). `swagger: true` publishes the docs; `require_token` gates them only alongside a non-empty token, so `swagger: true` with no gate makes the whole group readable by anyone with the URL — export warns once per build and `--strict` fails; `diagnostics: { allow: [\"api-group.docs-public\"] }` accepts it. A declared gate with NO token drops the block, so those bytes clear it: export FAILS under `swagger: true`, and with `swagger` off warns and completes.",
    "  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.",
    "    - `mode?`: `\"default\"` (the default) | `\"custom\"` | `\"disabled\"`, lowercase — a fourth value THROWS at export (`apiGroup()` itself does not check), because Xano neither rejects nor blanks it: it DROPS THE WHOLE API GROUP on import, so the deploy succeeds and every query in the group 404s. ⚠ Every OTHER field applies only under `\"custom\"`: `\"default\"` serves a FIXED permissive policy (any origin, `allow-headers: *`, `allow-credentials: true`, `max-age: 86400`) and ignores the block, so setting `maxAge`/`allowCredentials`/`allowHeaders` alone changes nothing. `\"disabled\"` sends no CORS headers at all, so every browser call fails.",
    "    - ⚠ Under `\"custom\"`, `allowOrigins` is matched as EXACT strings (scheme+host+port, no wildcard or subdomain expansion) and `\"*\"` is compared as a literal origin — it matches NOTHING. An unmatched origin gets no `access-control-*` headers at all, so the browser call fails while export, deploy and the preflight look fine. Name each origin, or use `mode: \"default\"` for any-origin. `allowMethods` gates the REAL response too: a verb left off gets no CORS headers back even though its preflight passes. Export warns on an empty origin list, a `\"*\"` entry, and a policy with no method enabled; a non-origin entry (trailing `/`, path) is refused.",
    "- Tasks, workflow tests, middleware and tools below (agents and MCP servers: `llms/kinds-agent-mcp.md`) share the envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.",
    "- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`). `active?` defaults `true`; `active: false` deploys it parked.",
    "  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`. `startsOn`/`endsOn` are **timestamp strings** validated at encode time — `\"2026-01-01T00:00:00Z\"`, or the space-separated `\"2026-01-01 00:00:00+0000\"` a pulled workspace carries — never epoch numbers, and never zoneless; `freq` is the repeat interval **in SECONDS** (omitted ⇒ runs ONCE) — spell it `every(\"15m\")`, a compile-time duration-to-seconds helper (`s`/`m`/`h`/`d`/`w`, terms concatenate). No cron, no timezone — a fixed-offset `startsOn` drifts an hour at each DST change; for a local time run hourly, gated on the local hour `withFilters(c.now(), fl.epochms_date(\"G\", \"America/New_York\"))`. `repeatEnabled?`/`endsEnabled?` follow whether `freq`/`endsOn` is set and are recovery-only — state one to reproduce a stored gate left OFF. Fires on an ephemeral (see Gotchas).",
    "- `workflowTest({ name, guid?, description?, docs?, datasource?, active?, tags?, stack? })` — an end-to-end test. NO `input`/`response`: `.call` something with an `as`, then assert on that var — `s.function.call({ fn, input, as: \"r\" })`, `s.expect.to_equal({ expr: ref(\"r\"), value: c.int(42) })`. `s.expect.*` belongs here — it is not inert elsewhere (a failure 500s the request), so treat one in a query/function/task as a mistake to remove. `active?` defaults `true`; chain tests with `s.workflow_test.call({ workflowTest: <def handle> })`.",
    "  - `datasource?`: Default `\"\"` is an EMPTY datasource (recommended), not \"no datasource\". Any non-empty name makes the engine CLONE it before EVERY run — against production-sized data, slow enough to fail the run, which is why `\"live\"` warns at compile time. On an EPHEMERAL, `\"live\"` holds only the seed fixtures (plus rows a `--keep-data` deploy kept), so it is the way to read `table({ seed })` rows — a small clone, dropped after the run. ⚠ The value is STORED, so clear it before you promote or the same test clones the real database.",
    "- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response?, responseShape?, tests? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`. ⚠ `input` ENCODES but an ATTACHED middleware never has it bound — the host request binds its own inputs, so `inp()` inside pre/post fails at runtime with `Unable to locate input` and a declared default does not stand in (`export()` warns). Read the request body with `s.util.get_all_input` instead; it yields a `{ type, vars }` envelope whose `vars` DIFFERS BY PHASE: `pre` → the request inputs (`payload.vars.<field>`); `post` → `{ status, result }`, the host's outcome (`payload.vars.result.<field>`; plus `payload` on an error). A request field read in `post` 500s after the host already ran (`export()` warns); read the request there with `s.util.get_raw_input`. `s.middleware.call` is the one path that DOES bind the declared map.",
    "  - `resultStrategy?`: `\"merge\" | \"replace\"` (default `merge`) — how the middleware `response` folds into the accumulator of the phase it is ATTACHED to, and the two phases accumulate DIFFERENT things. In `post` the accumulator is the host's RESULT, so a returned object changes what the CALLER receives. In `pre` it is the host's REQUEST INPUTS, so a returned object changes what the HOST receives. `merge` folds key-by-key, `replace` substitutes wholesale; either way the next entry in the chain sees the updated value. So `pre` + `replace` DISCARDS every caller input the middleware does not re-emit, and a discarded input is then unreadable — a 500, even where it is declared `required: false`, because input defaulting has already happened by the time the override lands.",
    "  - `exceptionPolicy?`: `\"silent\" | \"rethrow\" | \"critical\"` (default `\"rethrow\"` — a throw ABORTS the request and surfaces the authored error/status, which is what a guard wants). `\"silent\"` swallows the throw and lets the request through, so a guard set to it is NOT enforced — use it only for advisory middleware. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain.",
    "- `tool({ name, guid?, description?, instructions?, docs?, enabled?, title?, annotations?, icons?, output?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`. `title`/`annotations`/`icons`/`output` are MCP metadata (`llms/kinds-agent-mcp.md`).",
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
    "- `op`: `=`, `!=`, `>`, `<`, `>=`, `<=` (JS aliases `==` `===` `!==` are accepted and normalized).",
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
    "  those (ANDed), or (for `where`) a raw `Value`. `s.conditional`/`s.while`/`s.switch`, `db.query`,",
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
    "- `knowledge({ name, description?, type?, mode?, enabled?, body, refs?, guid?, tags? })` — markdown Xano's own AI reads before it acts — the workspace's builder agent, and outside agents reading the workspace through the Meta API or MCP. It does NOT reach an `agent()` run by `s.ai.agent.run`, whatever its `type` or `mode`: put what such an agent must know in its `llm.systemPrompt`. Takes `registerKnowledge`.",
    "  - `body` (REQUIRED): `knowledgeFile(\"./runbook.md\", import.meta.url)` — a path to a real markdown FILE. There is no inline-string form. The path resolves relative to the MODULE THAT DECLARES the item, not the process working directory and not the workspace entry; `import.meta.url` is required and is what makes that true.",
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
    "- ⚠ `mode: \"always\"` on a long body spends its whole length on every request, and nothing in the types says so. `\"auto\"` is the default for that reason. For an `auto` item `description` is ALL the agent sees until it decides to load the body, so write it to be matched against a request rather than as a title.",
    "- `name` takes letters, digits, and `/ _ - { } . ` or a space; anything else is an export error.",
  ];

  /** Toolchain modules: only a project that installs one needs this. */
  const toolchain: string[] = [
    "**Toolchain modules** extend the CLI, not the workspace — nothing to register in",
    "`xano/index.ts`. An installed one runs on `export` and `deploy` (after the compile,",
    "before the upload) and is verified, never rewritten, under `--frozen-lock`. Config",
    'lives in this project\'s `package.json` `"xanosdk"` block, keyed by package name.',
    "⚠ `marketplace install <pkg>` is not just `npm install`: it asks the module its questions",
    "and writes that block plus the `.gitattributes` lines it contributes. A module that",
    "arrived any other way (a plain `npm install`, a merged PR) is configured by running that",
    "same command on it; until then `export`/`deploy` report it unconfigured and it runs on",
    "shipped defaults. `marketplace reinstall <pkg>` re-asks with the current settings as the",
    "defaults and re-enables a disabled one; `marketplace remove <pkg>` drops block, lines and",
    "dependency together — a plain `npm uninstall` leaves the block, and a package it names",
    "that is no longer installed fails every `--frozen-lock` run.",
    "",
    "**A module's section of `xano/routes.gen.ts`.** A module with a `routesManifest` hook (types:",
    "`@xano/sdk/plugin`) writes a block between `// xanosdk:begin <pkg>` and `// xanosdk:end <pkg>`",
    "after the core sections, on every write of the file (`routes --emit`, `xano:routes`, `pull`,",
    "`generate`, `marketplace install|reinstall|remove`). Edits inside the block are overwritten.",
    "Install also adds the module's non-SDK peers (e.g. `zod`) as direct dependencies.",
    "The hook is synchronous and pure: given",
    "the request inputs under the manifest's keys and its config, it returns `{ imports?, source }`,",
    "imports as bare package names (`@xano/sdk*`, relative and `node:` are refused). A module that",
    "fails to load or throws leaves its previous block as it was, with a warning naming it, and the",
    "core sections still refresh; under `routes --emit --strict` it is fatal. `@xano-sdk/zod`",
    "(`xanosdk marketplace install zod`) is one: it adds `ROUTE_SCHEMAS` and its siblings.",
  ];

  const client: string[] = [
    "Importing a def into a browser bundle or a Node script — for `getPath()`, `getUrl()`, `verb`, or `InferResponse` — runs its factory calls; these are the costs and the checks.",
    "",
    "- **Client bundle size / tree-shaking.** `@xano/sdk` is `sideEffects: false` and pulls",
    "  no Node built-ins, so a bundler drops unused SDK exports. But importing a **def** for its",
    "  `getPath()`/`verb`/`getUrl()`/`getChannel()` also pulls whatever its `stack` references:",
    "  the `s.*`/`c.*` factory CALLS run at module load to BUILD it. Types are free.",
    "  ⚠ A FLOOR — **~267 kB minified (~65 kB gzipped)** for the FIRST def; splitting modules",
    "  never removes it. The floor is the RUNTIME, not the def: a second or much richer def",
    "  adds ~2 kB, so trimming a def does not shrink it.",
    "  Fix: `xanosdk routes <entry> --emit xano/routes.gen.ts` (`paths` is an accepted alias) — verbs, paths, and sockets as",
    "  plain data importing NOTHING, still compile-checked: `routePath(\"GET blog/{slug}\", { slug })`",
    "  `channelPath(\"rooms/{room_id}\", { room_id })`, `socketUrl(\"chat\", baseUrl)` (tenant base",
    "  URLs lifted to `wss://h/ws/<tenant>:<canonical>`). A rename is a type error, not a 404.",
    "- **Request types without the def.** `routes.gen.ts` also exports types-only `RouteInputs`,",
    "  `ChannelInputs`, `MessageInputs` (and `MessageName`), keyed like `ROUTES`, `CHANNELS`, and",
    "  `\"<channel key> <message name>\"`: `type NewListing = RouteInputs[\"POST listings\"]`. A",
    "  frontend types bodies, channel params and payloads from these, not `InferInput` on a def;",
    "  keep `InferInput` in code that already imports defs. They match `InferInput`, except a",
    "  `dbLink` input appears as the linked table's columns (what the server accepts). Responses",
    "  are not in the file: `InferResponse` on an `import type` of the def.",
    "  Runtime validation: `xanosdk marketplace install zod` adds `@xano-sdk/zod`, which writes",
    "  `ROUTE_SCHEMAS`/`CHANNEL_SCHEMAS`/`MESSAGE_SCHEMAS` into the file under the same keys, each",
    "  checked against its type at typecheck; the file then imports `zod`, never `@xano/sdk`.",
    "- **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack) importing a",
    "  query def to read `getPath()`/`verb` works directly. To spot-check from Node, run a REAL",
    "  file with `tsx <file.ts>` **from inside the project root** — not `tsx -e \"import …\"`",
    "  (its CJS-preparse mis-resolves the package `exports` map → ERR_PACKAGE_PATH_NOT_EXPORTED),",
    "  and not bare `node file.ts` (chokes on the `.js`-specifier intra-workspace imports the",
    "  xanosdk CLI's own loader resolves). Running from outside the project root also breaks",
    "  the `@xano/sdk` specifier resolution.",
    "",
    "**Reading the injected backend URL.** `xanosdk deploy <entry> --static <dir>` writes the deployed env's URL",
    "into every html document: a prerendered build serves a different one per",
    "route, and a route without the global renders fine while every call goes to the wrong",
    "origin. Read it at runtime with a build-time fallback:",
    "  const HOST = (typeof window !== 'undefined' && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;",
    "The scaffold's `lib/api.ts` types it (`interface Window { XANO_HOST?: string }` — `undefined` in dev)",
    "and exports this as a `string`, `XANO_HOST`; outside a scaffold declare the global yourself.",
    "In LOCAL DEV there is no injected global, so the fallback is what answers: set",
    "`VITE_XANO_HOST` in a `.env.local` beside `.env.example` at the PROJECT ROOT. The",
    "scaffold's vite config sets `envDir` there (its `root` is `frontend/`, and Vite",
    "resolves `.env` files against `root`) — without it the var reads as undefined, the",
    "host falls back to '', and every call 404s off the dev server.",
    "⚠ It is INJECTED in bracket form — `window[\"XANO_HOST\"]=\"…\"` — so verifying a deploy",
    "by grepping `window.XANO_HOST` matches nothing and reads as a failed inject. Grep the",
    "bare `XANO_HOST` token.",
    "**Frontend without the backend.** `xanosdk publish <dir> [--to <backend>]` uploads an",
    "already-built directory and nothing else — no compile, no import (scaffold script",
    "`npm run xano:deploy:frontend`). A Xano Engine (`--to local`, or bare after a local",
    "deploy) serves it, server half included, at `http://<prefix>.localhost:<port>`.",
    "**Server-rendered SvelteKit.** `adapter()` from `@xano/sdk/sveltekit` (needs `esbuild`) writes",
    "the static half at the build's root plus a server half in `.xano-ssr/`. A Xano Engine renders every",
    "path that is not a file through it (`load` reads the engine's own URL as `XANO_HOST` from",
    "`$env/dynamic/private`; a rendered page gets the deploy's `window.XANO_HOST` too). Any other host",
    "is not sent `.xano-ssr/`: it serves the static half and answers other paths with the `404.html`",
    "shell, where a route with a server `load` fails (no `__data.json`). A scaffolded project configures",
    "SvelteKit in `vite.config.ts`'s `sveltekit({ adapter })`, where `svelte.config.js` is ignored.",
    "⚠ `.xano-ssr/server.js` inlines `$env/static/private` values; it is never served (`/.xano-ssr/` answers 404).",
    "The injected `XANO_HOST` is the DESTINATION's URL, so one build published to two",
    "destinations serves two different documents. `--release <name>` checks only that the",
    "release exists; `--branch <label>` (workspace only) refuses unless that label is LIVE —",
    "a label match, not a content comparison. `--json` reports `published` and `verified` separately.",
    "**Displaying a stored file.** A file column comes back as `{ path, name, type, size,",
    "meta, access, url }`. ⚠ Do NOT use its `url`: on a tenant-scoped environment that field",
    "addresses the instance host WITHOUT the `/tenant/<name>` segment and 404s, silently —",
    "as a broken `<img>`, with every API assertion still passing. Build the URL from `path`",
    "instead: `fileUrl(row.avatar, HOST)` returns `null` for",
    "an absent file and is correct on an ephemeral and an instance workspace alike.",
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
    "- `ParseError: Invalid value for param` (HTTP 400) — `contains`/`@>`/`overlaps` on a text column (use `includes`), or a joined column qualified without `tableAlias`. `llms/statements-data.md`.",
    "- `ERROR_FATAL: <Type> does not exist: <type>:<n>` — `s.api.call`/`s.task.call`/`s.trigger.call`/`s.workflow_test.call` outside a workflow test; share logic via `defineFunction` + `s.function.run`. `llms.txt`.",
    "- `ERROR_FATAL \"Unable to decode.\"` — a populated JSON string where the engine expects `c.obj`'s form; write `c.obj({...})` or `obj({...})`. `llms/values.md`.",
    "- `Precondition failed.` in place of your message — `error` was a bare string; pass `c.text(\"…\")`. `llms/fields.md`.",
    "- `Param: token - Text filter requires an integer, float, string or boolean value` — `s.api.call` `auth.token` given a tagged `Value`; it must be a bare string. `llms/statements-calls.md`.",
    "- Every `s.db.add` into one table 400s naming a column while complaining about its VALUE — the column is named `run`. `llms.txt`.",
    "- HTTP 200 with an EMPTY body where `0` was expected — a bare `returnType: \"count\"` of zero; wrap it as `{ count: ref(\"n\") }`. `llms/statements-data.md`.",
    "- HTTP 200 with `[]` from a `db.query` that matches rows — a paged query (`metadata: true`, the default) whose `output` names bare columns; the selection applies to the ENVELOPE, so prefix them (`items.<column>`) or set `metadata: false` inside `paging`. `llms.txt`; `llms/statements-data.md`.",
    "- Every field mapped off an `s.api.request` result reads `null` — the upstream answered an error (a 403 for a missing `User-Agent` is the common one) and its body arrived as ordinary `response.result`; send a `User-Agent` and gate on `response.status`. `llms/statements-calls.md`.",
    "- A lambda returns error TEXT with HTTP 200 (`Could not resolve \"node:crypto\"`, an undefined-binding message) — the body threw; use the preloaded globals, the surface's bindings, and `capture`. `llms/lambda.md`.",
    "- `Unable to locate request.` (404) on an endpoint that deployed — a lowercase verb, a `.` in the name, or a CORS `mode` typo that dropped the whole API group. `llms/kinds-core.md`.",
    "- A browser call fails on a missing `access-control-allow-origin` while deploy looks fine — CORS `mode: \"custom\"` with `\"*\"` or an unmatched origin. `llms/kinds-core.md`.",
    "- A websocket is closed right after the handshake — a refused `connect` gate: an empty/falsy return, a crash, or a gating trigger with no `response`. `llms/triggers.md`.",
    "- `to_throw failed - response is ok` around an auth-refused call — `ERROR_CODE_ACCESS_DENIED` carries no message; the auth gate is not reachable from a workflow test. `llms/tests.md`.",
    "- Output reads `Hi [object Object]` — a tagged value inside a JS template literal; compose at runtime with `withFilters` + `fl.concat`. `llms.txt`.",
    "",
    "### Build-time and tooling failures",
    "",
    "- `export --strict` fails on a warning whose shape is meant (a fixture pinning a hazard) — accept it on ITS def only with `diagnostics: { allow: [\"<code>\"] }`, which takes any warning code that def raised (never an error) on every def kind. Accepted warnings are still listed: `export({ accepted: [] })`, `--json` `accepted[]`. An allowed code the def no longer raises warns `diagnostics.allow-unused`.",
    "- `must be ES modules` — package.json says `\"type\": \"commonjs\"`; set `\"type\": \"module\"`. `llms.txt` Quickstart.",
    "- A response types as `StackTupleWidened` — a `Statement[]` helper was spread into the stack; return `statements(...)`. `llms.txt`; `llms/statements-runtime.md`.",
    "- `ERR_PACKAGE_PATH_NOT_EXPORTED` — `tsx -e \"import …\"`, or running from outside the project root; run a real file with `tsx <file.ts>` from the root. `llms/client.md`.",
    "- `Missing statement: mvp:placeholder` on import — an unconfigured slot in a pulled tree; replace it with the statement it stands in for. `llms/legacy.md`.",
    "- A CLI command fails under `--json` or piped (unless stdout carries data): stdout is `{ ok: false, error: { code, message, exitCode, details?, suggestion? } }`, as does a failed release write. Codes: `SDK_SEED_IN_STATIC` (`details.leaks[]` → `publicSeed`), `SDK_EXPORT_INVALID` (`details.diagnostics[]`, `--strict` too), `SDK_DRIFT`, `SDK_BRANCH_TAKEN`, `SDK_BRANCH_LIVE`, `SDK_RELEASE_NAME_TAKEN`, `SDK_RELEASE_FILES_NOT_CARRIED`, `SDK_LIVE_BRANCH_MISMATCH` (`details.conflictsWith`), `SDK_IDENTITY_CONFLICT`, `SDK_KIND_CONFLICT`, `SDK_PRUNE_OUT_OF_SCOPE`, `SDK_IMPORT_REFUSED`, `SDK_SHARED_SCHEMA_CHANGE`, `SDK_CONSTRAINT_VIOLATION`, `SDK_CREDENTIAL_REJECTED` (`details`: `{ profile, credentialType, instance, workspaceId, signIn }`; ids null on a refused env refresh), `SDK_USAGE` (`details.reason: \"needs-confirmation\"`: run its `Re-run as`), `SDK_ERROR`. Landing refusal `details.refused`: identityConflict, renamePending, kindConflict, uniqueViolation, tableTrigger, importInProgress, importRefused, pruneOutOfScope. `warnings[]` / `details.warnings` / `accepted[]` entries: `{ code, message, subject? }` (`subject`: the def's `{ kind, name }`). Backend documents add `selector` and `workspaceId`.",
    "- A CLI command reports `could not reach <url>: fetch failed (<code>)` — blocked egress, not a bad credential; fix it before `xanosdk login`, which rotates a single-use refresh token.",
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
    "| 7 | `upgrade --check`: an upgrade is available. | `xanosdk upgrade`. |",
    "| 8 | A named backend could not be addressed (or a named release, profile, branch, test, module, lock entry, `--seed` guid or Xano Engine version is missing): gone, expired, unreachable, a stopped Xano Engine, or a busy import. | Retry, or redeploy. |",
    "| 9 | A write whose outcome is unknown, Ctrl-C during a write included. | Read the target's state before retrying. |",
    "| 130 | Ctrl-C outside a write or install. | — |",
  ];

  const kindsAgentMcp: string[] = [
    "- `mcpServer({ name, guid?, description?, instructions?, docs?, enabled?, canonical?, spec?, tags?, history?, tools?, prompts?, resources?, oauth?, llm?, output? })` — an MCP toolset. `llm?`/`output?` are the same blocks `agent()` takes and are usually absent: an MCP server and an agent are ONE stored object distinguished by `type`. Returns a handle with `getPath()`/`getUrl(baseUrl)` for the Streamable-HTTP endpoint — `getUrl` is NOT idempotent, a `baseUrl` already carrying an `/x2/mcp/<…>/stream` path THROWS, so resolve ONCE from the instance base URL. Fires on an ephemeral. A TENANT rides AFTER the prefix (`/x2/mcp/tenant/<tenant>/<canonical>/<token>/stream`), not as a base-URL segment: `getUrl` LIFTS a `/tenant/<name>` out of the base and re-places it there, so `getUrl(window.XANO_HOST)` is correct as-is; concatenating them by hand builds an unregistered route that 404s. Pass `{ tenant }` when the base URL cannot name it (a tenant on its own domain).",
    "  - `tools?`: a `ToolsetToolEntry[]`. Pass the `tool()` HANDLES directly (`tools: [saveNote]`); use the `{ tool, enabled?, auth?, type?, resourceUri?, toolMeta? }` wrapper when an entry needs more. `type: \"resource\"` (+ a required `resourceUri`) is the LEGACY way to publish a tool as an MCP resource — author a `resource()` and list it in `resources` instead; `toolMeta` is extra metadata on a tool entry. The two payload fields are per-type and supplying the other one is refused, because the engine stores it against neither. `auth` names an auth **table** (a `table({ auth: true })` handle or its name) — per-tool, and the only gate there is. ⚠ It is also what gives the tool a CALLER, on an `agent()` exactly as on an MCP server. `auth()` inside a tool whose entry names no table does NOT return null: the call answers a normal result carrying `{\"code\":\"ERROR_FATAL\",\"message\":\"\"}`, so the model reads a successful tool result and reports success while nothing is written. A caller token does not rescue it — the ENTRY supplies identity. Spell it `{ tool: saveNote, auth: users }`; `export()` warns. An entry naming no tool THROWS at export; a deliberate raw `id: 0` warns and carries through.",
    "  - `prompts?` / `resources?`: `prompt()` / `resource()` HANDLES (or names), or a `{ prompt, enabled?, auth? }` / `{ resource, enabled?, auth? }` wrapper. `auth` names the auth table and is what gives the stack a caller: a prompt/resource reading `auth()` behind an entry with none answers every `prompts/get` / `resources/read` with `-32603 \"Access Denied\"` (`export()` warns `toolset.primitive-reads-auth-ungated`). Listing one target twice THROWS; two resources with one `uri` on one server fail `export()` (`mcp.resource-uri-duplicate`). MCP-server only — `agent()` takes tools only.",
    "  - `history?` is the server tier for its tools, prompts AND resources alike; an object's own `history` wins. The workspace tier (`workspaceConfig({ history })`) has `prompt` and `resource` keys, both default on.",
    "  - `oauth?`: per-server sign-in; omit and nothing changes. Union on `mode`; `authTable` (REQUIRED, auth `table()` handle or name) is whose row the signed-in user is — `auth()` on the whole server, `t.auth` in its trigger. Hosted (the platform is the authorization server): `{ mode: \"hosted\", authTable, loginUrl }` — clients are sent to `loginUrl` (YOUR page, which is also the consent screen) with `mcp_request`; show `s.mcp.oauth.request`, sign the user in, then your endpoint calls `s.mcp.oauth.complete` with their `decision` and the page redirects to the URL it binds. External (your IdP issues tokens): `{ mode: \"external\", authTable, issuer, column, audience?, audienceAck?, claim?, claimAck?, preset?, allowedClientIds? }` — token `claim` (default `sub`) matched against `column`; `preset` is `auth0|clerk|workos|entra|okta|cognito|generic`. `loginUrl`/`issuer`/`audience` take `env(\"NAME\")` (resolved per environment).",
    "    - `export()` FAILS: hosted without `loginUrl` (`mcp.oauth-hosted-incomplete`); external without `issuer`/`column` (`mcp.oauth-external-incomplete`); `preset: \"clerk\"` without `allowedClientIds` (`mcp.oauth-preset-client-ids`); `claim` other than `sub`/`oid`/`email` without `claimAck` (`mcp.oauth-claim-unacked` — users can edit it at most providers). Unknown `mode`/`preset` THROWS; so do the dropped `consent`/`branding`/`trustedClients`.",
    "- `prompt({ name, guid?, description?, docs?, title?, icons?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — an MCP prompt; takes `registerPrompts`. `input` is the prompt's arguments (each field's `description`/`required`/enum `values` reach the client; enum values also answer completion requests). `response`: a text value is ONE user message; a list of `{ role: \"user\" | \"assistant\", content }` is sent in order: `s.set_var(\"m\", obj({ list: [obj({ role: c.text(\"user\"), content: ref(\"body\") })] }))`, `response: ref(\"m.list\")`. Without `response` or a top-level `s.return`, `prompts/get` fails.",
    "- `resource({ name, uri, guid?, description?, docs?, mimeType?, title?, icons?, annotations?, tags?, history?, input?, stack?, response?, responseShape?, middleware? })` — an MCP resource; takes `registerResources`. Clients address it by `uri`, never `name`.",
    "  - `uri`: a literal (`\"docs://readme\"`, no `input`) or an RFC 6570 LEVEL-1 template (`\"orders://{region}/{order_id}\"`). It must start with a scheme; each `{variable}` is letters/digits/`_`, one per brace pair, never two adjacent. `input` must be EXACTLY the template's variables, each a single `text`/`int`/`decimal`/`bool`/`enum`/`email`/`uuid` — anything else THROWS. A value that does not convert is refused before the stack runs.",
    "  - `response`: a string is returned as text; non-UTF-8 content (a file, binary) as a base64 blob. `mimeType?` omitted → derived from what the stack returns.",
    "  - `annotations?`: `{ audience?: (\"user\" | \"assistant\")[], priority?: 0..1, lastModified?: ISO 8601 string }`.",
    "- MCP metadata, on `tool`/`prompt`/`resource`: `title?` (display name clients show instead of `name`); `icons?: { src, mimeType?, sizes?, theme? }[]` — `src` is `https:` (≤ 2048 chars), a base64 `data:` URI of PNG/JPEG/WebP (≤ 64 KiB), or `hostedFile(\"./icon.png\", import.meta.url)`, a repo file served at each backend's own absolute URL (a pull keeps the `/vault/…` path); SVG, `http:` and every other scheme THROW; `mimeType` is `image/png|jpeg|webp`, `sizes` a list (`[\"48x48\"]`, `[\"any\"]`), `theme` `light|dark`. Tool only: `annotations?: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` — hints; an unset one is derived by the platform — and `output?`, a structured-output schema in the `input` grammar: a returned plain object then reaches the client as `structuredContent` plus a text copy, and a result that does not match is a tool error naming the field.",
    "- `s.mcp.elicit({ key, message, input?, as? })` — ask the MCP client's user mid-call; binds `{ action: \"accept\" | \"decline\" | \"cancel\", content? }` (`content` only on accept, keyed by the `input` field names). `key`: a stable name unique in the stack; `message`: string or value. `input` is the form: a FLAT set of `text`/`email`/`date`/`int`/`decimal`/`bool`/`enum` fields (an enum may be a list); nested objects, files, JSON, timestamps, `password` and `sensitive` fields THROW. Works in tool, prompt and resource stacks.",
    "  - ⚠ The WHOLE stack re-runs from the top when the user answers — everything BEFORE an elicit runs once per round trip, so ASK FIRST, then act. A write before an elicit (`s.db.*` writes, raw SQL, a non-GET `s.api.request`, `s.util.send_email`, `s.function.run`/`.call`, `s.tool.call`) makes `export()` warn `mcp.write-before-elicit`; accept a deliberate one per def with `diagnostics: { allow: [\"mcp.write-before-elicit\"] }`. An elicit inside `s.db.transaction` commits the transaction's earlier writes on every round trip.",
    "  - Input is collected only from clients on MCP `2026-07-28` or later that declare form elicitation. Every other caller — an older client, a debug run, an agent, a workflow test — gets `{ action: \"cancel\" }` and the stack carries on, so ALWAYS handle `cancel`. A runtime error inside an async function run.",
    "- `s.mcp.progress({ progress, total?, message? })` — report progress to a client that asked for it (a no-op otherwise); values never go backwards (a lower `progress` is sent as the last one).",
    "- `s.mcp.oauth.complete({ request, decision, unsafe_user_id?, as? })` — run by the endpoint your `loginUrl` page calls after sign-in; `request` is the page's `mcp_request`. Signs in the CALLER (`auth()`, an `authTable` row whose session token is under 10 minutes old) and binds the single-use URL (text) to redirect to. `decision` (`\"approve\" | \"deny\"`, REQUIRED) is what the user chose on your page. ⚠ `unsafe_user_id` names the row directly, skipping the caller checks — anyone reaching that endpoint signs in as that user.",
    "- `s.mcp.oauth.request({ request, as? })` — a pending sign-in's verified details for your `loginUrl` page to show before the user approves: `{ client_name, client_logo, callback_host, client_verified, server_name }`. Does not consume it.",
    "- `s.mcp.oauth.revoke({ mcp_server, user_id? | grant_id? | all?, as? })` — end hosted sign-ins on a server: EXACTLY ONE of `user_id`, `grant_id`, `all: c.bool(true)`, else `export()` fails (`mcp.oauth-revoke-target`). Binds `{ revoked }`.",
    "- `agent({ name, guid?, description?, docs?, enabled?, canonical?, tags?, history?, llm, tools?, output? })` — an LLM orchestrator. No top-level `instructions`/`prompt`/`spec` — the prompt lives under `llm`. Invoke from a stack with `s.ai.agent.run({ agent, args })`.",
    "  - `llm` (REQUIRED): typed provider settings, a discriminated union on `type` (`\"xano-free\" | \"anthropic\" | \"openai\" | \"google-genai\"`). Shared fields: `systemPrompt?`, `maxSteps?` (default `5`), and `prompt?` XOR `messages?` (genuinely exclusive: both is a type error and throws — the engine stores ONE `prompt_type`, so one would be dropped); plus provider fields (`apiKey?`, `model?`, `temperature?`, `reasoningEffort?`, …). String fields accept Twig placeholders — `{{ $args.x }}` for run inputs (the `args` of `s.ai.agent.run`), `{{ $env.NAME }}` for env vars.",
    "  - `tools?`: same `ToolsetToolEntry[]` as `mcpServer` — bare `tool()` handles, or a `{ tool, enabled?, auth? }` wrapper when one needs `enabled`/`auth`. A tool reading `auth()` MUST use the wrapper naming the auth table — a bare handle runs it with no caller (see `mcpServer`'s `tools?`).",
    "  - `output?`: `{ schema: Record<string, input.*>, enabled? }` — structured-output schema. `schema` is a named-field record authored with the `input.*` catalog, exactly like a `defineFunction`/`query` `input:` map (the stored `structuredOutputsSchema` is the same wire shape as function inputs). e.g. `output: { schema: { priority: input.enum([\"low\",\"high\"]), summary: input.text() } }`. When you pass the agent *handle* to `s.ai.agent.run({ agent })`, `.result` is typed straight from this schema — no `resultShape` witness needed (the shape is declared once). `resultShape` remains only to override that, or to type an agent referenced by bare name.",
    "  - **Run + read recipe (`s.ai.agent.run`):** bind the run to a var (`s.ai.agent.run({ agent, args, as: \"run\" })`) — it produces a rich envelope, and the completion is at **`.result`**. Read one structured field with a dotted ref (`response: ref(\"run.result.priority\")`) or the whole completion (`ref(\"run.result\")`, typed from `output.schema`); persist it in a later step the same way (`s.set_var(\"summary\", ref(\"run.result.summary\"))`). `args` is a plain object of run inputs (`{ topic: inp(\"topic\") }` — raw literals are fine, e.g. `{ max_steps: 3 }`) surfaced to the agent as `{{ $args.topic }}`. `.toolCalls` is the FINAL step's calls only (often `[]`); every call is a `.steps[].content[]` entry of `type: \"tool-call\"`.",
    "  - **Marketplace:** for chat history, use `@xano-sdk/chatbot`; for vector RAG, use `@xano-sdk/vector` (`tools: [vector.searchTool]`). Find add-ons with `xanosdk marketplace search <q>`.",
    "- Both kinds persist under the `toolset` payload key, so a same-name `agent` + `mcpServer` pair derives ONE guid and `export()` throws — give them distinct names.",
  ];

  const kindsRealtime: string[] = [
    "- **Realtime** — the only three-level chain: `realtimeServer` owns `realtimeChannel`s, which own `realtimeMessage` handlers. Pass the HANDLE, not a name (a channel path is unique only within its server).",
    "  - `realtimeServer({ name, guid?, description?, enabled?, canonical?, tags?, history? , middleware? })` — the container.",
    "    - `enabled` defaults to **false** — the one `enabled` in the SDK that does.",
    "    - An enabled server with no active channel still refuses the handshake.",
    "  - `realtimeChannel({ name, server, guid?, description?, active?, input?, anonymousClients?, presence?, publish?, conversation?, delivery?, rateLimit?, tags?, history?, middleware? })`",
    "    - `name` is a PATH (`\"lobby\"`, `\"rooms/{room_id}\"`); `input` types its `{param}` segments, NOT the payload. Every `{param}` MUST have a matching input, and that input must be a SCALAR and not a list (`json`/`object`/`array: true` have no URL form), or `realtimeChannel()` THROWS. `required: true` is NOT checked and is not needed — segment counts must match, so the segment is always present at join. Name charset as query (`A-Za-z0-9_-/{}`, max 200), and so is `tool`; `realtimeMessage` is NARROWER — no `/` or `{}`.",
    "    - Matching is STRICT: a literal segment beats a param (`rooms/lobby` and `rooms/{room_id}` coexist); segment counts must be EQUAL (`rooms/{room_id}` does NOT match `rooms/42/edit`); literals are CASE-SENSITIVE; an empty segment is REJECTED, not collapsed (a leading/trailing/doubled `/` matches nothing). `realtimeChannel()` refuses it and a partial-segment `{param}`; `getChannel()` a value outside `[A-Za-z0-9_-]`.",
    "    - An INACTIVE channel reports the same error as a nonexistent one — deactivating leaks nothing.",
    "    - `middleware?: { pre?, post? }` is the CONTAINER tier, on the channel and on the server alike — the default chain every message inherits, the same shape an api group has. Full chain: message -> channel -> server -> branch/workspace, mirroring `history`. Put a realtime auth or rate-limit guard here rather than repeating it on every `realtimeMessage`.",
    "    - `anonymousClients` also gates CONNECT: a tokenless socket connects only if an active channel of its server sets it (no server flag); each channel admits its own join.",
    "    - `publish?: { who?: \"nobody\"|\"anyone\"|\"authenticated\", direct? }` — `who` defaults to `nobody`: nobody can publish until you set it. `direct` (default false) allows DIRECT messages — a frame whose `options.to = { dbo_id, row_id }` addresses one USER (`dbo_id` = the auth table's id as `s.realtime.get_session` reports it, `row_id` = the user's row id) and reaches every socket of theirs on the channel, no one else; the sender gets a receipt `{ delivered_local, direct: true }`. `direct` REPLACES `who` for such a frame rather than adding to it (`direct: true` with `who: \"nobody\"` delivers direct messages and refuses broadcasts); an anonymous sender is refused. A direct message is never stored in the transcript or the `at_least_once` stream, so an offline user never gets it. ⚠ An `options.to` naming no usable identity is sent as an ordinary broadcast to the whole channel where `who` admits the sender.",
    "    - `conversation?: { enabled?, limit?, ttl? }` — the client-visible TRANSCRIPT replayed to a joiner (distinct from `history`, which is execution history). ⚠ `limit` DEFAULTS TO 0 AND 0 MEANS OFF: `{ enabled: true }` alone records nothing and replays nothing, silently. `ttl` is an IDLE expiry of the WHOLE transcript, refreshed by every write (an active channel never ages out; a silent one loses all of it at once) — NOT a per-message age cap.",
    "    - `delivery?: { guarantee?: \"at_most_once\"|\"at_least_once\", perRecipient? }` — `perRecipient` is independent of the guarantee, is a NO-OP unless the channel declares a `deliver` trigger, and costs a stack PER RECIPIENT PER MESSAGE. Per-viewer redaction needs BOTH HALVES — this flag AND an active `deliver` trigger bound to the channel — and with either missing the payload is delivered UNCHANGED to everyone; `export()` warns on each half alone.",
    "    - `rateLimit?: { messagesPerMinute? }` — 0 = unlimited, checked BEFORE the handler runs. A COST guardrail, not a security control: an anonymous client is bucketed per CONNECTION (reconnecting resets it), and it fails OPEN when its store is down.",
    "  - `realtimeMessage({ name, channel, server?, guid?, description?, active?, auth?, deliverTo?, input?, middleware?, stack?, response?, responseShape?, history?, disabled?, tags? })` — the invocable unit (the realtime analogue of a query).",
    "    - `input` types the message PAYLOAD. `server` is required only when `channel` is a bare path.",
    "    - `deliverTo?`: `\"channel\"` (default) | `\"sender\"` | `\"others\"` | `\"explicit\"`. ⚠ `\"explicit\"` still delivers to NOBODY — nothing selects recipients from inside a handler, and `s.realtime.publish` (which originates an event INTO a channel) is not a substitute.",
    "    - Only `\"channel\"`/`\"others\"` fan out AND are RECORDED in the `conversation` transcript — a `\"sender\"` response is invisible to every future joiner.",
    "  - **Both input surfaces read as ordinary inputs:** `inp(\"body\")` for a payload field, `inp(\"room_id\")` for the channel's `{room_id}`. No session lookup, no frame parsing.",
    "    - A path param is bound ONCE at join and read from the connection thereafter, never from the frame — a sender cannot claim a room it did not join.",
    "  - `s.realtime.get_session({ as })` — the CALLER's realtime session for the current frame. FLAT shape:",
    "    - `authenticated` bool · `client_id` text (the AUTHED ROW ID as text, `\"\"` anonymous) · `dbo_id` int (the auth TABLE's id — NOT the user's row id; `0` anonymous — to look the caller up use `client_id`. `dbo_id` is an int in the same position and typechecks, so a gate that keys on it finds no user and refuses EVERYONE) · `socket_id` int (transport id) · `channel` text (resolved path, `\"\"` in a server trigger) · `params` object (bound path params, `{}` when none — `ref(\"session.params.room_id\")`) · `extras` object · `opened_at` decimal.",
    "    - Works in a realtime MESSAGE stack and in CHANNEL and SERVER trigger stacks; off that path it degrades to an anonymous session.",
    "    - For a path param prefer `inp(\"room_id\")` in a MESSAGE; a lifecycle TRIGGER has only the session. Reach for the session when you need the CONNECTION (identity/extras) — \"who is this sender\" on an anonymous-client channel.",
    "    - ⚠ THREE UNRELATED THINGS ARE CALLED A CLIENT ID: `session.client_id` (app-facing identity), `session.socket_id` (transport), and a frame's `options.client_id` (the at_least_once CURSOR handle). Conflating the first and last breaks at_least_once for anonymous clients.",
    "  - `s.realtime.publish({ server, channel, data, message?, authTable?, authId? })` — the PUSH direction: originate a server-authored event onto a channel from ANY stack, no client frame first.",
    "    - `server` is the handle or its NAME (resolved by name, not guid); `channel` is the FILLED-IN path (`channel.getChannel({ room_id: 42 })`), never the template — a constant still carrying `{param}` THROWS at author time, and a constant `server`/`channel` naming nothing this workspace registers WARNS at export.",
    "    - A PER-ROW path whose id is only known at runtime is built as a value, not with `getChannel()` (which needs the id at author time): `withFilters(c.text(\"rooms/\"), fl.concat(ref(\"room.id\")))`, or `s.set_var` + `s.text.prepend`. A computed `channel`/`server` — a `ref`/`inp`, or a constant carrying a filter chain — is left alone by the export check.",
    "    - DELIVERY-ONLY — fanned out as-is; does NOT invoke a `realtimeMessage()` handler even when `message` names one (a channel `deliver` trigger still runs).",
    "    - SERVER-AUTHORITATIVE — bypasses `publish.who`, which governs CLIENTS. Authorize in your own stack.",
    "    - ⚠ FAIL-SOFT — a missing/disabled server or dead bus is swallowed engine-side, so a mis-targeted publish is SILENT with no result to check.",
    "    - `authTable`/`authId` are ASSERTED attribution on the frame — not a credential, nothing validates them.",
    "  - **Client recipe (derive, never hardcode):**",
    "    - `server.getUrl(baseUrl)` → `wss://<host>/ws/<canonical>` — accepts the `https://…` instance base URL and normalizes the scheme. `channel.getChannel({ room_id: 42 })` → `\"rooms/42\"`, the path that goes in a frame's `channel` field. Both throw rather than guess. A canonical is minted by `xanosdk export <entry> --lock`.",
    "    - Auth is a bearer token passed as the websocket SUBPROTOCOL: `new WebSocket(url, token)`. No token = an anonymous client, admitted only where `anonymousClients: true`.",
    "    - Frames are JSON `{ action: \"join\"|\"leave\"|\"broadcast\"|\"ack\"|\"ping\"|\"presence\", channel, type?, payload?, options?, id? }`. `broadcast` REQUIRES `type`: a `realtimeMessage` of that channel, else refused `Unknown message type`. You must `join` before you may `broadcast`, and the server's context is ready only a moment after `open` — an immediate first frame is refused.",
    "    - `options` is `{ to?, client_id?, channel? }` — `to: { dbo_id, row_id }` makes the frame a direct message (needs `publish.direct`), `client_id` is the at-least-once cursor handle, and `options.channel` WINS over a top-level `channel`.",
    "    - ⚠ KEEP THE SOCKET ALIVE: an idle connection is REAPED after ~10 minutes. A LISTEN-ONLY client (a feed or dashboard that joins and rarely publishes) MUST send `{ action: \"ping\" }` (answered `pong`) or any frame periodically or it silently drops.",
    "    - Server frames: `join` (ack `{ joined: true, params }`, + `cursor`/`resumed` on at_least_once) · `message` · `replay` · `broadcast` · `presence_full`|`presence_join`|`presence_leave` · `conversation_start`|`conversation_end` (replayed frames flagged `conversation: true`) · `pong` · `ack` · `error`.",
    "    - ⚠ `broadcast` is a RECEIPT to the sender, not a delivery confirmation: `payload.delivered_local` counts recipients on the ANSWERING NODE ONLY, not the channel. It also carries `id` on at_least_once and `dropped: true` when the handler returned null.",
    "    - `error` carries `payload.message`, plus `code`/`limit`/`retry_after` when rate limited. `rate_limited` is the ONLY code — do NOT switch on `code`.",
    "    - An `error` is a per-frame refusal, NOT a disconnect — EXCEPT a failed handshake and a REFUSED `connect` trigger, which each send one and then CLOSE with code 4401.",
    "  - **Tenant instances (isolated DB):** a tenant's realtime objects live in the TENANT's database, so BOTH halves of a client must name the tenant.",
    "    - Socket: `server.getUrl(base, { tenant })` → `/ws/<tenant>:<canonical>`. ⚠ A bare canonical on a tenant host resolves against the INSTANCE workspace instead.",
    "    - That colon form is PECULIAR TO THE SOCKET. Every other tenant URL gives the tenant its OWN segment — the HTTP half of the same client is `https://<host>/tenant/<tenant>/api:<canonical>/…`. NO request header is required for either.",
    "    - Because the shapes differ, `getUrl` TRANSLATES a tenant base URL instead of concatenating: pass the `https://<host>/tenant/<name>` that `xanosdk status` prints (and that deploy injects as `window.XANO_HOST`) and the tenant is LIFTED into the socket form. So `getUrl(window.XANO_HOST)` needs no `{ tenant }`, and a CONFLICTING `{ tenant }` alongside it throws.",
    "    - ⚠ `getUrl`/`socketUrl` are NOT idempotent — a `baseUrl` that already carries a `/ws/<…>` path THROWS. Resolve ONCE from the http(s) base; never feed a result back in.",
    "    - Still pass `{ tenant }` explicitly for a tenant on its OWN DOMAIN — the hostname carries it for HTTP, but there is nothing in the URL for the socket to lift.",
    "    - ⚠ Tokens are tenant-scoped (audience `<tenant>:<license>`, not the bare license), so one minted through the instance workspace is REJECTED by a tenant's realtime server — authenticate and dial through the same tenant.",
    "  - **Presence frames** (a `presence: true` channel only):",
    "    - `presence_full` carries `payload.members`, an ARRAY: at join it EXCLUDES the receiver (first joiner: `[]`), on a re-request it includes it. `presence_join`/`presence_leave` carry a single `payload.member`.",
    "    - A member is `{ id, dbo_id, authenticated, extras, joined_at }`: `id` the auth row id as a string (`\"0\"` anonymous), `dbo_id` the auth table's id (`0` anonymous), `extras` the connection's extras (`[]` if none), `joined_at` epoch SECONDS.",
    "    - Render `presence_full`, then apply deltas. One member per authenticated identity (a second tab fires no `presence_join`); anonymous ones all have `id` `\"0\"`, never collapsed.",
    "    - Join order: `join` ack → `presence_full` → (others get `presence_join`) → conversation replay → `replay` frames.",
    "    - A joined client re-requests it with `{ action: \"presence\", channel }`, answered to the SENDER only; a socket that never joined is REFUSED.",
    "  - **Conversation frames — the transcript hydrates the client, so DO NOT build a hydration endpoint.**",
    "    - On a `conversation` channel the replay is PUSHED automatically at join, unasked: `conversation_start` (`payload.count`) → the last `limit` messages, each a normal `action: \"message\"` frame carrying its ORIGINAL `type` and `payload` plus `conversation: true` and the original `ts` → `conversation_end`.",
    "    - Render `message` frames identically either way: no fetch or table read is needed to paint the initial view.",
    "    - ⚠ `{ enabled: true }` alone is a no-op: `limit` defaults to 0 and 0 means RETAIN NONE (see `conversation` above) — always pass `limit`.",
    "    - The POST-HANDLER broadcast payload IS the stored transcript row — a handler must broadcast everything the UI needs to render a past message (author name, id, `created_at`). Nothing else is replayed.",
    "    - The transcript is a capped ring (`limit`, `ttl`), not storage: persist to a table only for durability, search, or reads beyond it.",
    "  - **`delivery.guarantee: \"at_least_once\"` is a CLIENT CONTRACT, not just a channel setting.**",
    "    - The client must ACK what it receives — `{ action: \"ack\", channel, id }`, confirmed by `{ action: \"ack\", channel, payload: { cursor } }`.",
    "    - ⚠ An ANONYMOUS client must ALSO send a durable `options.client_id` in its JOIN frame (once; later acks need not repeat it). WITHOUT one it has no cursor, its acks are SILENTLY IGNORED, and it degrades to at_most_once. An AUTHENTICATED client is keyed by identity and needs no `client_id`.",
    "    - The missed gap arrives after join as `replay` frames, oldest-first, each with an `id` to ack. ⚠ A first join gets `cursor: \"0\"`: the WHOLE retained stream replays, repeating a `conversation` transcript.",
    "    - DISTINCT from the conversation transcript: `conversation_*` is the SHARED \"what was said before I arrived\", `replay` is the PER-CLIENT \"what I missed while disconnected\". Both may be on.",
    "    - How far back `replay` reaches is sized by `conversation.ttl` (here a REAL per-message age cut, and it BEATS `limit`), else `conversation.limit`, else 1000 — even on a channel with no transcript enabled.",
    "  - **What a message handler RETURNS decides delivery, and the failure directions are NOT symmetric.**",
    "    - A returned value fans out per `deliverTo` and becomes the transcript row.",
    "    - Returning NULL delivers NOTHING — the supported way to veto a message (the sender is told `dropped: true`).",
    "    - A payload REJECTED by the declared `input` also delivers nothing; the detail goes ONLY to the sender.",
    "    - ⚠ But a handler that CRASHES FAILS OPEN: the sender's ORIGINAL, UNVALIDATED payload is broadcast to the channel unchanged. A handler doing redaction or authorization must NOT be the only thing between client input and subscribers.",
    "",
  ];

  const triggers: string[] = [
    "### Triggers",
    "",
    "**A trigger's `stack` is a callback — `stack: (t) => [...]` — to read a trigger",
    "input** (a plain list works when it reads none). That's the one",
    "shape that doesn't carry over from the other kinds: a trigger has no",
    "user-declared `input`, so its inputs are **implied by type** (fixed by Xano,",
    "not editable) and arrive through the typed **stack handle** `t` — you can't",
    "reference them without it. (`response` too — a callback, or a plain value that",
    "reads none.) `t` exposes exactly that trigger type's inputs; a wrong",
    "name is a compile error, not a runtime surprise. The seven trigger types are",
    "distinct root factories (not a namespace): `{tableTrigger, realtimeServerTrigger,",
    "realtimeChannelTrigger, mcpServerTrigger, agentTrigger, workspaceTrigger,",
    "errorTrigger}({ name, guid?, description?, active?, tags?, history?, ... })`.",
    "`history` is per trigger (omit to inherit the workspace's `history.trigger`, default",
    "off); a trigger's own failure reaches the error log only while it is on.",
    "",
    "- `tableTrigger({ name, table?, datasources?, actions?: {insert?,update?,delete?,truncate?}, stack })` — database/table trigger. `t.new` / `t.old` are the row **after** / **before** the change; `t.action` (`insert|update|delete|truncate`), `t.datasource`. Bind `table` to a `table()` handle and `t.new(\"col\")` / `t.old(\"col\")` are typed to that row (misspelled column = compile error). ⚠ Insert's `old` and delete's `new` are `{}`, not null — branch on `t.action`, not a null check. Config-only (no response).",
    "- `realtimeServerTrigger({ name, realtimeServer, actions?: {connect?,disconnect?}, stack?, response?, responseShape? })` — realtime SERVER lifecycle (a client connecting to / disconnecting from the server, not a message). Inputs: `t.action` (`connect|disconnect`), `t.realtime_server`, `t.client`. Bind `realtimeServer` to a `realtimeServer()` handle (or its name).",
    "  - `connect` GATES the connection — a denial sends an `error` and CLOSES the socket with code 4401 before it is ever ready, so it is a real front door, not an observer; same return shape as a channel `join` below (EMPTY/FALSY DENIES — INCLUDING a gating trigger with NO `response`, which returns nothing and so refuses every client).",
    "  - A CRASH DENIES too — a gate that cannot answer must not admit. Both failure modes lock the door, so plan for a self-inflicted LOCKOUT (an unguarded drill into a null `db.get` raises → everyone refused), not a breach.",
    "  - Gating is OPT-IN: a server with no `connect` trigger accepts every connection.",
    "  - `disconnect` is OBSERVATIONAL (return ignored, throws swallowed — cleanup must always complete).",
    "  - Both are SERVER-scoped, so `s.realtime.get_session` works but carries no channel path and no bound params.",
    "- `realtimeChannelTrigger({ name, channel, actions?: {join?,leave?,deliver?}, stack?, response?, responseShape? })` — realtime CHANNEL lifecycle. Inputs: `t.action` (`join|leave|deliver`), `t.channel`, `t.payload`, `t.client`. Bind `channel` to a `realtimeChannel()` handle — a bare path is NOT accepted (it is unique only within its server). The three actions have DIFFERENT postures, and the posture decides what the stack should return:",
    "  - `join` GATES the join (it runs before membership) — return `{ allowed: c.bool(true) }` (optional `reason` reaches the client) or any truthy value to admit, and an EMPTY OR FALSY RETURN DENIES, so a stack that just falls through — or a gating trigger with NO `response` — refuses everyone, and a CRASH DENIES too. ONCE the object carries an `allowed` key admission needs STRICTLY `true` — `1`/`\"yes\"` there DENIES. Compute it as `c.expression(\"…\")` or a `ref()` to a `set_var` boolean (`expr()` is not a `response` value). That is the inverse of a crashing message, which still delivers, and of `deliver` below.",
    "  - A lifecycle trigger's inputs are PINNED to those four, so a channel PATH PARAM is NOT among them — `inp(\"room_id\")` RAISES, which crashes the gate and so REFUSES every client; take the param from `s.realtime.get_session` (`ref(\"session.params.room_id\")`).",
    "  - A gate establishes NO auth: `auth(\"id\")` reads 0 when authenticated, `ref(\"auth.id\")` raises — identity is `t.client(\"permissions.row_id\")` or the session. A SERVER connect/disconnect has no channel, so no params at all.",
    "  - `leave` is OBSERVATIONAL (return ignored, throws swallowed).",
    "  - `deliver` GATES delivery PER RECIPIENT — the per-viewer redaction tool and the most expensive action here (a stack per recipient per message), and it needs `delivery.perRecipient` on the channel to run at all — BOTH HALVES are required, so a `deliver` trigger on a channel without the flag NEVER RUNS and every subscriber receives the UNREDACTED payload (no error, no log line); `export()` warns on each half alone.",
    "  - **`deliver`'s RETURN VALUES DO NOT READ LIKE A FILTER:** ONLY an explicit NULL drops the message for that recipient; an OBJECT replaces that recipient's payload; ANYTHING ELSE — INCLUDING `false`, `0`, `\"\"` — DELIVERS IT UNCHANGED, as does a crash. So `return false` from a yes/no redaction check SENDS the message it was written to suppress — return null instead.",
    "  - The delivered payload arrives NESTED, so read `t.payload(\"<field>\")`, and `t.client` is the SENDER while `s.realtime.get_session` describes the RECIPIENT this run is for.",
    "- `mcpServerTrigger({ name, mcpServer, stack?, response?, responseShape? })` / `agentTrigger({ name, agent, stack?, response?, responseShape? })` — toolset connection. Bind with the `mcpServer()`/`agent()` def handle (or its name) — it resolves to the toolset guid at export. Raw numeric `objId` is the escape hatch, rarely right: ids are assigned at import, so a handle passed to `objId` is a type error, and binding nothing deploys a trigger that never fires. Inputs: `t.toolset` (`t.toolset(\"name\")`), `t.tools`; an MCP server's also `t.prompts`/`t.resources`: return one filtered to narrow what the connection lists, omit it to list all — and `t.auth`, the signed-in user `{dbo, id, extras}` when the server has `oauth` (null otherwise). Response-bearing; the default returns every list input.",
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
    "**`nullable` defaults PER TYPE, matching the engine's own column-creation API**: `true`",
    "for `f.vector`, `f.uuid`, every `f.geo.*` and every file type (`f.image`/`f.video`/",
    "`f.audio`/`f.attachment`), `false` for everything else (text, int, decimal, bool, email,",
    "enum, json, object, password, date, tableRef); inputs add date, timestamp and file, so an",
    "omitted one binds `null` (a `required` one still accepts an explicit `null`). Pass `nullable` to override —",
    "e.g. `f.geo.polygon({ nullable: false })`. An empty default becomes NULL only when",
    "nullable, so a non-null `f.vector(8)` column fails to create (`''` is not a vector).",
    "**`f.geo.*` values are `{ type, data }`, not GeoJSON.** The same shape goes in and comes",
    "back. `type` per column: `point` → `\"point\"`, `data` `{ lng, lat }`; `multipoint` → `\"points\"`,",
    "`linestring` → `\"path\"`, `polygon` → `\"poly\"` (ring closed for you), `data` `[{ lng, lat }, …]`;",
    "`multilinestring` → `\"paths\"`, `multipolygon` → `\"polys\"`, `data` `[[{ lng, lat }, …], …]`.",
    "Any other spelling (`\"multipoint\"`, `\"linestring\"`, `\"Point\"`) 400s `Only strings are supported for:`.",
    "Raw WKT text (`c.text(\"POINT(1 2)\")`) is accepted on write too, but a read never returns one.",
    "`methods` (validators/transforms, names per type below): `\"trim\"`, `\"min:8\"`",
    "(a text arg keeps its `:`: `\"startsWith:https://\"`), or `{ name, arg }` — for unlisted names and `pattern`'s error text.",
    "`f.json({children})` declares the nested shape stored INSIDE a json column — an ARRAY of",
    "`{name, type, methods?, children?}`, order-significant, distinct from the `FieldMap` that",
    "`f.object` takes positionally. Omit it for an unstructured json column.",
    "`f.enum(values)`/`f.vector(size)`/`f.object(children)`/`f.tableRef(table)` take a",
    "positional payload before opts — and still accept the standard `FieldOptions` after it",
    "(`f.enum([])`/`input.enum([])` are accepted: a pulled enum with no options, not one to",
    "author — it brands the column `never`, which `InferRow` surfaces as `undefined`.)",
    "(e.g. `f.tableRef(users, { required: true })` — only `min`/`max` are listed as tableRef",
    "methods below, but `required`/`nullable`/`description`/… apply like any field.)",
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
    "`s.db.query` → `eval`). Without that pairing the column stores and indexes but nothing",
    "queries it.",
    "`{ array: true }` makes any `f.*` scalar a **list column** — `f.text({ array: true })`",
    "surfaces as `string[]` in `InferRow<typeof table>` (the column analogue of `input.list`).",
    "**Seed a table's starting rows with `table({ seed })`.** `seed` takes rows",
    "typed against the table's schema as a WRITE shape (a column without",
    "`required: true`, and the system columns, may be omitted; `null` needs",
    "`nullable: true`) — inline (`seed: [{ name: \"…\" }]`), a FILE",
    "(`seed: seedFile(\"./seed.json\", import.meta.url)`; path resolves against the DECLARING",
    "file), or a thunk (`seed: () => import(\"./seed.json\")`, async ok, `.default` unwrapped).",
    "Inline rows are TYPED against the schema at compile time; a `seedFile`/thunk seed is",
    "not — `xanosdk export`/`deploy` validates it, naming the row index and column.",
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
    "`seed`-only — `s.db.bulk.add` DROPS `id` unless `allowIdField: true`.",
    "**`use_xdo` storage mode.** Workspace setting (`registerWorkspace({ use_xdo })`,",
    "default `false`): `true` stores fields as JSON in the `xdo` column (+ `gin(xdo)` index),",
    "`false` real columns.",
    "Tables inherit it; override with `table({ useXdo })`; a merge refuses to switch a populated table.",
    "A **column `default` must stay within the BMP** — a 4-byte character (codepoint > U+FFFF,",
    "e.g. an emoji) is rejected at export; put such a value on an `input.<type>({ default })`.",
    "`input.*` mirrors `f.*` — every column type below is",
    "a legal input (scalars, files `input.image/video/audio/attachment`, `input.geo.*`,",
    "`input.vector(size)`, `input.tableRef(table)`, `input.object(children)`), plus",
    "`input.dbLink(table)` is the odd one: ONE entry that EXPANDS into one input per",
    "COLUMN of the linked table, so read them by column name (`inp(\"email\")`), never by",
    "the entry's own name. `hidden: [\"created_at\"]` drops columns from that expansion.",
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
    "**An empty file column is a stored null that `where` does not see as null.** `expr(col(\"file\"), \"!=\", c.null())`",
    "matches EVERY row, and `= c.null()` matches none. Compare a key inside the file instead:",
    "`expr(col(\"file.path\"), \"!=\", c.null())` keeps only the rows holding a file.",
    "**Typed inputs validate/coerce on bind, before your stack runs** — so reach for the",
    "specific type instead of hand-rolling checks. `input.email({ required: true })` rejects a",
    "malformed address with a 400 (and trims; add `methods: [\"lower\"]` to downcase) — no",
    "`regex_matches` needed; `input.int`/`input.decimal`/`input.uuid`/`input.enum([...])`/`input.date`",
    "likewise reject or coerce bad input at the boundary. Drop to `input.text` + `s.precondition`",
    "only for rules no type expresses.",
    "⚠ `input.url` is NOT one of them — there is no engine `url` type, so it stores as `text`",
    "and validates NOTHING: a `javascript:`/`data:` URL type-checks, imports, and binds. When the value gets navigated",
    "to, check the scheme in the stack. It is INPUT ONLY — there is no `f.url` column.",
    "⚠ `input.timestamp` binds epoch MILLISECONDS. A number is taken as ms as-is, so epoch",
    "SECONDS (`date +%s`) bind in January 1970 with no error. An ISO-8601 string keeps its",
    "offset but DROPS fractional seconds (`\"…T19:30:00.123Z\"` binds `…:00.000`). Send epoch ms",
    "(`Date.now()`, `getTime()`) whenever sub-second precision matters.",
    "⚠ `input.list` does NOT reject a non-array: one value binds as a ONE-item list (`\"a\"` →",
    "`[\"a\"]`), and a non-JSON string given to an `input.object` binds an object of its",
    "children's DEFAULTS — so `input.list(input.object({...}))` given `\"notalist\"` binds",
    "`[{ name: \"\", … }]` with a 200. A list `min` does not catch it (that is one item). A string",
    "starting with `[` is parsed as JSON with NO element check at all. When the shape must hold,",
    "mark an object child `required: true` (the default-filled object then 400s with its param",
    "path) and check anything else with `s.precondition`.",
    "⚠ `s.precondition`'s `error` must be a TAGGED value — `c.text(\"…\")`, not a bare string.",
    "The engine falls back to the generic \"Precondition failed.\" whenever it reads an empty or",
    "non-scalar message, and a bare string lands there, so the client never sees your text. The",
    "`error_type` → HTTP status mapping is correct either way; only the message is lost.",
    `\`error_type\` is how a stack sets a FAILURE status: ${preconditionStatusLine()}.`,
    "For any other status — and for a redirect — use `respond.*`, which is sugar over",
    "`s.util.set_header` (that statement reaches the status line): `respond.status(201)`,",
    "`respond.redirect(url, { status?: 301|302|303|307 })` (a TUPLE — spread it; a `Location`",
    "alone does NOT redirect), and `respond.header(name, value)`. Position in the stack does not",
    "matter, a later status wins, and a FAILING `precondition` still wins over anything set",
    "before it. ⚠ `204` answers with an empty body whatever `response` says. ⚠ `respond.status`",
    "REFUSES `308`/`425`/`451`/`102`/`103`: the platform writes those and does not act on them,",
    "so the response is 200 with nothing reported — use 301, 429 and 403 instead.",
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
    "`withFilters(v, [fl.a(), fl.b()])` is also accepted. Every filter is typed:",
    "the ones below carry named args, and the rest take NO arguments — call them",
    "`fl.<name>()`, and passing an argument is a compile error.",
    "A typed filter's declared argument list is an EXACT count, not a floor: passing more",
    "than it lists THROWS, in the type and at runtime. The extra argument used to ride into",
    "the filter's arg list, where the engine either ignores it or fails opaquely on a live",
    "endpoint. `filter(\"name\", …)` is the untyped escape for a filter the catalog",
    "under-declares. Seven declared filters are exceptions the engine really does take more from, so they",
    "stay variadic: `concat` (trailing separator), `index_by` (trailing list flag), `get` (trailing variable",
    "map), `array_merge` and `array_merge_recursive` (any number of arrays), `jwe_encode` and",
    "`jwe_decode`. To send more than a zero-argument filter's `()` accepts, use the same",
    "`filter(\"name\", …)` escape. A filter with NO declared list takes nothing and is emitted",
    "`()` — except the variadic few listed under the catalog, which take arguments the",
    "catalog never declared and so are not arity-checked at all.",
    "A typed filter also accepts one object of NAMED arguments (`fl.add({ value: 1 })`); a key",
    "the filter does not declare throws rather than being dropped.",
    "A bare JS **scalar** — string, number or boolean — is accepted in ANY `fl.*` argument and",
    "wrapped as the constant you would have written by hand (`fl.get(\"a.b\", 0)` encodes",
    "identically to `fl.get(c.text(\"a.b\"), c.int(0))`). An object or array must still be built",
    "with `c.obj`/`c.array`. Any argument also takes a runtime value (`inp`, `ref`, a",
    "`withFilters` chain) — inside `obj()`/`expr()` an argument cannot carry its own filter",
    "chain, so compute it in a prior `set_var`. The arg types below name each argument's",
    "ENGINE type, not the JS type you may pass.",
    "`fl.add`/`fl.sub`/`fl.mul` keep an INT when both operands are ints (`2 × 3` is `6`, not",
    "`6.0`) and give a decimal only when either operand is one — the `decimal` return type",
    "below covers both, so an int pipeline needs no `fl.to_int()`. `fl.div` is an int only",
    "when it divides exactly.",
    "To add to a numeric column (counter, stock, balance), use `s.db.increment`",
    "(`llms/statements-data.md`) — one atomic UPDATE. A pipeline read-modify-write is NOT",
    "atomic (concurrent writers lose updates), and `col(\"clicks\")` does NOT resolve to the",
    "stored value inside a `db.edit` `row` (it is `null`; `null + 1` aborts): `db.get` the row",
    "`as: \"current\"`, then `withFilters(ref(\"current.clicks\"), fl.add(c.int(1)))`.",
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
  const zeroArg = m.filters.filter((fl) => !fl.args?.length && !fl.variadic).map((fl) => fl.name);
  const variadic = m.filters.filter((fl) => fl.variadic).map((fl) => fl.name);
  filters.push(
    "",
    `Zero-argument filters — call as \`fl.<name>()\`; an argument is a compile error: ${zeroArg.join(", ")}.`,
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
    "hand-authored: control flow is below, and the rest are in the `llms/statements-*`",
    "topic files this doc's navigation names.",
    "Wrap an `input`-routed `value` field in `ignored(...)` to store it but SKIP it at",
    "  runtime — the engine records `<name>:ignore` and the parameter falls back to its",
    "  default. Not the same as an empty value, and not the same as omitting the field",
    "  (which stores no entry at all). Mostly seen on a pulled workspace. A field written",
    "  into `context` instead (the `s.math.*`/`s.text.append` mutation family) has no slot",
    "  for the flag and THROWS rather than dropping it.",
    "Fields marked `value` take a `Value` (`c.*`/`ref`/`inp`); `comparison` takes an",
    "`expr(...)`. A `→ as: <type>` suffix names what the statement's `as:` output var",
    "holds (curated, not exhaustive — absence means read the `[output]` flag and prose).",
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
    "- `s.array.union({ source, with, as?, transform? })` — set-union two arrays. `with` is REQUIRED; omitted → `Unable to locate input: `.",
    "",
    "DB reads/writes (`table` is a def handle or name; `fieldName` defaults to the",
    "primary key `id`):",
    "",
    "- `s.db.get({ table, fieldName?, fieldValue, lock?, output?, as? })` — one row by field match; `output` restricts returned columns (and overrides column visibility — it can pull `internal` columns like a password hash).",
    "- `s.db.has({ table, fieldName?, fieldValue, as? })` — existence test.",
    "- `s.db.del({ table, fieldName?, fieldValue, as? })` — delete by field match.",
    "- `s.db.add({ table, row?, data?, output?, as? })` — insert; `row` is a partial keyed by column.",
    "  - A row CELL takes a tagged `Value`, a nested object of sub-keys, or a bare JS literal typed against that column: `row: { is_hidden: true, notes: \"…\" }` encodes exactly as `{ is_hidden: c.bool(true), notes: c.text(\"…\") }`. The tag comes from the COLUMN, not the literal — `10` on an `f.decimal()` column is `const:decimal`, not `const:int` — so a literal contradicting its column is a compile error on a `f.*`-schema table (`{ is_hidden: \"yes\" }` on an `f.bool()` column) and throws at encode on a raw-`ColumnDef[]` one. An `f.enum()` column keeps its member union. A column with no literal form — obj/json/list/geo/vector/file — still needs `c.obj`/`c.array`.",
    "  - `null` is accepted on EVERY column, including ones that refuse every other literal, and encodes `const:null` — a write OF null, not the same as omitting the key. A column's `nullable` is not consulted at encode; the engine refuses a null it forbids.",
    "  - Omitting a key on `add` writes the column's type default — declared `default` if set, `[]` for a list, `{}` for obj/json, else `null`. That `null` is EMITTED, not what the row holds: the engine applies the column's nullability, so a `nullable` column keeps `null` and a non-nullable one lands on its type's zero value (`\"\"`, `0`, `false`). Set the cell when the stored value matters. On `edit` an omitted key keeps its stored value.",
    "  - An `f.password()` cell takes the PLAINTEXT — the column hashes on write, so a pre-hashed value, or a hashing filter on the cell, stores a hash of a hash that `security.check_password` can never match.",
    "  - A `table({ seed })` cell hashes the same way: the import writes the plaintext through the column's own rules, so a seeded credential matches under `security.check_password` exactly as an added one does. Demo accounts work as fixtures — the usual caution about seed data applies, since the plaintext sits in the repo.",
    "- `s.db.edit({ table, fieldName?, fieldValue, row?, data?, output?, as? })` — update by field match.",
    "- `s.db.patch({ table, fieldName?, fieldValue, data, output?, as? })` — merge a partial. ⚠ Unlike `db.edit`'s `row`, `data` is a single object `Value` — write `obj({ unread: c.int(0) })`, not the column-keyed record `row` takes.",
    "  On these three, `output` restricts the columns of the RETURNED row only — it does not change",
    "  what is written. Not offered on `db.del`/`db.has` (their result is a scalar) or on",
    "  `db.add_or_edit` (no output envelope).",
    "- `s.db.add_or_edit({ table, fieldName?, fieldValue, row?, data?, as? })` — upsert.",
    "- `s.db.query({ table, where?, additionalWhere?, bind?, sort?, paging?, external?, returnType?, distinct?, eval?, output?, lock?, addon?, as? })` — search.",
    "  - `where` / `additionalWhere` — `expr(...)`, an `expr[]` (ANDed), or a raw `Value`. Rides `context.search`.",
    "    - ⚠ `ignoreEmpty` DROPS the predicate when the operand is empty (not zero rows). On `in` an empty list returns the UNFILTERED set, so never scope to permitted ids with it; a `bulk.delete` only it scopes throws.",
    "    - For the full operator set use `cmp(left, op, right, { ignoreEmpty? })` — `op`: `in`/`not in`/`like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… plus the `expr` comparisons. Database-only — a runtime condition takes the `expr` set only.",
    "    - ⚠ `like`/`ilike` take the operand as the PATTERN, verbatim: a bare term matches only an exact whole-string equal, and the endpoint answers HTTP 200 with zero rows — nothing reports a problem, so a search box that matches nothing ships. For substring matching use `includes`/`not includes`, which wrap the operand in `%…%` themselves and match case-INSENSITIVELY. Prefer them over a hand-built `\"%\" + term + \"%\"`, which is non-empty even for an empty term and so defeats `ignoreEmpty`; `includes` composes with it. `contains`/`@>`/`overlaps` are JSON/array containment, not text — on a text column they 400 `ParseError: Invalid value for param`.",
    "    - Compose nested boolean logic with `and(...)` / `or(...)` groups (also available on `addon()` `where`).",
    "    - An operand may be a bare value (`col`/`inp`/`ref`/`auth`/`c.*`) OR a **filtered** value (`withFilters(...)`) inline — the engine compiles the string and arithmetic filters (`trim`, `concat`, `upper`, `lower`, …) into the SQL.",
    "    - ⚠ The REQUEST-TIME timestamp filters have no SQL form and kill the request with a bare fatal naming nothing: `epochms_transform`, `epochms_add_ms`, `epochms_add_secs`, `epochms_date`, `epochms_from_format`. For a relative cutoff use the SQL-side family instead (`qf.epochms_add_day(7)`, `qf.epochms_sub_month(1)`, `qf.epochms_year(\"UTC\")`, …) — or compute it in an earlier `s.set_var` and `ref()` that. `export --strict` reports it; a bare `c.now()` operand is always fine.",
    "  - `bind: [{ table, as?, join?, where? }]` — joins (`context.bind[]`). `join` defaults to `\"inner\"`. `as` defaults to the table name; two joins to the same table need distinct aliases.",
    "    - ⚠ In `where`/`sort`/`eval` a JOINED column takes a dotted path (`col(\"team_row.id\")`); THIS query's own columns stay **bare** (`col(\"team\")`). Qualifying your own by table name needs `tableAlias` (same rule as `aggregate`) — without it the engine reads the operand as text and 400s `ParseError: Invalid value for param` naming the OTHER operand, so it throws at export instead.",
    "    - `bind: [{ table: team, as: \"team_row\", join: \"left\", where: expr(col(\"team\"), \"=\", col(\"team_row.id\")) }]`",
    "    - `bind: [{ expand: \"blog.categories\", as: \"cat\" }]` joins one row per element of a LIST column already in the query; read it as `col(\"cat.<key>\")`.",
    "    - ⚠ A join does NOT put the joined table's columns on the returned row — with or without a `bind`, a row is the QUERIED table's columns, which is what `InferResponse` types. There is no `row.team_row`. To read a joined column, PROJECT it with an `eval` whose `name` is the dotted path: `eval: [{ name: \"team_row.name\", as: \"team_name\" }]` puts `team_name` on the row and on the inferred type. A bare `name` there is `Unsupported parameter reference` at runtime (it qualifies to the base table), and a dotted joined column in `output` is dropped with no error.",
    "  - `returnType` — `\"list\"` (default) | `\"single\"` | `\"count\"` | `\"exists\"` | `\"stream\"` | `\"aggregate\"`. Drives `context.return.type` AND the `InferResponse` shape: `count`→`number`, `exists`→`boolean`, `single`→`Row|null`, `stream`→`Row[]` (pageable, no envelope), `list`→`Row[]`/envelope, `aggregate`→rows keyed by the `aggregate.group`/`eval` aliases. ⚠ A bare `count` of ZERO serializes as an EMPTY body, not `0` — a client parsing JSON gets a parse error on the one result it most needs to handle. Wrap it: `response: { count: ref(\"n\") }`.",
    "  - `eval: [{ name, as, filters? }]` — computed columns (`context.eval[]`). Each `as` grafts onto the row as an `unknown` key in `InferResponse`; shadowing a real column throws. Write `name` **bare** (`\"embedding\"`) — it is alias-qualified on emit exactly like `aggregate` (a bare eval name is `Unsupported param format` at runtime), and the statement declares the alias it used. An `as` alias is `sort`able in the SAME query.",
    "    - An `eval`/`sort`/`where` filter pipeline compiles to **SQL**: `trim`/`lower`/`concat` work there too, plus a DIFFERENT registry than `fl.*`: the vector family, geo `distance`/`within`/`covers`, `search_rank`, the timestamp family, the aggregators. Build these with **`qf.*`** — `filters: [qf.vector_cos_distance(inp(\"q\"))]` — which emits the same `{ name, arg }` step with the name, the argument COUNT and any enumerated argument checked at the call site. `qf` carries what the engine registers, including facts no name list holds: the per-part extractors take a timezone (`qf.epochms_month(\"UTC\")`), `qf.round`'s precision is required, `qf.time`'s part is an enum. `QUERY_FILTER_NAMES`/`QUERY_AGGREGATE_NAMES` list the set; the raw `{ name, arg }` form still works for anything `qf` does not carry (`vector_distance`, which has no registered engine class).",
    "    - **Vector similarity search** — the ONLY way to query an `f.vector` column (no `SearchOp` does distance). `eval: [{ name: \"embedding\", as: \"distance\", filters: [{ name: \"vector_cos_distance\", arg: [inp(\"q\")] }] }]` + `sort: [{ sortBy: \"distance\", dir: \"asc\" }]` ranks in the DATABASE over the column's index. Match the filter to the index `op` (`vector_cos_distance`↔`vector_cosine_ops`, `vector_l2_distance`↔`vector_l2_ops`, `vector_l1_distance`↔`vector_l1_ops`, `vector_inner_product`↔`vector_ip_ops`); `vector_cos_similarity` is the inverse, so sort it `desc`. The same filter on a `where` operand cuts off BY distance instead of by row count.",
    "  - `aggregate: { group?, eval?, sort?, paging? }` (with `returnType:\"aggregate\"`) builds `context.return.aggregate`. `group`/`eval` are `{ name, as, filters? }`, an aggregator like `sum`/`count` riding `filters`. Some aggregators resolve ONLY here, not in a runtime value pipeline: `count_distinct`, `median`, `to_list`/`to_distinct_list` (each with `_asc`/`_desc`), and `vector_distance`.",
    "    - ⚠ Write each `name` as a **bare** column (`\"status\"`). It is alias-qualified to `\"<alias>.status\"` on emit — the engine rejects an unqualified column in an aggregate with `Unsupported param format`. An already-dotted `name` (a `bind`ed/joined column) passes through.",
    "    - The alias it qualifies WITH is `tableAlias` when you set one, otherwise the table's name — and the statement DECLARES that alias (`dbo.as`) so the qualified name resolves. Nothing to do by hand; a bare `name` is the form to write.",
    "  - `sort: [{ sortBy: <col>, dir?: \"asc\"|\"desc\"|\"rand\" }]` and `paging: { page?, per_page?, offset?, totals?, metadata?, search?, sort? }` ride `context.return.list`.",
    "    - ⚠ `paging` with a page/per_page/offset field and `metadata` on (the DEFAULT) wraps the result in an envelope `{ items: Row[], curPage, nextPage, prevPage, offset, perPage, itemsReceived }` — plus `itemsTotal`/`pageTotal` when `totals: true` — instead of a bare `Row[]`. `InferResponse` reflects it. `paging: { metadata: false }` keeps the bare array.",
    "    - \u26a0 Under the ENVELOPE, `output` selects from the envelope, not the row: write `output: [\"itemsReceived\", \"curPage\", \"items.id\", \"items.title\"]`. A bare column list matches no envelope key, so every key is dropped and the response is `[]` at HTTP 200 with no error (and `ref(\"<var>.items\")` then fails on a var that is gone). With `metadata: false` the statement binds the rows, so bare columns are the right form there. `export()` warns on a row-rooted selection under an envelope; `--strict` fails it.",
    "    - Read `nextPage` (`number|null`) as the typed has-next signal.",
    "    - **Input-bound paging:** `page`/`per_page`/`offset` also accept a `Value` (`inp(\"page\")`), riding `context.simpleExternal` while the static block stays the engine gate (`enabled:true`). `paging.search`/`sort` are `Value` dynamic overrides.",
    "    - A `search`/`sort`-only `paging` (no numeric field) does NOT paginate.",
    "  - `external: { value, permissions? }` — the classic whole-config blob (forces the gate on). It falls back to input-bound `paging` when it resolves empty, so supplying both is valid.",
    "  - `distinct` — `\"auto\"` (default) | `\"yes\"` | `\"no\"`, riding `context.return.<list|stream>.distinct`.",
    "- `s.db.truncate({ table, reset?, as? })` · `s.db.schema({ table, path, as? })`.",
    "- `s.db.direct_query({ sql, responseType?, args?, parser?, as? })` — `sql` is a **raw string** (not a `Value`); binds go in `args: Value[]`. `parser: \"template_engine\"` renders the body as a template first — how a query interpolates a column or table name a bound arg cannot carry; omit it for the default.",
    "  - Template placeholders are Twig over the request scope: `{{ $input.name }}` for an input, `{{ $var.name }}` for a stack variable. ⚠ A BARE `{{ name }}` renders as the empty string — HTTP 200, no error, a query that silently ran with a blank where the value belonged. A bound `?` arg carries a VALUE without the template at all.",
    "  - ⚠ A table's PHYSICAL name is **not stable across deploys**. A deploy is a full replace, so every table is created afresh and the id in its name moves every time — the same unchanged project redeployed three times gave one table three different names. Never store, cache, hardcode or fixture one: resolve it from `information_schema` inside the same request that uses it.",
    "- `s.db.external.<engine>.direct_query({ sql, connectionString, responseType?, args?, parser?, as? })` — same shape against an EXTERNAL database; `<engine>` is `postgres`/`mysql`/`mssql`/`oracle`/`snowflake`. `connectionString` is a `Value` — reach for `env(...)`, not a literal — stored as `context.connection_string_flex`. A bare string stores the older `context.connection_string` instead (an env-var name unless it looks like a URL); each form round-trips as itself.",
    "- `s.db.transaction({ body })` — run a `Statement[]` atomically. It returns nothing, so it takes no `as`: read what the body binds. An `s.return` in the body ends the WHOLE stack with that value, and the writes before it commit.",
    "  - The body shares the enclosing stack: a variable it binds (`as: \"order\"` on an `s.db.add`) is still bound AFTER the transaction.",
    "- `s.db.bulk.add({ table, items, allowIdField?, as? })` / `s.db.bulk.update` / `s.db.bulk.patch` — `items` is an array `Value`.",
    "  - ⚠ `bulk.add` **drops `id` on every row unless `allowIdField: true`** (silently, next sequence value instead) — the opposite of `seed`, where `id` pins. Rows referenced by a foreign key need `allowIdField: true`; literal `items` carrying `id` without it throw. `bulk.update`/`patch` keep `id` (their match key).",
    "  - ⚠ **`bulk.update` is a whole-row REPLACE: every column an item OMITS is zeroed** (`\"\"`/`0`/`null`), HTTP 200, no error — `{ id: 7, status: \"done\" }` blanks the rest of row 7. **Use `s.db.bulk.patch`** for the partial write \"update these rows\" means. `export()` warns on a STATIC `items` missing columns (`--strict` fails); a `ref`/`inp` `items` is uninspectable.",
    "- `s.db.bulk.delete({ table, where?, allRows?, as? })` — deletes rows by a `context.search` filter. `where` is the same surface as `s.db.query` (`expr(...)`/`cmp(...)`, `and(...)`/`or(...)` groups, an array of those ANDed, or a raw `Value`) and encodes through the identical `{expression:[…]}` search shape. ⚠ A filter that constrains nothing (missing, empty, or `x OR and()`) deletes **every** row, so it **throws**: pass the filter, or `allRows: true` for a deliberate wipe (both together also throw). `allRows` emits the empty search the engine requires and returns the deleted count; reach for `s.db.truncate({ table, reset: true })` when the id sequence should restart too.",
    "- `s.db.increment({ table, where, fieldName, value, returnType?, output?, addon?, as? })` — adds `value` (a number or `Value`; negative decrements) to one `int`/`decimal` column on every row `where` matches, in ONE atomic locked UPDATE. **Use it for counters, stock, balances and tallies**: `db.get` → math → `db.edit` loses updates under concurrency, and so do `db.bulk.patch`/`update`. A guard in `where` (`expr(col(\"stock\"), \">=\", c.int(1))`) is re-checked under the row lock. `returnType: \"count\"` binds the changed-row count instead of the rows, and then takes no `output`/`addon`.",
    "  - ⚠ A `where` that constrains nothing (missing, empty, or `x OR and()`) changes NO rows and **throws**. A null stored value counts as 0. A fractional `value` on an `int` column, a non-numeric or list column, the `id` key, and a result that overflows the column are rejected with no rows changed.",
    "",
  ];

  const stmtRuntime: string[] = [
    "Runtime behavior (what the `as:` output holds, and misses):",
    "",
    "- `db.get` binds **`null`** when no row matches (it does NOT throw) — so the output is `InferRow<typeof table> | null`; null-check it. On a hit it binds the **full row**. (`db.has` is the boolean existence test.)",
    "- `db.edit` binds the **full, post-mutation row**. `db.add` binds the **full inserted row**, including the auto-assigned `id` and `created_at`. So `InferRow<typeof table>` is the right response type for those two. `db.del` **binds `null`**, not the deleted row.",
    "- Unlike `db.get`, `db.edit` and `db.del` **throw** `NotFound` (HTTP 404) when no row matches the field. `db.add` throws on a unique-constraint violation: HTTP 500 `ERROR_FATAL` \"Duplicate record detected…\", earlier writes kept. No error type is 409. `s.try_catch` catches it — and `s.precondition`/`guard.*` failures, answering 200 (`caught(\"code\")`: `ERROR_CODE_NOT_FOUND`, …) — so re-raise with an `s.precondition` in `catch` to keep a status. No partial unique index: NULLs never collide, so null the key (or delete the row) to free it.",
    "- **`InferResponse<typeof query>`** derives an endpoint's response type. It resolves object-literal responses to those keys; a `response: ref(\"x\")` returning a variable bound by a TOP-LEVEL db op on a `table()` resolves to that op's result:",
    "  | statement | resolves to | on a miss |",
    "  |---|---|---|",
    "  | `db.add` / `db.edit` / `db.patch` / `db.add_or_edit` | `Row` (the full written row, non-nullable) | throws — `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`; `add_or_edit` upserts and never misses |",
    "  | `db.get` | `Row \\| null` | binds `null` rather than throwing |",
    "  | `db.query` / `db.bulk.patch` | `Row[]` | — |",
    "  | `db.has` | `boolean` | — |",
    "  | `db.bulk.delete` | `number` (count) | — |",
    "  | `db.increment` | `Row[]` (updated rows), or `number` with `returnType: \"count\"` | `[]` / `0` |",
    "  | `db.del`, `db.bulk.add`/`bulk.update`, raw `direct_query` | `unknown` (the engine leaves them untyped) | — |",
    "  - A `get`/`query` `output: [...]` selection narrows to a `Pick` (still `| null` for `get`). A dotted `ref(\"row.col\")` into a `db.get` row projects that column carrying the `| null` (→ `Col | null`).",
    "  - A value reshaped by a lambda, or a variable built by control flow, also resolves to `unknown`.",
    "  - A CALL binds the TARGET's response type: `s.function.call`/`s.function.run`/`s.api.call`/`s.tool.call` given a def HANDLE brand their `as` with `InferResponse` of the target, so `ref(\"out.field\")` types to that field. What the target resolves to is what propagates — declare `responseShape` on the TARGET to fix every caller at once. A target named by STRING has no def to read and stays `unknown`; an async `s.function.run` binds its job id (`string`), not the result.",
    "  - In an object-literal response the KEYS are always known; a `c.*` constant VALUE types like an `s.set_var` of it (`{ success: c.bool(true) }` → `{ success: boolean }`).",
    "  - A NESTED member resolves to any depth by these same rules, in either spelling — `{ user: obj({ id: ref(\"row.id\") }) }` and the raw literal `{ user: { id: ref(\"row.id\") } }` both derive `{ user: { id: Col | null } }`. A raw scalar member types itself (`{ count: 3 }` → `number`).",
    "  - Runs on every response-bearing kind — `query`, `defineFunction`, `realtimeMessage`, `tool`, `middleware`, and the response-bearing triggers — each of which also accepts `responseShape`. A trigger builds its stack and response through CALLBACKS (`stack: (t) => [...]`), and the trace follows through them.",
    "  - Close any `unknown` by declaring `responseShape` on the def (`responseShape: null as InferRow<typeof t> | null`) — the declaration ALWAYS overrides derivation. It is available on EVERY kind listed above, `query` included.",
    "  - The shapes that never derive, and the one line that closes each: rows built in `s.lambda` (JS is opaque to the walk) → `responseShape: [] as Row[]`; a var bound ONLY inside branches → `responseShape` (a branch/case/loop/`try`/`catch` re-binding unions in; one in EVERY branch replaces); a call whose target is named by STRING → give the TARGET a `responseShape` (a handle then carries it) or declare it here. Use `responseShape` as the FIRST move here.",
    "  - An `s.set_var` holding a `c.*` CONSTANT brands its binding with that constant's JS type, so `ref(\"n\")` after `s.set_var(\"n\", c.int(1))` resolves to `number` (widened: `c.bool(false)` → `boolean`; `s.update_var` re-binds). A filter chain — the value's own or `asFilters` — then retypes it (`[fl.to_int()]` → `number`). A bare `ref`/`inp` stays `unknown`.",
    "  - ⚠ A hand-written `s.precondition` does not narrow the STATIC type. One (or a conditional) proving a `db.get` row non-null leaves `InferResponse` at `Row | null`, because the walk reads the stack's shape and not its control flow. `guard.found(\"row\")` DOES narrow: it emits the same non-null check (404) and drops `| null` from `row` — whole, dotted, and addon grafts alike — after it. `guard.owner` narrows the same way. Reach for `responseShape` only when neither fits.",
    "  - ⚠ A `resultStrategy: \"replace\"` middleware attached `post` reshapes the endpoint's output at runtime, which the static walk cannot see. Declare `responseShape` when a post middleware rewrites the response. A `merge` one makes a LIST response an index-keyed object; its keys are not inferred.",
    "  - ⚠ **Spreading a `Statement[]` helper into a stack kills the whole walk.** The trace needs the stack's TUPLE type, so `...myHelper()` where the helper returns `Statement[]` widens it and EVERY `as` in that stack — including ones declared after the spread — stops resolving. The response then types as `StackTupleWidened`, whose name says so. Fix: return `statements(s.a(...), s.b(...))` from the helper (a const-generic identity export — the tuple survives the spread). A helper that builds its array in a LOOP cannot be a tuple; declare `responseShape` there.",
    "- **Addons** enrich returned rows. `db.query`/`get`/`add`/`edit`/`patch` accept `addon: [{ addon, as, input?, output?, children? }]`; `db.add_or_edit`/`del`/`has`/`truncate` take no `addon`.",
    "  - `addon` is the target (name or def handle). `as` is the destination on the row — a bare alias (`\"_user\"`) or a dotted `offset.alias`, authored relative to a row. Under a metadata paging envelope the `items[]` offset is prefixed automatically; writing it yourself is tolerated and not double-prefixed.",
    "  - `envelope: true` grafts once onto a paged query's envelope instead of each row.",
    "  - `input` maps addon inputs — bind a parent-row column with `out(col)`. `output` restricts addon columns. `children` nests addons.",
    "  - The DEFINITION side — the `addon({...})` factory and `registerAddons` — is a def shape in `llms/kinds-core.md`.",
    "  - Attaching a typed `addon({ table, output })` handle merges its alias (the last `as` segment) onto the row in `InferResponse`: `{cols} | null` for `single`, `{cols}[]` for `list`, `number` for `count`, `boolean` for `exists`, and for `aggregate` an array keyed by the `group`/`eval` aliases (`unknown` values; `unknown` when neither is declared).",
    "  - An attachment-level `output` narrows an object/array graft further. A bare-NAME reference grafts `unknown` — narrow it at the call site.",
    "  - ⚠ An alias that shadows an existing column on the queried table throws at build time; rename with a `_` prefix.",
    "- **Middleware attachment** runs a reusable `middleware({...})` before/after a host's own stack. Distinct from `s.middleware.call` (inline invoke).",
    "  - Attach with the host's `middleware: { pre, post }` field on `query`/`function`/`task`/`tool`/`apiGroup` (NOT triggers): each phase is an ordered list of middleware refs (def handle or name), or `{ middleware, active: false }` to keep an entry disabled.",
    "  - Providing a phase **overrides** it (sets the stored `pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain — the engine resolves Query → API Group → Workspace at request time (override, not merge; the API-Group tier applies to queries — functions/tasks/tools have no API-group binding and inherit straight from the workspace).",
    "  - Prefer a def handle over a bare name when the middleware pins an explicit `guid`.",
    "  - `pre: middleware.clear()` (an empty list) overrides with nothing — stop inheriting.",
    "  - Workspace-level defaults are the terminal tier: `workspaceConfig({ middleware: { query: { pre }, function, task, tool } })` emits the flat `{host}_{phase}` map (no `_customize` flags) — setting it replaces the whole workspace map, so unlisted hosts are cleared; omit the field to leave existing workspace middleware untouched.",
    "- **Middleware request context.** A `pre` middleware runs **after** auth resolution, so `auth()` is available inside the middleware when the host is authenticated (its `auth` names an auth table); on a public host there is no caller identity for it to resolve.",
    "  - This matters for the canonical use — a rate limit keyed by `auth(\"id\")`: on an authenticated endpoint the bucket is per-user, but attach the same middleware to a public endpoint and `auth()` cannot resolve, so the request FAILS with a 403 on the first call, under `max`, with the host never running. Key off `sys.remoteIp()` on a public host.",
    "  - To catch that, `export()` **warns** (never blocks) when a middleware whose stack references `auth()` reaches a host where `auth()` may be null — a `query` with no auth table, a `task` (scheduled, never authenticated), or a `function`/`tool` (whose auth is caller-dependent). An authenticated query (its own `auth` table set) is skipped.",
    "  - Inherited attachment (API group, workspace tier) warns too.",
    "- **Rate-limit recipe (the canonical middleware).** Author it with `s.redis.ratelimit` and a **composite key** built via the filter chain — `\"prefix\" + auth(\"id\")` does not exist, you build the key: `middleware({ name: \"write_rl\", exceptionPolicy: \"rethrow\", stack: [ s.redis.ratelimit({ key: withFilters(c.text(\"rl:write:\"), fl.concat(auth(\"id\"))), max: c.int(10), ttl: c.int(30), error: c.text(\"Too fast.\") }) ] })`.",
    "  - `exceptionPolicy` defaults to `\"rethrow\"`, which is what makes a tripped limit abort with HTTP 429; `\"silent\"` would let the over-limit request through. Without `error` it never trips: it binds `false` and the request runs on (`export()` warns).",
    "  - Attach it with `middleware: { pre: [writeRl] }` on an **authenticated** host; on a public host key off `sys.remoteIp()`.",
    "  - **Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same* key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the key (fold in the host/action name) for an independent limit per host.",
    "- **Middleware `exceptionPolicy`** governs what a **throw** in the middleware stack does to the request. `\"rethrow\"` is the **default** — the throw aborts the request and surfaces the authored `error`/status (a tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs. `\"silent\"` swallows the throw, so a guard set to it is **not enforced** — advisory middleware only. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain.",
    "",
    "- **Request history** controls per-object execution capture (the request/task/trigger debugger). Authored as a single scalar `history` field on any primitive: `false` off, `true` on at the default capture depth, a number = capture depth (how many statement executions are recorded per history record — NOT record retention), `\"all\"` unlimited.",
    "  - **Omit `history` to inherit** — the engine resolves object → container → workspace at request time (a query inherits from its API group, a tool from its toolset envelope, everything else straight from the workspace). Any authored value stops inheriting for that object.",
    "  - Per-kind defaults (when inheriting): query/task/tool capture ON, function/trigger/middleware OFF; default depth 100.",
    "  - Container tiers are authorable too — `apiGroup({ history })` sets the `query_*` default its queries inherit, and an agent/mcp_server/toolset `history` sets the `tool_*` default its tools inherit.",
    "  - Workspace-level defaults are the terminal tier: `workspaceConfig({ history: { query, function, task, tool, trigger, middleware } })` emits the flat `{objType}_enabled`/`{objType}_limit` map (no inherit flag) — setting it is wholesale (unlisted types fall back to their engine default), so declare every default you want to keep; omit the field to leave existing workspace history untouched.",
    "",
    "- **Workspace environment variables** set a tenant's env vars through the workspace object: `workspaceConfig({ env: { STRIPE_KEY: \"\", APP_BASE_URL: \"\" } })`, passed to `registerWorkspace()` — unattached, it declares nothing. Author them as a name→value MAP, declaring each NAME with an EMPTY value. Read a var back with `env(\"NAME\")` (→ `$env.NAME`), which compiles to tag \"setting\" with the plain name.",
    "  - Values are SECRETS and do NOT belong here: they live in `xano/.env`, which is gitignored and survives a `xanosdk pull`, and every command that compiles a bundle reads it with no flag. Fill it by hand from `xano/.env.example`, or run `xanosdk env pull`. CI passes `--backend-env-file <path>` or `--env-var KEY=VALUE` instead. A compiled bundle carries the values in cleartext — don't commit one.",
    "  - What a deploy sends is the RESOLVED map (the declared names, then ONE file — `xano/.env`, or `--backend-env-file <path>` which REPLACES it, never both — then `--env-var`), not the literal object written here. `deploy` REPLACES the tenant's env with it, so a declared name with no value anywhere REFUSES the deploy rather than clearing the live value — fill the name in rather than putting the value back in source, and reach for `--allow-empty-env=NAME` only when clearing is what you mean.",
    "",
    "- **Workspace documentation** gates the workspace's hosted docs: `workspaceConfig({ documentation: { require_token: true } })`. `require_token: true` IS the declaration that a token exists; the value lives in `xano/.secrets.json`, keyed by the object it gates rather than by a name, and a literal `token` FAILS the export. It is NOT a backend env var — `env()` cannot read it. Other members are carried verbatim.",
    "  - ⚠ OMIT the block and NO `documentation` key is emitted, leaving the target's live block as it is; the legacy `realtime` block follows the same rule. An `apiGroup`'s `documentation` follows the OPPOSITE rule — see its def shape.",
    "  - A declared gate with no token emits no block at all and REFUSES a `deploy`; `--allow-empty-doc-token=<scope>` clears that gate deliberately (scope = `workspace`, or an API group's NAME). `xanosdk pull` writes `xano/.secrets.json`, and `--no-secrets` writes none.",
    "  - A merge (`deploy --to`) is ADD-ONLY, matched BY NAME — it creates names the target lacks but does NOT update or remove ones it has, so the target's value wins. Two gaps: a release carries no env values, so a NEW name reads null after `promote`/`tenant deploy` until `env set` (both name it first) — and a `--replace` deploy rebuilds it so every env var the target holds that the config does not declare is DROPPED (named, and confirmed, before it runs). Omit `env` entirely to leave existing env untouched. The separate `settings` field is a plain object.",
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
    "— its guid's seed; a legacy `query:<name>` is migrated by the next locked export.",
    "",
    "- `xanosdk lock rename <kind> <old> <new>` — `kind` is the SDK kind (`table`, `apiGroup`) or stored key (`dbo`).",
    "  Run it when `export` names it after a rename in code (it prints the command); the next export emits the original guid under the new name.",
    "  Reads the `index.ts` beside the lock (or `--entry`); refused while `<old>` is still exported. Composed names go in full; renaming a parent moves them.",
    "- `xanosdk lock prune <entry-file> [keys…] --yes` — drops orphaned entries. Finding orphans",
    "  RUNS the entry's module scope (env assertions included); `--identity-only --yes <key>…`",
    "  prunes named keys (`table:users`) with no evaluation and no orphan check.",
    "- `xanosdk lock import <live-bundle.json> [--yes]` — seed the lock from a `workspace export`",
    "  to take over an existing workspace (a compiled bundle is refused).",
    "- Every lock subcommand accepts `--lock=<path>`; from outside the lock's directory pass it.",
    "- Merge conflict: keep both sides; two keys on one guid → `lock rename` onto the kept",
    "  name, or `lock prune --identity-only --yes` the other.",
    "- Programmatic use: call `seedLockOverrides(readLockFile(path))` BEFORE importing any def",
    "  module — references bake guids at import time; `writeBundle` refuses an unseeded lock.",
    "",
    "What writes the lock: `export`/`deploy`/`release`/`preflight` of an ENTRY FILE update it;",
    "`compile`/`paths` only READ. `--no-lock` builds",
    "without one (names derive guids, the instance invents public URLs, no `--prune`);",
    "REFUSED over a parseable lock. A DEPLOY or a RELEASE writes back only `landed`: what",
    "this project LANDED on each destination (ephemerals: `.xano/ephemeral.json`). `--prune` deletes only that — never a merely",
    "exported name; no record there, no prune until one landing (commit it). A `deploy` (`--replace`",
    "too) PRESERVES the archive's guids, so the lock still describes the rebuilt",
    "workspace. CI: `--frozen-lock` fails (`SDK_DRIFT`) instead of changing the lock, and fails while the lock",
    "carries an entry no exported object matches — a plain `export` only warns and writes that",
    "entry down, after which nothing tells a rename from a deletion: resolve it with",
    "`lock rename` or `lock prune`, or accept them with `--allow-lock-orphans` when they are the",
    "not-yet-ported half of an adopted workspace.",
    "`export --check` implies `--frozen-lock` and writes nothing — no bundle, no lock — so it",
    "reads no `xano/.env` or `.secrets.json` and refuses the flags that supply them; this is",
    "what `npm run xano:check` runs, so CI needs no secrets. With no lock at all, either flag",
    "fails only when the source has identities to record (an empty workspace passes).",
    "",
  ];

  const stmtCalls: string[] = [
    "Auth & calls:",
    "",
    "- `s.security.create_auth_token({ table, id, extras?, expiration?, as? })` — `extras` defaults to `{}`, `expiration` (seconds, a `Value`: `c.int(3600)`) to 86400 (`c.int(0)` = never).",
    "- **Marketplace first:** `@xano-sdk/auth` registers a complete auth surface — signup/login/me endpoints plus their `user`/`account`/`event_log` tables — via `registerAuth(ws, { canonical: \"authn\" })`. Authentication only, not authorization. Inspect with `xanosdk marketplace details @xano-sdk/auth --prompt`.",
    "- **The auth loop end to end** — what that module implements; author it directly for a custom flow. An auth TABLE (`table({ auth: true })`) backs identity; a PUBLIC login query verifies and mints a token; every protected query names that table as `auth:` and reads the caller with `auth(...)`.",
    "  - Signup: `s.db.add({ table: users, row: { email: inp(\"email\"), password: inp(\"password\") } })` — the `f.password()` column hashes on write; take the submission as `input.text()` on signup AND login (see Gotchas on double-hashing).",
    "  - Login: `s.db.get({ table: users, fieldName: \"email\", fieldValue: inp(\"email\"), output: [\"id\", \"password\"], as: \"u\" })` — the `output` naming `password` is REQUIRED (the column is `access: \"internal\"` and absent from the row otherwise) → `s.precondition({ expr: expr(ref(\"u\", { safe: true }), \"!=\", c.null()), error: c.text(\"No such user.\"), error_type: \"notfound\" })` → `s.security.check_password({ text_password: inp(\"password\"), hash_password: ref(\"u.password\"), as: \"ok\" })` → precondition on `ok` → `s.security.create_auth_token({ table: users, id: ref(\"u.id\"), as: \"token\" })` → `response: { token: ref(\"token\") }`.",
    "  - Client: send it as an `Authorization: Bearer <token>` header. A `query({ auth: users })` refuses a request without a valid one before its stack runs; inside the stack `auth(\"id\")` is the caller's row id (`response: { id: auth(\"id\") }` is the whole `me` endpoint).",
    "- **Authorization, on top of that.** `guard.role(users, \"admin\")` and `guard.owner(\"note\", \"user_id\")` each return a fixed-arity TUPLE of statements — spread them (`stack: [...guard.role(users, \"admin\"), …]`); a helper returning `Statement[]` widens the stack and kills `InferResponse`.",
    "  - `guard.role(table, role | roles[], { field?, as?, errorType?, message?, missingErrorType?, missingMessage? })` — fetches the caller's own row by `auth(\"id\")` into `__actor`, asserts it EXISTS (401), then asserts its `role` is in the set (403). Roles type from the enum column; an unknown role or `field` throws. The existence step matters: a role check on a null actor row is not reliably false.",
    "  - `guard.owner(rowVar, ownerField = \"user_id\", { … })` — asserts the row bound to `rowVar` is non-null (404), THEN compares its owner column to `auth(\"id\")` (also 404). Drilling before the existence check is a 500, not a denial: `db.get` binds `null` on a miss and `ref(\"note.user_id\")` against it raises `Unable to locate var`. Takes the var NAME and the column separately for exactly that reason; a dotted path is refused.",
    "  - `guard.found(rowVar, { errorType?, message? })` — ONE statement: asserts the row bound to `rowVar` is non-null (404, `\"Not found.\"`), and NARROWS it — after it, `InferResponse` drops the `| null` from `rowVar`. `guard.owner`'s existence step is this statement.",
    "  - `guard.require(condition, { errorType?, message? })` for anything else — same shape, and it defaults to 403 where a bare `s.precondition` defaults to `standard`, i.e. **500**.",
    "- `s.security.create_uuid({ as? })` — bind a fresh UUID (v4). Takes nothing else. There is NO `create_guid` (internal, unpushable).",
    "- **Receiving a webhook** — no `auth`, no declared `input` (the signature covers the raw bytes): `s.util.get_raw_input({ encoding: \"none\", as: \"raw\" })` → `s.set_var(\"mac\", withFilters(ref(\"raw\"), fl.hmac_sha256(env(\"WH_SECRET\"))))` → `s.set_var(\"sig\", withFilters(sys.httpHeaders(), fl.get(\"X-Signature\")))` (Title-Cased) → an `s.precondition` (`error_type: \"unauthorized\"`) comparing the two TIMING-SAFELY by HMACing both again — `expr(withFilters(ref(\"sig\"), fl.hmac_sha256(env(\"WH_SECRET\"))), \"=\", withFilters(ref(\"mac\"), fl.hmac_sha256(env(\"WH_SECRET\"))))` — BEFORE `fl.json_decode()` reads `raw`. Claim the event id with `s.redis.set({ …, create_only: c.bool(true) })` and answer 200 to a replay.",
    "- `s.function.run({ fn, input?, as?, runtime? })` / `s.function.call({ fn, input?, as? })` — run another function; `input` is keyed by the target's input names (an undeclared one is a type and export error; generic over `fn`, pass `Record<string, Value>`; `2` binds an int — `c.decimal(2)` for a decimal). ⚠ `s.function.run` binds an input it OMITS from the CALLING def's same-named declared input — an endpoint declaring `discount` hands `?discount=100` through, or `0` when the client sends none. An endpoint/tool/prompt declaring NO inputs binds it from the raw request. `ignored()` always takes the target's default. Pass inputs explicitly (`statement.omitted-input` warns).",
    "  - `runtime?` runs it in the BACKGROUND: `{ mode: \"async-shared\" }` or `{ mode: \"async-dedicated\", cpu?, memory?, timeout?, maxRetry? }` (resources read at dedicated only). An async call DOES NOT return the result — it dispatches and continues, and `as` binds the job id (a UUID `string`); collect with `s.await({ ids, timeout, as })`, binding `{ \"<jobId>\": result }`; a too-short `timeout` or unknown id is a 500 `Async timeout`, no partial result. Omit for a normal call; same on `s.ai.agent.run`.",
    "- `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an endpoint. WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`).",
    "  - `api` takes the `query()` def HANDLE (or a `{ name, guid }` pair) — a bare name is refused, because a query's identity is composed from its api group, verb, and name.",
    "  - `headers` REPLACES the request headers the callee sees and takes the same shapes as `s.api.request`'s, or one `Value`.",
    "  - `auth` is `{ token, ignoreExpiration? }`: `token` must be a BARE STRING — a tagged `Value` deploys clean and then fails the run with `Param: token - Text filter requires an integer, float, string or boolean value`, since the engine stores that slot as plain text and never evaluates it.",
    "  - Neither slot authenticates the call today; see `llms/tests.md` for what a workflow-test run actually sees.",
    "- `s.api.request({ url, method?, params?, headers?, timeout?, follow_location?, verify_host?, verify_peer?, ca_certificate?, certificate?, certificate_pass?, private_key?, private_key_pass?, description?, output?, as? })` — external HTTP request (`mvp:api_request`). Ergonomic types, each also accepting a dynamic `Value`:",
    "  - `method` suggests the 7 verbs (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH).",
    "  - `params` a plain JSON object **or** a FLAT record whose values are tagged `Value`s (`{ count: ref(\"count\") }`, each lifted via a `set` filter — the same record-of-values shape `response: { key: value }` takes); a tagged value NESTED inside an object or array THROWS at encode, so wrap a structured body in `obj({...})`, which encodes any depth as one `const:expr2` (→ query string for GET/HEAD/OPTIONS, body otherwise).",
    "  - `headers` a `{ \"Name\": value }` record whose values may be tagged (`{ \"x-api-key\": env(\"KEY\") }`, each pair joined to a `\"Name: value\"` line) **or** a `string[]` of full header lines — prefer a header over a `?key=` query param for a credential — a URL reaches access logs and proxies.",
    "  - \u26a0 Neither spelling is envelope-safe: the `as` envelope's `request` half mirrors `url`, `params` AND `headers`, so never return it raw from a credentialed request \u2014 read `response.result`.",
    "  - A NAME outside the header-token charset is refused, and a LITERAL value (string or `c.text`) carrying CR/LF/NUL is refused; a value may hold `:` and spaces (`Bearer a: b` is a valid value). A TAGGED value cannot be checked at build time, so strip CRLF from caller-controlled input before this slot. Literal pairs are emitted before computed ones, whatever the key order.",
    "  - No `User-Agent` is sent unless `headers` carries one. An API requiring one answers **403** as ordinary `response.result` (no throw; every mapped field reads `null`). Send one (`headers: { \"User-Agent\": c.text(\"my-app\") }`) and gate on `ref(\"<var>.response.status\")` = 200 with `s.precondition`.",
    "  - A transport failure (timeout, DNS) does not throw — `s.try_catch` never catches it: `response.status` is `0`, with `response.error` set. Retry on `status == 0 || status >= 500`; `status < 500` passes a 0.",
    "  - `timeout` a `number` in seconds (1–86400), and `follow_location`/`verify_host`/`verify_peer` booleans.",
    "  - `description` and `output` filters ride the envelope. Cert pairings (certificate↔private_key, ca_certificate→verify_peer) are checked at build time when provable.",
    "  - The `as` result is typed as the `{request, response}` envelope (`response.status: number`, `response.result: unknown`), so `InferResponse` resolves a `ref` to it. Same typed result on `webflow.request` and `microservice.request`.",
    "- `s.stream.from_request({ url, method?, …tls, as? })` — streaming external HTTP request (`mvp:streaming_api_request`); same typed field surface as `s.api.request` (no description/output envelope). `url` is REQUIRED.",
    "- `s.util.send_email({ to, subject, message, from?, cc?, bcc?, reply_to?, service_provider?, api_key?, scheduled_at?, as? })` — send email from the stack. `service_provider` is `\"xano\"` (the built-in mailer — needs NO `api_key` and no configuration, and does not require a verified sender) or `\"resend\"` (pass the key as `api_key: env(\"RESEND_API_KEY\")`). Prefer this over hand-rolling `s.api.request` against a mail provider.",
    "- `s.webflow.request({ path, method?, …tls, as? })` — Webflow API request (`mvp:connect_webflow_api_request`); like `s.api.request` but addressed by `path` (host is engine-supplied), and `path` is REQUIRED — the engine rejects an empty one. No `headers`: the engine builds its own from the workspace's Webflow connection and ignores an authored value.",
    "- `s.task.call` / `s.tool.call` / `s.trigger.call` / `s.middleware.call` / `s.addon.call` — same `{ <target>, input?, as? }` shape against the named kind. `s.task.call` and `s.trigger.call` are WORKFLOW-TEST ONLY (see Gotchas in `llms.txt`); `s.tool.call`, `s.middleware.call` and `s.addon.call` run from any stack.",
    "- `s.action.call({ actionId, input?, registry?, as? })` / `s.action.package.call({ traceId, versionId, slug, input?, registry?, as? })` — invoke an installed action. Ids are SUPPLIED, never derived from a name: an action is installed onto the instance, so its identity is assigned at install and differs per instance — read them off a call in a pulled workspace. The package form needs all three parts; they are one composite and two of them address nothing. `registry` is the action's own settings, `input` the per-call arguments.",
    "- `s.cloud.job({ image, command, args?, secret?, template?, await?, as? })` — launch a containerized job. `image`/`command` are REQUIRED; omitted → `Missing param`. ⚠ `await` is SECONDS (default 60), not a boolean.",
    "- `s.cloud.job.status({ id, as? })` · `s.cloud.job.await({ ids, timeout, as? })` — poll one job, or block on several (`ids` a list `Value`, `timeout` in seconds; both required).",
    "",
    "Microservices (the `microservice()` def and the statement that calls it):",
    "",
    "- `microservice({ name, kind, … })` — two mutually exclusive shapes via `kind`: `builtin` declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and `helm` points at a chart and its `values` — passing both throws.",
    "  - EARLY SURFACE, expected to change — every export of a workspace declaring one prints a notice saying so.",
    "  - `configs`/`volumes` are typed and `@deprecated` but NOT deployable: the engine rejects an import carrying either, so `export()` fails the build rather than letting the deploy fatal.",
    "  - Put a value the workload reads in a container's `env`, and storage in a container's own `volumes` (`emptyDir`/`persistent`/`config`).",
    "  - Container names are free-form — they need not match the microservice name, which is what a stack addresses.",
    "- SECRETS RIDE ALONG — `chart.values` and `registryAuth.dockerconfigjson` are carried into the bundle, and into a pulled tree, verbatim. `process.env.X` in the def is NOT a way out: it resolves at EXPORT and writes the literal in.",
    "  - Reference a `workspaceConfig({ env })` var instead and only the NAME travels — the engine substitutes at DEPLOY. Two spellings: `env: [{ name: \"API_KEY\", fromEnv: \"STRIPE_SECRET\" }]` on a builtin container (`value`/`fromEnv` exclusive; both → build error), or `${env.NAME}` inside a helm `chart.values` (a VALUE at any depth, never a key). A name the workspace does not define FAILS the deploy rather than resolving blank.",
    "  - `registryAuth.dockerconfigjson` has NO such form: either leave it unset and pull a public image, or treat the bundle and any tree pulled from it as secret material — out of git, or rotate after. Export prints a notice per microservice carrying a literal; `--strict` does not promote it.",
    "- `s.microservice.request({ host, path, port?, method?, params?, headers?, timeout?, follow_location?, as? })` — in-cluster microservice call (`mvp:microservice_request`); no TLS fields.",
    "  - ONLY `host`+`path` required; the rest default to the engine's values (`GET`/`{}`/`[]`/`10`/`true`), always emitted.",
    "  - Pass the `microservice()` DEF as `host` — it binds by NAME (how the engine resolves it), so a rename fixes every call site and the port is checked before deploy.",
    "  - `port?` folds into `host` as `\"name:port\"`: a def exposing ONE `servicePort` resolves automatically, SEVERAL requires it.",
    "  - A raw `\"name:port\"` string works, unvalidated, and is the only way to reach an instance-level microservice.",
    "  - `tenantDeploy: \"manual\"` on the def imports the row without starting the workload.",
    "- `s.workflow_test.call({ workflowTest, datasource?, as? })` — run another workflow test from inside one, which is the only place it runs (see Gotchas in `llms.txt`). The odd one out: NO `input` (a workflow test takes none), and it carries `datasource?` instead — same clone caveat as the kind's own field.",
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
    const stmtCatalog: string[] = [];
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
      "Older paradigms this SDK still supports and still emits when it decodes an existing",
      "workspace. **Do not author these.** They are listed by name only so you recognize them",
      "in pulled code rather than \"fixing\" them; each line names what to use instead.",
      "",
      "Names overlap across the split deliberately — the engine reused words like",
      "\"realtime\" and \"channel\" for both generations. A name matching is NOT evidence that",
      "two things are the same object; check which list it came from.",
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
        "Read when `package.json` has a `\"xanosdk\"` block or you run `xanosdk marketplace`.",
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
      readWhen: "Read when defining an `agent()`, `mcpServer()`, `prompt()` or `resource()`.",
      body: s.kindsAgentMcp,
    },
    {
      path: "llms/kinds-knowledge.md",
      title: "Knowledge def shape",
      readWhen:
        "Read when the workspace defines a `knowledge()` item for its AI agents.",
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
