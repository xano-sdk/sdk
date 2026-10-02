/**
 * Query (API endpoint) kind → payload key `query`. Function-like
 * (input/run/result) plus HTTP fields: `verb`, `app` (api_group binding),
 * `auth`, `response_type`, `cache`, `output`. Validated against
 * the Xano engine's persisted shape.
 */
import type { SearchParams } from "../util/web-globals.js";
import type { ResultItemXdo, StackItemXdo, InputXdo, CacheXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse, warnUnboundReturn } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import type { ApiGroupDef } from "./api-group.js";
import type { TableDef } from "./table.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import { deriveQueryGuid, queryGroupComponent, resolveRef } from "../refs/guid.js";
import { resolveAuthRef } from "../refs/auth.js";
import { lockKey } from "../lock/lock.js";
import { getLockedCanonical } from "../lock/store.js";
import {
  parsePathParams,
  assertPathParamInputs,
  fillPathParams,
  type IsStaticPath,
  type PathParamValues,
} from "./path-params.js";
import { assertStoredName } from "./stored-name.js";
import { encodeTests } from "./test.js";
import { resolveMockKeys } from "./test-mocks.js";
import type { TestDef, TestXdo } from "./test.js";
import { assertOneOf } from "./closed-set.js";
import { describeEntry } from "../statements/args.js";

/**
 * The six HTTP verbs the engine stores, in the exact casing it stores them.
 * Exported as a runtime tuple (not just the {@link HttpVerb} type) so the
 * encoder can check a value the type system never saw — see
 * {@link assertQueryClosedSets}.
 */
export const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export type HttpVerb = (typeof HTTP_VERBS)[number];

/** The two `response_type` values the engine stores for a query. */
export const QUERY_RESPONSE_TYPES = ["standard", "stream"] as const;

export type QueryResponseType = (typeof QUERY_RESPONSE_TYPES)[number];

/**
 * `QueryDef` is generic over its `input` map `I` so a consumer can recover the
 * exact, branded input types via `InferInput<typeof myQuery>` (see
 * `src/inputs/infer.ts`), and over its declared response shape `Res` so
 * `InferResponse<typeof myQuery>` (see `src/responses/infer.ts`) recovers the
 * read shape. Both default so every existing use — a bare `QueryDef` — works
 * unchanged; `Res` defaults to `never` (undeclared), which routes
 * `InferResponse` to automatic derivation.
 */
export interface QueryDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
  N extends string = string,
  V extends HttpVerb = HttpVerb,
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "query";
  /**
   * The endpoint path within its api group — the last segment(s) of
   * `/api:<canonical>/<name>`.
   *
   * Holds ONLY letters, digits, `_`, `-`, `/`, and the `{}` of a path param —
   * the engine's stored charset, capped at 200 characters. Anything else (most
   * often a `.`, as in `export.zip`) is NOT rejected by Xano: it saves the
   * endpoint with an empty name, which deploys clean and then 404s
   * `Unable to locate request.` on every request. `query()` throws instead.
   * For a download endpoint use `export_zip` or `export/zip` and put the file
   * extension in the response headers.
   *
   * A `{param}` segment makes it a URL PATH PARAM: `"blog/{slug}"` binds the
   * segment to the `slug` input, and segments chain
   * (`"blog/{slug}/review/{review_id}"`). Every `{param}` MUST have a matching
   * `input` entry with a scalar type, or `query()` throws — a marker with no
   * input deploys as a permanently-broken route. `required: true` is NOT
   * demanded, because Xano's own editor leaves path-param inputs unmarked. A
   * marker need not be a whole segment: `"blog/post-{slug}"` routes fine.
   *
   * Routes match FIRST-FIT in creation order, with no literal-over-param
   * precedence, so `export()` refuses two routes in one group and verb that a
   * single request path can reach (`query.route-shadowed`) — `"runs/{id}"` with
   * a text or OPTIONAL int `id` beside `"runs/trend"`. Only a REQUIRED `int`/
   * `decimal` param matches digits only and so does not collide with a word.
   *
   * The CONVERSE is warned rather than enforced. An input that a `GET`/`DELETE`/
   * `HEAD` looks ONE ROW up by — the match argument of `s.db.get` or
   * the by-field edit/patch/delete family — is
   * ADDRESSING a resource and belongs in the path; `export()` reports
   * `query.path-segment-candidate` when the path does not bind it (not for a
   * personal-data or secret input like `email` or `invite_code`; accept it with
   * {@link QueryDef.diagnostics}). The endpoint
   * still serves `?blog_id=1`, which is why it is a warning: what it costs is
   * that the route is not addressable the way a REST client, cache key, or
   * access log expects, and `getPath()` types as STATIC, so a caller cannot
   * pass the value positionally. A segment is any value that names WHICH
   * resource is wanted, not merely one named like a key — `"shop/{country}"`
   * and `"blog/{category}"` are this shape too. An input that NARROWS A LIST
   * (an `s.db.query` filter) is the opposite case and correctly stays a
   * query-string param; inputs that are not in the path need nothing special.
   *
   * Captured as a literal so `getPath({ params })` types its keys from it.
   */
  name: N;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `(apiGroup, verb, name)` — a query's engine uniqueness — so a `GET`/`POST` pair on one path, and one path across two groups, are distinct objects. Set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  /**
   * The HTTP method, UPPERCASE — one of `GET`, `POST`, `PUT`, `PATCH`,
   * `DELETE`, `HEAD`. Anything else is refused at authoring time: the engine
   * stores an unrecognized verb as NULL, a null verb serves as GET, and the
   * endpoint then answers on the wrong method while the intended one 404s
   * `Unable to locate request.` A lowercase `"post"` is the usual miss.
   */
  verb: V;
  /**
   * The API group this query belongs to — an `apiGroup()` def or its name.
   * Resolved to the group's guid (which the engine remaps to a local id on
   * import), so the binding is stable across syncs. Prefer this over the raw
   * numeric `apiGroupId`. Pass the def handle when the group sets an explicit `guid`.
   */
  apiGroup?: ApiGroupDef | string;
  /** Escape hatch: a raw numeric `app.id`. Takes precedence over `apiGroup`. */
  apiGroupId?: number;
  /** Accepted export warnings — a lookup input kept in the query string on purpose. Never emitted. */
  diagnostics?: DiagnosticsFor<"query">;
  /**
   * The authentication table backing this endpoint, or `false`/omitted for a
   * public (no-auth) endpoint. Pass the auth `table()` def — the table marked
   * `table({ auth: true })` — and `export()` resolves it to that table's guid
   * (the engine remaps guid→local id on import), so the binding is stable across
   * syncs. A bare table name resolves the same way, but pass the def handle when
   * the table pins an explicit `guid`: a bare name derives its guid from the name
   * alone and would diverge from the pinned identity. A raw numeric `dbo.id` is
   * an escape hatch that wins when given. Xano supports any number of auth
   * tables, so name the one this endpoint authenticates against; `export()`
   * rejects a reference to a table it cannot find (and warns when the table is
   * not marked `auth: true`, which the engine allows). Once set, read the
   * authenticated record inside the stack with the `auth("path")` value ref.
   *
   * Unlike `apiGroup`, the numeric escape hatch lives in this same field rather
   * than a separate `authId`: `auth` is a single terminal value with no second
   * consumer (the `apiGroup` handle also feeds `getPath()`'s `canonical`, which
   * is why *it* needs the symbolic ref and the raw id to coexist as two fields).
   */
  auth?: false | null | TableDef | string | number;
  description?: string;
  docs?: string;
  /**
   * `"standard"` (default) buffers the response; `"stream"` streams it. Any
   * other value is refused at authoring time — the engine stores an
   * unrecognized `response_type` as NULL and falls back to `"standard"`, so a
   * misspelled `"streaming"` silently buffers.
   */
  responseType?: QueryResponseType;
  apiEnabled?: boolean;
  disabled?: boolean;
  /** Response caching. Any setting (`{ ttl: 30 }`) turns it on unless `active: false`; omit for off. */
  cache?: Partial<CacheXdo>;
  /**
   * Pre/post middleware attachment. `middleware: { pre: [mw], post: [...] }`
   * runs the listed middleware around this endpoint's stack. Providing a phase
   * sets its `_customize` flag (override); omitting it inherits from the API
   * group, then the workspace (the engine resolves the chain — Xano SDK emits
   * the flags and lists). `pre: middleware.clear()` overrides with nothing
   * (stop inheriting). Reference a `middleware()` def handle or its name.
   *
   * A `pre` middleware runs **after** auth resolution, so `auth()` is available
   * inside the middleware when this endpoint is authenticated (its `auth` names
   * an auth table). On a public endpoint (`auth` unset) there is no caller
   * identity for it to resolve — so keying a rate limit by `auth("id")` on a
   * public endpoint does not collapse into a shared bucket, it FAILS the request
   * with a 403 on the first call, before the host runs; key off `sys.remoteIp()`
   * there. `export()` **warns** (never blocks) when an
   * `auth()`-keyed middleware is attached here and this endpoint has no auth table.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit (API group → workspace). A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. Any value stops inheriting. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /**
   * Saved UNIT TESTS — named input sets run against this object, with
   * assertions on the response. The same tests the Xano editor shows.
   *
   * Build assertions with the top-level `expect.*` helpers (NOT `s.expect.*`,
   * which builds workflow-test statements). A statement in this object's stack
   * can return a mock instead of running, per test, via its `mock` option.
   *
   * ⚠ A run uses an EMPTY datasource, so no `table({ seed })` row is visible to
   * it: every `db` read misses, and an assertion on the first row fails against
   * a deployment whose endpoint returns those rows over HTTP. Create what the
   * test needs inside the run — a `defineFunction` fixture the stack calls
   * first — or `mock` the read.
   */
  tests?: TestDef[];
  /**
   * The saved request/response SAMPLE the Xano editor records — free-form JSON,
   * not tagged values. Recorded from a real call, so treat it as user data:
   * `codegen` DOES bring it back, deliberately, rather than dropping an
   * authored artefact silently.
   */
  example?: QueryExample;
  input?: I;
  /**
   * The endpoint's statement stack. Captured as the literal tuple `S` (via
   * `query()`'s `const` inference) so `InferResponse` can trace a single-variable
   * response back to the branded `db.get`/`db.query` that bound it. A
   * dynamically-built `Statement[]` widens `S` and the trace degrades to
   * `unknown` — the override (`responseShape`) remains the escape hatch.
   */
  stack?: S;
  /**
   * The response assignment: a single {@link Value} (returned directly) or a
   * record of named values (an object with those keys). Captured as the literal
   * `Resp` so `InferResponse` can auto-derive object-literal keys and, with
   * the branded stack, trace a single-variable response.
   */
  response?: Resp;
  /**
   * Type-only: declare the endpoint's response shape so
   * `InferResponse<typeof query>` recovers it exactly (the always-correct
   * override, taking precedence over automatic derivation). Reuse the read-side
   * types you already have — e.g. `responseShape: [] as InferRow<typeof link>[]`
   * for a list, or `null as InferRow<typeof s> | null` for a get. Use it for
   * responses the static walk can't see (filters, lambdas, control-flow vars).
   * The runtime value is ignored by `encodeQuery`; only its type is read.
   */
  responseShape?: Res;
}

/**
 * A `query()` handle: the def plus `getPath()` and `toSearchParams()`. It stays
 * a plain data descriptor with two added methods — they are dropped by
 * `JSON.stringify` and ignored by `encodeQuery`, so serialization and
 * conformance are unaffected.
 */
export type QueryHandle<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
  N extends string = string,
  V extends HttpVerb = HttpVerb,
> = QueryDef<I, Res, Resp, S, N, V> & {
    /**
     * The endpoint's **group-relative** URL path — `/api:<canonical>/<name>` —
     * ready to prepend a host and drop into `fetch`. The api group's `canonical`
     * is resolved from the bound `apiGroup` handle (or `opts.canonical`); it
     * throws if neither is available (an empty canonical is minted into
     * `xano.lock` at export and is not knowable from the def alone). The HTTP
     * verb is available separately as `<query>.verb`.
     *
     * When the name carries `{param}` segments, `params` is REQUIRED and its
     * keys are exactly those params — `getPath({ params: { slug: "hello" } })`
     * → `/api:blog/blog/hello`. It throws on a missing, empty, or unknown param,
     * and on a value containing `/` (which would address a different route).
     */
    getPath: IsStaticPath<N> extends true
      ? (opts?: { canonical?: string }) => string
      : (opts: { canonical?: string; params: PathParamValues<N> }) => string;
    /**
     * Serialize this endpoint's inputs into a GET query string, dropping the
     * ones bound to `{param}` path segments — those already ride in the path via
     * {@link getPath}, and sending them twice is how `?slug=` ends up alongside
     * `/blog/hello`. Otherwise identical to the free {@link toSearchParams}
     * (which has no view of the route and so keeps every key).
     */
    toSearchParams: {
      (input: Record<string, SearchParamValue>): SearchParams;
      (input: Record<string, unknown>): SearchParams;
    };
  };

/**
 * Encode a saved sample, dropping a half that holds nothing.
 *
 * A live round trip shows the engine stores an ABSENT half rather than a null
 * one, so writing `output: null` reads back as missing and fails the round
 * trip. Null and absent are one state here.
 */
function encodeExample(example: QueryExample | undefined): QueryExample {
  const out: QueryExample = {};
  if (example?.input !== undefined && example.input !== null) out.input = example.input;
  if (example?.output !== undefined && example.output !== null) out.output = example.output;
  return out;
}

/** A query's saved request/response sample — free-form JSON on both sides. */
export interface QueryExample {
  input?: unknown;
  output?: unknown;
}

export interface QueryXdo {
  name: string;
  description: string;
  docs: string;
  api_enabled: boolean;
  /** `false` (no auth), the auth table's guid, or a raw numeric `dbo.id`. */
  auth: false | number | string;
  response_type: string;
  verb: HttpVerb;
  disabled: boolean;
  /** The api group binding: a numeric local id, or the group's guid (the portable form). */
  app: { id: number | string };
  cache: CacheXdo;
  output: unknown[];
  middleware: MiddlewareBlock;
  tag: unknown[];
  history: { inherit: boolean; enabled: boolean; limit: number };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: TestXdo[];
  example: QueryExample;
  market_item: { id: number; version: number; guid: string };
}

/**
 * The engine's `cache` block, with an author's overrides applied.
 *
 * Exported because a FUNCTION carries the same block and the engine reads it the
 * same way (straight into its runtime config) — two copies of a nine-key
 * default would drift silently.
 */
export function defaultCache(override?: Partial<CacheXdo>): CacheXdo {
  // Any cache OBJECT means caching is wanted — `{ ttl: 30 }` stored `active:
  // false` and cached nothing, and `{}` did the same while every other spelling
  // turned it on. An authored `active` is spread over this below.
  return {
    active: override !== undefined,
    ttl: 3600,
    input: true,
    auth: true,
    datasource: true,
    ip: false,
    headers: [],
    env: [],
    ...override,
  };
}

/**
 * Resolve a query's `auth` to what the engine stores: `false` (no auth), a raw
 * numeric `dbo.id` (escape hatch), or the auth table's guid. Shared with toolset
 * tools via {@link resolveAuthRef} — a `TableDef` handle or bare table name
 * flows through `resolveRef("dbo", …)` (the same guid path `apiGroup` uses), so
 * the reference stays stable across syncs and any number of auth tables coexist.
 *
 * This runs per-def with no registry visibility, so it validates only what a
 * single def can prove (a `TableDef` handle's own `auth` flag; a plausible id).
 * A *bare-name* reference can't be checked here — `Xano.export()` cross-checks
 * the resolved guid against the registered auth tables.
 */
function resolveAuth(name: string, auth: QueryDef["auth"]): false | number | string {
  return resolveAuthRef("query", name, auth);
}

/**
 * Validate the endpoint path against the input map and return the `{param}`
 * names it declares. Shared by `query()` (authoring time — the error fires on
 * the line the author wrote) and `encodeQuery` (the backstop).
 *
 * Two rules with two different sources: the stored charset is the ENGINE's (a
 * name outside it is silently saved as NULL — see `assertStoredName`), while
 * the `{param}`↔input contract is Xano SDK's own opinion.
 */
function assertQueryPathParams(
  def: Pick<QueryDef<Record<string, InputDescriptor>, unknown>, "name" | "input">,
): string[] {
  const context = `query "${def.name}"`;
  assertStoredName(context, def.name, "route");
  const params = parsePathParams(context, def.name);
  assertPathParamInputs(context, params, def.input);
  return params;
}

/**
 * Refuse a `verb` or `responseType` outside the set the engine stores.
 * Both are string unions on `QueryDef`, and a union is
 * compile-time only — see `assertOneOf` for why that is not a check.
 *
 * Verified live on an ephemeral (see `examples/sandbox/_probe-closed-set.ts`):
 * `verb: "post"` and `verb: "TRACE"` both persisted as `verb: null`, and
 * `responseType: "streaming"` persisted as `response_type: null`, each after a
 * deploy that reported nothing wrong. The correctly-spelled controls (`GET`,
 * `stream`) round-tripped intact, so it is the value and not the write.
 */
function assertQueryClosedSets(
  def: Pick<QueryDef<Record<string, InputDescriptor>, unknown>, "name" | "verb" | "responseType">,
): void {
  const context = `query "${def.name}"`;
  assertOneOf(
    context,
    "verb",
    def.verb,
    HTTP_VERBS,
    "The engine does not reject an unrecognized verb — it stores NULL, and a null verb serves " +
      "as GET. So the endpoint deploys clean, answers on the wrong method, and the method you " +
      'meant 404s "Unable to locate request.", which reads as a routing or api-group problem.',
  );
  assertOneOf(
    context,
    "responseType",
    def.responseType,
    QUERY_RESPONSE_TYPES,
    "The engine does not reject an unrecognized response_type — it stores NULL, which falls " +
      "back to \"standard\". So a misspelled stream deploys clean and then quietly buffers the " +
      "whole response instead of streaming it.",
  );
}

export function encodeQuery(def: QueryDef<Record<string, InputDescriptor>, unknown>): QueryXdo {
  if (!def.name) throw new Error("query: `name` is required.");
  if (!def.verb) throw new Error("query: `verb` is required.");
  // Re-check the path↔input contract and the closed-set fields here, not just in
  // `query()`: `QueryDef` is public and the kind registry encodes plain objects,
  // so a hand-built def must not be able to route around the guards.
  assertQueryPathParams(def);
  assertQueryClosedSets(def);
  warnUnboundReturn("query", def.name, def.stack, def.response);
  const xdo: QueryXdo = {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    api_enabled: def.apiEnabled ?? true,
    auth: resolveAuth(def.name, def.auth),
    response_type: def.responseType ?? "standard",
    verb: def.verb,
    disabled: def.disabled ?? false,
    // The engine binds a query to its api group by the group's guid (export
    // maps id→guid, import remaps guid→local id). Deriving that guid from the
    // group's name is stateless and stable across syncs. A numeric `apiGroupId`
    // is an explicit escape hatch and wins when given.
    app: {
      id:
        def.apiGroupId ??
        (def.apiGroup !== undefined ? resolveRef("app", def.apiGroup) : 0),
    },
    cache: defaultCache(def.cache),
    output: [],
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("query", def.history),
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: encodeStack("query", def.name, def.stack),
    test: encodeTests(def.tests, "query", def.name),
    example: encodeExample(def.example),
    market_item: { id: 0, version: 0, guid: "" },
  };
  // Mocks are authored keyed by TEST NAME and stored keyed by test id.
  // The rewrite needs both the stack and the test list, so it happens here
  // rather than inside any statement factory.
  resolveMockKeys(xdo.run, xdo.test, "query", def.name);
  return xdo;
}

/**
 * The guid a query def resolves to — composed from its group, verb, and name
 * (see `querySeedName`: the engine's uniqueness for a query is all three, so a
 * `GET`/`POST` pair on one path, and one path repeated across groups, are
 * distinct objects).
 */
export function queryGuid(
  def: Pick<QueryDef, "name" | "verb" | "guid" | "apiGroup" | "apiGroupId">,
): string {
  if (def.guid) return def.guid;
  return deriveQueryGuid(queryGroupComponent(def), def.verb, def.name);
}

export const queryKind: ObjectKind<QueryDef, QueryXdo> = {
  name: "query",
  payloadKey: "query",
  encode: encodeQuery,
  guidOf: (def) => queryGuid(def),
};
registerKind(queryKind);

/**
 * Resolve the api group's `canonical` URL token for `getPath`, in priority
 * order:
 *   1. an explicit `getPath({ canonical })` override;
 *   2. the bound `apiGroup` handle's non-empty in-code `canonical`;
 *   3. the canonical minted-and-frozen in `xano.lock` for this group, read via
 *      the seeded override store (populated by `seedLockOverrides`, which the
 *      CLI and build scripts run before importing defs).
 *
 * We deliberately do NOT mint a fresh canonical here. A canonical is unique per
 * Xano *instance across all workspaces*; the only safe place to generate one is
 * an ordinary `xanosdk export` (random, collision-checked, then frozen so every later export
 * and every client agrees). Minting at `getPath()` time would hand a frontend a
 * token that doesn't match the deployed endpoint. So when nothing is resolvable
 * we throw with the fix rather than fabricate.
 */
function resolveCanonical(
  def: QueryDef<Record<string, InputDescriptor>, unknown>,
  override?: string,
): string {
  if (override) return override;
  const group = def.apiGroup;
  if (group && typeof group === "object" && typeof group.canonical === "string" && group.canonical !== "") {
    return group.canonical;
  }
  // Fall back to the canonical minted into xano.lock for this group. The group
  // binding is a handle (`{ name }`) or a bare name string; either yields the
  // lock key `app:<name>`.
  const groupName = typeof group === "string" ? group : group?.name;
  if (groupName) {
    const locked = getLockedCanonical(lockKey("app", groupName));
    if (locked) return locked;
  }
  throw new Error(
    `query "${def.name}": getPath() cannot resolve the api group's canonical URL token. ` +
      `Set an explicit \`apiGroup({ canonical })\`, or run \`xanosdk export <entry>\` once (it ` +
      `mints a unique canonical and freezes it in xano.lock) and seed that lock before ` +
      `importing defs — the CLI does this automatically, and build scripts call ` +
      `seedLockOverrides(readLockFile(path)) first. As a last resort pass one directly: ` +
      `getPath({ canonical: "..." }). (Minting here is unsafe — canonicals must be unique ` +
      `per instance across all workspaces, so they are only generated at locked export.)`,
  );
}

/**
 * Author an API query. Returns a {@link QueryHandle} — the def plus a
 * `getPath()` method — and preserves the exact, branded `input` map on the
 * return type so `InferInput<typeof theQuery>` recovers the request-payload type.
 */
/**
 * The `/api:<canonical>/<name>` path's trailing `<name>` segment: the query name
 * with any leading slash stripped. Shared so a consumer reconstructing the path
 * from an exported bundle (`xanosdk routes`) stays in lockstep with `getPath()`.
 */
export function pathSegment(name: string): string {
  return name.replace(/^\/+/, "");
}

function queryImpl<
  const I extends Record<string, InputDescriptor> = Record<never, never>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  // Default `readonly []` (not `readonly Statement[]`): an OMITTED stack is an
  // empty tuple, which `InferResponse` reads as "nothing to trace" — while an
  // explicitly widened `Statement[]` stack keeps its widened type and is
  // reported as the tuple-collapse it is.
  const S extends readonly Statement[] = readonly [],
  const N extends string = string,
  // Kept literal so `typeof q["verb"]` is `"POST"`, not the whole union: a
  // compile-time check that a def agrees with its route can then catch a verb
  // swap, not only a path change.
  const V extends HttpVerb = HttpVerb,
  // The auth table, kept on the handle so `auth("id")` in the response types
  // from its row. Type-only: nothing reads it at runtime.
  A = unknown,
>(def: QueryDef<I, Res, Resp, S, N, V> & { auth?: A }): QueryHandle<I, Res, Resp, S, N, V> & { auth?: A } {
  // The route is read off the name here, before register sees the def: a non-string
  // name crashed the path parser with a TypeError. The client bundle carries this
  // factory, so only this one field is checked here — register checks the rest.
  if (typeof def.name !== "string") {
    throw new Error(`query: \`name\` must be the route path as a string — got ${describeEntry(def.name)}.`);
  }
  // Fail on the line the author wrote, before export and before deploy: a
  // {param} with no matching required scalar input is a broken route.
  const params = assertQueryPathParams(def as QueryDef<Record<string, InputDescriptor>, unknown>);
  assertQueryClosedSets(def as QueryDef<Record<string, InputDescriptor>, unknown>);
  const context = `query "${def.name}"`;
  // The path segment is invariant across calls; only the canonical and the
  // param values can vary, so normalize the name once here.
  const path = pathSegment(def.name);
  const getPath = (opts?: { canonical?: string; params?: Record<string, string | number> }): string =>
    `/api:${resolveCanonical(def, opts?.canonical)}/${
      params.length ? fillPathParams(context, "getPath()", path, opts?.params, true) : path
    }`;
  const search = (values: Record<string, unknown>): SearchParams =>
    toSearchParams(
      // A non-record goes through whole, so it is refused as the free function refuses it.
      params.length && isPlainRecord(values)
        ? Object.fromEntries(Object.entries(values).filter(([key]) => !params.includes(key)))
        : values,
    );
  // Not kind-branded (see `def-brand.ts`): this ships in every browser bundle
  // that imports a query, and `verb` already says it is one.
  return { ...def, getPath, toSearchParams: search } as QueryHandle<I, Res, Resp, S, N, V> & { auth?: A };
}

/** A `{ name: value }` record: a plain object, not a list, `Map`, `Date` or other instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A scalar a query-string param carries as text. */
type SearchParamScalar = string | number | boolean;

/**
 * A value acceptable in a query-string param — the shape an `InferInput` map
 * yields: scalars, lists, and plain objects, nested to any depth.
 * `null`/`undefined` are dropped so an absent optional input contributes no param.
 */
export type SearchParamValue =
  | SearchParamScalar
  | null
  | undefined
  | ReadonlyArray<SearchParamValue>
  | { readonly [key: string]: SearchParamValue };

/**
 * Serialize a query input map into {@link URLSearchParams} for a GET request —
 * `query.toSearchParams(input)`. GET endpoints carry their inputs in the query
 * string, not a JSON body; this is the transport counterpart to
 * `InferInput<typeof q>`, so a generic `fetch` wrapper doesn't have to hand-roll
 * the encoding.
 *
 * The encoding is the bracket form Xano parses a query string into:
 * - scalars stringify (`true`→`"true"`, `1`→`"1"`; `0`/`false` are kept);
 * - a list of scalars sends `tags[]=a&tags[]=b`. A REPEATED plain key
 *   (`tags=a&tags=b`) is not a list to the endpoint: it keeps only the last value;
 * - an object sends `obj[k]=v`, a list of objects indexes each item
 *   (`items[0][k]=v`), to any depth;
 * - a list holding a list has no bracket form the endpoint reads, so it is sent
 *   as one JSON value (`lol=[[1,2],[3]]`), which binds exactly;
 * - `null`/`undefined` (top level or object member) are omitted, and so is an
 *   empty list or object — the endpoint then sees the input's default (`[]` for
 *   a list), the same as leaving it out. Inside a list, an item that would send
 *   nothing (`null`, `{}`) throws: dropping it would shift every later index.
 *
 * Fails loud rather than emitting a garbage param: a non-finite number
 * (`NaN`/`Infinity`), a bigint, a non-plain object (a `Date`, `Map`, class
 * instance), a cycle, or an object key containing `[`/`]` or empty throws a
 * {@link TypeError} instead of serializing to `"NaN"` / `"[object Object]"` or
 * a key the parser would split.
 *
 * Two call shapes, one runtime. Authored literals get {@link SearchParamValue}
 * autocomplete from the strict overload, but the wide `Record<string, unknown>`
 * overload accepts everything the strict one rejects — so a bad literal
 * type-checks here and is caught only at runtime, not at compile time. That is
 * deliberate: a generic transport that holds its endpoint input opaquely
 * (`Record<string, unknown>`, or an `InferInput<Q>` map behind a generic type
 * param) passes it with no `as` cast, and the runtime guard in the body below
 * is the real check, whichever overload it came in on.
 *
 * @example
 * const q = query({ name: "get_snippet", verb: "GET", apiGroup: g, input: { id: input.int() } });
 * const url = `${BASE}${q.getPath()}?${query.toSearchParams({ id: 7 })}`;
 * @example
 * String(query.toSearchParams({ tags: ["a", "b"], range: { min: 1 } }));
 * // → "tags%5B%5D=a&tags%5B%5D=b&range%5Bmin%5D=1"  (tags[]=a&tags[]=b&range[min]=1)
 * @example
 * // generic GET transport — the input map is `Record<string, unknown>`, no cast
 * url += `?${query.toSearchParams(opts.input)}`;
 */
export function toSearchParams(input: Record<string, SearchParamValue>): SearchParams;
export function toSearchParams(input: Record<string, unknown>): SearchParams;
export function toSearchParams(input: Record<string, unknown>): SearchParams {
  // The whole argument first: `null` read as "no params" would hide a transport
  // that lost its input, and a string or list was split into index keys.
  if (!isPlainRecord(input)) {
    throw new Error(
      `toSearchParams() takes the query input as a { name: value } record — got ${describeEntry(input)}.`,
    );
  }
  let params = new URLSearchParams();
  // The containers on the path to the value being encoded: a value that holds
  // one of them is a cycle. A container shared by two siblings is not.
  const ancestors: unknown[] = [];
  const fail = (path: string, why: string): never => {
    throw new TypeError(`toSearchParams: param "${path}" ${why}`);
  };
  const isScalar = (v: unknown): boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  // `path` is "" for the input record itself; returns whether anything was sent.
  const encode = (path: string, value: unknown): boolean => {
    if (value == null) return false;
    if (isScalar(value)) {
      if (typeof value === "number" && !Number.isFinite(value)) fail(path, `is ${value} — not a finite value`);
      params.append(path, String(value));
      return true;
    }
    const proto = typeof value === "object" ? Object.getPrototypeOf(value) : 0;
    if (path && !Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      fail(path, `is not a scalar, list or plain object (got ${describeEntry(value)})`);
    }
    if (ancestors.includes(value)) fail(path, "contains itself — a cycle has no query-string encoding");
    ancestors.push(value);
    let sent = false;
    if (Array.isArray(value) && value.some(Array.isArray)) {
      // Checked item by item as the bracket form would be, then sent as JSON.
      const outer = params;
      params = new URLSearchParams();
      value.forEach((item, index) => encode(`${path}[${index}]`, item));
      params = outer;
      params.append(path, JSON.stringify(value));
      sent = true;
    } else if (Array.isArray(value)) {
      // Scalars go as `k[]`; otherwise each item takes the next index.
      const plain = value.every(isScalar);
      value.forEach((item, index) => {
        if (!encode(`${path}[${plain ? "" : index}]`, item)) {
          fail(`${path}[${index}]`, `is ${item == null ? item : "empty"}: a list item that sends nothing would move every later one up. Remove it, or give it a value`);
        }
        sent = true;
      });
    } else {
      for (const [key, member] of Object.entries(value)) {
        if (key === "" || /[[\]]/.test(key)) fail(path ? `${path}[${key}]` : key, "is empty or holds `[`/`]` — a query string cannot carry that name");
        if (encode(path ? `${path}[${key}]` : key, member)) sent = true;
      }
    }
    ancestors.pop();
    return sent;
  };
  encode("", input);
  return params;
}

/**
 * Author an API query. Callable as `query({…})`; also carries
 * {@link toSearchParams} as `query.toSearchParams(input)` for GET transport.
 */
export const query = Object.assign(queryImpl, { toSearchParams });
