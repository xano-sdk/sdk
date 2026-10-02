/**
 * Shared normalizer for persisted-object deep-equal. Used by both the golden
 * fixture corpus (`test/`) and the `xanosdk preflight` round-trip diff:
 * it strips server- and auto-generated keys the engine adds on import (which the
 * SDK never emits) so authored-field parity can be compared directly.
 *
 * This lives in `src/` (not `test/`) because `xanosdk preflight` is shipped code
 * built from `src/` and cannot import from `test/`; `test/helpers/normalize.ts`
 * re-exports from here so the corpus keeps a single source of truth.
 *
 * Beyond the enumerated server keys, this also drops `workspace`, `branch`, and
 * `market_item`: in a real fixture these are large server/deploy-target blobs
 * (e.g. `workspace.editBranch`), and deploy-target binding is out of scope.
 * Removing them from both sides keeps the comparison focused on authored logic.
 */
import { impliedInputs } from "../kinds/trigger-inputs.js";

const STRIP_KEYS = new Set([
  // server columns / persistence
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "guid",
  "_draft",
  // auto-generated xsids / runtime keys
  "_xsid",
  "@guid",
  "@index",
  "stack_id",
  "index",
  // deploy-target / market binding (deferred)
  "workspace",
  "branch",
  "market_item",
  // The CREATOR of a knowledge item (`{id: 0}` for anything an import created).
  // Server-assigned provenance, in the same family as the already-stripped
  // `workspace`/`branch` bindings: the SDK never authors it, and a workspace
  // synced by two different people would otherwise diff on who touched it last.
  // Verified to be a knowledge-only key — no encoder in this SDK emits `user`
  // anywhere in a compiled payload.
  "user",
  // engine-stored source artifact (the raw XanoScript text), not authored data
  "xanoscript",
  // A workflow test's LAST RUN result — when it ran, how long it took, and the
  // pass/fail of each statement. Instance state produced by executing the test,
  // not workspace source, so the SDK neither authors nor emits it. A stored
  // object always carries the key (`null` until the test has been run once), so
  // without this the whole kind reads as a failed round trip.
  "lastRun",
  // storage-mode flag the golden table corpus predates (those fixtures were
  // captured before `use_xdo` was serialized). The SDK always emits it; it
  // doesn't change the authored schema, so drop it from both sides — same as
  // the already-stripped `index`, whose gin entry `use_xdo` only gates.
  "use_xdo",
  // A dead key, dropped for the same reason as `iterator` (see
  // {@link returnWithoutIterator}) and traced the same way.
  //
  // Xano's frontend writes `context: {dbo:{id}, allow_notfound: true}` from ONE
  // place — the auth scaffold generator that builds a signup/login query. No
  // engine class reads it: the `mvp` get-by class consults `dbo`, `output`, and
  // its args and nothing else, and the older non-MVP class reads a differently
  // named `allow_null`. So the member cannot change what a query does.
  //
  // It is deliberately NOT modelled — an authoring surface for a key the engine
  // ignores is the mistake this file already refuses to make elsewhere. But the
  // exclusion was only half-done: the encoder correctly declined to write it
  // while the comparison still demanded it, so a correct decision read as a
  // round-trip failure and sent every scaffolded auth query to `raw()`.
  "allow_notfound",
]);


/**
 * Recursively remove server/auto-generated keys from a parsed JSON value.
 *
 * Also coerces numeric `value` fields to strings: the golden corpus is
 * internally inconsistent about whether a `const:int`/`const:decimal` tagged
 * value serializes its `value` as a number (`10`) or a string (`"10"`) — the
 * same logical value either way. The SDK emits the documented string form
 * (`TaggedValue.value: string`); coercing here makes the comparison ignore that
 * serialization-generation artifact rather than fail on a real-equivalent value.
 */
function isEmptyObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}
/**
 * True for the interchangeable "no customization" forms: `""`, `{}`, and `[]`.
 *
 * `customize` is an associative map of column name → overrides, and an empty
 * associative collection serializes as a JSON **array** — the same artifact
 * already absorbed for `mocks` and an empty `context`. Missing the `[]` spelling
 * here was the single largest cause of `rawField()` in the sweep: 842 of 1,885
 * fields, 45% of a cluster the plan had classified as a field-authoring design
 * question rather than a canonicalization gap.
 */
export function isEmptyCustomize(v: unknown): boolean {
  return v === "" || isEmptyObject(v) || isEmptyArray(v);
}
/**
 * Is this object one entry of a saved `test[]` — `{name, expect[]}`?
 *
 * Shape, never the key name: a table column named `test` and a const value
 * "test" both exist in real workspaces and neither is a saved test.
 */
function isSavedTest(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as { name?: unknown; expect?: unknown };
  return typeof rec.name === "string" && Array.isArray(rec.expect);
}

function isEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}
/**
 * A persisted int equal to `n`, whether serialized as a number or as a numeric
 * string. The engine types these `int` but a readback can carry either form —
 * the same artifact the tagged-`value` coercion below absorbs.
 */
function isNumber(v: unknown, n: number): boolean {
  return v === n || (typeof v === "string" && v !== "" && Number(v) === n);
}

/**
 * Structural deep-equal for comparing an engine-default subtree to a frozen
 * default — and, exported, for comparing two normalized objects.
 *
 * Exported so a caller that has already normalized both sides does not carry its
 * own copy of the same walk; a second implementation is a second set of rules
 * about what "equal" means.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => deepEqual(x[k], y[k]));
}

/**
 * Canonicalize the two interchangeable persisted timestamp serializations to a
 * single instant string. The SDK emits ISO-8601 (`2026-01-01T00:00:00Z`); the
 * engine reads it back in Postgres form (`2026-01-01 00:00:00+0000`). They are
 * the same moment — a serialization-generation artifact (Branch A), like the
 * numeric `value` coercion — so collapse both to `Date.toISOString()`. Returns
 * `undefined` for any string that is not a timestamp (left untouched).
 */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})?$/;
function canonicalizeTimestamp(s: string): string | undefined {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) return undefined;
  let tz = m[3] ?? "Z";
  if (tz === "z") tz = "Z";
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`; // +0000 → +00:00
  const d = new Date(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The engine's default list-query `context.return` envelope. An addon (and any
 * db-query context) that customizes nothing has the engine fill this whole
 * subtree; the SDK omits it. Drop the key on both sides only when it deep-equals
 * this exact default (a customized paging/sort/distinct is preserved).
 */
const DEFAULT_CONTEXT_RETURN = {
  list: {
    sort: [],
    paging: { page: 1, offset: 0, totals: false, enabled: false, metadata: true, per_page: 25 },
    distinct: "auto",
  },
  type: "list",
  single: { sort: [] },
  stream: { sort: [], paging: { page: 1, enabled: false, per_page: 25 }, distinct: "auto" },
  aggregate: {
    eval: [],
    sort: [],
    group: [],
    index: [],
    paging: { page: 1, enabled: false, metadata: true, per_page: 25 },
  },
};
/**
 * The four result-shape sub-blocks of {@link DEFAULT_CONTEXT_RETURN}, by member
 * name. The engine writes every one of them on every query; the SDK writes only
 * the block its `returnType` selects, so each default sibling has to drop on its
 * own once any one of them is customized.
 */
const DEFAULT_RETURN_BLOCKS: Readonly<Record<string, unknown>> = {
  list: DEFAULT_CONTEXT_RETURN.list,
  single: DEFAULT_CONTEXT_RETURN.single,
  stream: DEFAULT_CONTEXT_RETURN.stream,
  aggregate: DEFAULT_CONTEXT_RETURN.aggregate,
};

/**
 * The leanest all-defaults `context.return`: the result type at its declared
 * default with no sub-block customized. A query saved by an engine generation
 * that did not expand the whole subtree persists exactly this, and it carries no
 * more information than {@link DEFAULT_CONTEXT_RETURN} does.
 */
const MINIMAL_CONTEXT_RETURN = { type: "list" };

/**
 * Whether a FIELD's `list` block sets no length bounds at all.
 *
 * The block is `{min, max}` and its unset spelling is not stable: the corpus
 * holds 8,814 fields storing `""` for both and two storing `{}` for both. They
 * are the same field — nothing is bounded either way — so the SDK's own `""`
 * spelling must compare equal to both, and an unbounded list must never keep the
 * key just because the editor happened to serialize its empty control as `{}`.
 *
 * Deliberately narrow: only a block whose members are ALL blank, and only the two
 * blank spellings the engine actually writes. A real bound (`{min:"1"}`) keeps
 * the key and is still compared.
 */
export function hasNoListBounds(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([member, bound]) =>
      (member === "min" || member === "max") &&
      (bound === "" || (typeof bound === "object" && bound !== null && isEmptyObject(bound))),
  );
}
/**
 * Return-block paging members the engine declares `int`. A readback can carry
 * either serialization, and the number is the declared form.
 */
const PAGING_INT_KEYS = new Set(["page", "per_page", "offset"]);

/**
 * Statements whose `input[]` entries the engine reads BY NAME, so their stored
 * order carries nothing.
 *
 * Each one is on this list for two reasons: the engine resolves that statement's
 * arguments by NAME rather than by position, so a reordering cannot change what
 * it does; and real workspaces store the same entries in more than one order —
 * 3 `api_request`, and one each of the two document statements.
 *
 * This is an allowlist and must stay one. Order IS meaningful on other
 * input-routed statements — a row write's columns, and a lookup whose `input[]`
 * has to LEAD with `field_name`/`field_value` — so a blanket sort would quietly
 * corrupt them.
 */
/**
 * Statements whose stored `input[]` the engine CANNOT read, so its entries are
 * editor exhaust rather than configuration.
 *
 * `mvp:create_image` is the only member, and it qualifies three times over: its
 * engine class declares no input schema at all (an empty one, in every version of
 * the class including the first); the stack runner only parses `input[]` when the
 * schema is non-empty and otherwise hands `process` an empty array; and that
 * `process` never reads its args, taking everything from `context`. The editor
 * agrees — the statement's panel has four controls (access, value, filename,
 * return-as) and no way to attach an input at all.
 *
 * What is actually stored is one `{tag:"auth", name:"id"}` route, on 26 statements
 * that all sit in a scaffolded `upload/image` endpoint, against 9 hand-made ones
 * that carry none — the present-and-absent-side-by-side pattern every other rule
 * here rests on. Dropping it on BOTH sides is what lets those decode as an
 * ordinary `s.storage.create_image(...)` instead of a raw envelope spread.
 *
 * An allowlist, and it must stay one: `mvp:set_data_source` and
 * `mvp:create_attachment` also store inputs upstream's schema omits, but their
 * engine classes DO declare and read them (`workspace_id`, `type`), so those are
 * modelled as arguments instead of discarded.
 */
const UNREADABLE_INPUT = new Set(["mvp:create_image"]);

/**
 * True when this statement's stored `input[]` is unreadable exhaust.
 *
 * Exported so the decoder keys its discard on the SAME list this normalizer
 * elides by — a second list would be a second thing to forget, and the two
 * disagreeing would mean emitting source that cannot round-trip.
 */
export function hasUnreadableInput(name: unknown): boolean {
  return typeof name === "string" && UNREADABLE_INPUT.has(name);
}

/**
 * Inputs a statement USED to declare and no longer does — stored on older
 * statements, read by nothing today.
 *
 * `ddtags` was a text shortcut on the datadog log and metric statements, sitting
 * between `hostname` and `tags`. It was removed upstream: the schema no longer
 * declares it, the engine class no longer declares it, and the branch that read
 * it is gone — the class derives the wire field from `tags` alone. Callers
 * were pointed at `tags`, which is the input that remains.
 *
 * A workspace written before that change still stores the entry, and it is dead
 * there: nothing reads it, and the statement behaves exactly as it would without
 * it. Dropping it on BOTH sides is what lets such a statement decode as an
 * ordinary `s.datadog.log(...)` instead of an opaque `raw()` — the alternative
 * is not "keep the byte", it is "lose the whole statement's typed form".
 *
 * This is NOT the same as adding the field back to the catalog. The catalog
 * matches the current engine, and emitting `ddtags` would write a field today's
 * engine does not declare.
 *
 * Deliberately narrow: the two statements that declared it, and only the entry
 * that was retired. The bulk siblings never declared it at the top level, and
 * their per-entry payloads are values rather than input rules, so they are not
 * listed. The drop is reported rather than made quietly — see the decoder.
 *
 * `hidden_cols` is the same shape on the two search-family QUERY statements. It
 * sat where `included_fields` sits today, and it was REPLACED rather than
 * renamed — the two mean opposite things, columns to hide versus fields to
 * keep — so a stored `hidden_cols` cannot be carried across to the field that
 * replaced it. Neither the schema nor the class declares it now and nothing
 * reads it. All four stored instances in the corpus carry it EMPTY, so the drop
 * costs nothing even on the reading that it once meant something.
 *
 * The corpus evidences it on the OpenSearch surface only; the Elasticsearch
 * sibling is listed because the two are generated from near-identical schemas
 * and declare the replacement at the identical position, not because a stored
 * instance was found.
 *
 * Keyed statement → retired input → the input that REPLACED it (`null` when
 * nothing did), matching {@link ADJUDICATED_OPTIONAL}'s shape in
 * `schema-dsl/overrides.ts`. "X was replaced by Y" is a fact about the retired
 * input, not about the statement — a statement that retires two inputs with
 * different successors has to be able to say so, and a second table keyed by
 * statement alone could neither express that nor be kept in sync.
 */
const RETIRED_INPUT: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  "mvp:datadog_log": { ddtags: "tags" },
  "mvp:datadog_metric": { ddtags: "tags" },
  "mvp:amazon_opensearch_query": { hidden_cols: "included_fields" },
  "mvp:elasticsearch_query": { hidden_cols: "included_fields" },
};

/** Shared empty result, so the common miss below allocates nothing. */
const NO_RETIRED_INPUTS: readonly string[] = [];

/**
 * The retired input names for a statement, if it has any.
 *
 * Exported so the decoder reports the SAME drop this normalizer elides — a
 * second list would be a second thing to forget, and the two disagreeing would
 * mean either a silent discard or a statement that cannot round-trip.
 */
export function retiredInputs(name: unknown): readonly string[] {
  const row = typeof name === "string" ? (Object.hasOwn(RETIRED_INPUT, name) ? RETIRED_INPUT[name] : undefined) : undefined;
  // `normalize` calls this for every object node it walks, so the miss path —
  // which is nearly all of them — must not mint a fresh array each time.
  return row ? Object.keys(row) : NO_RETIRED_INPUTS;
}

/**
 * The input that REPLACED a retired one, so the decoder's report can name it.
 *
 * Read per retired input rather than per statement: `ddtags` was folded into
 * `tags`, `hidden_cols` was replaced by `included_fields`, and a statement is
 * free to retire both kinds. `null`/`undefined` means nothing took its place.
 */
export function retiredInputSuccessor(name: unknown, input: string): string | null {
  const row = typeof name === "string" ? (Object.hasOwn(RETIRED_INPUT, name) ? RETIRED_INPUT[name] : undefined) : undefined;
  return row?.[input] ?? null;
}

const NAME_KEYED_INPUT = new Set([
  "mvp:create_auth",
  "mvp:api_request",
  "mvp:amazon_opensearch_document",
  "mvp:elasticsearch_document",
]);

/** An expression group that nests nothing — what an omitted group means. */
const EMPTY_SEARCH = { expression: [] };

/**
 * The inert `statement` the engine writes on an expression node whose `type` is
 * `"group"`.
 *
 * Every node carries BOTH members — `group` and `statement` — and `type` selects
 * which one is live. The engine dispatches on it in two independent walkers, and
 * neither ever reads the off-branch member: the search evaluator's
 * `case "group"` recurses into `$statement["group"]` alone, and the
 * expression-to-config converter's `case "group"` reads only
 * `$expr["group"]["expression"]`. The mirror of this is already handled — an
 * empty `group` on a `type:"statement"` node is dropped as a default (see the
 * `"group"` case in {@link isDefaultEnvelopeMember}) — and this is the missing
 * half, worth 6 `db.query` statements that fell back for carrying scaffolding.
 *
 * **Every group node's `statement` is dropped, blank or not**, because nothing
 * anywhere reads it. Five independent consumers were checked and all five
 * dispatch on `type` first: the engine's search evaluator and its
 * expression-to-config converter (every `["statement"]` read in the engine sits
 * inside a `case "statement":`), the frontend's row renderer (`@switch
 * (exp.type)`), and the frontend's own type-toggle handler, which reads the
 * GROUP's first child when converting back — never the parent's copy.
 *
 * The frontend also explains where a non-blank one comes from. Toggling a row
 * from statement to group copies the live comparison INTO the new group as its
 * first child and simply does not clear the original:
 *
 *     payload['group'] = { expression: [{ type: 'statement',
 *                                         statement: group.value.statement }] }
 *
 * So the leftover is a snapshot of the condition at the moment it was wrapped.
 * In the survey corpus 1 of 11 still matches the group's first child exactly and
 * 10 have drifted — the user kept editing the group while the frozen copy stayed
 * behind. It is editor exhaust, not authored intent: the UI renders only the
 * live branch, so whoever "wrote" it has no way to see it, edit it, or know it
 * is there.
 *
 * That is what separates this from `example` and a saved `test` list, which are
 * also unread but ARE user data and are therefore stripped rather than dropped.
 * The rule is not "never discard bytes" — it is never discard something someone
 * MEANT. A non-blank one is reported as an `expected-omission` so the discard is
 * visible; a blank one is pure scaffolding and goes quietly.
 */
export function isBlankGroupStatement(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const node = v as { op?: unknown; left?: unknown; right?: unknown };
  if (node.op !== "=") return false;
  const blankSide = (side: unknown): boolean =>
    side !== null &&
    typeof side === "object" &&
    (side as { tag?: unknown }).tag === "const" &&
    (side as { operand?: unknown }).operand === "";
  return blankSide(node.left) && blankSide(node.right);
}
/**
 * The per-return-type sub-blocks of a `db.query`'s `context.return`, and the
 * return types that have none.
 */
const RETURN_BLOCKS = ["single", "list", "stream", "aggregate"] as const;
const RETURN_TYPES = new Set<string>([...RETURN_BLOCKS, "count", "exists"]);

/**
 * A `context.return` reduced to its LIVE branch, or `undefined` when it is not a
 * return section or has no dead branch to shed.
 *
 * `return.type` selects one of four sub-blocks — `single`, `list`, `stream`,
 * `aggregate` (`count` and `exists` select none) — and the query editor writes
 * ALL of them on save, because the panel builds one form group over the whole
 * declared section and emits `form.value` wholesale. So a `type:"single"` query
 * still stores a fully-populated `list` block, paging and all, and a query that
 * was ever a list keeps whatever sort it had after switching away.
 *
 * Nothing reads the off-branches. The converter that turns the stored section
 * into the engine's query config is a chain of `if (returnType == "…")` arms,
 * each reading `return.<that type>.*` and nothing else; Xano's own
 * XanoScript↔stack translator likewise writes only the live block. The dead ones
 * are invisible in the editor and inert at runtime — the same editor exhaust as
 * an expression group's `statement` branch (see {@link isBlankGroupStatement}),
 * and dropped for the same reason: the rule is never discard what someone MEANT,
 * not never discard bytes.
 *
 * A dead branch that carries real configuration — a sort, a group-by, paging
 * switched on — is reported as an `expected-omission` by the decoder so the
 * discard is visible; the default-filled ones the editor writes on every save go
 * quietly, since reporting those would fire on nearly every query pulled.
 */
export function liveReturnSection(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const section = value as Record<string, unknown>;
  const type = section.type;
  if (typeof type !== "string" || !RETURN_TYPES.has(type)) return undefined;
  const dead = RETURN_BLOCKS.filter((b) => b !== type && b in section);
  if (dead.length === 0) return undefined;
  const live: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(section)) {
    if (!(RETURN_BLOCKS as readonly string[]).includes(k) || k === type) live[k] = v;
  }
  return live;
}

/**
 * A REQUIRED schema descriptor's `default` is inert, in whichever spelling.
 *
 * The engine's schema-to-runtime conversion opens by discarding the default
 * outright for any required entry — it overwrites it and clears the
 * "has a default" flag, unconditionally, before any other rule runs.
 *
 * So the stored `default` is thrown away before anything reads it, and the
 * spellings found in the wild — `""` and `"0"` from the engine's own templates
 * and from this SDK, `null` from a current instance — are one unreachable member.
 *
 * It governs BOTH schema arrays, because the engine converts a query or
 * trigger's `input` and a table's `schema` through that same one conversion. Real
 * workspaces store the two spellings side by side on the same required columns
 * (`id`/`name` as `"0"`/`""` in one workspace and `null` in another), and 82 of
 * 82 `.input[].default` verify-mismatch rows on a live sweep were required
 * entries. It also explains a finding an earlier session reached separately: a
 * `default: "0"` on a required column is an "inert leftover the engine ignores",
 * and this is the line that ignores it.
 *
 * On an OPTIONAL entry the stored default is NOT discarded — `created_at`
 * defaulting to `now` is real and must survive — but `null` and `""` still
 * converge there. The conversion's next step coalesces an absent-or-null
 * default to `""`, and the step after that turns `""` (or `null`, or `[]`) back
 * into `null` whenever the entry is nullable. So across all three branches:
 *
 * | entry | `null` becomes | `""` becomes |
 * |---|---|---|
 * | required | `null` | `null` |
 * | optional, not nullable | `""` | `""` |
 * | optional, nullable | `null` | `null` |
 *
 * The two spellings are therefore one state everywhere, and only a REQUIRED
 * entry additionally collapses a real value like `"0"`.
 *
 * Applied to the DESCRIPTOR, not to the array holding it: the field decoder
 * compares a lone descriptor, so an array-keyed rule missed every table column
 * and query input this was written for while still passing its own unit tests.
 */

/**
 * A realtime event's `auth` block with an UNBOUND auth table dropped, or
 * `undefined` when there is nothing to drop.
 *
 * `mvp:realtime_event` scopes an event to one auth row via
 * `context.auth.{dbo_id,row_id}`. The editor's form materializes both members
 * always and writes `dbo_id: 0` when no table is bound; the SDK omits the member
 * entirely when no `authTable` is given. `0` is not a table — this is the same
 * "an internal row id is not portable identity" that makes `guid 0` unresolvable
 * elsewhere — so the two spellings are one state, and a bound table can never
 * collide with it.
 *
 * Evidenced three ways, which is what it takes to drop bytes:
 *   • the statement's own runtime coalesces a missing `dbo_id` to `0` — in both
 *     places it reads one — so absent and `0` are literally the same value to
 *     it, and it then gates the whole row lookup on that id being truthy;
 *   • the statement's XanoScript schema declares `auth_table?=""`, so an
 *     unbound table is the declared default rather than a missing argument; and
 *   • a live round trip (`scripts/probe-persisted-defaults.ts`) deployed the
 *     SDK's omitted spelling into a fresh tenant and exported it back
 *     unchanged — the engine does NOT materialize the member on the way in, so
 *     omitting it cannot drift a deploy → pull cycle.
 *
 * Keyed on the SHAPE, not the name: an `auth` block pairing a numeric `dbo_id`
 * with a `row_id`, and only when the id is `0`. `dbo_id` appears exactly once in
 * the 177-project corpus and only here, but scoping by shape is what keeps that
 * true if it ever appears somewhere it means something else.
 */
export function unboundAuthTable(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  if (block.dbo_id !== 0 || !("row_id" in block)) return undefined;
  const rest = { ...block };
  delete rest["dbo_id"];
  return rest;
}

/**
 * The dead `context.return` branches that carry authored configuration — a
 * non-empty `sort`/`group`/`eval`/`index`, or paging switched on. Used to report
 * what {@link liveReturnSection} drops; a branch holding only the editor's
 * defaults returns nothing.
 */
/**
 * A `context.return` with the inert `iterator` member dropped from every result
 * block, or `undefined` when it is not a return section or carries none.
 *
 * `iterator` is a dead key. Streaming is selected by `return.type` alone: the
 * `dbo_view` engine class picks its iterator in a `switch` on `return["type"]`
 * whose only arm is `"stream"`, and no other engine code — neither the
 * stored-context-to-query-config converter nor the query parser — reads
 * `return.<block>.iterator` at all. So the member cannot change what a query
 * does, in any block, at any value.
 *
 * It is editor exhaust of the same kind as the dead sibling branches
 * {@link liveReturnSection} sheds, and is dropped for the same reason — except
 * this one sits INSIDE the live branch, so that function never reaches it. In
 * the survey corpus it appears on exactly one query (as `false`, on both `list`
 * and `aggregate`) against 555 that omit it entirely: the absent-vs-present
 * generational split, with the engine evidence that closes it.
 *
 * Modelling it instead would give the SDK an authoring surface for a key the
 * engine ignores — the same mistake `allow_notfound` is kept out of the SDK to
 * avoid. That one is stripped in {@link STRIP_KEYS} rather than here, because it
 * sits on `context` directly rather than inside a return block.
 */
export function returnWithoutIterator(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const section = value as Record<string, unknown>;
  if (typeof section.type !== "string" || !RETURN_TYPES.has(section.type)) return undefined;
  let found = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(section)) {
    if (
      (RETURN_BLOCKS as readonly string[]).includes(k) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "iterator" in (v as Record<string, unknown>)
    ) {
      found = true;
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.iterator;
      out[k] = rest;
      continue;
    }
    out[k] = v;
  }
  return found ? out : undefined;
}

/** Members of a `runtime` block the engine reads only at `async-dedicated`. */
const DEDICATED_RUNTIME_KEYS = ["cpu", "memory", "timeout", "max_retry"] as const;

/**
 * A call's `runtime` block with the members its `mode` does not read dropped,
 * or `undefined` when there is nothing to shed.
 *
 * The engine's stack converter switches on `runtime.mode` and copies the
 * resource members in the `async-dedicated` arm ALONE — `async-shared` falls
 * through to a block built from `mode` by itself, and every other value lands
 * on a default arm that discards the runtime outright. So outside
 * `async-dedicated` those four members cannot reach the statement.
 *
 * They are still written: the settings panel is one form over all five fields,
 * so switching to `async-shared` leaves whatever the dedicated form held (blank,
 * in the corpus). Same editor exhaust as a dead `context.return` branch, dropped
 * on the same rule and for the same reason — the SDK emits only what the mode
 * reads, and without this the two spellings never compare equal.
 */
export function liveAsyncRuntime(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  const mode = block.mode;
  // Not a mode-carrying runtime block — leave it entirely alone.
  if (typeof mode !== "string") return undefined;
  // `"disabled"` is what the settings panel writes when the user picks
  // "Standard run (Synchronous)". The converter's default arm discards the whole
  // block there, so it is the third spelling of the unset state, alongside
  // `null` and an absent key — and the empty block it reduces to is what the
  // default-envelope rule already drops.
  //
  // Scoped to the spellings actually observed, NOT to "any mode that is not
  // async". An unrecognized mode keeps its members: the engine would ignore it
  // too, but a value nothing in the corpus stores is not evidence of anything,
  // and silently emptying it would discard a shape before it was understood.
  if (mode === "disabled") return {};
  // At `async-dedicated` all four resource members are read, so nothing sheds.
  if (mode !== "async-shared") return undefined;
  if (!DEDICATED_RUNTIME_KEYS.some((k) => k in block)) return undefined;
  const live: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) {
    if (!(DEDICATED_RUNTIME_KEYS as readonly string[]).includes(k)) live[k] = v;
  }
  return live;
}

/**
 * Whether a toolset's `agent_settings` is the engine's BLANK scaffold — present,
 * fully-shaped, and carrying no agent configuration at all.
 *
 * An MCP toolset that configures no model still gets the whole block written,
 * every member at its empty value and `configs` keyed by the empty provider name
 * (`{"": {}}`). It is inert: every engine consumer reaches a provider config
 * through `agent_settings.type`, so a blank type selects `configs.` and
 * configures nothing.
 *
 * The two members read WITHOUT going through `type` — `structuredOutputs` and
 * `structuredOutputsSchema` — are checked too, so a block that only looks blank
 * is not mistaken for one. That is what keeps this from being a rule on a
 * generic key name (invariant 5).
 *
 * The SDK spells this state by omitting the block, so the two forms have to
 * compare equal or every MCP server without an `llm` fails to round-trip.
 */
/**
 * Whether a `result[]` entry is one the engine's response builder DISCARDS.
 *
 * The builder walks the stored list and drops an entry before it can
 * contribute anything in two cases this models:
 *
 *  - `disabled` is set — skipped outright;
 *  - the `name` is blank AND the list holds more than one entry. A blank name
 *    has nothing to key the response object by, so it is skipped. The exception
 *    is a list of exactly ONE blank-named entry, which is the "bare value"
 *    response — that entry is the whole response and is very much alive.
 *
 * A third rule the engine has (an empty `value` with no filters, on a non-`const`
 * entry) is deliberately NOT modelled: those entries round-trip today, so
 * dropping them would change stored bytes for no gain.
 *
 * Dead entries are editor exhaust with a real cost — one query stores four
 * items, three of them blank-named, and the whole response fell back to
 * `rawResponse()` because a record cannot be keyed by a name three items share.
 * The engine's answer is that those three contribute nothing, so the response
 * really is the one named item.
 */
export function isDeadResultItem(item: unknown, total: number): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const entry = item as { name?: unknown; disabled?: unknown };
  if (entry.disabled !== undefined && entry.disabled !== false) return true;
  return entry.name === "" && total !== 1;
}

/** Whether `value` is a stored `result[]` — an array of `{name,value,tag,filters}`. */
function isResultList(value: unknown): value is ReadonlyArray<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        "name" in e &&
        "value" in e &&
        "tag" in e &&
        "filters" in e,
    )
  );
}

/**
 * A `result[]` reduced to the entries the engine actually reads, or `undefined`
 * when nothing is dropped. Keyed on the entry SHAPE, never on the generic name
 * `result` (invariant 5).
 */
export function liveResultItems(value: unknown): unknown[] | undefined {
  if (!isResultList(value)) return undefined;
  const live = value.filter((e) => !isDeadResultItem(e, value.length));
  return live.length === value.length ? undefined : live;
}

export function isBlankAgentSettings(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (settings.type !== "") return false;
  if (settings.structuredOutputs === true) return false;
  const schema = settings.structuredOutputsSchema;
  if (Array.isArray(schema) && schema.length > 0) return false;
  return true;
}

export function configuredDeadReturnBlocks(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const section = value as Record<string, unknown>;
  const type = section.type;
  if (typeof type !== "string" || !RETURN_TYPES.has(type)) return [];
  return RETURN_BLOCKS.filter((b) => b !== type && isConfiguredReturnBlock(section[b]));
}

function isConfiguredReturnBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
  const b = block as Record<string, unknown>;
  for (const list of ["sort", "group", "eval", "index"]) {
    if (Array.isArray(b[list]) && (b[list] as unknown[]).length > 0) return true;
  }
  const paging = b.paging;
  return (
    paging !== null && typeof paging === "object" && (paging as { enabled?: unknown }).enabled === true
  );
}

/** The engine's default `context.external` (paged-external input) — SDK omits it. */
const DEFAULT_CONTEXT_EXTERNAL = {
  tag: "input",
  value: "",
  permissions: { page: true, sort: true, search: true, per_page: false },
};
/**
 * A `context.simpleExternal` block whose every facet binds NOTHING — the empty
 * scaffold the editor writes on a query that binds no paging facet.
 *
 * Keyed on the VALUE rather than on one frozen shape, because the scaffold has
 * more than one stored spelling: 61 across the sweep write each facet as
 * `{tag:"input", value:""}` and 3 as `{tag:"const", value:""}`. Both bind the
 * same nothing — an input named `""` does not exist, and an empty const parses
 * to nothing through the `int|min(1)` the engine declares.
 *
 * Reading the scaffold as authored was expensive out of proportion to its size:
 * five blank facets came back as five bound paging Values, and because the SDK
 * (correctly) refuses to author `external` alongside input-bound paging, the
 * recovered call did not merely mismatch — it THREW, taking the whole db.query
 * down to `raw()`. A blank facet is not a bind.
 *
 * The 4 genuinely populated blocks in the corpus keep every facet: a non-empty
 * value anywhere means the block was authored.
 */
function bindsNoPagingFacet(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const facets = Object.values(value as Record<string, unknown>);
  if (facets.length === 0) return false;
  return facets.every(
    (facet) =>
      facet !== null &&
      typeof facet === "object" &&
      !Array.isArray(facet) &&
      (facet as { value?: unknown }).value === "" &&
      ((facet as { filters?: unknown[] }).filters ?? []).length === 0,
  );
}

/**
 * The engine's default API-group CORS block — every facet off, no origins.
 *
 * Frozen here rather than imported from the encoder because this module sits
 * under the authoring layer, not above it. `test/validate/normalize.test.ts`
 * pins the literal against what the encoder emits by default, so the two cannot
 * drift apart silently.
 */
const DEFAULT_CORS = {
  mode: "default",
  allowOrigins: [],
  allowHeaders: [],
  allowCredentials: false,
  maxAge: 0,
  allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
};
/** The engine's default API-group `documentation` block — docs open, no token. */
const DEFAULT_DOCUMENTATION = { require_token: false, token: "" };
/** An attachment block that attaches nothing and customizes no phase. */
const DEFAULT_MIDDLEWARE = { pre: [], post: [], pre_customize: false, post_customize: false };

/**
 * Envelope members whose value, when it equals the listed default, is a
 * representational artifact rather than authored data. The SDK emits the
 * **full** persisted statement/object envelope (every member always present
 * with empty defaults); the older parser-generation fixtures omit those empties
 * entirely. Dropping a member from both sides when it holds its empty default
 * makes the two generations compare equal while still comparing any non-default
 * value (e.g. `disabled:true`, a populated `settings_registry`, `as:"user"`).
 */
/**
 * A raw-SQL statement's `context`, identified by the SQL it carries.
 *
 * Scopes the empty-`arg` drop below to the one place both spellings are known to
 * occur. `arg` is also the name of a FILTER's argument list, where an empty one
 * is written by every generation and dropping it would erase a real difference
 * between a zero-arg filter and one whose arguments went missing.
 */
function isRawSqlContext(container: unknown): boolean {
  return (
    container !== null &&
    typeof container === "object" &&
    typeof (container as { code?: unknown }).code === "string"
  );
}

/**
 * A runtime condition tree with the INERT join flag cleared off each list's
 * first term.
 *
 * Xano's condition editor attaches an AND/OR choice to every row, and a
 * workspace built through it routinely carries one on the first row — where
 * there is nothing preceding it to join to. The engine's runtime evaluator
 * proves it inert: it walks the list with an accumulator that starts unset,
 * and for the FIRST term neither short-circuit applies (both test the
 * accumulator against a boolean) and the combination branch takes the
 * `accumulator is unset` arm, which does not read the flag at all. The engine's
 * own renderer agrees — it emits no separator before the first row, so the flag
 * has nowhere to appear in the source it writes. Evaluating a nested group
 * recurses with a fresh accumulator, so the same holds at every level.
 *
 * The authored surface models joins BETWEEN terms, so it has nowhere to put a
 * flag on the first one. Clearing it on both sides of the comparison is what
 * lets an ordinary editor-built condition come back as `and(...)`/`or(...)`
 * instead of `raw()`.
 *
 * Scoped to `context.expr` — every consumer of that key is the runtime
 * evaluator above. A db search (`context.search`) becomes a SQL WHERE clause
 * built beside clauses the engine adds itself, where a leading `or` is NOT
 * known to be inert, and is deliberately left alone.
 */
function withoutLeadingJoin(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const expression = (v as { expression?: unknown }).expression;
  if (!Array.isArray(expression)) return v;
  const cleared = expression.map((entry, i) => {
    if (entry === null || typeof entry !== "object") return entry;
    const node = entry as Record<string, unknown>;
    const group = "group" in node ? { group: withoutLeadingJoin(node.group) } : {};
    if (i > 0) return { ...node, ...group };
    const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "or"));
    return { ...rest, ...group };
  });
  return { ...(v as Record<string, unknown>), expression: cleared };
}

export function isDefaultEnvelopeMember(key: string, v: unknown): boolean {
  switch (key) {
    // An empty `mocks` arrives as `[]` from the engine and `{}` from the SDK — the
    // empty-associative-collection artifact again. Both mean "no mocks".
    case "mocks":
      return isEmptyObject(v) || isEmptyArray(v);
    // An UNSET runtime binding, in both stored spellings: the `null` the engine
    // writes on one generation and the blank-member object it writes on another
    // (`{id: "", mode: ""}` on 6 real `mvp:function` statements). A binding that
    // names anything is preserved and still compares.
    case "runtime":
      return (
        v === null ||
        (typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          Object.values(v as Record<string, unknown>).every((member) => member === ""))
      );
    case "settings_registry":
      return v === null || isEmptyArray(v);
    case "addon":
      return isEmptyArray(v);
    case "disabled":
      return v === false;
    case "as":
    case "description":
    case "sql_name":
      return v === "";
    // The object-level members below are the same generational gap one level up
    // — an object saved by an older engine generation omits them, while both the
    // current engine and the SDK always write them at a fixed default. They were
    // 1,716 of the 1,744 round-trip mismatches in a 187-workspace sweep, and
    // each default is evidenced twice: the engine reads the absent key as this
    // value, and real workspaces store present-at-default and absent side by
    // side on one instance.
    case "docs":
    case "datasource":
    case "view_alias":
      return v === "";
    // An MCP tool entry's optional metadata, and the agent provider-config
    // members whose unset spelling is the empty string. Both store the empty
    // form and the absent form side by side across the corpus.
    case "tool_meta":
    case "resource_uri":
    case "alias":
    case "baseURL":
    case "safetySettings":
    case "dynamicRetrievalConfig":
    case "apiKey":
      return v === "";
    // `headers` is an empty STRING on an unset agent config and a string[] on an
    // api_request statement — dropping only the string spelling leaves an empty
    // header list comparing as the authored value it is.
    case "headers":
      return v === "";
    // MCP metadata a newer engine fills on every tool and toolset, at the value
    // an older one reads the absent key as: a tool's `icons`/`title`/
    // `annotations`/`output_schema`, a toolset's `prompt`/`resource` lists. The
    // SDK writes none of them, so a pulled tree re-exported without them and
    // every MCP server and tool on a current instance failed its round trip.
    // Array-only for `prompt` — an agent's own `prompt` is a string.
    case "icons":
    case "output_schema":
    case "prompt":
    case "resource":
      return isEmptyArray(v);
    case "title":
      return v === "";
    case "annotations":
      return (
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        Object.values(v as Record<string, unknown>).every((m) => m === null || isEmptyArray(m))
      );
    // A tool entry's kind. Absent means `tool`; a `resource` or `prompt` entry
    // says so and still compares. Value-distinct from the other `type`
    // discriminators (an expression node, a column type), none of which is `tool`.
    case "type":
      return v === "tool";
    // Four stored spellings of "no thinking budget" across 16 real configs: the
    // empty string, absent, and the block with its budget as either `0` or `""`.
    case "thinkingConfig":
      return (
        v === "" ||
        (typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          (v as Record<string, unknown>)["includeThoughts"] === false &&
          ((v as Record<string, unknown>)["thinkingBudget"] === 0 ||
            (v as Record<string, unknown>)["thinkingBudget"] === ""))
      );
    // A query with no declared response type. Type- and value-distinct from the
    // raw-SQL `response_type`, whose values are `list`/`single`/`count` and
    // whose own default (`list`) is spelled differently.
    case "response_type":
      return v === "standard";
    // Empty list members. `tag` is the load-bearing one: it is also the
    // discriminator every tagged value carries, so the rule is restricted to the
    // ARRAY spelling — a `tag: "const:str"` is a string and never matches.
    case "tag":
    case "views":
    case "result":
      return isEmptyArray(v);
    // Two API-group gates with opposite defaults, each the value the engine
    // falls back to when the key is absent: a group serves unless disabled,
    // documentation is off unless turned on.
    case "api_group_enabled":
      return v === true;
    case "swagger":
      return v === false;
    case "documentation":
      return deepEqual(normalize(v), normalize(DEFAULT_DOCUMENTATION));
    // A CORS block is applied ONLY when its `mode` is `"custom"` — the engine
    // reads an absent mode as `""`, which is not custom — so a block that does
    // not say `custom` configures nothing.
    //
    // Two spellings therefore mean the same default. The current one says
    // `mode: "default"`; an older one predates `mode` entirely and carries
    // `enabled: false`, a key that request path never reads.
    case "cors": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const block = { ...(v as Record<string, unknown>) };
      if (block["enabled"] === false) delete block["enabled"];
      block["mode"] ??= "default";
      return deepEqual(normalize(block), normalize(DEFAULT_CORS));
    }
    // Both stored spellings of "no middleware": the engine hands an empty
    // associative map back as a JSON array, the same artifact already absorbed
    // for `mocks`, `customize` and an empty `context`. A phase explicitly
    // customized to run nothing still compares — that is not inheriting.
    case "middleware":
      return isEmptyArray(v) || deepEqual(normalize(v), normalize(DEFAULT_MIDDLEWARE));
    // Two unrelated `offset`s, both at a default. An addon's is the response path
    // its rows are spliced into, `""` when spliced at the root. A list context's
    // paging offset is declared to default to 0. Neither carries information at
    // its default; any other value is preserved.
    case "offset":
      return v === "" || isNumber(v, 0);
    // Return-block paging members, each at its declared default. Type-distinct
    // from their same-named neighbours in a permissions block (`page: true`,
    // `per_page: false`), which are booleans and so untouched.
    case "page":
      return isNumber(v, 1);
    case "per_page":
      return isNumber(v, 25);
    case "metadata":
      return v === true;
    case "totals":
      return v === false;
    case "distinct":
      return v === "auto";
    // `s.setheader`'s duplicate-handling mode. The engine declares it
    // `duplicates?=replace` and reads it as `($data["duplicates"] ?? "replace")`,
    // so an absent key IS "replace"; 3 real statements omit it against 8 that
    // store it present-at-default. The key appears on no other statement.
    case "duplicates":
      return v === "replace";
    // A return sub-block whose every member sat at a default. These are checked
    // against their NORMALIZED form because the member rules above are what empty
    // them — without this the block survives as `{}` and the whole return envelope
    // never collapses, which is the only reason it matters.
    //
    // `list` also names a foreach's iterated value; a tagged value never
    // normalizes to empty, so that one is untouched.
    //
    // `enabled:false` is the one member no rule above empties, deliberately — it
    // is meaningful on a history block, so it cannot be dropped by name. It IS
    // droppable here, where the key says the block is paging: 7 real db.query
    // statements omit `paging` outright against 149 that store it present at
    // `enabled:false`, and the two spellings mean the same thing.
    //
    // Evidenced twice before being trusted. Every engine consumer reads the flag
    // as `["paging"]["enabled"] ?? false`, so an absent block IS a disabled one,
    // and the serializer returns before writing anything when it is off — a
    // disabled block emits no source at all. The siblings are provably inert
    // meanwhile: every read of `page`/`per_page`/`offset`/`metadata` sits behind
    // that same gate.
    //
    // Still narrow: this fires only once every OTHER member has normalized away.
    // A disabled block that customizes something (`{enabled:false, per_page:50}`)
    // keeps both and compares as itself.
    case "paging": {
      const normalized = normalize(v);
      return isEmptyObject(normalized) || deepEqual(normalized, { enabled: false });
    }
    // The same four blocks, plus the residue the member rules above cannot reach.
    //
    // The engine writes ALL FOUR result-shape blocks on every query; the SDK writes
    // only the one its `returnType` selects. Emptiness alone does not collapse a
    // default sibling, because two of its members have no rule that empties them —
    // the paging `enabled:false` gate and an aggregate's empty `group`/`index`
    // lists. So one customized `per_page` left every default sibling mismatching,
    // and a paged query could never verify.
    //
    // Deep-equality against each block's own frozen default is what reaches those
    // members WITHOUT a global rule on their generic names — `enabled:false` is
    // meaningful on a history block, and an empty `group` is a condition default
    // elsewhere. A block with anything authored inside it still compares.
    case "list":
      // `list` names two unrelated things. On a FIELD it is the length bounds of
      // an array column, and its unset spelling drifts: 8,814 fields in the sweep
      // store `{min:"", max:""}` and two store `{min:{}, max:{}}`. Both mean "no
      // bounds" — an unset bound is whatever the editor's empty control
      // serialized to that day — so an unbounded list must not depend on which.
      if (hasNoListBounds(v)) return true;
    // falls through to the result-shape block of the same name
    case "single":
    case "stream":
    case "aggregate":
      return (
        isEmptyObject(normalize(v)) ||
        deepEqual(normalize(v), normalize((Object.hasOwn(DEFAULT_RETURN_BLOCKS, key) ? DEFAULT_RETURN_BLOCKS[key] : undefined)))
      );
    // Field-envelope members the engine fills with a fixed default on save. A
    // field saved by an older engine generation omits them entirely, while both
    // the current engine and the SDK always write them — the same lean-vs-full
    // generational gap as the members above, and by far the most common one in
    // the wild: nearly every field in a workspace that has not been re-saved
    // lacks `is_settings_registry`. Without these the decoder cannot prove ANY
    // authored form reproduces such a field, so every one of them degrades to a
    // descriptor literal or `rawField()` — including foreign keys, which lose
    // their `f.tableRef(table)` form and the table import with it.
    case "is_settings_registry":
    case "sensitive":
      return v === false;
    case "mode":
    case "format":
      return v === "";
    // A field's `vector.size` is only authored on a `vector` column; on every
    // other type the engine writes this exact default. Dropping it at the
    // default is symmetric, so a real `vector` column of size 3 still compares
    // equal, and any other size is preserved and still compared.
    case "vector":
      return deepEqual(v, { size: 3 });
    // Agent `agent_settings.model`: the engine persists a top-level empty
    // `model:""` (the real model lives under `configs.<provider>.model`); the SDK
    // omits the empty top-level field. Drop it on both sides when empty.
    case "model":
      return v === "";
    // Statement input-entry members: the lean parser form omits these; the full
    // persisted form carries them. Drop at their defaults (a meaningful
    // `ignore:true` on a system column, or non-empty `children`, is kept).
    case "ignore":
    case "expand":
      return v === false;
    // Expression right-operand flag: the engine schema marks it `?=false` and
    // drops it at the default on save, so the persisted form (and the SDK) omit
    // it; older parser-generation fixtures still carry `ignore_empty:false`.
    case "ignore_empty":
      return v === false;
    case "children":
      return isEmptyArray(v);
    // The two stored generations of an external database connection sit in
    // SEPARATE fields, and a statement that uses one leaves the other at its
    // unset value rather than dropping it: the engine's optional-schema pass
    // gives the bare `connection_string` the text default `""` and leaves the
    // nested `connection_string_flex` as nothing at all. Neither unset spelling
    // says anything about the connection, so both drop on both sides — which is
    // what lets a statement stored in either generation prove against the one
    // field it actually uses. A populated field of either
    // generation is preserved and still compared.
    case "connection_string":
      return v === "";
    case "connection_string_flex":
      return v === null || v === "{}" || isEmptyObject(v);
    // A value's filter chain: an empty `filters:[]` is identical to no filter
    // chain. The engine always serializes it on a nested value (e.g. a
    // `context`-nested `filename`); the SDK omits it there. Drop the empty form
    // on both sides so the representational gap doesn't fail an otherwise-equal
    // value. A non-empty chain is preserved and still compared.
    case "filters":
      return isEmptyArray(v);
    // Statement/object input-entry array: the lean parser form omits an empty
    // `input`; the full persisted form carries `input:[]`; and the engine writes
    // `input:null` for a statement that takes no inputs at all. All three are the
    // same "no inputs" state — the SDK emits the `[]` spelling, so without the
    // null arm every input-less statement in a pulled workspace fails to prove
    // and degrades to `raw()`. Drop all three on both sides; a populated `input`
    // is preserved. Same two-spellings-of-empty shape as `settings_registry`.
    case "input":
      return v === null || isEmptyArray(v);
    case "shared_workspace":
      return v !== null && typeof v === "object" && (v as { is_shared?: unknown }).is_shared === false;
    // A trigger's `obj_id`: a table trigger's is the referenced table's GUID
    // *string* (authored, derived by the SDK, kept and compared). A workspace /
    // realtime / error trigger has no table, so the engine stores a *numeric*
    // branch/workspace reference (`1`) while the SDK emits a `0` placeholder —
    // deploy-target state, same rationale as the stripped `branch`. Drop the
    // numeric form on both sides; the guid-string form is preserved.
    case "obj_id":
      return typeof v === "number";
    // Toolset/query/function inherit-tier `history` block: when `inherit` is true
    // nothing is customized (the limit/enabled members are the inherited
    // defaults, not authored). The SDK omits it on a toolset; drop the inheriting
    // form on both sides. A customized (`inherit:false`) history is preserved.
    case "history":
      // An ARRAY is not a settings block — it is the engine's own record of past
      // runs, which the generated tree deliberately does not carry. Dropping it
      // from both sides is what stops that deliberate omission ALSO reading as a
      // failed round trip; the two mean opposite things and an object must not
      // report both.
      return (
        Array.isArray(v) ||
        (v !== null && typeof v === "object" && (v as { inherit?: unknown }).inherit === true)
      );
    // An MCP-server toolset persists `agent_settings:null` (only agents carry a
    // real settings block); the SDK omits it. Drop the null form.
    // `null`, and the engine's BLANK SCAFFOLD — an MCP toolset that configures no
    // model still gets the whole block written, inert (see
    // {@link isBlankAgentSettings}). The SDK spells both by omitting it.
    case "agent_settings":
      return v === null || isBlankAgentSettings(v);
    // An agent's default `agent_settings.telemetry` (all providers off, empty
    // keys): the SDK omits it. Drop when telemetry is disabled.
    case "telemetry":
      return v !== null && typeof v === "object" && (v as { enabled?: unknown }).enabled === false;
    // A tool/query/function `test:[]` scaffold array — the SDK omits it on a tool;
    // an empty test list is identical to none. Drop the empty form both sides.
    case "test":
      return isEmptyArray(v);
    // A query's saved request/response sample at its empty spelling. The SDK
    // writes `{}` whenever no sample is authored and the engine may store the
    // key not at all, or with both halves null. All three mean "no sample".
    // A POPULATED one is preserved and compared (and copied through opaquely —
    // see the `example` branch in the recursion below).
    case "example":
      return (
        v === null ||
        isEmptyArray(v) ||
        (typeof v === "object" &&
          Object.values(v as Record<string, unknown>).every((half) => half === null))
      );
    // A default `auth:false` (public / no auth table): the engine persists it on a
    // tool where the SDK omits it. Drop the `false` form; `auth:true` and an
    // auth-table id are preserved and still compared.
    // `false` and `""` are both "no auth table"; a guid names one and compares —
    // the round trip translates the compiled guid into the engine's re-minted
    // one first (`./guid-remap.ts`), so naming the WRONG table still diffs.
    case "auth":
      return v === false || v === "";
    // Default db-query `context` members the engine fills when an addon (or any
    // db context) customizes nothing; the SDK omits them. Empty-collection /
    // false members drop directly; the three structured members below match
    // their exact engine default (a customized context is preserved).
    case "bind":
    case "eval":
    case "sort":
      return isEmptyArray(v);
    case "future":
      return v === false;
    // Compare NORMALIZED against NORMALIZED default: normalize strips empty
    // `sort`/`eval`/`index` members from the nested subtree, so the frozen
    // default must pass through the same reduction to compare equal.
    case "lock":
      return deepEqual(normalize(v), normalize({ tag: "const:bool", value: "" }));
    // A condition container that holds nothing, in either stored spelling: the
    // `{expression: []}` the SDK writes and the empty associative-map form `[]`
    // the engine hands back — the same artifact already absorbed for `mocks`,
    // `customize` and an empty `context`. Both mean "no condition configured".
    // A populated container is untouched and still compares node for node.
    case "expr":
      return (
        isEmptyArray(v) ||
        (v !== null &&
          typeof v === "object" &&
          isEmptyArray((v as { expression?: unknown }).expression))
      );
    case "search":
      return deepEqual(normalize(v), normalize({ expression: [] }));
    // Two spellings of an all-defaults return block. The engine's declared shape
    // defaults the result type to a list and leaves every sub-block optional, so
    // a query that customizes nothing persists either the whole subtree (when the
    // engine filled it on save) or nothing but the type — and the SDK omits it
    // entirely. Accept both, and preserve any customized paging/sort/distinct.
    case "return":
      return (
        deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_RETURN)) ||
        deepEqual(normalize(v), MINIMAL_CONTEXT_RETURN)
      );
    // A condition entry's nested group. The engine declares it optional with no
    // default, so an entry that nests nothing omits the key while the SDK
    // materializes an empty search. Same state; drop the empty form on both
    // sides. A group that actually nests expressions is preserved and compared.
    case "group":
      return deepEqual(normalize(v), EMPTY_SEARCH);
    // A condition entry's or-flag, declared to default false: the persisted form
    // omits it at the default where the SDK writes it.
    case "or":
      return v === false;
    // Generated-asset visibility, declared to default public wherever it appears.
    case "access":
      return v === "public";
    // A precondition's error class, declared to default to the standard error.
    case "error_type":
      return v === "standard";
    case "external":
      return deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_EXTERNAL));
    case "simpleExternal":
      return bindsNoPagingFacet(v);
    default:
      return false;
  }
}

/**
 * A statement/object `output` is "empty" — `null` (what the engine writes for a
 * statement that shapes no result), `{filters:[]}` (lean parser form), and
 * `{items:[],filters:[],customize:false}` (full persisted form) are all the same
 * "no output customization" state. Drop the key from both sides when empty;
 * keep it (and recurse) when it carries selected `items`, `customize:true`, or a
 * `filters` chain.
 *
 * The `null` arm matters for the same reason as `input:null`: the SDK emits the
 * full form, so without it every result-less statement in a pulled workspace
 * fails its re-encode proof and degrades to `raw()`.
 *
 * The `filters` arm is NOT symmetry for its own sake — it is the whole reason a
 * statement's `as` filter chain (`… as $x|to_upper`) survives a round trip. This
 * predicate is the oracle the proof is judged against, so while it ignored
 * `filters` a decoder that dropped them compared EQUAL to the workspace it had
 * just lost data from. Widening it back would restore that silence.
 */
export function isEmptyOutput(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as { items?: unknown; customize?: unknown; filters?: unknown };
  const noItems = o.items === undefined || (Array.isArray(o.items) && o.items.length === 0);
  const noFilters = o.filters === undefined || (Array.isArray(o.filters) && o.filters.length === 0);
  return noItems && noFilters && o.customize !== true;
}

/**
 * A customized `history` block with its absent limit filled in at the engine's
 * default, or `undefined` when there is nothing to fill.
 *
 * Handles both shapes: the object tier's `{inherit, enabled, limit}` and a
 * container's `{inherit, <prefix>_enabled, <prefix>_limit}`. An INHERITING block
 * is left alone — it is dropped wholesale elsewhere, because an inherited
 * setting makes its own members inert.
 */
function historyWithDefaultLimit(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const block = v as Record<string, unknown>;
  if (block.inherit !== false) return undefined;
  const enabledKey = Object.keys(block).find((key) => key === "enabled" || key.endsWith("_enabled"));
  if (enabledKey === undefined) return undefined;
  const limitKey = enabledKey === "enabled" ? "limit" : `${enabledKey.slice(0, -"_enabled".length)}_limit`;
  if (Object.hasOwn(block, limitKey)) return undefined;
  return { ...block, [limitKey]: ENGINE_HISTORY_LIMIT };
}

/**
 * A workspace- or branch-tier history map (no `inherit` — the terminal tier)
 * with its `prompt_*` / `resource_*` pair at the default: on, depth 100.
 *
 * Those two pairs were added to the map with the MCP prompt and resource kinds,
 * so an instance from before them stores neither while a current one — and the
 * SDK — store both at the default. The engine reads the absent pair as exactly
 * that default (`prompt_enabled?=true`, `prompt_limit?=100`), so both spellings
 * are one state. Only these two new pairs, and only at their default: a pair an
 * author changed still compares.
 */
function withoutDefaultMcpHistoryPairs(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const block = v as Record<string, unknown>;
  if (Object.hasOwn(block, "inherit")) return undefined;
  const drop = ["prompt", "resource"].filter(
    (type) => block[`${type}_enabled`] === true && block[`${type}_limit`] === ENGINE_HISTORY_LIMIT,
  );
  if (drop.length === 0) return undefined;
  const out = { ...block };
  for (const type of drop) {
    delete out[`${type}_enabled`];
    delete out[`${type}_limit`];
  }
  return out;
}

/** The limit every tier of the engine's history resolver falls back to. */
export const ENGINE_HISTORY_LIMIT = 100;

/** An `@` target naming a table by local row id (`dbo=14`) rather than by guid. */
const LOCAL_DBO_REF = /^dbo=\d+$/;

/**
 * Rewrite every LOCAL table reference in a `customize` subtree to the unbound
 * spelling, and report which targets were cleared.
 *
 * A per-column override inside `customize` can carry an `@` table reference, and
 * an old engine version did not remap those to portable guids on export the way
 * it does everywhere else. What is left is a row id in the SOURCE workspace,
 * naming whatever happens to hold that id anywhere else — not identity, the same
 * conclusion {@link isBoundNumericId} reaches for a numeric reference generally.
 *
 * The decoder clears them so a pulled tree carries no confidently-wrong
 * reference, and the comparison applies the same rewrite so that deliberate
 * change does not ALSO read as a failed round trip. One implementation, used
 * from both sides, because two copies of this rule would drift.
 */
export function clearLocalDboRefs<T>(value: T, cleared?: Set<string>): T {
  if (Array.isArray(value)) {
    return value.map((item) => clearLocalDboRefs(item, cleared)) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  const next = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, member]) => [
      key,
      clearLocalDboRefs(member, cleared),
    ]),
  ) as { name?: unknown; arg?: unknown };
  if (next.name === "@" && Array.isArray(next.arg)) {
    const target = next.arg[0];
    if (typeof target === "string" && LOCAL_DBO_REF.test(target)) {
      cleared?.add(target);
      return { ...next, arg: ["dbo=", ...next.arg.slice(1)] } as unknown as T;
    }
  }
  return next as unknown as T;
}

/**
 * Statements whose `context` **IS** their tagged value, and the `tag` each one's
 * engine schema declares as that value's default.
 *
 * For all of these the engine declares every context member
 * optional-with-a-default and fills the absent ones: `filters` is a list and so
 * defaults to `[]`, `value` is declared `text` whose type default is `""`, and
 * `tag` defaults to the value below. An empty `context` therefore resolves to a
 * blank value of that tag — the same statement as one storing those members
 * explicitly. It is a second stored spelling, not a shape no authoring surface
 * can produce.
 *
 * **The tag is per-statement and MUST be read, never assumed.** Most default to
 * `const`, but the `UpdateVarBase` family overrides it per subclass — arithmetic
 * to `const:decimal`, the bitwise ops and `math_mod` to `const:int`,
 * `array_merge` to `const:array` — and `die` and `setheader` default to **input**,
 * a blank input reference rather than a constant. Assuming `const` across the
 * family would have mis-decoded five of them; this is the same trap invariant 2
 * names, where `swagger` and `api_group_enabled` are structurally identical and
 * default opposite ways.
 *
 * `named` marks the statements whose context also carries the target variable's
 * `name` (the `UpdateVarBase` family routes it there, declared `text` and so
 * also defaulting to `""`). `set_var` is not one of them — its name rides the
 * envelope `as` — and `die`/`sleep`/`setheader` have no name at all. The fill has
 * to match what the encoder writes for the recovered record, and the encoder
 * writes `name: ""` for exactly the `named` ones.
 *
 * Evidenced twice, as a default must be. The engine's optional-schema pass
 * supplies each member when the key is absent, AND real workspaces store both
 * spellings side by side — per statement, not just in aggregate: 101 `set_var`
 * carry a blank const explicitly against 18 that store nothing, and every
 * statement below has exactly one empty instance alongside its populated ones.
 *
 * Then settled on a live engine (`scripts/probe-empty-setvar.ts`), because a
 * source trace is not a behaviour: the two spellings deployed into two fresh
 * tenants bind the same value. That probe also showed the engine PERSISTS
 * whichever spelling it is handed rather than canonicalizing, so a pulled
 * workspace that stored `{}` re-exports as the EXPLICIT form — the bytes change,
 * deliberately, and the live probe is what licenses changing them at all.
 */
const EMPTY_CONTEXT_FILL: ReadonlyMap<
  string,
  { tag?: string; named: boolean; extra?: Readonly<Record<string, unknown>> }
> = new Map([
  // Its name rides the envelope `as`, so the context is the value alone.
  ["mvp:set_var", { tag: "const", named: false }],
  // Standalone classes, each declaring its own default tag.
  ["mvp:sleep", { tag: "const:int", named: false }],
  ["mvp:die", { tag: "input", named: false }],
  ["mvp:setheader", { tag: "input", named: false }],
  // `array_pop`/`array_shift` carry NO `tag`, because they take no operand:
  // popping or shifting reads nothing, their specs route no spread field, and
  // the encoder writes `name` alone. The fill must be exactly what the encoder
  // writes — filling a value they cannot author invents members the comparison
  // then demands forever, which is what shipped once when they were given the
  // full `UpdateVarBase` treatment below.
  //
  // A name-only fill is a different claim from that one, and it is evidenced
  // twice on the engine, both times on the SCALAR `name`:
  //   • the statement's own XanoScript schema declares `name?='': context.name`
  //     — the default for an absent name IS the empty string; and
  //   • the shared base class declares `name` as a plain `text` member and runs
  //     it through the same optional-schema pass that licenses every entry here.
  //
  // That second point is exactly where the loops failed (see
  // {@link LOOP_EMPTY_ITERAND}): that pass materializes a SCALAR member but
  // defaults a NESTED object to the literal string `"{}"`. `name` is a scalar,
  // `list`/`cnt` are not, and the shape is what decides. The engine's own
  // statement-transform corpus stores `{"context":{}}` for `mvp:array_shift`.
  ["mvp:array_pop", { named: true }],
  ["mvp:array_shift", { named: true }],
  // The `UpdateVarBase` family: `{name, value, tag, filters}`, `tag` overridden
  // per subclass by `getDefaultTag()`. `test/codegen/spec-inverse` asserts every
  // entry's members against the spec catalog so the two cannot drift.
  ["mvp:update_var", { tag: "const", named: true }],
  ["mvp:array_merge", { tag: "const:array", named: true }],
  ["mvp:array_push", { tag: "const", named: true }],
  ["mvp:array_unshift", { tag: "const", named: true }],
  ["mvp:bitwise_and", { tag: "const:int", named: true }],
  ["mvp:bitwise_or", { tag: "const:int", named: true }],
  ["mvp:bitwise_xor", { tag: "const:int", named: true }],
  ["mvp:math_add", { tag: "const:decimal", named: true }],
  ["mvp:math_sub", { tag: "const:decimal", named: true }],
  ["mvp:math_mul", { tag: "const:decimal", named: true }],
  ["mvp:math_div", { tag: "const:decimal", named: true }],
  ["mvp:math_mod", { tag: "const:int", named: true }],
  ["mvp:text_append", { tag: "const", named: true }],
  ["mvp:text_prepend", { tag: "const", named: true }],
  ["mvp:text_trim", { tag: "const", named: true }],
  ["mvp:text_ltrim", { tag: "const", named: true }],
  ["mvp:text_rtrim", { tag: "const", named: true }],
  ["mvp:text_starts_with", { tag: "const", named: true }],
  ["mvp:text_istarts_with", { tag: "const", named: true }],
  ["mvp:text_ends_with", { tag: "const", named: true }],
  ["mvp:text_iends_with", { tag: "const", named: true }],
  ["mvp:text_contains", { tag: "const", named: true }],
  ["mvp:text_icontains", { tag: "const", named: true }],
  // The file-resource family and `debug_log`: the context IS the value, like
  // `set_var`, but the file resources declare a sibling SCALAR (`access`) that
  // the same optional pass materializes alongside it — so the fill carries it.
  // The nested `filename` is NOT filled: a nested object defaults to the literal
  // string `"{}"` and materializes nothing.
  //
  // `extra` is exactly where the `array_pop` note above applies. `create_attachment`
  // ALSO declares `include_meta?=false`, and filling it failed the round trip —
  // the SDK's spec models no such field, so the encoder never writes it and the
  // fill demanded a member the recovered record could not produce. The fill has
  // to equal what the ENCODER writes, not everything the engine would supply.
  // (A workspace that stores a real `include_meta` still degrades to `raw()`,
  // which is the correct handling for an unmodelled member.)
  //
  // Read off each statement class's own schema, and the default tag is NOT
  // uniform across them — the file resources declare `tag?=input` while
  // `debug_log` declares `tag?=const`, the same split `die`/`setheader` have.
  ["mvp:create_image", { tag: "input", named: false, extra: { access: "public" } }],
  ["mvp:create_audio", { tag: "input", named: false, extra: { access: "public" } }],
  ["mvp:create_attachment", { tag: "input", named: false, extra: { access: "public" } }],
  ["mvp:debug_log", { tag: "const", named: false }],
]);

/**
 * A loop whose iterand is ABSENT, and the empty iterand it is REPAIRED to.
 *
 * **What the engine's optional-schema pass does and does not fill**, since this
 * keeps coming up and the answer is not uniform. That pass walks a context
 * schema and, for each absent member:
 *
 *  - SCALAR (`value: text`, `response_type?=list`) → filled with the type's
 *    default. This is why {@link EMPTY_CONTEXT_FILL} works.
 *  - LIST (`arg[]`, `filters[]`) → filled with `[]`.
 *  - NESTED OBJECT (`list:`, `cnt:`, `connection_string_flex:`) → defaulted to
 *    the literal STRING `"{}"`, which materializes nothing. The statement class
 *    then reads the key directly and faults.
 *
 * So "the schema declares a default" is not enough — the member's SHAPE decides.
 * Two clusters were mis-read on that: the loops below, and the raw-SQL family,
 * whose empty contexts look fillable until you notice `connection_string_flex`
 * is a nested object with nothing to recover.
 *
 * This is not a default the engine supplies — that was checked, and it does not.
 * `mvp:foreach` and `mvp:for` declare `list`/`cnt` as nested `{value, tag?=…,
 * filters[]}` objects with default tags and run them through the same
 * optional-schema pass that makes {@link EMPTY_CONTEXT_FILL} correct one level
 * up, but that pass defaults a nested object to the literal string `"{}"`
 * rather than materializing its members, and both statements read the key
 * directly. A live engine (`scripts/probe-empty-context.ts`) confirmed it:
 * `foreach` raises "For Each Loop: missing list argument" and `for` faults on
 * `Undefined array key "cnt"`.
 *
 * So the stored form is BROKEN — the key went missing on the way out, an empty
 * value that did not survive serialization — and 9 real statements carry it.
 * The repair gives each the benign reading of the empty value it lost: an empty
 * list, and a zero count. Both are no-ops, which is the closest a working loop
 * gets to one that cannot run.
 *
 * **This EVALUATES DIFFERENTLY and is reported as `modernized` at every site**,
 * exactly like a blank `const:obj` becoming `c.obj()`: the stored form throws at
 * runtime and the repaired form iterates nothing. That report is the whole
 * licence for it — silently turning a fault into a no-op would hide a real
 * defect in the source workspace.
 */
const LOOP_EMPTY_ITERAND: ReadonlyMap<string, { member: string; value: string; tag: string }> =
  new Map([
    ["mvp:foreach", { member: "list", value: "[]", tag: "const:array" }],
    ["mvp:for", { member: "cnt", value: "0", tag: "const:int" }],
  ]);

/** A blank value at `tag` — what the engine's optional-schema pass materializes. */
function blankValue(tag: string): Record<string, unknown> {
  return { value: "", tag, filters: [] };
}

/**
 * An `mvp:switch` context with the subject block's members stripped from the
 * ROOT, or `undefined` when there are none there.
 *
 * The statement stores its subject as a nested `context.value` block —
 * `{value, tag, filters}` — and some saves ALSO materialize that block's own
 * `tag` and `filters` alongside it at the context root:
 *
 *     context: { value: {value:"123", tag:"const:int", filters:[]},
 *                tag: "const", filters: [], elif: {…}, else: {…} }
 *
 * The root pair is exhaust. The statement reads its subject out of the nested
 * block and faults when that block has no `tag` of its own, so the root copy is
 * never consulted — and in every observed instance the two DISAGREE (`const:int`
 * nested against the schema default `const` at the root), which is what a
 * defaulted-and-unread member looks like rather than a second answer.
 *
 * Dropped only when the nested block is actually there to own them. A context
 * whose `value` is not a block has no other subject spelling, so whatever those
 * root members are, they are not exhaust and are left alone.
 *
 * `filters: []` at the root was already invisible — an empty filter chain drops
 * everywhere — so before this the pair was treated inconsistently and a
 * one-key difference cost five statements in a workspace audit their typed form.
 */
export function liveSwitchContext(stored: unknown): Record<string, unknown> | undefined {
  if (stored === null || typeof stored !== "object") return undefined;
  const { name, context } = stored as { name?: unknown; context?: unknown };
  if (name !== "mvp:switch") return undefined;
  if (context === null || typeof context !== "object" || Array.isArray(context)) return undefined;
  const block = context as Record<string, unknown>;

  const subject = block.value;
  const nested =
    subject !== null && typeof subject === "object" && !Array.isArray(subject) &&
    typeof (subject as { tag?: unknown }).tag === "string";
  if (!nested) return undefined;

  const strays = ["tag", "filters"].filter((key) => key in block);
  if (strays.length === 0) return undefined;
  return Object.fromEntries(Object.entries(block).filter(([k]) => !strays.includes(k)));
}

/**
 * An `mvp:array_map` context with the branch its `output_type` does NOT select
 * dropped, or `undefined` when there is nothing to drop.
 *
 * The statement has two mapping branches and reads exactly one: `output_type`
 * `"value"` reads `transform_value`, `"object"` reads `transform_object[]`.
 * Which members are PERSISTED depends on who saved it:
 *
 *  - the engine writes only the live branch. Live-captured, not inferred: an
 *    imported object-mode statement comes back with no `transform_value` at all
 *    (see test/fixtures/statements/array_map_object.json). That is what this SDK
 *    emits, so this rule never fires on a round trip of our own output;
 *  - the editor builds its form from the whole context schema and saves the
 *    entire form value, so an object-mode save also carries `transform_value`
 *    at its schema defaults, and a value-mode save carries `transform_object: []`.
 *    This rule exists for THAT writer. Its evidence is the editor source rather
 *    than a capture — the round-trip path reads back what the SDK imported, so
 *    it cannot produce the editor's spelling to be captured.
 *
 * Neither spelling can change what the statement does — the engine's map loop
 * branches on `output_type` and reads exactly one of the two, so the other is
 * never looked at whatever it holds. This is one state stored two ways, the same
 * shape as the `return`-section and trigger-`meta` rules above.
 *
 * A POPULATED dead branch goes too, and that is the part worth stating plainly:
 * those are real bytes, and dropping them means a pull-then-deploy no longer
 * carries the rows an author left behind when they switched the statement's
 * mode. It is done because the alternative was worse — the whole statement fell
 * to `raw()`, so it could not be read or re-authored at all — and because the
 * engine line above says the rows cannot affect a run. It is NOT done quietly:
 * the decoder reports the drop as an `expected-omission` naming what went.
 */
export function liveArrayMapContext(stored: unknown): Record<string, unknown> | undefined {
  if (stored === null || typeof stored !== "object") return undefined;
  const { name, context } = stored as { name?: unknown; context?: unknown };
  if (name !== "mvp:array_map") return undefined;
  if (context === null || typeof context !== "object" || Array.isArray(context)) return undefined;
  const block = context as Record<string, unknown>;

  const dead = (block.output_type ?? "value") === "object" ? "transform_value" : "transform_object";
  if (!(dead in block)) return undefined;

  return Object.fromEntries(Object.entries(block).filter(([k]) => k !== dead));
}

/**
 * The `context` the engine's optional-schema pass would produce for `stored`,
 * or null when this statement has no such fill.
 *
 * Two cases, and they are NOT the same kind of thing:
 *
 *  - {@link EMPTY_CONTEXT_FILL} — the whole context IS the value and the engine
 *    genuinely supplies the members. Byte-changing but behaviour-preserving.
 *  - {@link LOOP_EMPTY_ITERAND} — the iterand went missing and the engine does
 *    NOT supply it. This is a REPAIR that evaluates differently, and every site
 *    is reported as `modernized` by the loop decoder.
 *
 * The decoder reads this to recover the value, and the comparison reads it so
 * the recovered statement's explicit re-encode still matches the sparse stored
 * spelling. One implementation, used from both sides, because two copies of this
 * rule would drift and the drift would be invisible.
 */
export function filledContext(stored: unknown): Record<string, unknown> | null {
  if (stored === null || typeof stored !== "object") return null;
  const { name, context } = stored as { name?: unknown; context?: unknown };
  if (typeof name !== "string") return null;

  const whole = EMPTY_CONTEXT_FILL.get(name);
  if (whole) {
    // All three empty spellings: `{}` from the SDK, `[]` from the engine's
    // serializer, and `null` from a current engine.
    const empty =
      context === null ||
      (Array.isArray(context) && context.length === 0) ||
      (typeof context === "object" && Object.keys(context).length === 0);
    if (!empty) return null;
    // No tag means no operand — the fill is the name alone.
    if (whole.tag === undefined) return { name: "" };
    return {
      ...(whole.named ? { name: "" } : {}),
      ...blankValue(whole.tag),
      ...(whole.extra ?? {}),
    };
  }

  const loop = LOOP_EMPTY_ITERAND.get(name);
  if (loop) {
    if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
    const block = context as Record<string, unknown>;
    if (block[loop.member] !== undefined) return null;
    return { ...block, [loop.member]: { value: loop.value, tag: loop.tag, filters: [] } };
  }
  return null;
}

/**
 * The six trigger `meta` action groups at rest — every flag off, every list
 * empty. Mirrors the skeleton the trigger factories synthesize.
 */
const INERT_TRIGGER_META_GROUPS: Readonly<Record<string, unknown>> = {
  database: {
    datasource: [],
    search: { expression: [] },
    action: { delete: false, insert: false, truncate: false, update: false },
  },
  toolset: { action: { connection: false } },
  workspace: { action: { branch_live: false, branch_merge: false, branch_new: false } },
  workspace_realtime_channel: { action: { message: false, join: false } },
  realtime_server: { action: { connect: false, disconnect: false } },
  channel: { action: { join: false, leave: false, deliver: false } },
};

/**
 * A trigger `meta` with its inert action groups dropped, or `undefined` when the
 * value is not a trigger meta.
 *
 * Every trigger carries the WHOLE six-group skeleton with only its own group's
 * flags set — that is what the engine writes today and what the factories
 * synthesize. Real workspaces disagree: across a 25-bundle sweep, all 24 stored
 * triggers carried only two to four of the groups, because a trigger saved before
 * a group existed never gained it and nothing re-saves it. The engine reads an
 * absent group and an all-off group identically (there is no flag to read either
 * way), so the two are one state stored in two generations of spelling.
 *
 * Dropping the inert ones from both sides is what lets a subset-meta trigger
 * decode to a factory call — `tableTrigger` has no argument for "which groups the
 * engine happened to persist", and without this rule every real-world trigger
 * would fail its round-trip check and fall back to `satisfies`.
 *
 * Deliberately narrow. Only a group that deep-equals its all-off default is
 * dropped, and only under a `meta` key whose members are all recognized group
 * names — so a NON-default group still compares, and a `meta` belonging to
 * anything other than a trigger is left entirely alone.
 */
function withoutInertTriggerMetaGroups(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (!entries.every(([k]) => Object.hasOwn(INERT_TRIGGER_META_GROUPS, k))) return undefined;
  const kept = entries.filter(([k, v]) => !deepEqual(v, (Object.hasOwn(INERT_TRIGGER_META_GROUPS, k) ? INERT_TRIGGER_META_GROUPS[k] : undefined)));
  return kept.length === entries.length ? undefined : Object.fromEntries(kept);
}

/** The canonical `prompts`/`resources`/`auth` trigger inputs, normalized, by name. */
let canonicalToolsetPrimitives: ReadonlyMap<string, unknown> | undefined;

function toolsetPrimitive(name: unknown): unknown {
  canonicalToolsetPrimitives ??= new Map(
    impliedInputs("toolset", "mcp")
      .filter((i) => i.name === "prompts" || i.name === "resources" || i.name === "auth")
      .map((i) => [i.name, normalize(i)]),
  );
  return typeof name === "string" ? canonicalToolsetPrimitives.get(name) : undefined;
}

/**
 * A toolset trigger's `input` without its canonical `prompts`, `resources` and
 * `auth` entries.
 *
 * An MCP server's trigger receives all three after `toolset`/`tools`, and the
 * SDK always writes them. A trigger saved before they existed stores none of
 * them (or only the first two), and nothing re-saves it. The spellings behave
 * the same: no stored stack can read an input its trigger never had, a
 * response without the key leaves that list unfiltered, and the signed-in user
 * the platform passes as `auth` reaches the stack either way.
 *
 * Only an entry equal to the canonical one is dropped, so a mis-shaped entry on
 * either side still compares.
 */
function withoutToolsetPrimitiveInputs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((i) => {
    const canonical = toolsetPrimitive((i as { name?: unknown } | null)?.name);
    return canonical === undefined || !deepEqual(normalize(i), canonical);
  });
}

export function normalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
    // stored here, where assigning it on a plain `{}` sets a prototype instead.
    const out = Object.create(null) as Record<string, unknown>;
    // A `const:obj` stored blank in its TWO blank spellings — `value:""` and
    // `value:null`. These really are one value: the engine JSON-decodes the
    // stored string and both yield null. Canonicalize to `""`, the form
    // `c.obj(null)` writes and the dominant one in the corpus (96 vs 17).
    //
    // NOT `"{}"`: that is not an equivalence — `{}` decodes to an empty object,
    // not null — and it would let a decoded `c.obj()` "round-trip" while
    // re-pointing statements at a different value on the next deploy. An alias
    // is a semantic claim (invariant 3); the engine's evaluator is what settles
    // it, and it says these two are equal and `{}` is not.
    const blankObj =
      (value as { tag?: unknown }).tag === "const:obj" &&
      "value" in (value as object) &&
      ((value as { value?: unknown }).value === "" ||
        (value as { value?: unknown }).value === null);
    // A table (`dbo`) object carries a `schema` array but no `context`. Older
    // golden export fixtures store a top-level `as:<name>` on tables; live
    // `mvp_dbo` never does (a table returns nothing). Drop it on both sides.
    const isTable = "schema" in (value as object) && !("context" in (value as object));
    // `mvp:create_auth` stores its four named entries in two different orders —
    // `dbtable, extras, expiration, id` on 21 of 25 real statements and
    // `id, dbtable, extras, expiration` on the other 4 — and the SDK can only
    // write one of them. Ordering them by name on BOTH sides makes the two
    // spellings compare equal.
    //
    // Scoped to this one statement, and only because a live round trip settled
    // it: both orders mint a token, and the engine persists whichever order it
    // is handed rather than canonicalizing. The entries are named parameters, so
    // position carries nothing — but that is a fact about this statement, not a
    // licence to sort `input[]` anywhere else, where order IS meaningful (a row
    // write's columns, a lookup's leading field_name/field_value).
    const sortsInput = NAME_KEYED_INPUT.has((value as { name?: unknown }).name as string);
    // …and a statement whose `input[]` the engine cannot reach at all drops it
    // outright, on both sides (see {@link UNREADABLE_INPUT}).
    const dropsInput = UNREADABLE_INPUT.has((value as { name?: unknown }).name as string);
    // …and one that carries an input the statement USED to declare drops just
    // that entry (see {@link RETIRED_INPUT}).
    const retired = retiredInputs((value as { name?: unknown }).name);
    // A sparse context — empty, or missing a loop's iterand — is one spelling of
    // the members the engine's optional-schema pass supplies. Substitute them so
    // that spelling compares equal to the explicit one (see {@link filledContext}).
    const contextFill = filledContext(value);
    // An `array.map` whose stored context carries BOTH mapping branches — what an
    // editor save writes — reduced to the one its `output_type` reads.
    const arrayMapContext = liveArrayMapContext(value);
    // An `mvp:switch` carrying its subject block's members at the context root
    // as well (see {@link liveSwitchContext}).
    const switchContext = liveSwitchContext(value);
    // An expression node whose live branch is the nested group: its `statement`
    // member is scaffolding the engine never reads (see
    // {@link isBlankGroupStatement}).
    const isGroupNode = (value as { type?: unknown }).type === "group";
    // A middleware attachment block, identified by its own flags rather than by
    // the generic names `pre`/`post`. A phase list is read ONLY when its
    // `_customize` flag is set — the engine's resolver returns it on that branch
    // and otherwise falls through to the parent tier without looking at the list
    // — so a list sitting behind an off flag is an editor leftover the engine
    // never runs, and compares equal to the empty list the SDK writes.
    const isMiddlewareBlock =
      "pre_customize" in (value as object) || "post_customize" in (value as object);
    // A REQUIRED schema descriptor's `default` is discarded by the engine before
    // anything reads it, in whichever spelling it was stored. See the block
    // comment on this rule above for the engine line and the evidence.
    const isDescriptor = "type" in (value as object) && "required" in (value as object);
    const requiredEntry = (value as { required?: unknown }).required === true;
    for (const [k, stored] of Object.entries(value as Record<string, unknown>)) {
      // A `context.return` is reduced BEFORE any other rule sees it: it keeps
      // only the branch its `type` selects — the editor writes all four and the
      // engine reads one ({@link liveReturnSection}) — and sheds the inert
      // `iterator` inside whichever branch survives ({@link returnWithoutIterator}).
      // Reducing first is what lets the default-envelope drop below still fire:
      // a section that is all editor exhaust collapses to the minimal `{type}`,
      // which is the spelling the SDK omits entirely.
      // A call's `runtime` block is reduced the same way and for the same
      // reason: only the members its `mode` actually reads survive (see
      // {@link liveAsyncRuntime}), so a block that is all exhaust collapses to
      // the unset state the default-envelope drop below already handles.
      // A `result[]` keeps only the entries the engine's response builder reads
      // (see {@link liveResultItems}); the dead ones are editor exhaust the SDK
      // does not write back.
      const v =
        k === "expr"
          ? withoutLeadingJoin(stored)
          : k === "result"
          ? (liveResultItems(stored) ?? stored)
          : k === "return"
          ? (() => {
              const live = liveReturnSection(stored) ?? stored;
              return returnWithoutIterator(live) ?? live;
            })()
          : k === "runtime"
            ? (liveAsyncRuntime(stored) ?? stored)
            : stored;
      // A saved test's auth `token` is dropped from BOTH sides. It is an
      // expiring credential, so the decoder deliberately does not write it into
      // a committed tree (it reports the omission instead) — and comparing a
      // key one side will never carry would make every authenticated saved test
      // read as a failed round trip on top of the omission it already reported.
      // Exactly one of "left behind" and "does not re-export" should fire.
      if (k === "token" && isSavedTest(value)) continue;
      // A saved test's `id` is NOT a server column. It is the test's identity,
      // and the key a statement's `mocks` map is stored against — so a pull that
      // reminted it would silently detach every mock. Kept, against the generic
      // `id` strip, and keyed on the entry's shape rather than the name: real
      // workspaces hold table columns called `test` and const values "test".
      if (k === "id" && isSavedTest(value)) {
        out[k] = v;
        continue;
      }
      if (STRIP_KEYS.has(k)) continue;
      if (isTable && k === "as") continue;
      if (isGroupNode && k === "statement") continue;
      if (
        isMiddlewareBlock &&
        (k === "pre" || k === "post") &&
        (value as Record<string, unknown>)[`${k}_customize`] !== true
      ) {
        continue;
      }
      // Full-envelope members at their empty default: a representational
      // artifact between the parser and persisted generations — drop on both
      // sides (see {@link isDefaultEnvelopeMember}).
      // A raw-SQL statement's positional bind arguments, in both spellings of
      // "none". The live postgres capture in
      // `test/fixtures/statements/db_external_query.json` stores
      // `context.arg: []`; the 22 statements the audit measured (4 direct query,
      // 9 mysql, 9 snowflake) store no `arg` key at all. Both are the engine's
      // own bytes, and an encoder can only write one of them — so whichever it
      // writes manufactures a mismatch against the other and every parameterless
      // query in a pulled workspace degrades to `raw()`. Drop the
      // empty form on both sides; a populated `arg[]` is authored state and is
      // preserved and still compared.
      if (k === "arg" && isEmptyArray(v) && isRawSqlContext(value)) continue;
      if (isDefaultEnvelopeMember(k, v)) continue;
      if (isDescriptor && k === "default") {
        // Required: discarded outright. Otherwise: `null` and `""` converge in
        // every remaining branch, so they are one state and a real default like
        // `"now"` or `"pre"` still survives.
        if (requiredEntry || v === null || v === "") {
          out[k] = null;
          continue;
        }
      }
      // `output` is an object only on statements; drop it when it carries no
      // selected items / customization (the `output:[]` array on query/function
      // envelopes is unaffected and falls through to normal handling).
      if (k === "output" && isEmptyOutput(v)) continue;
      // A CUSTOMIZED history block whose limit member is absent: materialize it
      // at the engine's default, so the older save and the current one are one
      // state. Evidenced twice, which is what invariant 2 asks for — every limit
      // read in the engine's resolver is `?? 100`, at every tier (object,
      // api-group, toolset, channel, server, branch, workspace), and the corpus
      // holds both spellings side by side on the SAME key (69 api groups store
      // `query_limit: 100`, 9 omit it). The editor renders the absent form as
      // 100 and writes it back on the next save, which is the generational gap
      // that produced both.
      //
      // Only the LIMIT converges. An absent `*_enabled` is left alone: its
      // default varies by object type (`function`/`middleware`/`trigger` are
      // off, the rest on), so one rule here would have to re-derive the type,
      // and a wrong guess would change what the engine records.
      if (k === "history") {
        const trimmed = withoutDefaultMcpHistoryPairs(v);
        if (trimmed !== undefined) {
          out[k] = normalize(trimmed);
          continue;
        }
        const filled = historyWithDefaultLimit(v);
        if (filled !== undefined) {
          out[k] = normalize(filled);
          continue;
        }
      }
      // A trigger's `meta` carrying only SOME of the six action groups: the
      // absent ones are one spelling of "all flags off" (see
      // {@link withoutInertTriggerMetaGroups}).
      if (k === "meta") {
        const reduced = withoutInertTriggerMetaGroups(v);
        if (reduced !== undefined) {
          out[k] = normalize(reduced);
          continue;
        }
      }
      // A toolset trigger's `prompts`/`resources`/`auth` inputs: see
      // {@link withoutToolsetPrimitiveInputs}.
      if (k === "input" && (value as { obj_type?: unknown }).obj_type === "toolset" && "meta" in (value as object)) {
        out[k] = normalize(withoutToolsetPrimitiveInputs(v));
        continue;
      }
      // `customize` empty form is a serialization-generation artifact: the corpus
      // emits `{}` on some fields and `""` on others within the *same* table, with
      // no authoring distinction. Canonicalize both empties to the CURRENT form
      // — `{}`, what the engine and the SDK write today — so field comparisons
      // ignore it (a non-empty customize is preserved and still compared).
      //
      // The direction matters. Normalizing toward `""` made the legacy shape the
      // canonical one, which no authoring surface can emit; every column carrying
      // it was therefore declared unrepresentable and forced through
      // `rawField()`. Canonicalizing forward instead means a legacy column
      // decodes to the same readable `f.*` call as its modern twin, and the tree
      // re-exports the current form. `""` is a shape this SDK reads and never
      // writes.
      if (k === "customize" && isEmptyCustomize(v)) {
        out[k] = {};
        continue;
      }
      // A populated customize: clear any LOCAL table reference inside it before
      // comparing, matching the decoder's own rewrite (see
      // {@link clearLocalDboRefs}). Scoped to this subtree — a numeric reference
      // at FIELD level is a different, already-settled case that stays verbatim.
      if (k === "customize") {
        out[k] = normalize(clearLocalDboRefs(v));
        continue;
      }
      // An empty `context` arrives as `[]` from the engine and `{}` from the SDK:
      // an empty associative collection serializes as a JSON array, so the two
      // are the same "no context" state with no authoring distinction.
      // Canonicalize forward to `{}` — the form the SDK writes — so the split
      // does not fail an otherwise-equal statement, and so the `context.*` rules
      // below always see one shape.
      //
      // Scoped to `context` deliberately. A blanket array→object coercion would
      // corrupt every genuinely-empty list in the envelope.
      // A query's saved request/response SAMPLE is OPAQUE: recorded payload,
      // not a structure this normalizer has any business reducing. Its keys are
      // whatever the endpoint takes and returns, and a payload that happens to
      // hold one named `input` or `output` was being rewritten by the
      // engine-envelope rules meant for statement envelopes — which reduced one
      // real 700-byte sample to `{}`. Copied through untouched instead.
      if (k === "example") {
        // A half holding null is the same state as an absent one — the engine
        // stores absence, verified on a live round trip — so they converge here
        // rather than reading as a byte difference.
        out[k] = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(([, half]) => half !== null),
        );
        continue;
      }
      if (dropsInput && k === "input") continue;
      // An input the statement no longer declares (see {@link RETIRED_INPUT}) is
      // dropped from both sides, so a workspace written before the removal
      // compares equal to one written after it.
      if (k === "input" && Array.isArray(v) && retired.length > 0) {
        out[k] = v
          .filter((entry) => !retired.includes(String((entry as { name?: unknown })?.name ?? "")))
          .map((entry) => normalize(entry));
        continue;
      }
      if (sortsInput && k === "input" && Array.isArray(v)) {
        out[k] = [...v]
          .sort((a, b) =>
            String((a as { name?: unknown })?.name ?? "").localeCompare(
              String((b as { name?: unknown })?.name ?? ""),
            ),
          )
          .map((entry) => normalize(entry));
        continue;
      }
      // An `auth` block naming no table: `dbo_id: 0` is the editor's spelling of
      // the member the SDK omits (see {@link unboundAuthTable}).
      if (k === "auth") {
        const unbound = unboundAuthTable(v);
        if (unbound) {
          out[k] = normalize(unbound);
          continue;
        }
      }
      // An `mvp:array_map` carrying the branch its `output_type` does not select:
      // editor exhaust the engine never reads (see {@link liveArrayMapContext}).
      if (k === "context" && arrayMapContext) {
        out[k] = normalize(arrayMapContext);
        continue;
      }
      // An `mvp:switch` whose subject block's `tag`/`filters` were materialized
      // at the context root as well: fill the statement never reads.
      if (k === "context" && switchContext) {
        out[k] = normalize(switchContext);
        continue;
      }
      if (k === "context" && contextFill) {
        out[k] = normalize(contextFill);
        continue;
      }
      // `null` is the THIRD spelling of no-context, alongside the `[]` and `{}`
      // above. It does not appear anywhere in the 177-project corpus — that
      // instance is old — and turned up on a current one under `mvp:create_auth`,
      // whose declared context schema is empty outright: the statement
      // has no context to hold, so every empty spelling of it is the same
      // nothing. Canonicalize to `{}` with the others, or the statement loses its
      // readability to a key the engine never reads.
      if (k === "context" && (isEmptyArray(v) || v === null)) {
        out[k] = {};
        continue;
      }
      // `arg` (filter/method arguments) is numeric/string-inconsistent in the
      // corpus (`[8]` vs `["10"]`) — the same artifact as `value`; coerce the
      // numbers to the SDK's string form so the comparison ignores it.
      if (k === "arg" && Array.isArray(v)) {
        out[k] = v.map((e) => (typeof e === "number" ? String(e) : normalize(e)));
        continue;
      }
      // A paging int persisted as a numeric STRING. These coerce toward the NUMBER,
      // the opposite direction to `value`/`arg` above, because that is what each
      // form declares: a tagged `value` is a string, `page`/`per_page`/`offset` are
      // ints. Same artifact, canonicalized toward the declared type in both cases.
      //
      // The default-holding forms already reconcile via `isNumber`; this is for a
      // CUSTOMIZED one, where a stored `"10"` against an encoded `10` cost 11
      // `db.query` statements their readability.
      //
      // An addon's `offset` shares the key name and holds a response PATH
      // (`"items[]"`), which is not a numeric string and so passes through — the
      // same coexistence the two `offset` rules already rely on.
      if (PAGING_INT_KEYS.has(k) && typeof v === "string" && /^-?\d+$/.test(v)) {
        out[k] = Number(v);
        continue;
      }
      // `value` coercion absorbs a corpus inconsistency (the SDK always emits the
      // string form; only older goldens carry the number). `temperature` is a
      // different case: the SDK's agent encoder emits a NUMBER (buildProviderConfig
      // in src/kinds/agent.ts) but the engine persists a string ("1"), so this
      // absorbs a real SDK↔engine divergence — proven for the openai golden. The
      // deeper fix is to stringify temperature in the encoder once goldens for the
      // other providers confirm the same (agent objects aren't capturable via the
      // function-only round-trip path today).
      if (k === "value" && blankObj) {
        out[k] = "";
        continue;
      }
      // A tagged `value` is declared a STRING (`TaggedValue.value`), and the engine
      // persists a `const:bool` either way — `value: false` and `value: "false"` are
      // the same authored boolean. Coerced for the same reason as the numeric form
      // directly above, and it is what a stored `context.lock` costs otherwise: 25
      // `db.query` statements degraded to `raw()` over the spelling of one flag.
      //
      // Only `true`/`false` under a `value` key. A boolean anywhere else keeps its
      // type and is still compared.
      // `operand` is the same tagged value under the name a COMPARISON gives it
      // (`statement.left` / `statement.right`), and the corpus is inconsistent
      // there for the same reason: a real workspace stores `const:int` `0` as the
      // number while the SDK writes the documented string.
      //
      // Leaving it out was a silent hole rather than a missing nicety. The
      // decoders hand `prove` the STORED value object as the factory argument, so
      // a re-encode reproduces the number and the proof passes — while the source
      // it emits says `c.int(0)`, which encodes `"0"`. The proof therefore could
      // not see a difference that `verify` (comparing a real re-export) reports.
      out[k] =
        (k === "value" || k === "operand" || k === "temperature") &&
        (typeof v === "number" || typeof v === "boolean")
          ? String(v)
          : normalize(v);
    }
    return out as unknown as T;
  }
  // Collapse the two persisted timestamp serializations to one instant (Branch A
  // serialization artifact) — see {@link canonicalizeTimestamp}. Non-timestamp
  // strings pass through untouched.
  if (typeof value === "string") {
    const ts = canonicalizeTimestamp(value);
    if (ts !== undefined) return ts as unknown as T;
  }
  return value;
}
