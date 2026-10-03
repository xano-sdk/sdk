/**
 * The advisory warnings a decoded tree accepts on its defs, so a freshly pulled
 * project passes its own `--strict` check.
 *
 * THE RULE: a warning is accepted on decode when (1) it is advisory — the
 * shape deploys and works, the warning only says a different shape would be
 * better — and (2) its remedy would change the LIVE contract the pull just
 * read, which is not a decode's call to make:
 *
 *  - `query.path-segment-candidate` — the remedy moves an input into the path
 *    of a route clients already call.
 *  - `stack.env-undeclared` — the variable is set on the instance outside the
 *    workspace's own env list (a dashboard value); declaring it is a change to
 *    the workspace, not to the tree.
 *  - `realtime.server-disabled` — the server is off on the instance.
 *  - `workflow-test.live-datasource` / `test.live-datasource` — the test runs
 *    against live on the instance.
 *  - `api-group.docs-public` — the group's docs are published ungated on the
 *    instance.
 *  - `statement.omitted-input` — the call takes the caller's same-named input
 *    (or an input-less caller's raw request) on the instance; passing a value
 *    instead changes what the call receives.
 *  - `mcp.write-before-elicit` — the write repeats on every elicit round trip
 *    on the instance; moving it changes what the tool does.
 *  - `condition.mixed` — the stored condition mixes AND and OR at one level;
 *    choosing a grouping is choosing a meaning, and the pull's report already
 *    names it (`ambiguous-condition`).
 *  - `response.unbound-return` — a top-level `s.return` answers with no
 *    declared `response`; the value comes back, and declaring one rewrites the
 *    stored response envelope.
 *  - `value.obj-zero-based-numeric-keys` — the stored object evaluates as a
 *    list on the instance; rewriting it as a list or renaming its keys is
 *    choosing a meaning.
 *
 * A second, narrower class: a stored shape the AUTHORING rules refuse outright
 * but the engine stores, which only a rename or a rewrite of the live contract
 * would clear. The def keeps it so the pull builds, and the allow marks it:
 *
 *  - `api-group.cors-origin-unmatchable` — a stored CORS origin no browser
 *    `Origin` can equal; correcting it changes which callers the group serves.
 *  - `table.column-name-unusable` — a live column whose name deploys but fails
 *    inserts or filters; renaming it moves data.
 *  - `query.route-shadowed` — two live routes one request path can match;
 *    making them disjoint renames a route clients already call. Accepted on
 *    the first query of the pair, which is all the warning asks.
 *
 * Everything else — a shape that silently loses data, reads nothing, or fails
 * at run time — is left to warn: a pull must surface those, not bury them.
 *
 * Emitted only as `diagnostics: { allow }` on the def, which never reaches the
 * bundle, so the round trip is byte-identical.
 */
import { allowableWarnings, DiagnosticBag } from "../workspace/diagnostics.js";
import { CORS_UNMATCHABLE, unmatchableOrigins } from "../kinds/api-group.js";
import { COLUMN_NAME_UNUSABLE, unusableColumns } from "../kinds/table.js";
import {
  checkLiveDatasourceTests,
  checkOmittedCallInputs,
  checkPathSegmentCandidates,
  checkRealtimeSilentShapes,
  checkRouteShadowing,
  checkStacks,
  checkWriteBeforeElicit,
  checkZeroBasedObjects,
} from "../workspace/guards.js";

const ACCEPT_ON_DECODE = new Set([
  "query.path-segment-candidate",
  "stack.env-undeclared",
  "realtime.server-disabled",
  "workflow-test.live-datasource",
  "test.live-datasource",
  "statement.omitted-input",
  "mcp.write-before-elicit",
  "api-group.docs-public",
  "condition.mixed",
  "response.unbound-return",
  "value.obj-zero-based-numeric-keys",
  CORS_UNMATCHABLE,
  COLUMN_NAME_UNUSABLE,
  "query.route-shadowed",
]);

const cache = new WeakMap<object, WeakMap<object, string[]>>();

/** Each stored object's accepted codes, for one bundle payload. */
function acceptedFor(payload: Record<string, unknown>): WeakMap<object, string[]> {
  const hit = cache.get(payload);
  if (hit !== undefined) return hit;
  const accepted = new WeakMap<object, string[]>();
  const add = (subject: object, code: string): void => {
    const codes = accepted.get(subject) ?? [];
    if (!codes.includes(code)) accepted.set(subject, [...codes, code]);
  };
  const sections: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(payload)) if (Array.isArray(value)) sections[key] = value;
  const bag = new DiagnosticBag();
  // Records instead of reporting: every warning is swallowed here, and the
  // ones with a subject and an accept-on-decode code are remembered.
  bag.accepts = (code, subject) => {
    if (subject !== undefined && ACCEPT_ON_DECODE.has(code)) add(subject, code);
    return true;
  };
  const workspace = payload["workspace"];
  // Env is hoisted to the top-level `payload.env`; the decoded config declares it.
  const config = { ...(workspace !== null && typeof workspace === "object" ? workspace : {}), env: payload["env"] ?? [] };
  checkStacks([], sections, bag, config, "authored");
  checkPathSegmentCandidates(sections, bag);
  checkRealtimeSilentShapes(sections, bag);
  checkLiveDatasourceTests(sections, bag);
  checkOmittedCallInputs(sections, bag);
  checkWriteBeforeElicit(sections, bag);
  checkZeroBasedObjects(sections, bag);
  checkRouteShadowing(sections, bag);
  // Raised while a def encodes, not from the bytes: read here the way it reads
  // the def — a top-level `mvp:return` and an empty response.
  for (const key of ["query", "function"]) {
    for (const obj of sections[key] ?? []) {
      const o = obj as { run?: unknown; result?: unknown } | null;
      if (o === null || typeof o !== "object") continue;
      const returns = Array.isArray(o.run) && o.run.some((st) => (st as { name?: unknown } | null)?.name === "mvp:return");
      if (returns && (!Array.isArray(o.result) || o.result.length === 0)) add(o, "response.unbound-return");
    }
  }
  for (const group of sections["app"] ?? []) {
    const g = group as { swagger?: unknown; documentation?: { require_token?: unknown } } | null;
    if (g !== null && g.swagger === true && g.documentation?.require_token !== true) add(g, "api-group.docs-public");
    const cors = (g as { cors?: { mode?: unknown; allowOrigins?: unknown } } | null)?.cors;
    if (g !== null && cors?.mode === "custom" && Array.isArray(cors.allowOrigins) && unmatchableOrigins(cors.allowOrigins).length > 0) {
      add(g, CORS_UNMATCHABLE);
    }
  }
  for (const t of sections["dbo"] ?? []) {
    const stored = t as { schema?: unknown } | null;
    if (stored !== null && typeof stored === "object" && unusableColumns(stored.schema).length > 0) add(stored, COLUMN_NAME_UNUSABLE);
  }
  cache.set(payload, accepted);
  return accepted;
}

/**
 * The codes to write as `diagnostics.allow` on the def decoded from `stored`,
 * limited to those its kind accepts — in a fixed order, so a pull is
 * deterministic.
 */
export function acceptedOnDecode(kindName: string, stored: object, payload: Record<string, unknown>): string[] {
  const offered = allowableWarnings(kindName);
  const codes = [...(acceptedFor(payload).get(stored) ?? [])];
  return offered.filter((code) => codes.includes(code));
}
