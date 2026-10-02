/**
 * `s` — the unified, discoverable statement authoring surface.
 *
 * Merges the codegen'd namespace (every declarative statement, reachable as
 * `s.<namespace>.<method>({…})` — e.g. `s.math.add`, `s.array.find`, `s.db.get`)
 * with the hand-authored control-flow / terminal specials that the codegen
 * defers (`!class`/`!function`). This is the one place to look for "what
 * statements can I author": tab-complete `s.` and explore.
 *
 * The generated factories take a single typed args object; the specials keep
 * their authored signatures. Both return a `Statement` ready for a function /
 * query / trigger `stack`.
 */
import { registerFactoryPaths } from "./statement.js";
import type { AppendBrand, AsShapeBrand, Statement } from "./statement.js";
import type { Value } from "../values/value.js";
import type { FilterXdo } from "../types/xdo.js";
import type { ApplyFilters } from "../values/filter-result.js";
import "./generated/catalog.js"; // side-effect: registers every generated spec on the statement registry
import { generated } from "./generated/factories.generated.js";
import { setVar, updateVar } from "./set-var.js";
import { conditional } from "./conditional.js";
import { forLoop, foreachLoop, whileLoop, group } from "./special/loops.js";
import { switchStatement, tryCatch } from "./special/branch.js";
import {
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
} from "./special/calls.js";
import {
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
  dbIncrement,
  dbBulkPatch,
  dbBulkUpdate,
  dbQuery,
  dbTransaction,
  dbExternalQuery,
} from "./special/db.js";
import { apiRequest, streamFromRequest, webflowRequest } from "./special/api-request.js";
import { ipLookup } from "./special/ip-lookup.js";
import { microserviceRequest } from "./special/microservice.js";
import { aiAgentRun, cloudJob, cloudJobAwait, cloudJobStatus } from "./special/ai-cloud.js";
import {
  arrayMap,
  arrayUnion,
  comment,
  getRawInput,
  postProcess,
  realtimeEvent,
  realtimePublish,
  createAuthToken,
  expectToThrow,
  expectToMatch,
} from "./special/misc.js";
import { precondition, throwError } from "./special/precondition.js";
import {
  createAttachment,
  createAudio,
  createImage,
  createVideo,
  setHeader,
} from "./special/closed-sets.js";
import { lambda } from "./special/lambda-args.js";
import { mcpElicit } from "./special/mcp.js";
import type { ExternalSqlEngine } from "./special/db.js";
import {
  returnValue,
  foreachBreak,
  foreachContinue,
  foreachRemove,
} from "./special/control-flow.js";

/** `s.object.keys`, branded so the bound var reads as the key list. */
type ObjectKeys = <const As extends string = string, const Fs extends readonly FilterXdo[] = readonly []>(
  a?: Omit<NonNullable<Parameters<typeof generated.object.keys>[0]>, "as" | "asFilters"> & { as?: As; asFilters?: Fs },
) => Statement & AsShapeBrand<As, ApplyFilters<string[], Fs>>;

/** `s.security.create_uuid`, branded so the bound var reads as the UUID string it is. */
type CreateUuid = <const As extends string = string, const Fs extends readonly FilterXdo[] = readonly []>(
  a?: Omit<NonNullable<Parameters<typeof generated.security.create_uuid>[0]>, "as" | "asFilters"> & { as?: As; asFilters?: Fs },
) => Statement & AsShapeBrand<As, ApplyFilters<string, Fs>>;

/** An in-place list mutator, branded with the name it appends to and the value appended. */
type Appender<F extends (a: never) => Statement, Spread extends boolean> = <
  const N extends string = string,
  V extends Value = Value,
>(
  a: Omit<NonNullable<Parameters<F>[0]>, "name" | "value"> & { name?: N } & (Spread extends true ? { value?: V } : { value: V }),
) => Statement & AppendBrand<N, V, Spread>;

/** A `db.external.<engine>.direct_query` factory bound to one engine. */
const externalQuery = (engine: ExternalSqlEngine) => ({
  direct_query: (a: Omit<Parameters<typeof dbExternalQuery>[0], "engine">) =>
    dbExternalQuery({ ...a, engine }),
});

// `cloud.job` is both a statement and the namespace for its await/status ops.
const cloudJobNs = Object.assign(cloudJob, { await: cloudJobAwait, status: cloudJobStatus });

export const s = {
  ...generated,
  // Typed overrides of generated factories: `precondition` narrows `error_type`
  // to the status-bearing enum, and `throw` documents that it returns HTTP 200
  // (use `precondition` for a status-observable rejection).
  precondition,
  throw: throwError,
  // Typed refusal of `capture`, which belongs to `lam.fn` — the bare TS2353 the
  // generated factory produced implied dropping the field rather than moving
  // the body. Same bytes.
  lambda,
  // Hand-authored specials (not in the codegen'd catalog).
  set_var: setVar,
  update_var: updateVar,
  conditional,
  comment,
  for: forLoop,
  foreach: foreachLoop,
  while: whileLoop,
  group,
  switch: switchStatement,
  try_catch: tryCatch,
  return: returnValue,
  foreach_break: foreachBreak,
  foreach_continue: foreachContinue,
  foreach_remove: foreachRemove,
  // Call family — invoke another workspace object. `api.call`/`api.realtime_event`
  // merge into the generated `api` namespace; the rest are new namespaces.
  // `api.request` (and `stream.from_request`/`webflow.request`/`microservice.request`
  // below) are typed hand-authored overrides of their generated factories.
  function: { run: functionRun, call: functionCall },
  action: { call: actionCall, package: { call: actionPackageCall } },
  workflow_test: { call: workflowTestCall },
  api: { ...generated.api, call: apiCall, realtime_event: realtimeEvent, request: apiRequest },
  // Microservices are a top-level feature: the `microservice()` def and the
  // statement that calls one live side by side. The override is load-bearing —
  // `...generated` above already exposes the RAW generated factory here, and it
  // has none of the defaulting that lets a call name only `host` and `path`.
  microservice: { ...generated.microservice, request: microserviceRequest },
  // `realtime.publish` is the CURRENT-layer send statement (`api.realtime_event` is the
  // superseded one); `get_session` beside it is generated.
  realtime: { ...generated.realtime, publish: realtimePublish },
  stream: { ...generated.stream, from_request: streamFromRequest },
  webflow: { ...generated.webflow, request: webflowRequest },
  task: { call: taskCall },
  tool: { call: toolCall },
  // MCP server stacks (tool / prompt / resource): ask the client's user mid-call,
  // and report progress (generated). `oauth` is the MCP sign-in hand-off a
  // login page's stack runs (generated; `export()` checks revoke's one-of target).
  mcp: { ...generated.mcp, elicit: mcpElicit },
  trigger: { call: triggerCall },
  middleware: { call: middlewareCall },
  addon: { call: addonCall },
  // Database family — merges into the generated `db` namespace.
  db: {
    ...generated.db,
    add: dbAdd,
    edit: dbEdit,
    add_or_edit: dbAddOrEdit,
    get: dbGet,
    del: dbDel,
    has: dbHas,
    patch: dbPatch,
    truncate: dbTruncate,
    schema: dbSchema,
    direct_query: dbDirectQuery,
    query: dbQuery,
    increment: dbIncrement,
    transaction: dbTransaction,
    bulk: { add: dbBulkAdd, delete: dbBulkDelete, patch: dbBulkPatch, update: dbBulkUpdate },
    external: {
      mssql: externalQuery("mssql"),
      mysql: externalQuery("mysql"),
      oracle: externalQuery("oracle"),
      postgres: externalQuery("postgres"),
      snowflake: externalQuery("snowflake"),
    },
  },
  // AI agent + cloud jobs.
  ai: { ...generated.ai, agent: { run: aiAgentRun } },
  cloud: { ...generated.cloud, job: cloudJobNs },
  // Array map/union, expect.to_throw, auth-token, raw-input/post-process merge
  // into their generated namespaces.
  array: {
    ...generated.array,
    map: arrayMap,
    union: arrayUnion,
    // Typed overrides of the generated factories: same bytes, plus the element
    // an accumulator gains, which `InferResponse` reads off the list it traces.
    push: generated.array.push as Appender<typeof generated.array.push, false>,
    unshift: generated.array.unshift as Appender<typeof generated.array.unshift, false>,
    merge: generated.array.merge as Appender<typeof generated.array.merge, true>,
  },
  expect: { ...generated.expect, to_throw: expectToThrow, to_match: expectToMatch },
  security: { ...generated.security, create_auth_token: createAuthToken, create_uuid: generated.security.create_uuid as CreateUuid },
  // The generated factory, typed: `object.keys` always binds a list of the
  // object's key names, so `ref("<as>")` traces to `string[]`, not `unknown`.
  object: { ...generated.object, keys: generated.object.keys as ObjectKeys },
  util: {
    ...generated.util,
    get_raw_input: getRawInput,
    get_input: getRawInput,
    post_process: postProcess,
    // Typed override of the generated factory: same bytes, plus the nested
    // result shape a `ref` into the bound var has no other way to learn.
    ip_lookup: ipLookup,
    // `duplicates` is a closed set the codegen ships as a bare `string`.
    set_header: setHeader,
  },
  // `access` is a closed set the codegen ships as a bare `string`, and it
  // defaults to `public` — a misspelled `"private"` would serve the file to
  // the world with no compile-time signal.
  storage: {
    ...generated.storage,
    create_attachment: createAttachment,
    create_audio: createAudio,
    create_image: createImage,
    create_video: createVideo,
  },
} as const;

// Every statement error names the `s.` factory an author called — learned here,
// where the whole tree is assembled, for the specials no spec names.
registerFactoryPaths(s, "s");

/**
 * Load every statement onto this copy's registry. Each factory registers as
 * its module loads, and the package is `sideEffects: false`, so a build that
 * reaches the encoder without the `s` tree (the CLI's `compile`) would carry
 * only the statements it happened to import. Naming `s` keeps them all.
 */
export function registerAllStatements(): void {
  registerFactoryPaths(s, "s");
}
