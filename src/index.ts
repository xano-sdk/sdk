/**
 * xanosdk — author an entire Xano workspace in TypeScript and compile it to the
 * importable `packageExport` JSON bundle.
 *
 * Start here (declarative def-objects, NOT a callback/chaining builder):
 *
 * ```ts
 * import { workspace, table, query, input, f, c, inp, ref } from "@xano/sdk";
 *
 * const users = table({ name: "users", schema: { email: f.email({ required: true }) } });
 *
 * const listUsers = query({
 *   name: "list_users", verb: "GET", apiGroup: api,
 *   stack: [dbQuery({ table: users, as: "rows" })],
 *   response: ref("rows"),
 * });
 *
 * export default workspace("my-app")        // a `new Xano()` with the name set
 *   .registerTables([users])
 *   .registerQueries([listUsers]);          // `xanosdk export ./index.ts` reads the default export
 * ```
 *
 * - Tables/inputs are typed catalogs: `f.<type>(opts)` for columns,
 *   `input.<type>(opts)` for endpoint inputs. A foreign key is `f.tableRef(table)`.
 * - Statements live under one discoverable namespace, `s.<ns>.<method>({...})`
 *   (e.g. `s.math.add`, `s.db.get`); the flat factories (`dbQuery`, `dbAdd`, …)
 *   are exported too.
 * - Bind data with the right helper: `c.*` constant, `ref` stack var, `inp`
 *   input, `col` table column, `auth("id")` the caller. (`ref` ≠ `tableRef`.)
 * - `manifest.json` / `llms.txt` (shipped) describe the whole surface for agents.
 *
 * This entry is the AUTHORING API. The compiler machinery behind it — per-kind
 * `encode*`, the kind and statement registries, the bundle serializer, the
 * `xano.lock` model — lives on `@xano/sdk/internal`, and none of it is needed
 * to define a workspace. The `node:fs` half (writers, lock-file I/O, the
 * programmatic CLI) is on `@xano/sdk/node`.
 *
 * See the README and `llms.txt` for the full tour.
 */

// Authoring
export { defineFunction } from "./function/define.js";
export type { FunctionDef, ResponseDef } from "./function/define.js";
export { input } from "./inputs/input.js";
export type { InputOptions, InputDescriptor } from "./inputs/input.js";
// Consumer contract: derive a query's request-payload type from its declared
// inputs (no codegen) — `InferInput<typeof myQuery>`. The read-side counterpart
// is `InferRow<typeof myTable>` (exported with the table kind below).
export type { InferInput } from "./inputs/infer.js";
// Consumer contract: derive a query/function's response type from its declared
// `responseShape` (override) or its `response`/`stack` (auto-derivation) — the
// read-side round-trip counterpart of `InferInput`.
export type { InferResponse, StackTupleWidened } from "./responses/infer.js";
export type {
  TypeBrand,
  BrandValue,
  BrandOpts,
  ValueOf,
  FromFieldMap,
  RowFromFieldMap,
  XanoFileRef,
  XanoGeoValue,
  XanoGeoPosition,
  // Ride a table def's inferred type — nameable for a consumer's `.d.ts`.
  BrandType,
  RawBrandValue,
  ObjectOf,
  XanoDbLink,
  XanoFileUpload,
  XanoGeoType,
  XanoGeoData,
} from "./fields/value-types.js";
export { f } from "./fields/catalog.js";
// Client-side file addressing: build a fetchable URL from a file column's
// `path` and your base URL, rather than its own tenant-less `url`.
export { fileUrl } from "./fields/file-url.js";
export { hostedFile, isHostedFile } from "./fields/hosted-file.js";
export type { HostedFile, HostedFileAccess } from "./fields/hosted-file.js";
export type { FieldDescriptor, FieldMap, FieldOpts, MethodOpts, ConstMethodOpts, EnumDefault } from "./fields/catalog.js";
export type {
  MethodSpec,
  MethodArg,
  FieldAccess,
  TextFormat,
  FieldStyleType,
  FieldOptions,
  ReadonlyMethods,
} from "./fields/field.js";
export type {
  TextMethod,
  IntMethod,
  DecimalMethod,
  EmailMethod,
  PasswordMethod,
  VectorMethod,
  TableRefMethod,
} from "./fields/generated/field-methods.generated.js";
export {
  c,
  ref,
  inp,
  col,
  auth,
  resp,
  caught,
  env,
  setting,
  sys,
  out,
  toolset,
  filter,
  withFilters,
} from "./values/value.js";
export type { CaughtField } from "./values/value.js";
export type { Value, RefValue, FilteredValue, RegexValue, AuthValue, InpValue, NotObjMember, CaughtValue } from "./values/value.js";
// A constant that also remembers the JS type it resolves to, so `s.set_var`
// can brand its binding and a `ref()` into it infers instead of bottoming out.
export type { ConstValue } from "./values/value.js";
export type { ApplyFilter, ApplyFilters } from "./values/filter-result.js";
export { obj } from "./values/obj.js";
export type { ObjInput, ObjMember, ObjShape, ObjValue } from "./values/obj.js";
// Lambda authoring: write a JavaScript body as a typed function whose parameters
// ARE the engine's injected bindings, so `$acc` is a compile error rather than a
// wrong value at runtime. `lam.file` lives on `@xano/sdk/node`.
export {
  lam,
  LAMBDA_BINDINGS,
  LAMBDA_GLOBALS,
  LAMBDA_MODULE_GLOBALS,
  LAMBDA_CODE_FILTERS,
  LAMBDA_STATEMENTS,
  assertLambdaBody,
} from "./values/lambda.js";
export type {
  LambdaSurface,
  LambdaBindings,
  LambdaBody,
  LambdaOptions,
  RawLambdaOptions,
  AmbientBindings,
  IteratingBindings,
  CaptureValue,
  Capturable,
  CaptureRecord,
} from "./values/lambda.js";
export { fl } from "./values/fl.js";
// The SQL-side counterpart of `fl.*`: the filters a db-query `eval`/`sort`/`where`
// resolves, which compile into the statement the database runs. Typed from the
// engine's own filter/aggregate classes, so the name, the argument count and an
// enumerated argument's spellings are checked where you write them.
export { qf, QUERY_FILTER_NAMES, QUERY_AGGREGATE_NAMES, QUERY_FILTER_SPECS } from "./values/generated/query-filters.generated.js";
export type { QueryFilter } from "./values/generated/query-filters.generated.js";
// The SQL-side filter registry — what a db-query `eval`/`sort`/`where` resolves
// on top of `fl.*`, including the vector-distance family (see query-filters.ts).
export type { QueryFilterName } from "./values/query-filters.js";
export { setVar, updateVar } from "./statements/set-var.js";
export type { AuthShape } from "./statements/set-var.js";
export { conditional, expr } from "./statements/conditional.js";
// Runtime predicates the engine's eight comparison operators cannot spell —
// `in`, `contains`, `starts_with`, `empty`, `between` — as one `withFilters` +
// `expr` each. The SQL-only `cmp()` operators of the same name do NOT resolve in
// a conditional/while/precondition.
export { cond } from "./statements/cond.js";
// The two authorization checks every app writes, as the shape that is correct:
// a role check that asserts the caller's row EXISTS first, and an ownership
// check that drills only after it. Both return a fixed-arity tuple, so spreading
// one does not widen the stack and kill `InferResponse`.
export { guard } from "./statements/guard.js";
// Set the HTTP status, redirect, or add a response header — sugar over
// `s.util.set_header`, which reaches the status line. Refuses the codes a live
// sweep found the platform writes and then ignores (308, 425, 451, …), each of
// which otherwise answers 200 with nothing reported.
export { respond } from "./statements/respond.js";
export type { RedirectStatus, HeaderOptions } from "./statements/respond.js";
export type { RoleGuardOptions, OwnerGuardOptions, FoundGuardOptions } from "./statements/guard.js";
// `freq: every("15m")` — a duration string as the bare second count every
// repeat/expiry knob in the engine takes. Compile-time only; the bundle carries
// the same integer either way.
export { every } from "./util/duration.js";
export type { Comparison } from "./statements/conditional.js";
export { cmp, and, or, mixed } from "./statements/special/db-search.js";
export type {
  SearchOp,
  SearchComparison,
  SearchGroup,
  SearchNode,
} from "./statements/special/db-search.js";
export type { Statement, StatementAnnotations, StatementOptions } from "./statements/statement.js";
// `AsShapeBrand`, `FoundBrand` and `Prettify` are not written by hand, but all
// ride the INFERRED type of a def with a stack (`FoundBrand` once it uses
// `guard.found` / `guard.owner`): `tsc --declaration` in a consuming package
// has to name them, and could not while they lived only in an internal chunk
// (TS2742).
// The same holds for every other phantom a def's inferred type can carry — the
// control-flow brands, the value carriers (`auth()`, `inp()`, the tags `obj()`
// refuses), and the helpers a response record is checked through.
// `npm run audit:dts` stages examples/sandbox as a consumer to prove it.
export type { AsShapeBrand, FoundBrand, BodyBrand, MaybeBodyBrand, AppendBrand, CatchBrand, BranchesBrand, MemberUpdateBrand } from "./statements/statement.js";
export type { Prettify, ProtoKeySafe, NoExtraKeys } from "./fields/value-types.js";
// Tuple-preserving identity for statement helpers — keeps `InferResponse` alive
// across a spread.
export { statements } from "./statements/statement.js";

// Hand-authored control-flow / terminal specials
export {
  returnValue,
  die,
  debugLog,
  foreachBreak,
  foreachContinue,
  foreachRemove,
} from "./statements/special/control-flow.js";
export { forLoop, foreachLoop, whileLoop, group } from "./statements/special/loops.js";
export type { ForArgs, ForeachArgs, WhileArgs } from "./statements/special/loops.js";
export { switchStatement, switchCase, tryCatch } from "./statements/special/branch.js";
export type { SwitchArgs, SwitchCaseArgs, TryCatchArgs } from "./statements/special/branch.js";
// `HeaderMap` rides the emitted signature of every HTTP-request statement, so a
// caller writing a helper that BUILDS a headers record needs to be able to name
// its type — the same gap `LambdaBody` had before it was exported.
export type { HeaderMap, HttpMethod } from "./statements/special/coerce.js";
// The `{request, response}` envelope `s.api.request` / `s.webflow.request` /
// `s.microservice.request` bind to `as` — and, through `AsShapeBrand`, part of
// the INFERRED type of every def that calls one. A downstream package emitting
// declarations has to be able to name it, so leaving it unexported broke
// `tsc --declaration` in any consumer with such a def (TS4023).
// `test/fixtures/dts-consumer/` compiles that shape as a guard.
export type {
  ApiRequestResult,
  ApiRequestArgs,
  StreamFromRequestArgs,
  WebflowRequestArgs,
} from "./statements/special/api-request.js";
export type { MicroserviceArgs, MicroserviceHost } from "./statements/special/microservice.js";
export {
  functionRun,
  functionCall,
  apiCall,
  taskCall,
  toolCall,
  triggerCall,
  middlewareCall,
  addonCall,
  actionCall,
  actionPackageCall,
  workflowTestCall,
} from "./statements/special/calls.js";
export type {
  FunctionRunArgs,
  RunBinding,
  FunctionCallArgs,
  ApiCallArgs,
  TaskCallArgs,
  ToolCallArgs,
  TriggerCallArgs,
  MiddlewareCallArgs,
  AddonCallArgs,
  ActionCallArgs,
  WorkflowTestCallArgs,
} from "./statements/special/calls.js";
export {
  aiAgentRun,
  cloudJob,
  cloudJobAwait,
  cloudJobStatus,
} from "./statements/special/ai-cloud.js";
export type {
  AiAgentRunArgs,
  AgentRunResult,
  CloudJobArgs,
  CloudJobAwaitArgs,
  CloudJobStatusArgs,
} from "./statements/special/ai-cloud.js";
export {
  arrayMap,
  arrayUnion,
  comment,
  getRawInput,
  postProcess,
  realtimeEvent,
  createAuthToken,
  expectToThrow,
} from "./statements/special/misc.js";
export { ipLookup } from "./statements/special/ip-lookup.js";
export type { IpLookupArgs, IpLookupResult } from "./statements/special/ip-lookup.js";
export type { ElicitResult, McpElicitArgs } from "./statements/special/mcp.js";
export type {
  ArrayMapArgs,
  ArrayMapShape,
  GetRawInputArgs,
  RealtimeEventArgs,
  CreateAuthTokenArgs,
  ExpectToThrowArgs,
} from "./statements/special/misc.js";
export {
  dbAdd,
  dbEdit,
  dbAddOrEdit,
  dbGet,
  dbDel,
  dbHas,
  dbPatch,
  dbTruncate,
  dbSchema,
  dbDirectQuery,
  dbBulkAdd,
  dbBulkDelete,
  dbBulkPatch,
  dbBulkUpdate,
  dbIncrement,
  dbQuery,
  dbTransaction,
  dbExternalQuery,
} from "./statements/special/db.js";
export type {
  DbField,
  DbAddArgs,
  DbEditArgs,
  DbAddOrEditArgs,
  DbDirectQueryArgs,
  DbGetArgs,
  DbDelArgs,
  DbHasArgs,
  DbPatchArgs,
  DbTruncateArgs,
  DbSchemaArgs,
  DbBulkAddArgs,
  DbBulkDeleteArgs,
  DbBulkWriteArgs,
  DbIncrementArgs,
  DbIncrementReturnType,
  DbQueryArgs,
  DbReturnType,
  DbDistinct,
  DbEval,
  DbEvalFilter,
  DbAggregate,
  DbAggregatePaging,
  DbBind,
  DbJoin,
  DbExternal,
  DbExternalPermissions,
  DbWhere,
  DbTransactionArgs,
  DbExternalQueryArgs,
  ExternalSqlEngine,
  DbResponseType,
  SortDir,
  SortDirective,
  DbSortDirective,
  DbPaging,
} from "./statements/special/db.js";
export type { AddonSpec } from "./statements/special/addon-encode.js";
export type { ObjectRef } from "./refs/guid.js";

// Unified statement authoring surface — the discoverable `s.<namespace>.<method>`
// catalog. All 214 engine statement surfaces: 149 declarative ones generated from
// the engine's field schemas, merged with 65 hand-authored specials (control flow,
// the db family, the call family).
export { s } from "./statements/s.js";

// Per-statement options — apply `disabled`, `description`, or `asFilters` to an
// already-built statement: `annotate(s.db.get({…}), { asFilters: [fl.count()] })`.
export { annotate } from "./statements/statement.js";

// Agent-grounding manifest TYPES. The builders themselves (`buildManifest`,
// `renderDocs`, `renderLlmsTxt`) and the surface catalog `STATEMENT_SURFACES`
// that drives coverage are on the `@xano/sdk/internal` subpath.
export type {
  Manifest,
  ManifestKind,
  ManifestStatement,
  ManifestField,
  ManifestValue,
} from "./manifest/manifest.js";

// Schema-driven statement catalog
export type { StatementSpec, FieldRule, Route, Authored } from "./statements/schema-dsl/interpret.js";
export { mathAdd, mathSub, mathMul, mathDiv, bitwiseAnd, bitwiseOr, bitwiseXor, textAppend, textPrepend, objectKeys, objectValues, objectEntries } from "./statements/generated/catalog.js";

// Kind model
export type { ObjectKind } from "./kinds/kind.js";
export { tableTrigger, realtimeTrigger, realtimeServerTrigger, realtimeChannelTrigger, mcpServerTrigger, agentTrigger, workspaceTrigger, errorTrigger } from "./kinds/trigger.js";
export type {
  TriggerDef,
  TriggerXdo,
  TriggerObjType,
  DatabaseActions,
  WorkspaceActions,
  RealtimeActions,
  RealtimeServerActions,
  RealtimeChannelActions,
  DatabaseInputs,
} from "./kinds/trigger.js";
export type { ToolsetType } from "./kinds/trigger-inputs.js";
// Typed input handles passed to a trigger's `stack`/`response` callback.
export type {
  FieldAccessor,
  RealtimeInputs,
  RealtimeClient,
  RealtimeServerTriggerInputs,
  RealtimeChannelTriggerInputs,
  AgentTriggerInputs,
  McpServerTriggerInputs,
  WorkspaceInputs,
  ErrorInputs,
} from "./kinds/trigger-handle.js";
export { tool } from "./kinds/toolset.js";
export { prompt } from "./kinds/prompt.js";
export type { PromptDef, PromptXdo } from "./kinds/prompt.js";
export { resource } from "./kinds/resource.js";
export type { ResourceDef, ResourceXdo } from "./kinds/resource.js";
export type {
  McpIcon,
  McpIconMimeType,
  ToolAnnotations,
  ResourceAnnotations,
} from "./kinds/mcp-metadata.js";
export { mcpServer } from "./kinds/mcp-server.js";
export type { McpServerDef, McpServerXdo, McpServerHandle, McpPathOptions } from "./kinds/mcp-server.js";
export type {
  McpOauth,
  McpOauthHosted,
  McpOauthExternal,
  McpOauthPreset,
  McpOauthEnvString,
  McpOauthXdo,
} from "./kinds/mcp-oauth.js";
export { agent } from "./kinds/agent.js";
export type {
  AgentDef,
  AgentHandle,
  AgentXdo,
  AgentSettingsXdo,
  AgentOutput,
  LlmSettings,
  LlmProvider,
  LlmPrompt,
  AnthropicLlm,
  OpenAiLlm,
  GoogleGenAiLlm,
  XanoFreeLlm,
} from "./kinds/agent.js";
export { knowledge, knowledgeFile, knowledgeDir } from "./kinds/knowledge.js";
export type {
  KnowledgeDef,
  KnowledgeType,
  KnowledgeMode,
  KnowledgeFileSource,
  KnowledgeDirSource,
} from "./kinds/knowledge.js";
export { table, seedFile } from "./kinds/table.js";
export type {
  TableDef,
  TableXdo,
  ColumnDef,
  SchemaDef,
  SchemaCols,
  RowOf,
  InferRow,
  SeedRow,
  SeedSource,
  SeedFileSource,
  IndexDef,
  IndexXdo,
  IndexType,
  IndexOp,
  IndexLang,
  ViewDef,
  ViewXdo,
} from "./kinds/table.js";
export { query, toSearchParams } from "./kinds/query.js";
export type { UrlLike, SearchParams, SearchParamsMembers } from "./util/web-globals.js";
export type {
  QueryDef,
  QueryHandle,
  QueryXdo,
  HttpVerb,
  QueryResponseType,
  SearchParamValue,
} from "./kinds/query.js";
export { apiGroup } from "./kinds/api-group.js";
export type { ApiGroupDef, ApiGroupXdo, CorsConfig, CorsMode } from "./kinds/api-group.js";

// Wide def aliases for module composition — annotate a heterogeneous module
// array with these when `.flatMap()`/`.concat()` collapses inference onto the
// first element (see `kinds/any-def.ts` for the whole story).
export type { AnyTableDef, AnyQueryDef, AnyFunctionDef, AnyAddonDef } from "./kinds/any-def.js";

// --- microservice: a container workload deployed alongside the workspace ---
export { microservice } from "./kinds/microservice.js";
export type {
  MicroserviceDef,
  MicroserviceXdo,
  MicroserviceDeployment,
  MicroserviceContainer,
  MicroserviceIngress,
  MicroserviceIngressPath,
  MicroserviceConfig,
  MicroserviceVolume,
  MicroserviceChart,
  MicroserviceRegistryAuth,
  ContainerPort,
  ContainerResources,
  ContainerEnv,
  ContainerVolume,
} from "./kinds/microservice.js";

// --- realtime: realtime_server -> channel -> message ---
export { realtimeServer } from "./kinds/realtime-server.js";
export type {
  RealtimeServerDef,
  RealtimeServerXdo,
  RealtimeServerHandle,
  RealtimeUrlOptions,
} from "./kinds/realtime-server.js";
export { realtimeChannel } from "./kinds/realtime-channel.js";
export type {
  RealtimeChannelDef,
  RealtimeChannelXdo,
  RealtimeChannelHandle,
  RealtimeServerRef,
  ChannelPublishDef,
  ChannelPublishWho,
  ChannelConversationDef,
  ChannelDeliveryDef,
  ChannelDeliveryGuarantee,
  ChannelRateLimitDef,
} from "./kinds/realtime-channel.js";
export { realtimeMessage } from "./kinds/realtime-message.js";
export type {
  RealtimeMessageDef,
  RealtimeMessageXdo,
  RealtimeChannelRef,
  MessageDeliverTo,
} from "./kinds/realtime-message.js";
export { task } from "./kinds/task.js";
export type { TaskDef, TaskXdo, ScheduleDef } from "./kinds/task.js";
export type { MockEntry, MockMap, MockXdo } from "./values/mock.js";
export { expect, TEST_EXPECT_TYPES } from "./values/expect.js";
export type { TestExpect, TestExpectType } from "./values/expect.js";
export { test } from "./kinds/test.js";
export type { TestDef, TestXdo } from "./kinds/test.js";
export { workflowTest } from "./kinds/workflow-test.js";
export type { WorkflowTestDef, WorkflowTestXdo } from "./kinds/workflow-test.js";
export { middleware } from "./kinds/middleware.js";
export type { MiddlewareDef, MiddlewareXdo, ResultStrategy, ExceptionPolicy } from "./kinds/middleware.js";
export type { MiddlewareAttach, MiddlewareAttachEntry } from "./kinds/middleware-attach.js";
export type { HistoryInput, WorkspaceHistoryDef, WorkspaceHistoryXdo } from "./kinds/history.js";
export { addon } from "./kinds/addon.js";
export type { AddonDef, AddonXdo } from "./kinds/addon.js";
export { workspaceConfig } from "./kinds/workspace-config.js";
// A typed reader for the env names THIS config declares, so a misspelling is a
// compile error rather than a null at request time. The export-time counterpart
// is the `stack.env-undeclared` warning.
export { typedEnv } from "./kinds/workspace-config.js";
export type { WorkspaceConfigDef, WorkspaceConfigXdo, WorkspaceMiddlewareDef, WorkspaceMiddlewareXdo } from "./kinds/workspace-config.js";
export type {
  ToolDef,
  ToolXdo,
  ToolsetBaseDef,
  ToolsetBaseXdo,
  ToolsetToolRef,
  ToolsetToolEntry,
  McpPrimitiveEntry,
  McpPrimitiveRef,
} from "./kinds/toolset.js";
export type { AuthRef } from "./refs/auth.js";

// Workspace registry + aggregate export
export { Xano, workspace } from "./workspace/xano.js";
export type { Bundle, BundlePayload, BundleType, PayloadArrayKey } from "./workspace/export.js";

// Compile + emit. Only the pure string emitters live on the browser-safe entry;
// the `node:fs` writers (`writeArtifact`, `writeBundle`) and lock-file I/O
// (`readLockFile`, `writeLockFile`) are exported from `@xano/sdk/node`.
export { compile } from "./function/compile.js";
export { emit, emitBundle } from "./emit/emit.js";

// Identity lock file (xano.lock). Programmatic contract: seed BEFORE any def
// module is evaluated, once per process (see src/lock/store.ts).
export type {
  LockFile,
  LockEntry,
  LockExportContext,
  MergeResult,
  RenameResult,
  AdoptResult,
  AdoptChange,
} from "./lock/lock.js";
export { seedLockOverrides, resetLockOverrides } from "./lock/store.js";

// Types
export type * from "./types/xdo.js";
export { ignored } from "./values/ignored.js";

// Types that ride a def's or a statement's INFERRED type (a `db.query` output
// projection, a filter chain's result, an agent's output, a table's internal
// columns). Nobody writes them by hand, but a consumer emitting its own `.d.ts`
// must be able to name them (TS2742) — `npm run audit:dts` holds the line.
export type { Condition } from "./statements/expression.js";
export type { PathParams } from "./kinds/path-params.js";
export type { OutputPath, OutputRoot, QualifiedCol, PagingEnvelopeField } from "./statements/special/output-select.js";
export type { AggregateRow, EvalFields } from "./statements/special/db-search.js";
export type { AgentResultOf } from "./kinds/agent.js";
export type { InternalColsOf } from "./kinds/table.js";
export type { FilterResults, ElementResult, SameArrayResult, GroupedArrayResult } from "./values/generated/filters.generated.js";
export type { QueryFilterResults } from "./values/generated/query-filters.generated.js";
export type { OutputAuthored } from "./statements/schema-dsl/interpret.js";
