/**
 * `@xano/sdk/internal` — the compiler machinery behind the authoring API.
 *
 * Everything here is reachable, importable, and **not** part of the surface you
 * author a workspace with. It is the layer `workspace().export()` runs: the
 * per-kind encoders, the kind and statement registries, the bundle serializer,
 * the `xano.lock` model, and the coverage constants that describe what this
 * build implements.
 *
 * ### Why it is not on `@xano/sdk`
 *
 * The root entry is what an agent scans to answer "what can I import". Mixing
 * `encodeQuery` in beside `query` gives that scan no signal for which of the two
 * to reach for, and the noise costs more than the machinery ever bought — the
 * risk was never that something calls `phpJsonEncode`, it is that a quarter of
 * the list is compiler guts and the real surface gets diluted.
 *
 * Anything exported is also API someone can depend on, so the split is drawn now
 * rather than after these names are load-bearing for a consumer.
 *
 * ### When you legitimately want it
 *
 * Tooling that builds on the compiler rather than authoring against it: a script
 * that encodes one object without a workspace, a lock-file utility, a test
 * harness asserting bundle bytes. Nothing here is documented in `llms.txt`, and
 * none of it is needed to define a workspace.
 *
 * These names are versioned like the rest of the package, but they describe an
 * internal contract — expect them to move with the compiler, not with the
 * authoring API.
 */

export { toNestedFields } from "./fields/catalog.js";
export { FIELD_METHODS } from "./fields/generated/field-methods.generated.js";
export { FILTER_NAMES } from "./values/generated/filters.generated.js";
export {
  QUERY_EXPRESSION_FILTERS,
  VECTOR_FILTERS,
  isQueryExpressionFilter,
} from "./values/query-filters.js";
// What a compiled bundle needs from the instance it lands on — the editor's own
// per-statement gating, so a promote onto a different plan can be checked before
// it fails on the first request. `xanosdk export`/`deploy` print this.
export {
  CAPABILITIES,
  STATEMENT_CAPABILITIES,
  bundleCapabilities,
} from "./validate/capabilities.js";
export type { Capability, CapabilityId, CapabilityRequirement } from "./validate/capabilities.js";
export {
  encodeStatement,
  getStatementFactory,
  isRegisteredStatement,
} from "./statements/statement.js";
export {
  deriveGuid,
  resolveRef,
  REFERENCEABLE_KINDS,
} from "./refs/guid.js";
export {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  IMPLEMENTED_STATEMENTS,
  sPathOf,
} from "./statements/surfaces.js";
export {
  buildManifest,
  renderDocs,
  renderLlmsTxt,
  LLMS_TXT,
  TOTAL_OBJECT_KINDS,
} from "./manifest/manifest.js";
export {
  encodeFromSpec,
  registerSpec,
} from "./statements/schema-dsl/interpret.js";
export { generated as generatedStatements } from "./statements/generated/factories.generated.js";
export {
  GENERATED_SPECS,
  GENERATED_STATEMENT_NAMES,
} from "./statements/generated/catalog.js";
export {
  registerKind,
  getKind,
  encodeObject,
  isRegisteredKind,
  registeredKinds,
} from "./kinds/kind.js";
export {
  functionKind,
  encodeFunction,
} from "./kinds/function.js";
export {
  triggerKind,
  encodeTrigger,
} from "./kinds/trigger.js";
export {
  toolKind,
  encodeTool,
  encodeToolsetBase,
  encodeToolRefs,
  resolveToolsetCanonical,
} from "./kinds/toolset.js";
export {
  mcpServerKind,
  encodeMcpServer,
} from "./kinds/mcp-server.js";
export {
  agentKind,
  encodeAgent,
} from "./kinds/agent.js";
export {
  knowledgeKind,
  encodeKnowledge,
  isKnowledgeFileSource,
  isKnowledgeDirSource,
  KNOWLEDGE_FILE,
  KNOWLEDGE_DIR,
} from "./kinds/knowledge.js";
export {
  tableKind,
  encodeTable,
  encodeColumn,
  encodeIndex,
  encodeView,
} from "./kinds/table.js";
export {
  queryKind,
  encodeQuery,
} from "./kinds/query.js";
export {
  apiGroupKind,
  encodeApiGroup,
} from "./kinds/api-group.js";
export {
  microserviceKind,
  encodeMicroservice,
  declaredServicePorts,
} from "./kinds/microservice.js";
export {
  realtimeServerKind,
  encodeRealtimeServer,
  resolveRealtimeServerCanonical,
} from "./kinds/realtime-server.js";
export {
  realtimeChannelKind,
  encodeRealtimeChannel,
  realtimeChannelGuid,
  channelPathParams,
} from "./kinds/realtime-channel.js";
export {
  realtimeMessageKind,
  encodeRealtimeMessage,
  realtimeMessageGuid,
} from "./kinds/realtime-message.js";
export {
  taskKind,
  encodeTask,
  encodeSchedule,
} from "./kinds/task.js";
export {
  workflowTestKind,
  encodeWorkflowTest,
} from "./kinds/workflow-test.js";
export {
  middlewareKind,
  encodeMiddleware,
} from "./kinds/middleware.js";
export {
  buildMiddlewareBlock,
  encodeMiddlewareEntry,
  encodeMiddlewareList,
} from "./kinds/middleware-attach.js";
export {
  encodeHistory,
  encodeContainerHistory,
  buildWorkspaceHistory,
} from "./kinds/history.js";
export {
  addonKind,
  encodeAddon,
} from "./kinds/addon.js";
export {
  workspaceKind,
  encodeWorkspaceConfig,
} from "./kinds/workspace-config.js";
export { resolveAuthRef } from "./refs/auth.js";
export {
  buildBundle,
  calcSignatureJson,
  phpJsonEncode,
  PAYLOAD_ARRAY_KEYS,
} from "./workspace/export.js";
export { encodeResponse } from "./function/compile.js";
export { serializeBundle } from "./emit/emit.js";
export {
  LOCK_VERSION,
  // A single-def renderer maps a lock's payload keys onto the kinds it can
  // render, and needs the identity table's own list to know when a newly added
  // kind has no mapping yet.
  LOCK_PAYLOAD_KEYS,
  emptyLock,
  parseLock,
  serializeLock,
  validateLockModel,
  mintCanonical,
  lockKey,
  resolvePayloadKey,
  createLockContext,
  recordObserved,
  mergeObserved,
  renameLockEntry,
  adoptFromBundle,
  WORKSPACE_KEY,
} from "./lock/lock.js";
export {
  isLockSeeded,
  getLockedGuid,
  getLockedCanonical,
} from "./lock/store.js";

// The types those functions speak in, so a caller can name one without reaching
// back to the root entry for half its imports.
export type { ObjectKind } from "./kinds/kind.js";
export type { LockFile, LockEntry, LockExportContext, MergeResult, RenameResult, AdoptResult, AdoptChange } from "./lock/lock.js";
export type { Bundle, BundlePayload, BundleType, PayloadArrayKey } from "./workspace/export.js";
export type { Manifest, ManifestKind, ManifestStatement, ManifestField } from "./manifest/manifest.js";
