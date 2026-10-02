/**
 * The central `Xano` registry. Authoring happens in a `xano/` folder
 * tree; modules export typed objects and register them **explicitly** on a
 * `Xano` instance (no folder auto-discovery magic — confirmed with the user).
 * `export()` walks the registrations and emits the aggregate `packageExport`
 * bundle.
 *
 * Per-kind sugar methods (`registerFunctions`, …) are thin wrappers over the
 * generic `register(kindName, …)`. More sugar is added as each kind lands.
 */
import type { AnyWarningCode } from "../codes.js";
import { getKind, encodeObject } from "../kinds/kind.js";
import { getLockedCanonical } from "../lock/store.js";
import { describeEntry } from "../statements/args.js";
import { isTaggedValue } from "../values/value.js";
import { obj, type ObjInput } from "../values/obj.js";
import { AUTHOR_KIND_NAME, assertDefShape, assertNoProtoKeys } from "../kinds/def-shape.js";
import { assertNameAsStored } from "../kinds/stored-name.js";
import { DEF_KEYS, assertDefKeys } from "../kinds/def-keys.js";
import { nearestKey } from "../util/known-keys.js";
import { defKindOf } from "../kinds/def-brand.js";
import { withArticle } from "../util/article.js";
import { sdkKindName } from "../util/sdk-kind.js";
import { middlewareEntryGuid, stackReferencesAuth } from "../kinds/middleware-attach.js";
import { deriveGuid, refSpelling, resolveRef, REFERENCEABLE_KINDS } from "../refs/guid.js";
import { buildBundle } from "./export.js";
import {
  documentationTokenDeclarations,
  resolveDocumentationTokens,
  type DocumentationTokenDeclaration,
  type SecretsRemedy,
} from "./documentation-token.js";
import type { Bundle, BundleType, PayloadArrayKey } from "./export.js";
import {
  identityNamesByGuid,
  CANONICAL_PAYLOAD_KEYS,
  lockKey,
  lockNameForObject,
  LOCK_PAYLOAD_KEYS,
  mintCanonical,
  recordObserved,
  WORKSPACE_KEY,
} from "../lock/lock.js";
import type { CanonicalSource, LockEntry, LockExportContext } from "../lock/lock.js";
import type { FunctionDef } from "../function/define.js";
import type { TableDef } from "../kinds/table.js";
import type { KnowledgeDef } from "../kinds/knowledge.js";
import type { ResolvedKnowledge } from "./knowledge.js";
import type { HostedFileResolver } from "./hosted-file.js";
import { HOSTED_ICON_KINDS, pendingHostedFile } from "../fields/hosted-file.js";
import type { QueryDef } from "../kinds/query.js";
import type { ApiGroupDef } from "../kinds/api-group.js";
import type { TriggerDef } from "../kinds/trigger.js";
import type { TaskDef } from "../kinds/task.js";
import type { MiddlewareDef } from "../kinds/middleware.js";
import type { AddonDef } from "../kinds/addon.js";
import type { ToolDef } from "../kinds/toolset.js";
import type { PromptDef } from "../kinds/prompt.js";
import type { ResourceDef } from "../kinds/resource.js";
import type { McpServerDef } from "../kinds/mcp-server.js";
import type { AgentDef } from "../kinds/agent.js";
import type { MicroserviceDef } from "../kinds/microservice.js";
import type { RealtimeServerDef } from "../kinds/realtime-server.js";
import type { RealtimeChannelDef } from "../kinds/realtime-channel.js";
import type { RealtimeMessageDef } from "../kinds/realtime-message.js";
import type { WorkflowTestDef } from "../kinds/workflow-test.js";
import type { WorkspaceConfigDef } from "../kinds/workspace-config.js";
import type { InputDescriptor } from "../inputs/input.js";
import type { ResponseDef } from "../responses/response.js";
import type { Statement } from "../statements/statement.js";

/**
 * The register methods take the WIDEST instantiation of each def type, not the
 * bare name.
 *
 * A def's `Res` parameter surfaces as `responseShape?: Res` and defaults to
 * `never`, so the bare `FunctionDef` — the spelling the issue proposed —
 * accepts only defs that declare NO `responseShape`: the moment an author adds
 * one, `responseShape?: MyType` stops being assignable to `responseShape?:
 * never` and the registration they were already making stops compiling. Pinning
 * `Res` to `unknown` (and every other parameter to its own constraint) accepts
 * every instantiation while still rejecting an object that is not that kind of
 * def at all.
 */
type AnyInputs = Record<string, InputDescriptor>;
type AnyStack = readonly Statement[];
/** Any function def, whatever its input/response/stack parameters resolved to. */
type AnyFunctionDef = FunctionDef<AnyInputs, unknown, ResponseDef, AnyStack>;
type AnyQueryDef = QueryDef<AnyInputs, unknown, ResponseDef, AnyStack, string>;
type AnyToolDef = ToolDef<AnyInputs, unknown, ResponseDef, AnyStack>;
type AnyPromptDef = PromptDef<AnyInputs, unknown, ResponseDef, AnyStack>;
type AnyResourceDef = ResourceDef<AnyInputs, unknown, ResponseDef, AnyStack>;
type AnyTriggerDef = TriggerDef<unknown, ResponseDef, AnyStack>;
type AnyMiddlewareDef = MiddlewareDef<unknown, ResponseDef, AnyStack>;
type AnyRealtimeMessageDef = RealtimeMessageDef<AnyInputs, unknown, ResponseDef, AnyStack>;
type AnyRealtimeChannelDef = RealtimeChannelDef<AnyInputs, string>;
type AnyAddonDef = AddonDef<unknown>;
type AnyTableDef = TableDef<string, unknown>;
/** The leaf hosts that run a middleware chain on their own request. */
const MIDDLEWARE_HOST_KINDS = ["query", "task", "function", "tool", "prompt", "resource"] as const;
type MiddlewareHostKind = (typeof MIDDLEWARE_HOST_KINDS)[number];
import type { ObjectKind } from "../kinds/kind.js";
import { assertMockKeysResolved, assertTestIds } from "../kinds/test-mocks.js";
import {
  allowableWarnings,
  DiagnosticBag,
  setDiagnosticSink,
  type Diagnostic,
  type DiagnosticSubject,
} from "./diagnostics.js";
import {
  checkDecodeOnlyStatements,
  checkRunFamilyHosts,
  checkLiveDatasourceTests,
  checkExpressionOperands,
  checkInterpolatedValues,
  checkMcpStackHazards,
  checkZeroBasedObjects,
  checkIntRange,
  checkRegexOperandOrder,
  checkTimezoneArgs,
  checkReferences,
  checkMicroserviceReferences,
  checkNonJsonValues,
  checkRealtimeGates,
  checkToolAuthIdentity,
  checkPrimitiveAuthIdentity,
  checkWriteBeforeElicit,
  checkMcpResourceUris,
  checkStackAuthRatelimit,
  checkRatelimitWithoutError,
  checkAuthNoCaller,
  checkRealtimeSilentShapes,
  checkNonNullVectorColumns,
  checkRealtimeDeliver,
  checkRealtimeJoinDeliver,
  checkSeed,
  checkReservedColumnNames,
  checkUnusableColumnNames,
  checkCacheTtl,
  checkReservedInputNames,
  checkOmittedCallInputs,
  checkUnknownCallInputs,
  checkAddonAttachments,
  checkUnitTests,
  checkAddonOutput,
  checkGuardRoleColumns,
  checkToolOutputSchema,
  checkAgentArgPlaceholders,
  checkAssertionsOutsideTests,
  checkAgentApiKeys,
  checkKnowledge,
  checkRealtimePublish,
  checkTriggerBindings,
  checkPasswordInputHashing,
  checkZipPasswordKeys,
  checkToThrowScope,
  checkUnboundVarRefs,
  checkSafeRefMatchArgs,
  checkNullMatchArgs,
  checkPathSegmentCandidates,
  checkRouteShadowing,
  checkSameNameSiblings,
  checkStacks,
  postEnvelopeMisreads,
  unnestedEnvelopeReads,
  checkLoopControl,
  checkSwitchFallthrough,
  checkSearchOperandFilters,
  checkApiGroupDocsExposure,
  checkDocumentationTokens,
  checkMicroserviceSecrets,
  checkMicroserviceBlocks,
} from "./guards.js";
import { checkMcpOauth, checkMcpOauthRevoke } from "./guards-mcp-oauth.js";
import { checkFilterOperands } from "./filter-operands.js";

/**
 * Cross-realm brand. `instanceof Xano` breaks when Xano SDK is loaded by two
 * different module loaders (e.g. the CLI under bare Node while a `.ts` entry is
 * loaded through tsx), since each loader has its own `Xano` constructor. A
 * `Symbol.for` key is shared through the global registry, so a structural
 * brand check survives that split.
 */
const XANO_BRAND: unique symbol = Symbol.for("xanosdk.Xano");

/**
 * Where a registry was created: an `Error` whose stack names the module that
 * called `new Xano()` / `workspace()`. `writeBundle` reads it to find the
 * project the defs belong to when nothing else names one. Registry-keyed, so
 * every loaded copy of the SDK reads the same slot.
 */
export const XANO_ORIGIN: unique symbol = Symbol.for("xanosdk.Xano.origin");

/**
 * An encode failure from a nested response record, named where the author
 * wrote it. `response: { x: { t: toolset("token") } }` wraps `{ t: … }` in an
 * `obj()` at encode time — the only `obj()` an export itself calls — so its
 * refusal said "obj(): `t`…" with no def and no `x`. Found by re-trying each
 * record member; any other failure passes through untouched.
 */
function nameResponseRecordError(err: unknown, kindName: string, def: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const response = (def as { response?: unknown; name?: unknown } | null)?.response;
  if (response === null || typeof response !== "object" || isTaggedValue(response)) return err;
  if (err.message.startsWith("`response.")) {
    err.message = `${authorKindName(kindName)} "${String((def as { name?: unknown }).name)}": ${err.message}`;
    return err;
  }
  // A top-level member that is not a record reaches `obj()` too, whose refusal
  // names neither the def nor the key — and the author never called `obj()`.
  if (err.message.startsWith("obj() takes a { key: value } record")) {
    const bad = Object.entries(response).find(([, m]) => typeof m !== "object" || m === null || Array.isArray(m));
    if (bad !== undefined) {
      const [key, member] = bad;
      err.message =
        `${authorKindName(kindName)} "${String((def as { name?: unknown }).name)}": \`response.${key}\` is ` +
        `${describeEntry(member)} — a response key takes a value (\`ref("x")\`, \`c.*\`) or a { key: value } record.` +
        (Array.isArray(member)
          ? ` A list of values goes inside a record member (\`${key}: { items: [ … ] }\`), or bind it first ` +
            `(\`s.set_var\`) and use \`ref()\`; a list of constants is \`c.array([ … ])\`.`
          : "");
    }
    return err;
  }
  if (!err.message.startsWith("obj(): `")) return err;
  for (const [key, member] of Object.entries(response)) {
    if (member === null || typeof member !== "object" || Array.isArray(member) || isTaggedValue(member)) continue;
    try {
      obj(member as ObjInput);
    } catch {
      err.message =
        `${authorKindName(kindName)} "${String((def as { name?: unknown }).name)}": ` +
        err.message.replace("obj(): `", `\`response.${key}.`) +
        ` A nested response record is one object expression; a top-level response key can carry this value as it is.`;
      break;
    }
  }
  return err;
}

/**
 * One entry of a `register*` call must be a def object. Through `any` — most
 * often a `cond && fn` entry — `undefined` reached the encoder and reported
 * `Cannot read properties of undefined (reading 'name')`, naming nothing the
 * author wrote. Worded like the stack-entry guard, with the same remedy.
 */
function assertDefEntry(via: string, kindName: string, def: unknown, index: number | undefined): void {
  if (typeof def === "object" && def !== null && !Array.isArray(def)) return;
  const at = index === undefined ? "its argument" : `entry [${index}]`;
  const hint =
    def === false || def === undefined
      ? " A `cond && def` entry leaves false/undefined behind — spread it instead: `...(cond ? [def] : [])`."
      : typeof def === "function"
        ? " A factory passed uncalled is a function — call it: `table({ … })`, not `table`."
        : Array.isArray(def) && index === undefined
          ? ` It takes one def, not a list — \`${via}(def)\`.`
          : "";
  throw new Error(`${via}: ${at} must be ${withArticle(authorKindName(kindName))} def — got ${describeEntry(def)}.${hint}`);
}

/** The factory name an author writes for a registry kind. */
function authorKindName(kindName: string): string {
  return AUTHOR_KIND_NAME[kindName] ?? (kindName === "workspace" ? "workspaceConfig" : kindName);
}

/** The `register*` method that takes each registry kind. */
const REGISTER_METHOD: Readonly<Record<string, string>> = {
  workspace: "registerWorkspace",
  table: "registerTables",
  function: "registerFunctions",
  query: "registerQueries",
  api_group: "registerApiGroups",
  task: "registerTasks",
  middleware: "registerMiddleware",
  addon: "registerAddons",
  tool: "registerTools",
  prompt: "registerPrompts",
  resource: "registerResources",
  mcp_server: "registerMcpServers",
  agent: "registerAgents",
  trigger: "registerTriggers",
  knowledge: "registerKnowledge",
  microservice: "registerMicroservices",
  realtime_server: "registerRealtimeServers",
  channel: "registerRealtimeChannels",
  message: "registerRealtimeMessages",
  workflow_test: "registerWorkflowTests",
};

/**
 * A def made by ANOTHER kind's factory is refused by name, before any encoder
 * reads it. Through `any`, `registerFunctions([queryDef])` exported the query as
 * a function, `registerQueries([functionDef])` said "`verb` is required", and
 * `registerTriggers([functionDef])` crashed with a TypeError. The factory's
 * brand says which kind a def is; a def with none is left to the shape check.
 */
/**
 * The kind a def with NO brand plainly is, from a key only that kind carries —
 * a spread (`{ ...group }`) or a literal drops the brand. A query is the one
 * kind with `verb` (its factory ships in browser bundles, so it is not
 * branded); an API group the one with `cors`, and the one besides the workspace
 * config with `swagger`. Anything else is left to the shape check.
 */
function structuralKind(def: unknown, kindName: string): string | undefined {
  if (typeof def !== "object" || def === null) return undefined;
  const d = def as { verb?: unknown; cors?: unknown; swagger?: unknown; canonical?: unknown; objType?: unknown };
  if (typeof d.verb === "string") return "query";
  // A trigger is the one kind with `objType`: a decoded realtime trigger is
  // written as a literal that `satisfies TriggerDef`, which carries no brand.
  if (typeof d.objType === "string") return "trigger";
  if (d.cors !== undefined || (d.swagger !== undefined && kindName !== "workspace")) return "api_group";
  // `canonical` is a group's URL slug. The other kinds that carry one (an MCP
  // server, an agent, a realtime server) are branded by their factories, so an
  // UNBRANDED def with a slug is a group — `apiGroup()` is the identity and
  // leaves no brand. Only where the target kind has no slug of its own.
  if (d.canonical !== undefined && !CANONICAL_KINDS.has(kindName)) return "api_group";
  return undefined;
}

/**
 * The registry kind of a lone def: the brand its factory stamped, else a key
 * only one kind carries (a query's `verb`, a group's `cors`/`swagger`/`canonical`,
 * a table's `schema`). `undefined` when nothing says — a def compiled alone has
 * no `register*` call to say it instead.
 */
export function standaloneDefKind(def: unknown): string | undefined {
  const branded = defKindOf(def);
  if (branded !== undefined) return branded;
  const structural = structuralKind(def, "");
  if (structural !== undefined) return structural;
  if (typeof def !== "object" || def === null) return undefined;
  if ((def as { schema?: unknown }).schema !== undefined) return "table";
  // `apiGroup()` is the identity, so a group with none of its own keys set
  // (`apiGroup({ name, description })`) carries no mark. Every other factory
  // brands its def, so an unbranded one whose keys are all a group's is a group.
  const keys = Object.keys(def);
  if (keys.includes("name") && keys.every((k) => API_GROUP_KEYS.has(k))) return "api_group";
  return undefined;
}

const API_GROUP_KEYS: ReadonlySet<string> = new Set(DEF_KEYS["api_group"]);

/** The registry kinds whose defs carry a `canonical` slug of their own. */
const CANONICAL_KINDS: ReadonlySet<string> = new Set(["api_group", "mcp_server", "agent", "realtime_server", "workspace"]);

function assertDefKind(via: string, kindName: string, def: unknown, index: number | undefined): void {
  const made = defKindOf(def) ?? structuralKind(def, kindName);
  if (made === undefined || made === kindName) return;
  const at = index === undefined ? "its argument" : `entry [${index}]`;
  const method = REGISTER_METHOD[made];
  throw new Error(
    `${via}: ${at} is ${withArticle(authorKindName(made))} def, not ${withArticle(authorKindName(kindName))} def` +
      (method === undefined ? "." : ` — use ${method}.`),
  );
}

/**
 * A def's `diagnostics.allow`, checked against the codes its kind offers. A code
 * the kind never raises would accept nothing, and a misspelt one would read as
 * accepted while the warning kept failing `--strict` — both are refused.
 */
function acceptedWarnings(kindName: string, def: unknown): ReadonlySet<string> | undefined {
  const diagnostics = (def as { diagnostics?: unknown } | null)?.diagnostics;
  if (diagnostics === undefined || diagnostics === null) return undefined;
  const offered = allowableWarnings(kindName);
  const name = (def as { name?: unknown }).name;
  const owner = `${authorKindName(kindName)}${typeof name === "string" ? ` "${name}"` : ""}`;
  const codes = offered.map((c) => `"${c}"`).join(", ");
  if (offered.length === 0) throw new Error(`${owner}: \`diagnostics\` — this def raises no warning that can be accepted.`);
  const allow = (diagnostics as { allow?: unknown }).allow;
  const extra = typeof diagnostics === "object" ? Object.keys(diagnostics).find((k) => k !== "allow") : undefined;
  if (typeof diagnostics !== "object" || !Array.isArray(allow) || extra !== undefined) {
    throw new Error(
      `${owner}: \`diagnostics\` must be { allow: [...] } — got ${describeEntry(extra ?? allow ?? diagnostics)}` +
        `${extra === undefined ? "" : " as a key"}. Codes this def can accept: ${codes}.`,
    );
  }
  for (const code of allow) {
    if (typeof code === "string" && offered.includes(code)) continue;
    const near = typeof code === "string" ? nearestCode(code, offered) : undefined;
    throw new Error(
      `${owner}: \`diagnostics.allow\` names ${typeof code === "string" ? `unknown code "${code}"` : describeEntry(code)} ` +
        `for ${withArticle(authorKindName(kindName))}${near === undefined ? "." : ` — did you mean "${near}"?`} ` +
        `Codes this def can accept: ${codes}.`,
    );
  }
  return new Set(allow as string[]);
}

/** The options {@link Xano.export} takes. */
export interface ExportOptions {
  lock?: LockExportContext;
  strict?: boolean;
  /**
   * Knowledge bodies and reference files, already read off disk by the Node
   * compile path. Passed IN rather than read here so `export()` stays free
   * of `node:fs`, and filled before signing because a knowledge body rides
   * inside the payload rather than as a separate archive member.
   */
  knowledge?: readonly ResolvedKnowledge[];
  /**
   * Reads each `hostedFile(...)` a field references, on the Node compile
   * path. Every pending placeholder is filled from it before signing, and
   * the files it read become the payload's file library. Without it the
   * placeholders stay inert and no file ships.
   */
  hostedFiles?: HostedFileResolver;
  /**
   * Deploy-time workspace environment variables, merged over the authored
   * `workspaceConfig({ env })` before the bundle is signed. The CLI fills
   * these from `xano/.env` by default, or from `--backend-env-file <path>` /
   * `--env-var KEY=VALUE`. Values pass straight through to the bundle and
   * are never written anywhere else.
   */
  envOverrides?: Readonly<Record<string, string>>;
  /**
   * Documentation-token values, keyed by SCOPE — `workspace`, or `apiGroup:<guid>`
   * for an API group. Read from `xano/.secrets.json` rather than from
   * `xano/.env`: this is a secret addressed by the object that holds it, not
   * by a name a stack reads.
   *
   * These are NOT backend env vars and must never reach the bundle's
   * top-level `env` — that array is the workspace's own environment, and a
   * doc-site token is not one of its variables. They are substituted into
   * the documentation blocks here, before the bundle is signed, because the
   * bundle is signature-sealed and a later patch invalidates it.
   *
   * A declared gate with no value here emits NO `documentation` key at all,
   * never an empty token. `allowEmptyDocToken` is the one way an author
   * turns an unresolved gate into a deliberately cleared one.
   */
  documentationTokens?: Readonly<Record<string, string>>;
  /** Scope keys the author has said may be sent EMPTY. */
  allowEmptyDocToken?: ReadonlySet<string>;
  /**
   * Filled with every warning a `diagnostics.allow` accepted — never printed,
   * never failing `strict`, but still found. Filled before the export can
   * refuse, so a fixture reads it whether or not the export threw.
   */
  accepted?: Diagnostic[];
  /**
   * The secrets file and `secrets fill` command the documentation-token
   * findings name — the ones this entry actually uses. Defaults to the
   * scaffold's `xano/.secrets.json` and a bare `xanosdk secrets fill`.
   */
  secretsRemedy?: SecretsRemedy;
}

/**
 * A register or export refusal classed as the author's mistake. A plain
 * `Error` raised while encoding a def or assembling the bundle is a check
 * refusing what was registered — two objects on one identity, a response that
 * is not a value — so it is tagged a
 * usage failure (`SDK_USAGE`), by shape, as this layer does not import the CLI's
 * error types. One that carries its own `code`, and a `TypeError` or other
 * runtime fault, keeps its class: that is the SDK's fault, not the author's.
 */
function asAuthoringRefusal(err: unknown): unknown {
  if (err instanceof Error && Object.getPrototypeOf(err) === Error.prototype && (err as { code?: unknown }).code === undefined) {
    Object.defineProperty(err, "name", { value: "UsageError", configurable: true, writable: true });
  }
  return err;
}

/** The offered code a misspelt one most likely meant: a spelling slip, or the same code cut short or lengthened. */
function nearestCode(code: string, offered: readonly string[]): string | undefined {
  return nearestKey(code, offered) ?? offered.find((c) => c.includes(code) || code.includes(c));
}

export class Xano {
  /** @internal cross-realm identity brand — see {@link Xano.isXano}. */
  readonly [XANO_BRAND] = true;

  constructor() {
    Object.defineProperty(this, XANO_ORIGIN, { value: new Error("registry created"), enumerable: false });
  }
  /** Encoded objects keyed by `packageExport` payload key. */
  private readonly sections = new Map<string, unknown[]>();
  /** Table defs, encoded lazily at {@link export} so each can inherit the workspace `use_xdo`. */
  private readonly tableDefs: TableDef[] = [];
  private readonly knowledgeDefs: KnowledgeDef[] = [];
  private workspaceConfig: Record<string, unknown> = {};
  /**
   * Whether the attached config named `env` at all — `env: {}` included. The
   * encoded config always carries an `env` list, so it cannot tell a config that
   * declares none on purpose from one that was never attached; this can.
   */
  private envAuthored = false;
  /**
   * Whether a config was passed to {@link registerWorkspace} by the author, as
   * opposed to the `{ name }` the {@link workspace} shorthand registers. Lets the
   * env guard tell "no config attached" from "the attached config has no `env`".
   */
  private configAttached = false;
  private bundleType: BundleType = "workspace";
  /**
   * Encoded objects whose `canonical` a locked {@link export} filled in (from
   * the lock or freshly minted) rather than the author writing it.
   *
   * The fill mutates the registered object, so a second `export()` off the same
   * registry can no longer see that the slug started empty. Without this the
   * re-export would classify a minted token as a pinned one and a later release
   * would refuse over a URL nobody promised.
   */
  private readonly filledCanonicals = new WeakSet<object>();
  /** The filled canonicals whose lock entry was adopted from a live backend (`canonical_source: "adopted"`). */
  private readonly adoptedCanonicals = new WeakSet<object>();
  /** Every guid a def pins with its own `guid:` — recorded in the lock as `guid_source: "code"`. */
  private readonly codeGuids = new Set<string>();

  /** True for any `Xano` registry, even one created by a different module instance. */
  static isXano(value: unknown): value is Xano {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[XANO_BRAND] === true
    );
  }

  /** Encode one def and stamp its deterministic guid (the engine's sync/reference anchor). */
  private encodeOne(kind: ObjectKind<unknown, unknown>, def: unknown): unknown {
    let encoded: unknown;
    // A warning the encoder raises is about THIS def: held and raised again by
    // each export, about the encoded object, so the def's `diagnostics.allow`
    // reaches it and `strict` fails on it like any other export finding.
    const raised: Diagnostic[] = [];
    const previous = setDiagnosticSink((d) => raised.push(d));
    try {
      encoded = kind.encode(def);
    } catch (err) {
      throw asAuthoringRefusal(nameResponseRecordError(err, kind.name, def));
    } finally {
      setDiagnosticSink(previous);
    }
    if (raised.length > 0 && encoded !== null && typeof encoded === "object") this.encodeWarnings.set(encoded, raised);
    // `mock` is offered on every statement, but only the kinds that store
    // `test[]` resolve its keys from test name to test id. Elsewhere it would
    // encode still keyed by name, and the engine ignores a mock whose key is
    // not a real test id — deploying clean and silently never applying.
    assertTestIds(encoded, kind.name);
    assertMockKeysResolved(encoded, kind.name);
    // Every guid-bearing object carries a deterministic guid — its identity
    // anchor for sync (the engine upserts by guid) and the target of any
    // reference (see refs/guid.ts). A standalone `compile()` has no
    // cross-references to resolve.
    if (REFERENCEABLE_KINDS.has(kind.name) && encoded && typeof encoded === "object") {
      const obj = encoded as Record<string, unknown>;
      // An explicit `guid` on the def is used verbatim (pins identity across a
      // rename / matches an existing workspace object); otherwise derive a
      // stable one from the display name. Guid type is the migrate type
      // (== payloadKey), e.g. table → "dbo".
      // A kind whose identity is not `md5("<payloadKey>:<name>")` declares
      // `guidOf` (the realtime family — a channel path is unique only per
      // server, a message name only per channel, so the name alone would make
      // two distinct objects share one guid and collapse onto one row).
      const explicit = (def as { guid?: string }).guid;
      if (obj.guid === undefined && typeof obj.name === "string") {
        obj.guid = explicit ?? kind.guidOf?.(def) ?? deriveGuid(kind.payloadKey, obj.name);
      }
      if (typeof explicit === "string" && explicit !== "" && obj.guid === explicit) this.codeGuids.add(explicit);
    }
    return encoded;
  }

  /** Register one or more authoring defs of a given kind. */
  register(kindName: string, defOrDefs: unknown, via = `register(${JSON.stringify(kindName)})`): this {
    const kind = getKind(kindName);
    const defs = Array.isArray(defOrDefs) ? defOrDefs : [defOrDefs];
    defs.forEach((def, i) => {
      assertDefEntry(via, kind.name, def, Array.isArray(defOrDefs) ? i : undefined);
      assertDefKind(via, kind.name, def, Array.isArray(defOrDefs) ? i : undefined);
      const name = (def as { name?: unknown }).name;
      // Keys first: `table({ schmea })` is a misspelt `schema`, not a missing one.
      assertDefKeys(`${authorKindName(kind.name)}${typeof name === "string" ? ` "${name}"` : ""}`, def, DEF_KEYS[kind.name], kind.name);
      assertDefShape(kind.name, def as Record<string, unknown>);
      assertNameAsStored(authorKindName(kind.name), name);
    });
    // Checked with the shape, before anything is recorded: a refused allow
    // leaves no def half-registered behind it.
    const allows = defs.map((def) => acceptedWarnings(kind.name, def));
    for (const def of defs) this.assertNotAlreadyRegistered(kind.name, def);
    // Tables are encoded lazily at export: a table's `use_xdo` defaults to the
    // workspace's `use_xdo`, which may be registered in any order, so we resolve
    // it once both are known (see {@link export}).
    if (kind.name === "table") {
      // The encoded dbo inherits the allow at export; the def carries it too,
      // because the column checks read the def.
      defs.forEach((def, i) => {
        this.tableDefs.push(def as TableDef);
        if (allows[i]) this.accepted.set(def as object, allows[i]);
      });
      return this;
    }
    // Knowledge encodes eagerly like everything else, but the AUTHORED def is
    // kept too: its `body`/`refs` markers are paths the Node compile path reads,
    // and they are deliberately absent from the encoded xdo.
    if (kind.name === "knowledge") {
      for (const def of defs) this.knowledgeDefs.push(def as KnowledgeDef);
    }
    const bucket = this.sections.get(kind.payloadKey) ?? [];
    defs.forEach((def, i) => {
      const encoded = this.encodeOne(kind, def);
      const allow = allows[i];
      if (allow && encoded && typeof encoded === "object") this.accepted.set(encoded, allow);
      bucket.push(encoded);
    });
    this.sections.set(kind.payloadKey, bucket);
    return this;
  }

  /**
   * A table's bundle entry, encoded now that the workspace `use_xdo` is known: a
   * table without an explicit `useXdo` inherits the workspace default.
   */
  private encodeTableEntry(def: TableDef): Record<string, unknown> {
    const wsUseXdo = this.workspaceConfig.use_xdo === true;
    const encoded = this.encodeOne(
      getKind("table") as ObjectKind<unknown, unknown>,
      def.useXdo === undefined ? { ...def, useXdo: wsUseXdo } : def,
    ) as Record<string, unknown>;
    // The engine decorates each dbo with an import directive *only* at
    // package-export time — it isn't part of the stored dbo, so it lives here
    // rather than in `encodeTable`. The import reader switches on `import.mode`;
    // "standard" = create-or-update by guid (merge/reference are the
    // marketplace-install modes). Without it the import fatals on an undefined
    // "import" key.
    const dbo = { ...encoded, import: { mode: "standard" } };
    const allow = this.accepted.get(def);
    if (allow) this.accepted.set(dbo, allow);
    const raised = this.encodeWarnings.get(encoded);
    if (raised) this.encodeWarnings.set(dbo, raised);
    return dbo;
  }

  /**
   * @internal The entry `def` becomes in the bundle a registry holding only it
   * exports — what `emit` and `xanosdk compile` print. Registered first, so the
   * def is validated exactly as a `register*` call validates it; the encoder's
   * warnings are returned rather than printed, for the caller's checks to raise.
   * The cross-object fills a lone def can take are applied as export applies
   * them: an empty canonical from the seeded lock, hosted-file icons from
   * `opts.hostedFiles`, a group's documentation token from
   * `opts.documentationTokens`. Knowledge bodies are export's.
   */
  encodeEntry(
    kindName: string,
    def: unknown,
    opts: { hostedFiles?: HostedFileResolver; documentationTokens?: Record<string, string> } = {},
  ): { payloadKey: string; entry: Record<string, unknown>; warnings: readonly Diagnostic[] } {
    const kind = getKind(kindName);
    if (kind.name === "workspace") {
      this.registerWorkspace(def as WorkspaceConfigDef);
      return { payloadKey: kind.payloadKey, entry: this.export().payload.workspace as Record<string, unknown>, warnings: [] };
    }
    this.register(kind.name, def);
    const encoded =
      kind.name === "table"
        ? this.encodeTableEntry(def as TableDef)
        : (this.sections.get(kind.payloadKey)!.at(-1) as Record<string, unknown>);
    const warnings = this.encodeWarnings.get(encoded) ?? [];
    let entry = encoded;
    // An empty canonical is the lock's, as a locked export fills it.
    if (CANONICAL_PAYLOAD_KEYS.has(kind.payloadKey) && entry.canonical === "" && typeof entry.name === "string") {
      const locked = getLockedCanonical(lockKey(kind.payloadKey, entry.name));
      if (locked !== undefined) entry = { ...entry, canonical: locked };
    }
    if (opts.hostedFiles !== undefined && (HOSTED_ICON_KINDS as readonly string[]).includes(kind.payloadKey)) {
      const sections: Partial<Record<PayloadArrayKey, unknown[]>> = { [kind.payloadKey]: [entry] };
      this.fillHostedFiles(sections, opts.hostedFiles);
      entry = sections[kind.payloadKey as PayloadArrayKey]![0] as Record<string, unknown>;
    }
    // A group's documentation gate with no value supplied ships without the
    // block, as an export with no secrets file writes it.
    if (kind.name === "api_group") {
      entry = resolveDocumentationTokens({
        workspace: {},
        apiGroups: [entry],
        values: opts.documentationTokens ?? {},
      }).apiGroups![0] as Record<string, unknown>;
    }
    return { payloadKey: kind.payloadKey, entry, warnings };
  }

  /**
   * Every def object handed to {@link register}, by identity, so the SAME one
   * registered twice is caught at the call that did it.
   *
   * Identity, not structure. Two separately constructed defs sharing a name are
   * a genuine collision, and the guid check at export already diagnoses that
   * correctly — it explains that identity derives from `(type, name)` and names
   * both objects. This guard must not shadow it.
   */
  private readonly registered = new Set<object>();

  /** The warnings each encoded object's encoder raised, raised again about it by every export. */
  private readonly encodeWarnings = new WeakMap<object, readonly Diagnostic[]>();

  /** Each encoded object's accepted warning codes, from its def's `diagnostics.allow`. */
  private readonly accepted = new WeakMap<object, ReadonlySet<string>>();

  /** The workspace config's accepted warning codes — they hold for every object. */
  private workspaceAccepted: ReadonlySet<string> | undefined;

  /**
   * Refuse the same def object twice.
   *
   * The failure this front-runs: a helper registers a def on your behalf and
   * you then register it again yourself — `registerAuth(ws).registerTables([userTable])`
   * is the reported shape. Nothing objected at the second call; it surfaced much
   * later at `emitBundle` as `Duplicate object guid (efb55…) shared by "dbo/user"
   * and "dbo/user"`, a message that names a guid and the same label twice and
   * points at neither line.
   */
  private assertNotAlreadyRegistered(kindName: string, def: unknown): void {
    if (def === null || typeof def !== "object") return;
    if (!this.registered.has(def)) {
      this.registered.add(def);
      return;
    }
    const name = (def as { name?: unknown }).name;
    const label = typeof name === "string" ? `"${name}"` : "it";
    throw new Error(
      `register: the same ${kindName} def ${label} was registered twice on this workspace. ` +
        `The second registration is always a mistake — the bundle would carry the object twice ` +
        `under one guid, which fails the import. A helper that registers on your behalf is the ` +
        `usual cause (\`registerAuth(ws)\` registers its own tables, so a following ` +
        `\`registerTables([userTable])\` is the duplicate): drop the manual call. Two DIFFERENT ` +
        `defs that share a name are a separate problem, and export reports that one by guid.`,
    );
  }

  /**
   * Register the workspace settings object (singleton).
   *
   * A config with no `name` inherits the one already on the registry — which is
   * what `workspace("my-app")` set — so the natural chain
   * `workspace("my-app").registerWorkspace(workspaceConfig({ history }))` no
   * longer makes an author restate a name this registry has held since its
   * first call. An explicit `name` still wins, and a rename this way is
   * a rename of the workspace.
   */
  registerWorkspace(def: WorkspaceConfigDef): this {
    // One config, never a list: through `any`, `registerWorkspace([cfg])` was
    // encoded as a config with no known keys — every setting silently dropped.
    if (def !== undefined && def !== null) {
      assertDefEntry("registerWorkspace", "workspace", def, undefined);
      assertDefKind("registerWorkspace", "workspace", def, undefined);
      assertNoProtoKeys("registerWorkspace", def);
      assertDefKeys("workspaceConfig", def, DEF_KEYS.workspace, "workspace");
      assertDefShape("workspace", def as unknown as Record<string, unknown>);
    }
    const authored = (def ?? {}) as { name?: unknown };
    if (typeof authored.name === "string" && authored.name.trim() === "") {
      throw new Error(
        `registerWorkspace: the workspace name must not be blank — got ${describeEntry(authored.name)}. ` +
          `Name it, or leave \`name\` out to keep the one \`workspace("…")\` gave.`,
      );
    }
    const inherited = this.workspaceConfig.name;
    const withName =
      authored.name === undefined && typeof inherited === "string"
        ? { ...authored, name: inherited }
        : authored;
    this.workspaceConfig = encodeObject<Record<string, unknown>>("workspace", withName);
    this.workspaceAccepted = acceptedWarnings("workspace", authored);
    this.envAuthored = (authored as { env?: unknown }).env !== undefined;
    this.configAttached = SHORTHAND_CONFIGS.has(def) ? this.configAttached : true;
    return this;
  }

  /**
   * Fill each encoded knowledge item's `content` and emit its reference files as
   * the sibling `knowledge_file` section.
   *
   * Reference rows name their parent by GUID rather than by row id: the id does
   * not exist until the import inserts the parent, and the importer resolves the
   * guid back to it. `references` stays empty — the platform derives that list
   * from the stored files itself, so anything written here is overwritten.
   */
  private fillKnowledge(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    resolved: readonly ResolvedKnowledge[],
  ): Array<{ item: object; code: AnyWarningCode; message: string }> {
    const byName = new Map(resolved.map((r) => [r.name, r]));
    const files: Array<Record<string, unknown>> = [];
    const warnings: Array<{ item: object; code: AnyWarningCode; message: string }> = [];
    // Copied, not edited: the encoded items are the registry's own, so a later
    // unresolved `export()` must still see an empty body.
    const items = ((sections.knowledge ?? []) as Array<Record<string, unknown>>).map((source) => {
      if (!byName.has(source.name as string)) return source;
      const copy = { ...source };
      const allow = this.accepted.get(source);
      if (allow) this.accepted.set(copy, allow);
      const raised = this.encodeWarnings.get(source);
      if (raised) this.encodeWarnings.set(copy, raised);
      return copy;
    });
    if (sections.knowledge !== undefined) sections.knowledge = items;
    for (const item of items) {
      const match = byName.get(item.name as string);
      if (match === undefined) continue;
      item.content = match.content;
      for (const w of match.warnings ?? []) warnings.push({ item, ...w });
      for (const file of match.files) {
        files.push({
          knowledge: { id: item.guid },
          path: file.path,
          content: file.content,
          size: file.size,
          guid: deriveGuid("knowledge_file", `${item.name as string}/${file.path}`),
        });
      }
    }
    if (files.length > 0) sections.knowledge_file = files;
    return warnings;
  }

  /**
   * Replace every pending hosted-file placeholder with the resolver's value and
   * list the files it read as the `vault` section.
   *
   * The encoded MCP objects are the registry's own, shared by every export, so
   * each is copied rather than edited: an unresolved `export()` after a
   * resolved one still sees the inert placeholder.
   */
  private fillHostedFiles(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    resolver: HostedFileResolver,
  ): void {
    for (const key of HOSTED_ICON_KINDS) {
      const items = sections[key] as Array<Record<string, unknown>> | undefined;
      if (items === undefined) continue;
      sections[key] = items.map((item) => {
        const icons = item.icons as object[] | undefined;
        if (!Array.isArray(icons) || !icons.some((icon) => pendingHostedFile(icon) !== undefined)) return item;
        const copy = {
          ...item,
          icons: icons.map((icon) => {
            const hosted = pendingHostedFile(icon);
            return hosted === undefined ? icon : { ...icon, src: resolver.resolve(hosted.ref, hosted.rules) };
          }),
        };
        // The copy answers for its source's `diagnostics.allow`, keyed by the registered object.
        const allow = this.accepted.get(item);
        if (allow) this.accepted.set(copy, allow);
        return copy;
      });
    }
    const rows = resolver.libraryRows();
    if (rows.length > 0) sections.vault = rows;
  }

  /** Set the bundle `type` (defaults to "workspace"). */
  setBundleType(type: BundleType): this {
    this.bundleType = type;
    return this;
  }

  /**
   * The registered table defs (with their authored `seed`), for the Node deploy
   * path to build `content/` seed entries. Deliberately NOT reached from
   * `export()` — seed values are resolved only in the deploy pipeline, so they
   * never enter the browser-safe bundle. See {@link import("./seed.js")}.
   */
  tables(): readonly TableDef[] {
    return [...this.tableDefs];
  }

  /**
   * The ENCODED workspace config, read-only.
   *
   * For the deploy path, which needs to know which env variable names the
   * workspace declares before the bundle exists — so an `--env-var` naming
   * something undeclared can be reported as an addition rather than silently
   * appended, and so a declared name with no value anywhere can refuse a deploy
   * rather than clear the live one. A shallow copy: nothing outside
   * `registerWorkspace` may write it.
   */
  workspaceSettings(): Readonly<Record<string, unknown>> {
    return { ...this.workspaceConfig };
  }

  /**
   * Every scope in this workspace that declares a documentation gate, with the
   * sidecar key its token is stored under.
   *
   * For the deploy path, which has to know them before the bundle exists — so a
   * gate with no token anywhere can refuse a deploy rather than ship a workspace
   * whose doc site silently does not match its source. Read off the ENCODED
   * shapes, so a decoded workspace is covered exactly like a hand-authored one,
   * and so the guid each key is built from is the one already stamped at
   * registration.
   */
  documentationTokenNames(): readonly DocumentationTokenDeclaration[] {
    return documentationTokenDeclarations({
      workspace: this.workspaceConfig,
      apiGroups: this.sections.get("app"),
    });
  }

  /**
   * The registered knowledge defs (with their authored `body`/`refs` path
   * markers), for the Node compile path to read markdown off disk. Deliberately
   * NOT reached from `export()` — a file read has no place in the browser-safe
   * bundle, so the encoder emits an empty `content` and the compile path fills
   * it. See {@link import("./knowledge.js")}.
   */
  knowledge(): readonly KnowledgeDef[] {
    return [...this.knowledgeDefs];
  }

  registerFunctions(defs: AnyFunctionDef[]): this {
    return this.register("function", defs, "registerFunctions");
  }

  /** Register knowledge items — the markdown a workspace's AI agents read. */
  registerKnowledge(defs: KnowledgeDef[]): this {
    return this.register("knowledge", defs, "registerKnowledge");
  }

  registerTriggers(defs: AnyTriggerDef[]): this {
    return this.register("trigger", defs, "registerTriggers");
  }

  registerTools(defs: AnyToolDef[]): this {
    return this.register("tool", defs, "registerTools");
  }

  /** Register MCP prompts. Expose one by listing it in an `mcpServer({ prompts })`. */
  registerPrompts(defs: AnyPromptDef[]): this {
    return this.register("prompt", defs, "registerPrompts");
  }

  /** Register MCP resources. Expose one by listing it in an `mcpServer({ resources })`. */
  registerResources(defs: AnyResourceDef[]): this {
    return this.register("resource", defs, "registerResources");
  }

  registerMcpServers(defs: McpServerDef[]): this {
    return this.register("mcp_server", defs, "registerMcpServers");
  }

  registerAgents(defs: AgentDef[]): this {
    return this.register("agent", defs, "registerAgents");
  }

  registerTables(defs: AnyTableDef[]): this {
    return this.register("table", defs, "registerTables");
  }

  registerQueries(defs: AnyQueryDef[]): this {
    return this.register("query", defs, "registerQueries");
  }

  registerApiGroups(defs: ApiGroupDef[]): this {
    return this.register("api_group", defs, "registerApiGroups");
  }

  registerTasks(defs: TaskDef[]): this {
    return this.register("task", defs, "registerTasks");
  }

  registerMiddleware(defs: AnyMiddlewareDef[]): this {
    return this.register("middleware", defs, "registerMiddleware");
  }

  registerAddons(defs: AnyAddonDef[]): this {
    return this.register("addon", defs, "registerAddons");
  }

  registerMicroservices(defs: MicroserviceDef[]): this {
    return this.register("microservice", defs, "registerMicroservices");
  }

  registerRealtimeServers(defs: RealtimeServerDef[]): this {
    return this.register("realtime_server", defs, "registerRealtimeServers");
  }

  registerRealtimeChannels(defs: AnyRealtimeChannelDef[]): this {
    return this.register("channel", defs, "registerRealtimeChannels");
  }

  registerRealtimeMessages(defs: AnyRealtimeMessageDef[]): this {
    return this.register("message", defs, "registerRealtimeMessages");
  }

  registerWorkflowTests(defs: WorkflowTestDef[]): this {
    return this.register("workflow_test", defs, "registerWorkflowTests");
  }

  /**
   * Assemble the signed aggregate `packageExport` bundle.
   *
   * With `options.lock` (a {@link LockExportContext}), the export participates
   * in identity locking: empty api-group/toolset canonicals are filled from the
   * lock — minted fresh on first sight — and every identity the bundle emits is
   * reported back through `ctx.observed` (MUTATING the passed context), which
   * the caller merges into the lock file. All lock work happens before the
   * bundle is signed. Without options the output is byte-identical to before.
   *
   * With `options.strict`, every build WARNING fails the export instead of
   * printing — the shapes that deploy clean and then lose data or return the
   * wrong rows. Nothing about the emitted bundle changes; it either exports or
   * it does not.
   */
  export(options: ExportOptions = {}): Bundle {
    try {
      return this.assemble(options);
    } catch (err) {
      throw asAuthoringRefusal(err);
    }
  }

  /** {@link export}'s work, its refusals not yet classed. */
  private assemble(options: ExportOptions): Bundle {
    const lockCtx = options.lock;
    const sections: Partial<Record<PayloadArrayKey, unknown[]>> = {};
    for (const [key, arr] of this.sections) {
      sections[key as PayloadArrayKey] = arr;
    }
    // Encode tables now that the workspace `use_xdo` is known: a table without an
    // explicit `useXdo` inherits the workspace default, so the two stay in sync.
    if (this.tableDefs.length > 0) {
      sections[getKind("table").payloadKey as PayloadArrayKey] = this.tableDefs.map((def) => this.encodeTableEntry(def));
    }
    const knowledgeWarnings =
      options.knowledge !== undefined && options.knowledge.length > 0 ? this.fillKnowledge(sections, options.knowledge) : [];
    if (options.hostedFiles !== undefined) {
      this.fillHostedFiles(sections, options.hostedFiles);
    }
    // What the documentation blocks will hold once their tokens are resolved.
    // Computed as a read-only VIEW for the guards rather than written back,
    // because the objects it copies are the registry's own and are still to be
    // stamped by the lock: `checkDocumentationTokens` has to see a resolved
    // value as a value, and `checkApiGroupDocsExposure` has to tell a gate that
    // will exist from a declared name that resolved to nothing. The substitution
    // that ships is taken again below, after the lock, and before the signature.
    const resolveDocs = () =>
      resolveDocumentationTokens({
        workspace: this.workspaceConfig,
        apiGroups: sections["app" as PayloadArrayKey],
        values: options.documentationTokens ?? {},
        ...(options.allowEmptyDocToken ? { allowEmpty: options.allowEmptyDocToken } : {}),
      });
    const docsView = resolveDocs();
    // The view copies each group it resolves; a copy answers for its source's
    // `diagnostics.allow`, which is keyed by the registered object.
    docsView.apiGroups?.forEach((copy, i) => {
      const allow = this.accepted.get(sections["app" as PayloadArrayKey]?.[i] as object);
      if (allow && copy !== null && typeof copy === "object") this.accepted.set(copy, allow);
    });
    // Every build-time finding lands in one bag so the author sees the whole
    // set at once, and so a hard error aborts BEFORE the lock is mutated or the
    // bundle is signed.
    const bag = new DiagnosticBag(options.strict === true);
    // Which codes each allow accepted, so an allow that accepted nothing is
    // reported. Both are counted when the def and the workspace name one code.
    const used = new Map<ReadonlySet<string>, Set<string>>();
    const use = (allow: ReadonlySet<string> | undefined, code: string): boolean => {
      if (allow?.has(code) !== true) return false;
      used.set(allow, (used.get(allow) ?? new Set()).add(code));
      return true;
    };
    bag.accepts = (code, subject) => {
      // Both calls run — no short-circuit — so each allow naming the code is counted.
      const own = use(subject === undefined ? undefined : this.accepted.get(subject), code);
      return use(this.workspaceAccepted, code) || own;
    };
    // Built on first need: an export that raises nothing never names a def.
    let subjectMap: Map<object, DiagnosticSubject> | undefined;
    const subjects = () => (subjectMap ??= this.diagnosticSubjects(sections, docsView.apiGroups));
    bag.describe = (subject) => subjects().get(subject);
    for (const arr of Object.values(sections)) {
      for (const obj of arr ?? []) {
        if (obj === null || typeof obj !== "object") continue;
        for (const d of this.encodeWarnings.get(obj) ?? []) bag.warn(d.code, d.message, obj);
      }
    }
    for (const { item, code, message } of knowledgeWarnings) bag.warn(code, message, item);
    // A documentation token spelled literally in source: refused outright, since
    // the by-name form covers every legitimate use.
    // The UNRESOLVED objects, deliberately. "Is a token spelled out in source"
    // is a source-side question, and a value substituted from `xano/.env` is
    // indistinguishable from a committed one once it is in the block — so
    // reading the resolved view here would refuse exactly the shape this feature
    // exists to recommend.
    checkDocumentationTokens(this.workspaceConfig, sections, bag, options.secretsRemedy);
    // The RESOLVED view, equally deliberately. "Will these docs be open" is a
    // question about the OUTCOME, so it has to see a name that resolved to a
    // real gate as a gate, and one that resolved to nothing as no gate.
    const documentedSections =
      docsView.apiGroups === undefined ? sections : { ...sections, app: docsView.apiGroups };
    // The unresolved set separates "nobody asked for a gate here" from "the
    // author asked and the value is missing". Only the second is an error: on a
    // group, dropping the key is written as the engine default on import, so
    // there is no safe bundle to write for it.
    checkApiGroupDocsExposure(documentedSections, bag, new Set(docsView.unresolvedGroups), options.secretsRemedy);
    // A query's `auth` is resolved to its stored guid at encode time in
    // `encodeQuery` (see `resolveAuth`); here — where the table registry is
    // known — we confirm each resolved reference actually names a registered
    // auth table. Xano supports any number of auth tables; each endpoint names
    // the one it authenticates against.
    this.validateQueryAuth(sections, bag);
    // Catch an `auth()`-keyed middleware directly attached to a host that can't
    // resolve a request identity — the silent null-bucket collapse.
    this.validateMiddlewareAuth(sections, bag);
    // A post chain reading the request out of get_all_input — which in post
    // holds the host's outcome — fails after the host already ran.
    this.validatePostMiddlewareEnvelope(sections, bag);
    // A microservice's registry credential / Helm values ride the bundle
    // verbatim. Nothing is wrong — say so where the bytes are written.
    checkMicroserviceSecrets(sections, bag);
    // Typed-but-undeployable blocks, and the one notice saying the surface is
    // early — both at the moment the author can still act on them.
    checkMicroserviceBlocks(sections, bag);
    // Every cross-object reference must name something this bundle carries.
    // Runs last so a more specific diagnostic (an unregistered auth table)
    // is reported in its own words rather than as a bare dangling guid.
    // Shapes that succeed with HTTP 200 and the wrong result — warnings, so
    // they never block a deploy.
    // A function anywhere in an encoded object: JSON writes it as null. First,
    // because every walker after this one reads the tree as JSON.
    checkNonJsonValues(sections, bag, this.workspaceConfig);
    checkLiveDatasourceTests(sections, bag);
    checkStacks(
      this.tableDefs,
      sections,
      bag,
      this.workspaceConfig,
      this.envAuthored ? "authored" : this.configAttached ? "no-env" : "unattached",
    );
    // `ignoreEmpty` on an operand that is already empty: a predicate that can
    // only be dropped, which on `in` returns everything instead of nothing.
    checkExpressionOperands(sections, bag);
    // A stored string carrying `[object Object]`: a tagged value interpolated
    // into a JS template literal at build time, served verbatim by the engine.
    checkInterpolatedValues(sections, bag);
    // An object literal keyed `0..n-1`: the engine evaluates it as a list.
    checkZeroBasedObjects(sections, bag);
    checkIntRange(sections, bag);
    // A regex pair written backwards — the SUBJECT piped, the PATTERN in the
    // argument. `withFilters` refuses it at build time; this catches what never
    // passed through it (a `rawValue`, a decoded workspace), because the shape
    // deploys clean and answers false for every input.
    checkRegexOperandOrder(sections, bag);
    checkTimezoneArgs(sections, bag);
    checkReferences(this.bundleType, sections, this.workspaceConfig.guid, bag);
    checkMicroserviceReferences(this.bundleType, sections, bag);
    // A statement the engine writes but will not read back — this bundle cannot
    // import at all while it carries one. Unscoped by bundle type: a partial
    // bundle is no more importable than a full one here.
    checkDecodeOnlyStatements(sections, bag);
    // A `Run …` step in a stack that cannot resolve it: deploys clean, passes
    // from the builder, and fails the first real request. Xano SDK scopes the
    // family the way Xano categorises it — a testing surface.
    checkRunFamilyHosts(sections, bag);
    // A loop-control statement with no loop to control: undefined engine
    // behaviour, and no reading under which the author meant it.
    checkLoopControl(sections, bag);
    // A `s.switch` case with no `break`: the engine falls through into every
    // later case body (and the default), which type-checks and imports clean.
    checkSwitchFallthrough(sections, bag);
    // A request-only timestamp filter on a `where` operand: the predicate is
    // compiled into SQL, where that filter has no form, and the request dies
    // with a bare fatal.
    checkSearchOperandFilters(sections, bag);
    // A `where` operand the operator refuses by its shape — a scalar `between`
    // or `in`, containment on a text column: a clean deploy and a 400 per request.
    checkFilterOperands(sections, bag);
    // A tool reading `auth()` behind an entry that names no auth table: the
    // call answers a normal result carrying an empty-message fatal, so the
    // model reports success and nothing is written.
    checkToolAuthIdentity(sections, bag);
    checkPrimitiveAuthIdentity(sections, bag);
    checkWriteBeforeElicit(sections, bag);
    checkMcpStackHazards(sections, bag);
    checkMcpResourceUris(sections, bag);
    // An MCP server's `oauth` the platform would refuse to save.
    checkMcpOauth(sections, bag);
    checkMcpOauthRevoke(sections, bag);
    checkStackAuthRatelimit(sections, bag);
    // A limiter with no `error` never stops a request: it binds false and the stack runs on.
    checkRatelimitWithoutError(sections, bag);
    checkAuthNoCaller(sections, bag);
    // A realtime gate that can only ever say no — a lockout, not a breach.
    checkRealtimeGates(sections, bag);
    // The realtime shapes the docs call silent: a server left off, a transcript
    // with no limit, "explicit" delivery, a deliver gate returning false.
    checkRealtimeSilentShapes(sections, bag);
    checkNonNullVectorColumns(sections, bag);
    // A `deliver` gate whose channel never runs it — the failure ships the
    // UNREDACTED payload — and the inverse flag that pays for nothing.
    checkRealtimeDeliver(this.bundleType, sections, bag);
    checkRealtimeJoinDeliver(sections, bag);
    // A trigger attached to no object: it deploys, and then never fires.
    checkTriggerBindings(sections, bag);
    // A `ref()` naming a variable nothing binds: a clean bundle and a 500.
    checkUnboundVarRefs(sections, bag);
    // A `to_throw` body reading a variable bound outside it: the isolated var
    // stack makes the setup unreachable, and the test blames the guard.
    checkToThrowScope(sections, bag);
    // A submitted password taken through `input.password`, which hashes it a
    // second time so `check_password` can never match.
    checkPasswordInputHashing(sections, bag);
    // A zip statement sent with no password key (an explicit `null`): a clean
    // deploy, then `Missing param` on every request.
    checkZipPasswordKeys(sections, bag);
    // A `{ safe: true }` drill feeding a db lookup: the null it exists to
    // produce is never a legal match value, so the request dies at 400 one
    // statement before the guard that was meant to answer.
    checkSafeRefMatchArgs(sections, bag);
    // The literal sibling: a `c.null()` in that same slot, which the engine
    // refuses on the FIRST call rather than on an unlucky one.
    checkNullMatchArgs(sections, bag);
    // An input that addresses one row but rides the query string instead of the
    // path, so the route is not addressable the way a REST client expects.
    checkPathSegmentCandidates(sections, bag);
    // Two routes in one group and verb that a single request path can match:
    // the router serves whichever was created first, so one silently answers
    // for the other.
    checkRouteShadowing(sections, bag);
    // Two same-kind objects sharing a name behind explicit guids: exports today,
    // refused by the lock the recommended workflow commits.
    checkSameNameSiblings(sections, bag);
    // Seed rows: the same validation `xanosdk export`/`deploy` runs, so the
    // programmatic and CLI paths agree on what is legal.
    checkSeed(this.tableDefs, bag, this.workspaceConfig.use_xdo === true);
    // A column the engine reserves: the table deploys, reads back correctly,
    // and then every insert into it 400s with a message about the value.
    checkReservedColumnNames(this.tableDefs, bag);
    checkUnusableColumnNames(this.tableDefs, bag);
    checkCacheTtl(sections, bag);
    // The same reserved key in a call's input map: the callee receives the
    // unevaluated argument — defaults for an object, a 400 for a text input.
    checkReservedInputNames(sections, bag);
    // An input a function call leaves out: the engine binds it from the
    // caller's input of the same name, which at an endpoint is the request.
    checkOmittedCallInputs(sections, bag);
    checkUnknownCallInputs(sections, bag);
    checkAddonAttachments(sections, bag);
    checkUnitTests(sections, bag);
    checkAddonOutput(sections, bag);
    checkGuardRoleColumns(sections, this.tableDefs, bag);
    checkToolOutputSchema(sections, bag);
    checkAgentArgPlaceholders(sections, bag);
    checkAssertionsOutsideTests(sections, bag);
    checkAgentApiKeys(sections, bag);
    // `resolved` gates the empty-body check: a browser-safe `export()` carries
    // empty bodies by design, so it would fire on every item and mean nothing.
    checkKnowledge(sections, bag, { resolved: options.knowledge !== undefined });
    // A realtime publish aimed at a server/channel this bundle does not carry —
    // the one cross-object reference stored by name rather than by guid.
    checkRealtimePublish(this.bundleType, sections, bag);
    // Last: only now has every check had its chance to use an allow.
    this.checkAllowsUsed(bag, subjects, used);
    options.accepted?.push(...bag.accepted());
    bag.flush();
    if (lockCtx) this.applyLock(lockCtx, sections);
    // The workspace-import path requires `workspace.guid`. Under a lock,
    // `applyLock` stamps it from the workspace canonical; without one, derive a
    // deterministic guid from the workspace name so a lock-less `deploy` still
    // imports. Deterministic → stable across redeploys (refresh doesn't churn it).
    // Follow-up: build with a lock by default instead of this fallback.
    if (this.workspaceConfig.guid === undefined) {
      const wsName = typeof this.workspaceConfig.name === "string" ? this.workspaceConfig.name : "workspace";
      this.workspaceConfig.guid = deriveGuid("workspace", wsName);
    }
    // Resolved HERE, after the lock has stamped its canonicals onto the
    // registry's own objects, so the copies that ship carry them. Copies rather
    // than a mutation, so the registry keeps the reference and a SECOND export
    // resolves from scratch instead of reusing this build's value.
    const shipped = resolveDocs();
    if (shipped.apiGroups !== undefined) sections["app" as PayloadArrayKey] = shipped.apiGroups;
    return buildBundle({
      type: this.bundleType,
      workspace: shipped.workspace,
      sections,
      lock: lockCtx?.lock,
      ...(options.envOverrides ? { envOverrides: options.envOverrides } : {}),
      ...(options.knowledge !== undefined ? { knowledgeRead: true } : {}),
    });
  }

  /**
   * The def each object this export checks was registered from — the encoded
   * objects, the table defs whose columns are read directly, and the copies the
   * docs view took — for a finding to name its subject.
   */
  private diagnosticSubjects(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    docsCopies: readonly unknown[] | undefined,
  ): Map<object, DiagnosticSubject> {
    const subjects = new Map<object, DiagnosticSubject>();
    const add = (obj: unknown, kind: string): void => {
      if (obj === null || typeof obj !== "object") return;
      const name = (obj as { name?: unknown }).name;
      if (typeof name === "string") subjects.set(obj, { kind, name });
    };
    add(this.workspaceConfig, "workspace");
    for (const [key, items] of Object.entries(sections)) {
      for (const obj of items ?? []) add(obj, sdkKindName(key, obj as Record<string, unknown>));
    }
    for (const def of this.tableDefs) add(def, "table");
    docsCopies?.forEach((copy, i) => {
      const source = subjects.get(sections["app" as PayloadArrayKey]?.[i] as object);
      if (source && copy !== null && typeof copy === "object") subjects.set(copy, source);
    });
    return subjects;
  }

  /**
   * Warn on each `diagnostics.allow` code that accepted nothing in this export.
   * The shape it named is gone, or the check stopped finding it — either way
   * the source still reads as "this def has a known hazard". Raised directly
   * rather than through `warn`: it is about the allow itself, so no allow can
   * accept it. A code whose check did not run here had nothing to accept.
   */
  private checkAllowsUsed(
    bag: DiagnosticBag,
    subjects: () => ReadonlyMap<object, DiagnosticSubject>,
    used: ReadonlyMap<ReadonlySet<string>, ReadonlySet<string>>,
  ): void {
    const owners = new Map<ReadonlySet<string>, DiagnosticSubject>();
    for (const [obj, subject] of subjects()) {
      const allow = obj === this.workspaceConfig ? this.workspaceAccepted : this.accepted.get(obj);
      if (allow && !owners.has(allow)) owners.set(allow, subject);
    }
    for (const [allow, subject] of owners) {
      const unused = [...allow].filter((code) => used.get(allow)?.has(code) !== true && !bag.wasSkipped(code));
      if (unused.length === 0) continue;
      const one = unused.length === 1;
      bag.add({
        severity: "warning",
        code: "diagnostics.allow-unused",
        message:
          `${subject.kind} "${subject.name}": \`diagnostics.allow\` accepts ${unused.map((c) => `"${c}"`).join(", ")}, ` +
          `but this export raised no such warning about ${allow === this.workspaceAccepted ? "any def" : "it"} — ` +
          `the shape ${one ? "it" : "they"} accepted is gone, or the check no longer finds it. ` +
          `Remove ${one ? "it" : "them"} from \`allow\`.`,
        subject,
      });
    }
  }

  /**
   * Cross-check every query's resolved `auth` against the registered auth tables.
   *
   * `resolveAuth` (in `encodeQuery`) turns a table ref into a guid with no
   * registry visibility, so a bare-name typo produces a valid-looking guid that
   * only fails at deploy with an opaque engine error. Here we have the registry,
   * so we catch it at export and name the offending query.
   *
   * A registered table that is not `table({ auth: true })` only WARNS: the
   * engine reads that flag nowhere at request time (it compares the token's
   * `dbo` to the endpoint's by name, and mints tokens for any table by name), so
   * refusing the combination blocked a real workspace's round trip. A numeric
   * `auth` (raw `dbo.id` escape hatch) references a table by id xanosdk never
   * sees, so it's left as-is; `false` is a public endpoint. A table that pins an
   * explicit `guid` referenced by bare name lands in the "not registered" branch
   * (its name-derived guid diverges from the pinned one) — pass the def instead.
   */
  private validateQueryAuth(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    bag: DiagnosticBag,
  ): void {
    // The query kind's `payloadKey` (see `queryKind`); referenced literally so
    // this doesn't depend on the query kind being registered in every workspace.
    const queries = sections["query" as PayloadArrayKey];
    if (!Array.isArray(queries) || queries.length === 0) return;
    // Every registered table's guid → name, and the subset that are auth tables.
    // Resolved via the same `resolveRef("dbo", …)` a query's `auth` flows through,
    // so an explicit-guid table matches by def-handle reference.
    const tableNameByGuid = new Map<string, string>();
    const authGuids = new Set<string>();
    for (const def of this.tableDefs) {
      const guid = resolveRef("dbo", def);
      tableNameByGuid.set(guid, def.name);
      if (def.auth === true) authGuids.add(guid);
    }
    for (const q of queries) {
      if (!q || typeof q !== "object") continue;
      const auth = (q as { auth?: unknown }).auth;
      // Only a guid (string) needs the registry; `false`/number carry no name.
      if (typeof auth !== "string" || authGuids.has(auth)) continue;
      const name = String((q as { name?: unknown }).name ?? "?");
      const known = tableNameByGuid.get(auth);
      // A REGISTERED table that isn't flagged `auth` warns rather than throws.
      // The engine compares the token's `dbo` to the endpoint's by name and reads
      // the table's flag nowhere, so the combination works — and one real
      // workspace ships it, which throwing made impossible to pull.
      if (known) {
        bag.warn(
          "query.auth-table-unflagged",
          `query "${name}" requires auth against table "${known}", which is not marked ` +
            `\`table({ auth: true })\`. The engine allows it — a token minted for that table is ` +
            `accepted — but the editor will not offer the table as an auth source. Mark it if that ` +
            `is what you meant.`,
          q as object,
        );
        continue;
      }
      // A full workspace bundle reports every unregistered reference once, in
      // `checkReferences`, worded by whether a handle or a name was passed —
      // reporting it here too gave one cause two errors, the first telling an
      // author who passed the def handle to check for a typo.
      if (this.bundleType === "workspace") continue;
      bag.error(
        "query.auth-table-unregistered",
        refSpelling(auth) === "handle"
          ? `query "${name}": \`auth\` is a table def that isn't registered on this workspace — add ` +
            `it with \`registerTables([…])\`.`
          : `query "${name}": \`auth\` references a table that isn't registered on this workspace. ` +
            `Check the name for a typo, or register the auth table with \`registerTables([…])\`; if ` +
            `it pins an explicit \`guid\`, pass the table def rather than its name.`,
      );
    }
  }

  /**
   * Warn about an `auth()`-keyed middleware **directly attached** to a host where
   * there is no caller identity for `auth()` to resolve.
   *
   * The footgun: a rate limiter keyed by `auth("id")` is the canonical middleware,
   * but attach it to a host with no authenticated caller and `auth()` cannot
   * resolve — every request 403s before the host runs, with no signal at author
   * or export time. This surfaces it at export, where the
   * middleware registry is known (an attachment entry only carries the target's
   * guid; we resolve it back to the encoded `run` to inspect for `auth()`).
   *
   * It **warns, never throws** — a bare `auth()` reference is not proof the
   * request will fail: the statement holding it may sit on a branch that never
   * runs on this host, and the same middleware object is often attached to
   * authenticated hosts too. Blocking the export would produce false positives
   * on legitimate use. The warning names the host and reason so
   * the author can confirm intent, key off `sys.remoteIp()`, or move to an
   * authenticated host.
   *
   * Scope: the host's EFFECTIVE chain, across all three tiers. Seeing only a
   * host's own `middleware.pre`/`post` would let an author who DRY'd a per-user
   * limiter up to `apiGroup({ middleware })` or to the workspace tier silently
   * reintroduce the failure — the same unresolvable key, attached one level up,
   * with the warning switched off. The limiter is most naturally written once at
   * the group, so that is the tier that most needs the warning.
   *
   * The cascade is the engine's own: a phase whose `_customize` flag is set is
   * answered by that tier (including `clear()`, which customizes with an empty
   * list and therefore stops inheritance); an un-customized phase falls through
   * to the API group, then to the workspace's `{objType}_{phase}` map. A query
   * that clears a phase is NOT warned about a group middleware it does not run.
   *
   * An authenticated `query` (its own `auth` table set) resolves an identity, so
   * it is skipped at every tier.
   */
  private validateMiddlewareAuth(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    bag: DiagnosticBag,
  ): void {
    // auth() detection is lazy + memoized, so only a stack that is actually
    // attached is deep-walked — a defined-but-unattached middleware never is.
    const authCache = new Map<string, boolean>();
    const referencesAuth = (guid: string, mw: Record<string, unknown> | undefined): boolean => {
      let hit = authCache.get(guid);
      if (hit === undefined) {
        // The registry keeps only the encoded middleware; walk its `run` (the tag
        // survives encoding — see `stackReferencesAuth`).
        const run = mw?.run;
        hit = stackReferencesAuth(Array.isArray(run) ? run : undefined);
        authCache.set(guid, hit);
      }
      return hit;
    };

    // Why `auth()` may be null on each host kind. A `query` with its own auth
    // table resolves an identity and is skipped.
    const reasons: Record<MiddlewareHostKind, string> = {
      query: "this endpoint has no auth table",
      task: "a task is scheduled/background and never has a request identity",
      function: "there is no caller identity unless an authenticated caller invokes it",
      tool: "there is no caller identity unless an authenticated caller invokes it",
      prompt: "there is no caller identity unless an authenticated caller invokes it",
      resource: "there is no caller identity unless an authenticated caller invokes it",
    };

    for (const { label, host, hostName, tier, guid, middleware } of this.attachedMiddleware(sections)) {
      // An authenticated query resolves an identity, so auth() is fine there.
      if (label === "query" && (host as { auth?: unknown }).auth) continue;
      if (!referencesAuth(guid, middleware)) continue;
      const mwName = String(middleware?.name ?? guid);

      bag.warn(
        "middleware.auth-null-host",
        `middleware "${mwName}" references auth() and is attached to ${label} ` +
          `"${hostName}"${tier}, where ${reasons[label]}. auth() cannot resolve there and the request ` +
          `FAILS (403) rather than degrading to a shared key — attach it to an authenticated ` +
          `host, key off sys.remoteIp(), or remove auth().`,
        middleware,
      );
    }
  }

  /**
   * Warn about a middleware in a host's effective **`post`** chain that reads a
   * request field out of `s.util.get_all_input` — see `postEnvelopeMisreads`.
   *
   * In `post` that envelope holds the host's outcome (`{ status, result }`), not
   * the request, so the read cannot resolve. Under the default `rethrow` policy
   * it fails the request with `Unable to locate var` after the host's stack has
   * run and its writes have landed. Checked on the effective chain for the same
   * reason as {@link validateMiddlewareAuth}: a post middleware is most often
   * attached once, at the group or the workspace tier.
   *
   * Warns rather than throws: the same middleware is valid in a `pre` chain, and
   * a read on a branch the post path never takes fails nothing.
   */
  private validatePostMiddlewareEnvelope(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    bag: DiagnosticBag,
  ): void {
    // A read straight off the envelope (`payload.note`) fails in EITHER phase,
    // attached or not — checked once per middleware.
    for (const middleware of sections["middleware" as PayloadArrayKey] ?? []) {
      const unnested = unnestedEnvelopeReads(middleware);
      if (unnested.length === 0) continue;
      const hard = unnested.filter((r) => !r.safe);
      const soft = unnested.filter((r) => r.safe);
      const list = (rs: typeof unnested) => rs.map((r) => `\`${r.path}\``).join(", ");
      const fixed = unnested.map((r) => `\`${r.path.replace(".", ".vars.")}\``).join(", ");
      const outcome = [
        hard.length > 0 ? `${list(hard)} fails with \`Unable to locate var\` (a 500)` : "",
        soft.length > 0 ? `${list(soft)} (a safe/\`get\` read) is always null, silently` : "",
      ].filter(Boolean);
      bag.warn(
        "middleware.envelope-unnested",
        `middleware "${String((middleware as { name?: unknown }).name ?? "?")}" reads ` +
          `${list(unnested)} straight off \`s.util.get_all_input\`, which binds a ` +
          `\`{ type, vars }\` envelope — the request is under \`vars\`, so ${outcome.join("; ")}. ` +
          `In \`pre\` read ${fixed} (or unwrap once: \`asFilters: [fl.get(c.text("vars"))]\`); in \`post\`, ` +
          `\`vars\` is \`{ status, result }\` and the request body is \`s.util.get_raw_input\`.`,
        middleware as object,
      );
    }
    const misreadCache = new Map<string, string[]>();
    for (const { label, hostName, phase, tier, guid, middleware } of this.attachedMiddleware(sections)) {
      if (phase !== "post") continue;
      let misreads = misreadCache.get(guid);
      if (misreads === undefined) {
        misreads = postEnvelopeMisreads(middleware);
        misreadCache.set(guid, misreads);
      }
      if (misreads.length === 0) continue;
      const mwName = String(middleware?.name ?? guid);
      // One hint per var bound by get_all_input — a stack may bind it twice.
      const results = [...new Set(misreads.map((p) => p.split(".")[0]!))]
        .map((b) => `\`${b}.vars.result.<field>\``)
        .join(" / ");

      bag.warn(
        "middleware.post-reads-request",
        `middleware "${mwName}" is in the post chain of ${label} "${hostName}"${tier} and reads ` +
          `${misreads.map((p) => `\`${p}\``).join(", ")} from \`s.util.get_all_input\`. In \`post\` ` +
          `that envelope is \`{ type, vars: { status, result } }\` (plus \`payload\` on an error) — ` +
          `the host's outcome, not the ` +
          `request — so the read fails with \`Unable to locate var\` after the host already ran ` +
          `(under \`rethrow\`, a failed response for committed work). Read the response at ` +
          `${results}, or the request body with \`s.util.get_raw_input\`.`,
        middleware,
      );
    }
  }

  /**
   * Every enabled middleware attachment in each leaf host's EFFECTIVE chain,
   * resolved across all three tiers — one row per host, phase and entry.
   *
   * The cascade is the engine's own: a phase whose `_customize` flag is set is
   * answered by that tier (including `clear()`, which customizes with an empty
   * list and therefore stops inheritance); an un-customized phase falls through
   * to the API group (queries only), then to the workspace's
   * `{objType}_{phase}` map. The apiGroup and workspace tiers are not hosts —
   * they are resolved INTO each host's chain. A disabled attachment does not run
   * and is not yielded.
   */
  private *attachedMiddleware(sections: Partial<Record<PayloadArrayKey, unknown[]>>): Generator<{
    label: MiddlewareHostKind;
    host: Record<string, unknown>;
    hostName: string;
    phase: "pre" | "post";
    tier: string;
    guid: string;
    middleware: Record<string, unknown> | undefined;
  }> {
    const middlewares = sections["middleware" as PayloadArrayKey];
    if (!Array.isArray(middlewares) || middlewares.length === 0) return;
    const byGuid = new Map<string, Record<string, unknown>>();
    for (const mw of middlewares) {
      if (!mw || typeof mw !== "object") continue;
      const guid = (mw as { guid?: unknown }).guid;
      if (typeof guid === "string") byGuid.set(guid, mw as Record<string, unknown>);
    }

    // Tier 2, for queries only: the API group a query belongs to, by `app.id`.
    const groupByGuid = new Map<string, Record<string, unknown>>();
    for (const group of sections["app" as PayloadArrayKey] ?? []) {
      if (!group || typeof group !== "object") continue;
      const guid = (group as { guid?: unknown }).guid;
      if (typeof guid === "string") groupByGuid.set(guid, group as Record<string, unknown>);
    }
    // Tier 3: the workspace's flat `{objType}_{phase}` map. It carries no
    // `_customize` flag — it is the terminal fallback, so an empty list there
    // genuinely means "nothing".
    const workspaceTier = (this.workspaceConfig.middleware ?? {}) as Record<string, unknown>;

    const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
    /** A tier answers a phase when it customizes it — `clear()` included. */
    const customizes = (block: unknown, phase: "pre" | "post"): boolean =>
      !!block && typeof block === "object" &&
      (block as Record<string, unknown>)[`${phase}_customize`] === true;

    for (const label of MIDDLEWARE_HOST_KINDS) {
      const hosts = sections[label];
      if (!Array.isArray(hosts)) continue;
      for (const host of hosts) {
        if (!host || typeof host !== "object") continue;
        const block = (host as { middleware?: unknown }).middleware;
        const hostName = String((host as { name?: unknown }).name ?? "?");
        // Only a query has an API-Group tier between it and the workspace.
        const groupId = label === "query"
          ? (host as { app?: { id?: unknown } }).app?.id
          : undefined;
        const group = typeof groupId === "string" ? groupByGuid.get(groupId) : undefined;

        for (const phase of ["pre", "post"] as const) {
          // The first tier that CUSTOMIZES the phase answers it, and everything
          // below it is not run.
          let entries: unknown[];
          let tier: string;
          if (customizes(block, phase)) {
            entries = list((block as Record<string, unknown>)[phase]);
            tier = "";
          } else if (group && customizes(group.middleware, phase)) {
            entries = list((group.middleware as Record<string, unknown>)[phase]);
            tier = ` (inherited from apiGroup "${String(group.name ?? "?")}")`;
          } else {
            entries = list(workspaceTier[`${label}_${phase}`]);
            tier = " (inherited from the workspace tier)";
          }

          for (const entry of entries) {
            if ((entry as { disabled?: unknown })?.disabled === true) continue;
            const guid = middlewareEntryGuid(entry);
            if (!guid) continue;
            yield {
              label,
              host: host as Record<string, unknown>,
              hostName,
              phase,
              tier,
              guid,
              middleware: byGuid.get(guid),
            };
          }
        }
      }
    }
  }

  /**
   * Lock participation (see {@link export}): canonical fill + identity report.
   * Runs after all sections are assembled and before signing.
   */
  private applyLock(
    ctx: LockExportContext,
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
  ): void {
    // Canonicals already spoken for (explicit in code, locked, or emitted in a
    // previous export() of this registry) must never be re-minted onto another
    // object — a duplicate canonical is one URL token serving two APIs.
    const usedCanonicals = new Set<string>();
    for (const entry of Object.values(ctx.lock.objects)) {
      if (entry.canonical) usedCanonicals.add(entry.canonical);
    }
    for (const arr of Object.values(sections)) {
      for (const obj of arr ?? []) {
        const canonical = (obj as { canonical?: unknown }).canonical;
        if (typeof canonical === "string" && canonical !== "") usedCanonicals.add(canonical);
      }
    }
    const mintUnique = (): string => {
      let token = mintCanonical();
      while (usedCanonicals.has(token)) token = mintCanonical();
      usedCanonicals.add(token);
      return token;
    };
    // Fill empty api-group/toolset canonicals: locked value, else mint-and-freeze.
    // An explicit in-code canonical is already in the payload and stays.
    // Before minting for a key the lock doesn't know, check whether some OTHER
    // lock entry pins this object's GUID — that's a moved/orphaned entry for
    // the same engine object (a rename reverted before the `lock rename`
    // fix-up), and its canonical is the object's real public URL. Reusing it
    // beats minting a fresh token that would silently change the URL.
    const canonicalByGuid = (guid: unknown): string | undefined => {
      if (typeof guid !== "string") return undefined;
      for (const entry of Object.values(ctx.lock.objects)) {
        if (entry.guid === guid && entry.canonical !== undefined) return entry.canonical;
      }
      return undefined;
    };
    // WHICH of the two a canonical is, recorded as it is decided.
    //
    // A slug the code sets is a contract with whatever frontend was built from
    // it; one this SDK filled in — from the lock or freshly minted — is a value
    // nobody asked for, kept only so the URL stays stable. Only the moment
    // below can tell them apart (afterwards every object carries a non-empty
    // slug and they look identical), and a release needs the distinction to
    // know which slugs it must insist on.
    const sourceByKey = new Map<string, CanonicalSource>();
    // Driven by the shared canonical-bearing set rather than a literal list, so
    // a kind that gains a canonical participates in minting automatically.
    for (const key of CANONICAL_PAYLOAD_KEYS as Set<PayloadArrayKey>) {
      for (const obj of sections[key] ?? []) {
        if (!obj || typeof obj !== "object") continue;
        const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown };
        if (typeof o.name !== "string") continue;
        if (o.canonical === "") {
          const locked = ctx.lock.objects[lockKey(key, o.name)];
          o.canonical = locked?.canonical ?? canonicalByGuid(o.guid) ?? mintUnique();
          // Filled from a slug `lock import` took from a live backend: still that.
          if (locked?.canonical !== undefined && locked.canonical_source === "adopted") this.adoptedCanonicals.add(obj);
          // The fill MUTATES the registered object, which outlives this call —
          // a second `export()` off the same registry would see a non-empty
          // slug and read this fill as an author's pin. Remember what we filled
          // so the classification survives a re-export; mistaking a minted
          // token for a contract is the direction that refuses a release over a
          // URL nobody promised.
          this.filledCanonicals.add(obj);
        }
        sourceByKey.set(
          lockKey(key, o.name),
          this.adoptedCanonicals.has(obj) ? "adopted" : this.filledCanonicals.has(obj) ? "minted" : "code",
        );
      }
    }
    // The workspace canonical lives under a fixed key. An empty one is
    // filled from the lock (the `lock import` round-trip) but never minted,
    // because the engine provisions workspace canonicals itself.
    //
    // Measured 2026-08-26 by `scripts/probe-workspace-canonical.ts`, which
    // carries the run: an emitted workspace canonical does NOT survive import.
    // The engine mints its own, per provisioned environment, and keeps it —
    // echoing its own value back changes nothing either, so it is not reading
    // the field at all on that path. Never minting is therefore right: a minted
    // value would be discarded exactly like an authored one.
    //
    // The fill below is still worth doing, but for LOCAL bookkeeping only — it
    // is what lets `recordObserved` carry the workspace identity and catch a
    // conflict. Nothing it emits steers the deploy.
    const ws = this.workspaceConfig as { canonical?: unknown };
    if (ws.canonical === "") {
      ws.canonical = ctx.lock.objects[WORKSPACE_KEY]?.canonical ?? "";
    }
    // Deliberately unclassified: the workspace slug is provisioned by the
    // instance and an emitted one changes nothing (see above), so calling it
    // pinned or minted would both be claims this SDK cannot make good on.
    if (typeof ws.canonical === "string" && ws.canonical !== "") {
      recordObserved(ctx, WORKSPACE_KEY, { canonical: ws.canonical });
    }
    // Report every guid-bearing object the bundle emits (guid conflicts with
    // the lock hard-error inside recordObserved). A query's lock name is
    // its composed (group, verb, name) identity, resolved against this bundle's
    // own app section, so key == guid seed holds and a verb pair records as two
    // entries rather than colliding on one.
    const appNames = identityNamesByGuid(sections);
    // Which object first claimed each lock key, so a second one with another
    // guid is refused here naming both by SDK kind — `recordObserved` sees only
    // the key, which for an agent + MCP server pair is one `toolset` key.
    const claimed = new Map<string, { label: string; guid: string }>();
    for (const [payloadKey, arr] of Object.entries(sections)) {
      // Only the kinds a lock can hold: anything else (the file library, whose
      // identity is its content) would write a key the next read refuses.
      if (!LOCK_PAYLOAD_KEYS.has(payloadKey)) continue;
      for (const obj of arr ?? []) {
        if (!obj || typeof obj !== "object") continue;
        const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown; type?: unknown };
        if (typeof o.name !== "string" || typeof o.guid !== "string") continue;
        const identity: LockEntry & { guid: string } = { guid: o.guid };
        if (this.codeGuids.has(o.guid)) identity.guid_source = "code";
        const lockName = lockNameForObject(payloadKey, o as { name: string }, appNames);
        const key = lockKey(payloadKey, lockName);
        const label = `${sdkKindName(payloadKey, o)} "${o.name}"`;
        const prior = claimed.get(key);
        if (prior !== undefined && prior.guid !== o.guid) {
          const why =
            payloadKey === "toolset"
              ? "Agents and MCP servers share ONE name space."
              : `Two objects of one kind sharing a name behind explicit guids.`;
          throw new Error(
            `Two exported objects collapse onto lock key "${sdkKindName(payloadKey, o)}:${lockName}" — ` +
              `${prior.label} and ${label}, with different guids (${prior.guid} vs ${o.guid}). ${why} ` +
              `A lock entry holds ONE guid per name, so an explicit \`guid\` cannot separate them: rename one.`,
          );
        }
        claimed.set(key, { label, guid: o.guid });
        if (typeof o.canonical === "string" && o.canonical !== "") {
          identity.canonical = o.canonical;
          // Only the canonical-bearing kinds are classified above; anything
          // else carrying the field is not a slug this SDK mints or pins.
          const source = sourceByKey.get(key);
          if (source !== undefined) identity.canonical_source = source;
        }
        // Agents and MCP servers share the toolset key; the lock keeps which,
        // for the messages that name an entry whose object is gone.
        if (payloadKey === "toolset" && (o as { type?: unknown }).type === "agent") identity.type = "agent";
        recordObserved(ctx, key, identity);
      }
    }
  }
}

/**
 * Convenience entry point — the natural name for "make a workspace."
 * `workspace("my-app")` is exactly `new Xano().registerWorkspace({ name:
 * "my-app" })`, returning the chainable {@link Xano} registry. Continue with the
 * per-kind `register*` methods and finish with `.export()`:
 *
 * ```ts
 * export default workspace("my-app")
 *   .registerTables([users])
 *   .registerQueries([listUsers]);
 * ```
 *
 * Authoring is functional/declarative: there is **no** callback-builder form —
 * you pass typed def-objects (`table({...})`, `query({...})`,
 * `defineFunction({...})`) to the `register*` methods, not a `w => {...}` closure.
 */
export function workspace(name: string): Xano {
  // A blank name exported cleanly and deployed a workspace nobody can find by
  // name in a listing; refused here, where it was typed.
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      `workspace(name): the workspace name must be a non-empty string — got ${describeEntry(name)}. ` +
        `Name it: \`workspace("my-app")\`.`,
    );
  }
  const shorthand = { name };
  SHORTHAND_CONFIGS.add(shorthand);
  return new Xano().registerWorkspace(shorthand);
}

/** The `{ name }` objects {@link workspace} registers — not a config the author attached. */
const SHORTHAND_CONFIGS = new WeakSet<object>();
