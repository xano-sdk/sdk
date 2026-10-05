/**
 * Node-only transport for RUNNING the tests a workspace already carries: the
 * two list routes and the two run routes, for both test families.
 *
 * Addresses an environment through a `{base, workspaceId}` pair (see
 * `emit/env-target.ts`), so the same four calls serve the caller's real
 * workspace and an ephemeral without knowing which it is.
 *
 * ## `status === "ok"` is the only pass
 *
 * Pass is `"ok"`; everything else failed. This is not caution about an unknown
 * vocabulary — the two families measurably DISAGREE on what a failure is called:
 *
 * | | pass | failure |
 * |---|---|---|
 * | `unit_test/{id}/run`     | `"ok"` | `"fail"` |
 * | `workflow_test/{id}/run` | `"ok"` | `"exception"` |
 *
 * Measured against a live engine (see `examples/sandbox/_probe-tests.ts`), with
 * both an assertion mismatch and an unexpected throw exercised per family. Any
 * check written as `status === "fail"` would therefore report every workflow
 * failure as a pass. Treating the set as open costs nothing and is the only form
 * that survives a third status appearing.
 *
 * ## A run's `timing` is optional
 *
 * Measured: `workflow_test` runs carry it (including a legitimate `0`, which is
 * why the read is a `typeof` check and not a truthiness one), and `unit_test`
 * runs never do. Still read defensively — treating it as required and formatting
 * it unguarded throws into the per-test catch, which records a SECOND outcome
 * for the same test, inflating the counts and flipping the exit code on a suite
 * where nothing actually failed.
 *
 * ## The failure MESSAGE lives in a different place per family
 *
 * A failing `unit_test` run carries it per-assertion in `results[]`
 * (`{status: "fail", message}`) and sends no top-level `message`. A failing
 * `workflow_test` run carries it as a top-level `message` and sends no
 * `results[]`. Both are read, in that order.
 *
 * ## A failed run is a result; a failed list is an error
 *
 * A non-2xx running ONE test is that test's failure and the walk continues — a
 * suite that stops at the first flaky call reports less than it knows. A non-2xx
 * LISTING tests is fatal: the totals would otherwise describe a subset while
 * claiming to describe the suite.
 *
 * Routes are APPENDED to `base`, never resolved against it — a tenant served
 * under a `/tenant/<name>` prefix would otherwise be addressed as its parent
 * instance. See the `env-target.ts` header.
 */
import type { BearerTarget } from "../auth/token.js";
import { appendSentence, fetchOrExplain, httpFailure, serverMessage, statusLabel, transportTarget } from "../util/http.js";
import { hasString, isRecord, listAnswer, recordAnswer, writeTransportFailure, type Row } from "./answer-shape.js";

/** The engine's own sentence in a JSON error body, or undefined (a page, text, or JSON without one). */
function labelledMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.message !== "string" || parsed.message.trim() === "") return undefined;
  return serverMessage(text);
}

/** Engine error codes that name a condition no retry changes. */
const PERMANENT_CODES = new Set([
  "ERROR_CODE_NOT_FOUND",
  "ERROR_CODE_ACCESS_DENIED",
  "ERROR_CODE_UNAUTHORIZED",
  "ERROR_CODE_BAD_REQUEST",
  "ERROR_CODE_INPUT_ERROR",
  "ERROR_CODE_PERMISSION_DENIED",
]);

/**
 * Whether an engine's JSON answer names a permanent condition — by its `code`,
 * or a message that says the thing is invalid, missing or not the caller's
 * ("Invalid workspace.", "Not found", "Access denied"). Anything else from a
 * 5xx (an engine fault, an unlabelled error) may pass on a retry.
 */
function permanentEngineError(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (typeof parsed.code === "string" && PERMANENT_CODES.has(parsed.code)) return true;
  const message = typeof parsed.message === "string" ? parsed.message : "";
  return /^\s*invalid\b|\bnot found\b|\baccess denied\b|\bpermission denied\b|\bunauthori[sz]ed\b/i.test(message);
}

/** Bound each call so a stalled endpoint cannot hang the CLI/CI. */
const TIMEOUT_MS = 120_000;

/** Page size for the list walk — plenty for a real suite, small enough not to build a huge response. */
const PAGE_SIZE = 100;

/** Runaway backstop for the list walk. Not a limit anyone is expected to reach. */
const MAX_PAGES = 100;

/** Which family a test belongs to. */
export type TestKind = "unit" | "workflow";

/** Where to send calls for one environment. Structurally the `MetaTarget` the emit layer resolves. */
export interface TestTarget {
  /** Origin, possibly with a path prefix. Routes are APPENDED to it. */
  base: string;
  workspaceId: number;
}

/** One runnable test, as listing found it. */
export interface TestHandle {
  kind: TestKind;
  /** Unit tests are addressed by a string id, workflow tests by a numeric one. */
  id: string | number;
  name: string;
  /**
   * The object a unit test hangs off. Workflow tests are standalone and carry none.
   *
   * A query's name is not unique — `GET notes` and `POST notes` are two queries,
   * and so is `notes` in two API groups — so a query also carries its `group`
   * and `verb`, which is what {@link qualifiedName} needs to name one test. The
   * test list does not send them; {@link listTests} reads them off the API groups.
   */
  object?: { type: string; name: string; group?: string; verb?: string };
  /**
   * The datasource the test runs against; `""` means the empty (recommended)
   * one, and any other value names one the engine CLONES before the run.
   *
   * Measured: the `workflow_test` list sends it, the `unit_test` list does NOT
   * send it at all. So absent means "the list did not say", never "empty
   * datasource" — a caller surfacing the clone hazard can only ever do so for
   * workflow tests, and must not present silence as safety.
   */
  datasource?: string;
}

/** One expectation of a unit test, as the run reported it. */
export interface TestExpectation {
  /** Position in the test's `expect` list, counted from 0. */
  index: number;
  status: "pass" | "fail";
  /** Why it failed. Absent on a pass. */
  message?: string;
}

/** What running one test produced. */
export interface TestOutcome extends TestHandle {
  status: "pass" | "fail";
  /** The first failing assertion's message, or the run's own error sentence. */
  message?: string;
  /**
   * Every expectation of a unit test, in order — all the failures, not only the
   * one `message` names. Absent when the run reported none: a workflow test, or
   * a run the engine refused.
   */
  expectations?: TestExpectation[];
  /** Seconds, when the engine reported them. Absent is normal, not a failure. */
  timing?: number;
}

/**
 * A test's fully-qualified name — what disambiguates two tests sharing a short
 * name, and the form `xanosdk test run` takes.
 *
 * A query is named as its lock key names it, `query:<group>|<verb>|<name>`, so
 * `GET notes` and `POST notes` each carrying a test `dup` qualify to two
 * different strings. Everything else is `<type>:<name>/<test>`; a workflow test
 * is standalone and is `workflow:<test>`, so one sharing a unit test's name
 * still has a form that selects it alone.
 */
export function qualifiedName(handle: TestHandle): string {
  if (handle.kind === "workflow") return `workflow:${handle.name}`;
  const object = handle.object;
  if (object === undefined) return handle.name;
  const owner =
    object.type === "query" && object.group !== undefined && object.verb !== undefined
      ? `${object.group}|${object.verb}|${object.name}`
      : object.name;
  return `${object.type}:${owner}/${handle.name}`;
}

/** `<type>:<name>/<test>` without a query's group and verb — selects one test only when the query's name is unique. */
export function objectQualifiedName(handle: TestHandle): string | undefined {
  return handle.object === undefined ? undefined : `${handle.object.type}:${handle.object.name}/${handle.name}`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Every call goes through here: bearer, timeout, and the shared transport-failure
 * wording.
 *
 * A {@link BearerTarget} rather than a full credential, all the way down this
 * module: the routes are addressed from the {@link TestTarget}, so the bearer is
 * genuinely all that is read — and `deploy --test` against a Xano Engine has
 * only the engine's own token to offer.
 */
async function metaFetch(
  auth: BearerTarget,
  url: string,
  action: string,
  init?: RequestInit,
): Promise<Response> {
  return fetchOrExplain(
    url,
    {
      ...init,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${auth.access_token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    action,
    TIMEOUT_MS,
  ).catch((err: unknown) => {
    // A run is a POST: one that got no answer may have been received, said as
    // every other write says it — unless the connection was refused before
    // anything was sent. A list is a read and already says "Nothing was changed".
    throw (init?.method ?? "GET").toUpperCase() !== "GET" ? writeTransportFailure(err) : err;
  });
}

/** One page of a list endpoint: its rows, and whether the server says there is another. */
interface Page {
  rows: Record<string, unknown>[];
  nextPage: number | undefined;
}

/**
 * Read one list page, tolerating both a bare array and an `{items, nextPage}`
 * envelope — the same two shapes the ephemeral list already accepts — with
 * EVERY row one `isRow` recognises.
 *
 * NOT an empty list, and not a shorter one. A 2xx whose body is neither shape,
 * or whose rows are not tests, is refused the shared way: returning zero rows
 * would end the walk and report "no tests" — a green run for a suite nobody
 * read — and dropping the rows that did not look like tests reported a subset
 * as the suite.
 */
function readPage(text: string, action: string, url: string, isRow: (row: Row) => boolean): Page {
  const { rows, envelope } = listAnswer(text, action, url, isRow);
  // Measured: a final page sends `nextPage: null`, not an absent key. The
  // `typeof` check reads that as "no next page" — a truthiness check would
  // too, but would also swallow a legitimate page 0.
  return { rows, nextPage: typeof envelope?.nextPage === "number" ? envelope.nextPage : undefined };
}

/**
 * Walk a list endpoint to the end.
 *
 * Termination is the server's own `nextPage`, never "the page came back full" —
 * a full final page is not a promise of another one. An empty page also stops
 * the walk, which covers an endpoint that omits `nextPage` entirely rather than
 * looping forever. `onTruncate` fires when the backstop trips, so a caller can
 * say a subset was collected instead of presenting it as the whole suite.
 */
async function collectPages(
  auth: BearerTarget,
  buildUrl: (page: number) => string,
  action: string,
  isRow: (row: Row) => boolean,
  onTruncate?: (collected: number) => void,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildUrl(page);
    const res = await metaFetch(auth, url, action, { method: "GET" });
    const text = await res.text();
    if (!res.ok) {
      // The rule for a LISTING: a 5xx is "the suite could not be listed" —
      // unreachable, exit 6 with the retry — whether its body is a gateway's
      // page or the engine's own JSON message. A listing is a read with no test
      // of its own to fail, so a server fault there is named and retried, not a
      // verdict (E2E pass 25: a 502 page exited 1 where ECONNRESET exited 6;
      // pass 26: a 500 with a JSON message still exited 1, with no remedy). The
      // one 5xx kept as a plain failure (exit 1) is an engine answer that names
      // a PERMANENT condition — the workspace or route is not there, the caller
      // may not read it — which no retry changes. A 4xx is always that. `runTest`
      // differs on purpose: there a labelled answer IS that test's result.
      // A 429 is the rate limit turning the listing away: no answer yet, as a 5xx.
      const message = httpFailure(action, res, text);
      const unanswered = (res.status >= 500 && !permanentEngineError(text)) || res.status === 429;
      throw unanswered ? new TestRunUnansweredError(message, res.status) : new Error(message);
    }
    const { rows: pageRows, nextPage } = readPage(text, action, url, isRow);
    rows.push(...pageRows);
    if (pageRows.length === 0 || nextPage === undefined) return rows;
  }
  onTruncate?.(rows.length);
  return rows;
}

/** List the saved unit tests in an environment. */
async function listUnitTests(
  auth: BearerTarget,
  target: TestTarget,
  onTruncate?: (collected: number) => void,
): Promise<TestHandle[]> {
  const rows = await collectPages(
    auth,
    (page) =>
      `${target.base}/api:meta/workspace/${target.workspaceId}/unit_test` +
      `?page=${page}&per_page=${PAGE_SIZE}`,
    "list unit tests",
    // A unit test is addressed by its string id and shown by its name.
    (row) => hasString(row, "id") && hasString(row, "name"),
    onTruncate,
  );
  // The row names a query by its bare name and id only. Its group and verb —
  // what tells `GET notes` from `POST notes` — are read off the API groups, and
  // only when a query carries a test at all.
  const queryIds = new Set(
    rows.flatMap((row) => (row.obj_type === "query" && typeof row.obj_id === "number" ? [row.obj_id] : [])),
  );
  const located = queryIds.size === 0 ? new Map<number, QueryPlace>() : await locateQueries(auth, target, queryIds);
  return rows.flatMap((row) => {
    const id = asString(row.id);
    const name = asString(row.name);
    if (id === undefined || name === undefined) return [];
    const objectType = asString(row.obj_type);
    const objectName = asString(row.obj_name);
    const place = objectType === "query" && typeof row.obj_id === "number" ? located.get(row.obj_id) : undefined;
    return [
      {
        kind: "unit" as const,
        id,
        name,
        object:
          objectType !== undefined && objectName !== undefined
            ? { type: objectType, name: objectName, ...(place ?? {}) }
            : undefined,
        datasource: typeof row.datasource === "string" ? row.datasource : undefined,
      },
    ];
  });
}

/** Where a query lives: its API group's name and its verb. */
interface QueryPlace {
  group: string;
  verb: string;
}

/**
 * The group and verb of each query in `ids`, read off the API group list and
 * each group's query list. Stops walking groups once every id is placed.
 *
 * A failed list is fatal here as everywhere in this module: a test named
 * without its group and verb is the ambiguity this lookup exists to remove.
 */
async function locateQueries(
  auth: BearerTarget,
  target: TestTarget,
  ids: ReadonlySet<number>,
): Promise<Map<number, QueryPlace>> {
  const root = `${target.base}/api:meta/workspace/${target.workspaceId}/apigroup`;
  const groups = await collectPages(
    auth,
    (page) => `${root}?page=${page}&per_page=${PAGE_SIZE}`,
    "list API groups",
    (row) => typeof row.id === "number" && hasString(row, "name"),
  );
  const placed = new Map<number, QueryPlace>();
  for (const group of groups) {
    if (placed.size === ids.size) break;
    const groupName = group.name as string;
    const queries = await collectPages(
      auth,
      (page) => `${root}/${group.id as number}/api?page=${page}&per_page=${PAGE_SIZE}`,
      `list the queries in API group "${groupName}"`,
      (row) => typeof row.id === "number" && hasString(row, "verb"),
    );
    for (const query of queries) {
      const id = query.id as number;
      if (ids.has(id)) placed.set(id, { group: groupName, verb: query.verb as string });
    }
  }
  return placed;
}

/** List the workflow tests in an environment. */
async function listWorkflowTests(
  auth: BearerTarget,
  target: TestTarget,
  onTruncate?: (collected: number) => void,
): Promise<TestHandle[]> {
  const rows = await collectPages(
    auth,
    (page) =>
      `${target.base}/api:meta/workspace/${target.workspaceId}/workflow_test` +
      // Names are all we need; pulling every test's source to learn one would be
      // a much larger response for no gain.
      `?page=${page}&per_page=${PAGE_SIZE}&include_xanoscript=false`,
    "list workflow tests",
    // A workflow test is addressed by its numeric id and shown by its name.
    (row) => typeof row.id === "number" && hasString(row, "name"),
    onTruncate,
  );
  return rows.flatMap((row) => {
    const name = asString(row.name);
    if (typeof row.id !== "number" || name === undefined) return [];
    return [
      {
        kind: "workflow" as const,
        id: row.id,
        name,
        datasource: typeof row.datasource === "string" ? row.datasource : undefined,
      },
    ];
  });
}

/**
 * Every test in an environment, both families, in listing order (unit first).
 *
 * `kind` narrows to one family and skips the other request entirely — asking for
 * workflow tests and paging the unit-test list anyway is pure cost.
 */
export async function listTests(
  auth: BearerTarget,
  target: TestTarget,
  opts: { kind?: TestKind; onTruncate?: (collected: number) => void } = {},
): Promise<TestHandle[]> {
  const out: TestHandle[] = [];
  if (opts.kind !== "workflow") out.push(...(await listUnitTests(auth, target, opts.onTruncate)));
  if (opts.kind !== "unit") out.push(...(await listWorkflowTests(auth, target, opts.onTruncate)));
  return out;
}

/** The run response, as much of it as we read. Every field is optional but `status`. */
interface RunResponse {
  status?: unknown;
  message?: unknown;
  timing?: unknown;
  results?: unknown;
}

/**
 * A unit-test run's `results`, one row per expectation; `undefined` when none
 * can be read. A row that is not a pass or a fail is skipped, but keeps its
 * neighbours' indexes: `index` is the expectation's place in the test, not in
 * this list.
 */
function readExpectations(results: unknown): TestExpectation[] | undefined {
  if (!Array.isArray(results)) return undefined;
  const expectations = results.flatMap((entry, index): TestExpectation[] => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as { status?: unknown; message?: unknown };
    if (row.status !== "pass" && row.status !== "fail") return [];
    const message = asString(row.message);
    return [{ index, status: row.status, ...(row.status === "fail" && message !== undefined ? { message } : {}) }];
  });
  return expectations.length > 0 ? expectations : undefined;
}

/**
 * A run the environment answered with a bare 5xx — a gateway's page, an
 * unlabelled server error — or a 429 from its rate limit. No result was
 * reported, and nothing says the test disagreed: the suite is unreachable,
 * like a dropped connection.
 */
export class TestRunUnansweredError extends Error {
  override readonly name = "TestRunUnansweredError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Run one test and report what happened.
 *
 * Never throws for a test-level failure: a non-2xx, an unparseable body, or a
 * non-ok status all come back as a failing {@link TestOutcome} so the walk over
 * a suite continues. A transport failure (the host never answered) does throw —
 * that is the environment being unreachable, not this test disagreeing.
 */
export async function runTest(
  auth: BearerTarget,
  target: TestTarget,
  handle: TestHandle,
): Promise<TestOutcome> {
  const route = handle.kind === "unit" ? "unit_test" : "workflow_test";
  const url = `${target.base}/api:meta/workspace/${target.workspaceId}/${route}/${handle.id}/run`;
  const action = `run ${handle.kind} test "${handle.name}"`;

  const res = await metaFetch(auth, url, action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The unit-test route reads an optional `{branch}`; Xano SDK models no branch
    // concept, so an empty object takes the engine's live-branch default. The
    // workflow route reads no body at all and ignores this.
    body: "{}",
  });

  const text = await res.text();
  if (!res.ok) {
    // A test that ran and disagreed is answered 200 with a non-ok `status`
    // (below) — both run routes report the test's own error that way. A
    // non-2xx is the route itself: the engine refusing to run THIS test (a
    // 4xx carrying a `message`) is that test's failure; a refusal of the
    // CALLER (401, 403), a rate limit, or a failure with nothing to say (a
    // proxy's page) is about reaching the environment, not about the test,
    // and must not be counted as a failing test. Nor is any 5xx, labelled or
    // not: a `{code, message}` 503 is a server error, not a result (E2E pass
    // 30: it counted as FAIL, exit 5).
    if (
      res.status >= 500 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 429 ||
      labelledMessage(text) === undefined
    ) {
      const message = appendSentence(
        httpFailure(action, res, text),
        `Nothing was run to a result — ${transportTarget(url)} did not report one.`,
      );
      // A 5xx is the environment (or a gateway before it) not answering, and a
      // 429 its rate limit turning the run away before it started — the suite
      // is unreachable either way, as a dropped connection is.
      throw res.status >= 500 || res.status === 429 ? new TestRunUnansweredError(message, res.status) : new Error(message);
    }
    return { ...handle, status: "fail", message: `${statusLabel(res)}: ${labelledMessage(text)!}` };
  }

  // A run answer is an object carrying `status`. A page, `null`, an array or a
  // stranger's object is not a result at all — refused the shared way (host
  // only, never the body), never counted as a failing test.
  const body = recordAnswer(text, action, url, (row) => typeof row.status === "string") as RunResponse;

  // The one rule: pass is "ok". Never enumerate the failure statuses.
  const passed = body.status === "ok";
  const expectations = readExpectations(body.results);
  return {
    ...handle,
    status: passed ? "pass" : "fail",
    message: passed
      ? undefined
      : expectations?.find((e) => e.status === "fail" && e.message !== undefined)?.message ??
        asString(body.message) ??
        `status: ${String(body.status)}`,
    ...(expectations !== undefined ? { expectations } : {}),
    // Optional by contract — read defensively, never format unguarded.
    timing: typeof body.timing === "number" ? body.timing : undefined,
  };
}
