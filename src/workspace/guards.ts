/**
 * Export-time guards for authoring shapes that can only produce a failed
 * deploy, and the build-time warnings for shapes that succeed with the wrong
 * result.
 *
 * The bar for a guard here is deliberately high, and it is NOT "the engine
 * currently rejects this" — most of the audit's engine-class findings are bugs
 * in a single engine code path, against shapes the engine's own tooling emits.
 * Blocking those would disable a supported feature and have to be un-shipped
 * the moment the engine is fixed. They are labelled `external` on the tracker
 * and carry a regression test in `test/workspace/diagnostics.test.ts` asserting
 * NO diagnostic fires: `useXdo: true`, a `.` in a query name and
 * `idType: "uuid"`.
 *
 * There are currently NO hard guards on engine-rejected shapes, and that is the
 * considered position rather than an omission. A seeded table carrying a
 * non-scalar column was guarded here for exactly one release, on the
 * strength of a live reproduction; the cause turned out to be a stale
 * per-worker model cache upstream that dropped a column's value
 * cast, which is fixed and was never anything an author could avoid. A
 * reproduction proves a symptom, not a rule — the guards that survive are the
 * ones about Xano SDK's OWN contract (a reference must name something the
 * bundle carries), not ones asserting what the engine will accept.
 */
import { COLUMN_NAME_UNUSABLE, tableColumns, tableIndexes, isSeedFileSource, unusableColumns } from "../kinds/table.js";
import { emailAddress } from "../fields/email-address.js";
import { coerceSeedRowValues, assertSeedIds, assertSeedUnique, isNonPublicColumn, isUuid } from "./seed-coerce.js";
import { guidSeedHint, refSpelling, resolveRef } from "../refs/guid.js";
import { statementLabel } from "../statements/statement.js";
import { roleColumnProblem } from "../statements/guard.js";
import { appNamesByGuid, identityNamesByGuid, lockNameForObject } from "../lock/lock.js";
import { DECODE_ONLY_STATEMENTS } from "../statements/decode-only.js";
import { READ_UNCONDITIONALLY } from "../statements/schema-dsl/overrides.js";
import { isQueryExpressionFilter } from "../values/query-filters.js";
import { PAGING_ENVELOPE_ROOTS } from "../statements/special/output-select.js";
import { FILTER_NAMES } from "../values/generated/filters.generated.js";
import { reversedRegexOperands, sys } from "../values/value.js";
import { LAMBDA_CODE_FILTERS, maskNonCode } from "../values/lambda.js";
import { unguardedArgPlaceholders } from "./template-args.js";
import type { TableDef } from "../kinds/table.js";
import type { TaggedValue } from "../types/xdo.js";
import {
  apiGroupScope,
  documentationScopeLabel,
  documentationTokenLiteral,
  SCAFFOLD_SECRETS_REMEDY,
  supplyTokenRemedy,
  allowEmptyTokenRemedy,
  type SecretsRemedy,
  type DocumentationScope,
} from "./documentation-token.js";
import { safeNames } from "../util/env-name.js";
import { sdkKindName } from "../util/sdk-kind.js";
import { nearestKey } from "../util/known-keys.js";
import { isLiveDatasource, liveDatasourceMessage } from "../kinds/datasource.js";
import { microserviceHandleName } from "../kinds/microservice.js";
import { CORS_UNMATCHABLE, describeUnmatchableOrigins, unmatchableOrigins } from "../kinds/api-group.js";
import { findNonJson, nonJsonMessage } from "./non-json.js";
import { toolsetTargetField } from "../kinds/toolset-target.js";
import { DiagnosticError, type DiagnosticBag } from "./diagnostics.js";

// --- stack warnings: shapes that succeed with HTTP 200 and the wrong result ---

/** Statement names the stack walk keys on. */
const BULK_UPDATE = "mvp:dbo_bulkupdate";
const DB_GET = "mvp:dbo_getby";
const DB_QUERY = "mvp:dbo_view";
/** The db statements whose result is ONE row, which their `output` selects from. */
const ROW_OUTPUT_STATEMENTS: ReadonlySet<string> = new Set([
  DB_GET,
  "mvp:dbo_add",
  "mvp:dbo_editby",
  "mvp:dbo_patch",
  "mvp:dbo_addoreditby",
]);
const GET_ALL_INPUT = "mvp:get_all_input";

/**
 * Auto-injected columns an author is not expected to restate on a bulk item:
 * `id` targets the row, and `created_at` carries an engine default.
 */
const SYSTEM_COLUMNS = new Set(["id", "created_at"]);

/** One encoded statement, loosely typed — only the keys the walk reads. */
interface EncodedStatement {
  readonly name: string;
  readonly as?: unknown;
  readonly input?: unknown;
  readonly context?: unknown;
  readonly output?: unknown;
}

/**
 * Visit every object and array under `root`, in source order.
 *
 * Iterative, and shared by every collector below, because the shape being
 * crossed is the AUTHOR's: a deep expression tree or a hand-built `raw()`
 * payload made each recursive walk die with a bare `RangeError` from inside a
 * guard the author never called. Children are pushed in reverse so
 * they pop in order — the diagnostics these feed are reported in the order the
 * findings were made, and reversing siblings would silently reorder an author's
 * error list.
 */
export function walkNodes(root: unknown, visit: (node: Record<string, unknown>) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    visit(record);
    const values = Object.values(record);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
}

/**
 * Every statement in an object, including those nested in a conditional or a
 * loop. A statement is any object carrying a `mvp:`-prefixed `name`, which is
 * the one marker every encoded statement shares regardless of where it sits.
 */
function collectStatements(node: unknown, out: EncodedStatement[]): void {
  walkNodes(node, (record) => {
    if (typeof record.name === "string" && record.name.startsWith("mvp:")) {
      out.push(record as unknown as EncodedStatement);
    }
  });
}

/** The named entry of a statement's `input[]`, if present. */
function statementInput(
  statement: EncodedStatement,
  name: string,
): { tag?: unknown; value?: unknown } | undefined {
  if (!Array.isArray(statement.input)) return undefined;
  return statement.input.find(
    (entry) => (entry as { name?: unknown })?.name === name,
  ) as { tag?: unknown; value?: unknown } | undefined;
}

/** The table guid a db statement is bound to (`context.dbo.id`). */
function statementTableGuid(statement: EncodedStatement): string | undefined {
  const id = (statement.context as { dbo?: { id?: unknown } } | undefined)?.dbo?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * A db statement bound to no table (`context.dbo.id: ""`) — `table: null`.
 *
 * That is the engine's own broken state: the statement does nothing wherever it
 * runs. A pulled tree must be able to spell it (a deleted table leaves exactly
 * these bytes, and the pull already reports each one), so a plain export stays
 * silent. `--strict` is the switch that says "nothing broken ships", and a step
 * that silently does nothing is broken — so under it each one is a failure,
 * named by owner and statement.
 */
function checkBlankTableBindings(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  if (!bag.strict) return;
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      const blank = statements.filter((st) => statementTableGuid(st) === "");
      if (blank.length === 0) continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const which = [...new Set(blank.map((st) => `\`${statementLabel(st.name)}\``))].join(", ");
      bag.warn(
        "stack.blank-table",
        `${owner} has ${blank.length === 1 ? "a db statement" : `${blank.length} db statements`} (${which}) ` +
          `bound to no table (\`table: null\`) — ${blank.length === 1 ? "it does" : "they do"} nothing when ` +
          `run. Point ${blank.length === 1 ? "it" : "each"} at a table, or remove ${blank.length === 1 ? "it" : "them"}.`,
        obj,
      );
    }
  }
}

/**
 * `s.db.bulk.update` is a full-row REPLACE, and nothing says so.
 *
 * Confirmed in the engine: bulk update and bulk patch run the same code and
 * differ by one argument to the input-schema builder — update keeps each
 * column's default and writes it, patch strips defaults so an absent key
 * contributes nothing. So an item shaped `{ id, status }` applies the status
 * and writes every other column to its zero value: text to `""`, int to `0`.
 * HTTP 200, no error, data gone.
 *
 * This warns rather than blocks: replacing a row IS the statement's job, and an
 * author who supplies a deliberate subset may mean it. Only a STATIC items
 * array can be checked — a `ref` is opaque at build time, which is a documented
 * limit of the check rather than a silent gap.
 */
function checkBulkUpdate(
  statement: EncodedStatement,
  owner: string,
  subject: object,
  tablesByGuid: ReadonlyMap<string, TableDef>,
  bag: DiagnosticBag,
): void {
  const guid = statementTableGuid(statement);
  const def = guid === undefined ? undefined : tablesByGuid.get(guid);
  if (!def) return;
  const items = statementInput(statement, "items");
  // A `ref`/`var` items list carries no keys to compare — say nothing.
  if (typeof items?.tag !== "string" || !items.tag.startsWith("const")) return;
  if (typeof items.value !== "string") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(items.value);
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  const supplied = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const key of Object.keys(item as Record<string, unknown>)) supplied.add(key);
  }
  if (supplied.size === 0) return;

  const cleared = tableColumns(def)
    .map((col) => col.name)
    .filter((name) => !SYSTEM_COLUMNS.has(name) && !supplied.has(name));
  if (cleared.length === 0) return;

  bag.warn(
    "db.bulk-update-partial-item",
    `${owner}: \`s.db.bulk.update\` on table "${def.name}" is a full-row REPLACE, and these ` +
      `items omit ${cleared.map((n) => `"${n}"`).join(", ")} — each omitted column is written ` +
      `to its zero value ("" / 0 / null), not left alone, with an HTTP 200 and no error. Use ` +
      `\`s.db.bulk.patch\` to write only the keys an item carries, or supply every column you ` +
      `mean to preserve. (Only a static \`items\` array is checked; a \`ref\` cannot be.)`,
    subject,
  );
}

/** Column names a `db.get` will return, or `undefined` when it returns the default set. */
function outputColumns(statement: EncodedStatement): Set<string> | undefined {
  const output = statement.output as
    | { items?: unknown; customize?: unknown }
    | undefined;
  if (!output || output.customize !== true || !Array.isArray(output.items)) return undefined;
  const names = new Set<string>();
  for (const item of output.items) {
    const name = (item as { name?: unknown })?.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

/**
 * Every stack-variable reference inside an object.
 *
 * A `var` reference is spelled TWO ways depending on where it sits. As an
 * ordinary value it carries `value`; as a comparison OPERAND — inside an
 * `if`/`elif`/`while` condition, a `precondition`, a `db.query` `where`, or an
 * `array.*` predicate — the same reference carries `operand` instead. Reading
 * only `value` would miss every reference in a condition, which is most of them.
 */
function collectVarRefs(
  node: unknown,
  out: string[],
  skip?: ReadonlySet<unknown>,
): void {
  walkNodes(node, (record) => {
    exprReads(record, "var", out);
    if (record.tag !== "var") return;
    // A skipped record's OWN name is left out; the walk still descends into
    // its filter chain, whose arguments are ordinary reads.
    if (skip?.has(record)) return;
    if (typeof record.value === "string") out.push(record.value);
    if (typeof record.operand === "string") out.push(record.operand);
  });
}

/**
 * The `$<root>.name.path` reads inside an expression value.
 *
 * `obj({ z: ref("x") })` (and a `c.expression`) stores ONE `const:expr2` whose
 * value is expression source — `{ z: $var.x }` — so its members carry no tagged
 * value for a walker to find. Read outside string literals.
 */
function exprReads(record: Record<string, unknown>, root: "var" | "input" | "env", out: string[]): void {
  if (record.tag !== "const:expr2") return;
  for (const text of [record.value, record.operand]) {
    if (typeof text !== "string" || !text.includes(`$${root}.`)) continue;
    const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    for (const m of code.matchAll(EXPR_READ[root])) out.push(m[1]!);
  }
}

const EXPR_READ = {
  var: /\$var\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g,
  input: /\$input\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g,
  env: /\$env\.([A-Za-z_$][\w$]*)/g,
} as const;

/**
 * The two assertions whose SUBJECT is a variable's existence. An unbound name
 * there is not a runtime failure: `to_not_be_defined` catches the engine's
 * `Missing var entry` and passes on it, and `to_be_defined` is asserting about
 * exactly that. The subject (authored `expr`) is stored at `context.value1`.
 */
const EXISTENCE_ASSERTIONS = {
  "mvp:test_expect_to_not_be_defined": "exempt",
  "mvp:test_expect_to_be_defined": "never-bound",
} as const;

/** Each existence assertion's subject record, keyed by what it asserts. */
function existenceSubjects(
  statements: readonly EncodedStatement[],
): Map<unknown, (typeof EXISTENCE_ASSERTIONS)[keyof typeof EXISTENCE_ASSERTIONS]> {
  const subjects = new Map<unknown, "exempt" | "never-bound">();
  for (const statement of statements) {
    const role = EXISTENCE_ASSERTIONS[statement.name as keyof typeof EXISTENCE_ASSERTIONS];
    if (!role) continue;
    const subject = (statement.context as { value1?: { tag?: unknown } } | undefined)?.value1;
    if (subject && typeof subject === "object" && subject.tag === "var") subjects.set(subject, role);
  }
  return subjects;
}

/**
 * Reading an `access: "internal"` column that the `db.get` did not return.
 *
 * An internal column is absent from a `db.get` result unless `output` names it
 * — `output` overrides column visibility. `f.password` defaults to
 * `access: "internal"`, so the canonical login stack (the most-copied stack in
 * the SDK) reads `ref("u.password")` against a row that has no `password` key
 * and dies at runtime with `Unable to locate var: u.password`.
 *
 * Statically unambiguous, so it warns. Scoped to vars bound by `db.get`: a var
 * bound by anything else is not something this can reason about, and guessing
 * would produce exactly the false positives that train a warning away.
 */
function checkInternalColumnReads(
  statements: readonly EncodedStatement[],
  owner: string,
  subject: object,
  tablesByGuid: ReadonlyMap<string, TableDef>,
  bag: DiagnosticBag,
): void {
  // var name -> the table it was bound from, and what the read returned.
  const bindings = new Map<string, { def: TableDef; output: Set<string> | undefined }>();
  for (const statement of statements) {
    if (statement.name !== DB_GET) continue;
    const as = statement.as;
    if (typeof as !== "string" || as === "") continue;
    const guid = statementTableGuid(statement);
    const def = guid === undefined ? undefined : tablesByGuid.get(guid);
    if (!def) continue;
    bindings.set(as, { def, output: outputColumns(statement) });
  }
  if (bindings.size === 0) return;

  const refs: string[] = [];
  for (const statement of statements) collectVarRefs(statement, refs);

  const reported = new Set<string>();
  for (const path of refs) {
    const dot = path.indexOf(".");
    if (dot <= 0) continue;
    const root = path.slice(0, dot);
    const column = path.slice(dot + 1);
    const binding = bindings.get(root);
    if (!binding || binding.output?.has(column)) continue;
    const col = tableColumns(binding.def).find((c) => c.name === column);
    if (!col || col.access !== "internal") continue;
    if (reported.has(path)) continue;
    reported.add(path);
    bag.warn(
      "db.internal-column-read",
      `${owner}: reads \`ref("${path}")\`, but "${column}" on table "${binding.def.name}" is ` +
        `\`access: "internal"\` and a \`db.get\` does not return it — the row has no ` +
        `"${column}" key, so this fails at runtime with \`Unable to locate var: ${path}\`. Name ` +
        `the column in \`output\` on that \`db.get\` (\`output\` overrides column visibility), ` +
        `e.g. \`output: ["id", "${column}"]\`.`,
      subject,
    );
  }
}


/**
 * Every `{ tag: "input" }` reference inside an object.
 *
 * Spelled two ways, exactly as a `var` reference is (see {@link collectVarRefs}):
 * an ordinary value carries `value`, a comparison OPERAND — inside a `where`, an
 * `if` condition, a `precondition` — carries `operand`. Reading only `value`
 * would miss every input a query filters on, which is most of them.
 */
function collectInputRefs(node: unknown, out: string[]): void {
  walkNodes(node, (record) => {
    exprReads(record, "input", out);
    if (record.tag !== "input") return;
    if (typeof record.value === "string") out.push(record.value);
    if (typeof record.operand === "string") out.push(record.operand);
  });
}

/** The declared input names on an encoded def (`input[].name`). */
function declaredInputNames(record: Record<string, unknown>, tableColumns?: TableColumns): Set<string> | null {
  const names = new Set<string>();
  if (!Array.isArray(record.input)) return names;
  for (const entry of record.input) {
    const e = entry as { name?: unknown; type?: unknown; hidden?: unknown; customize?: unknown };
    const name = e?.name;
    // An `input.dbLink(table)` expands into one input per column of the table,
    // read by column name — less the `hidden` ones. Its own name reads nothing.
    const link = typeof e?.type === "string" ? /^(.+)_mvpschema$/.exec(e.type) : null;
    if (!link && typeof name === "string" && name !== "") names.add(name);
    if (link && tableColumns) {
      const columns = tableColumns.get(link[1]!);
      // A table outside this bundle: its columns are unknowable, so nothing is checked.
      if (columns === undefined) return null;
      const hidden = new Set(Array.isArray(e.hidden) ? e.hidden : []);
      const customize = (e.customize ?? {}) as Record<string, { hidden?: unknown } | undefined>;
      for (const column of columns) {
        if (!hidden.has(column) && customize[column]?.hidden !== true) names.add(column);
      }
    }
  }
  return names;
}

/** Each table's column names, by table guid. */
type TableColumns = ReadonlyMap<string, readonly string[]>;

function tableColumnsOf(sections: Readonly<Record<string, unknown[] | undefined>>): TableColumns {
  const out = new Map<string, string[]>();
  for (const t of sections.dbo ?? []) {
    const record = t as { guid?: unknown; schema?: unknown } | null;
    if (typeof record?.guid !== "string" || !Array.isArray(record.schema)) continue;
    out.set(
      record.guid,
      record.schema.flatMap((c) => (typeof (c as { name?: unknown })?.name === "string" ? [(c as { name: string }).name] : [])),
    );
  }
  return out;
}

/**
 * The declared input a reference actually resolves against — its BASE segment.
 *
 * Drilling into a structured input is ordinary and correct: a database trigger
 * reads `inp("new.id")` against its declared `new`, an error trigger reads
 * `inp("error.code")` against `error`. Only the base is checkable here; what
 * lives under it is the input's own schema, which this guard does not read.
 */
function inputBase(reference: string): string {
  const cut = reference.search(/[.[]/);
  return cut === -1 ? reference : reference.slice(0, cut);
}

/**
 * The channel path params in scope for a realtime message (its `channel.id`).
 * Empty for everything else — a channel-lifecycle trigger is bound to a channel
 * too, but its inputs are pinned to `action`/`channel`/`payload`/`client`, so a
 * path param read with `inp()` raises there.
 */
function boundChannelInputs(
  payloadKey: string,
  record: Record<string, unknown>,
  channelInputs: ReadonlyMap<string, Set<string>>,
): ReadonlySet<string> {
  if (payloadKey !== "message") return new Set();
  const guid = (record.channel as { id?: unknown } | undefined)?.id;
  return (typeof guid === "string" ? channelInputs.get(guid) : undefined) ?? new Set();
}

/**
 * `inp("<name>")` naming an input the enclosing def does not declare.
 *
 * The reported shape: a `/decide` endpoint declaring only `proposed_action_id`
 * reads `inp("amount")` because the value lives on a row it fetched, not on the
 * request. Nothing objects — `inp()` takes a bare string with no link to the
 * def around it — so `tsc` passes, `export --strict` passes, the deploy
 * succeeds, and every branch that reads it dies with
 * `ERROR_FATAL "Unable to locate input: amount"`. The correct form was
 * `ref("action.amount")`, one character class away in the source.
 *
 * Statically decidable: the declared inputs and the references are both in the
 * bundle. Two defs are scoped differently from their own `input[]`:
 *
 *  - a realtime MESSAGE also sees the owning channel's path params
 *    (`rooms/{room_id}` reaches a message stack as `inp("room_id")`). A
 *    channel-lifecycle TRIGGER does NOT — its inputs are pinned, so the param
 *    is read from the session, and the warning says so;
 *  - a MIDDLEWARE binds nothing at all, which {@link checkMiddleware} already
 *    reports in its own words — skipped here so one mistake is not reported twice.
 *
 * Warns rather than blocks, like every check in this file: the SDK must be able
 * to pull, edit and push back whatever the engine holds, and a stored object
 * carrying a broken reference is still an object that has to round-trip.
 */
function checkInputScope(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const channelInputs = new Map<string, Set<string>>();
  const tableColumns = tableColumnsOf(sections);
  for (const channel of sections.channel ?? []) {
    if (!channel || typeof channel !== "object") continue;
    const record = channel as Record<string, unknown>;
    if (typeof record.guid === "string") {
      channelInputs.set(record.guid, declaredInputNames(record)!);
    }
  }

  for (const [payloadKey, arr] of Object.entries(sections)) {
    if (payloadKey === "middleware") continue;
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      // An addon has no stack: its `where` (`context.search`) reads the inputs.
      const addon = payloadKey === "addon";
      if (!Array.isArray(record.run) && !addon) continue;

      const declared = declaredInputNames(record, tableColumns);
      if (declared === null) continue;
      for (const name of boundChannelInputs(payloadKey, record, channelInputs)) {
        declared.add(name);
      }

      const references: string[] = [];
      // `run` is the stack and `result` is the response spec; an undeclared
      // input fails the same way in either, and both are the author's own.
      collectInputRefs(addon ? record.context : record.run, references);
      collectInputRefs(record.result, references);

      const missing = [...new Set(references.map(inputBase))].filter(
        // A bare `inp("")` is the whole input object, not a named one.
        (name) => name !== "" && !declared.has(name),
      );
      if (missing.length === 0) continue;

      const name = typeof record.name === "string" ? record.name : "?";
      const declaredList =
        declared.size === 0
          ? "it declares no inputs at all"
          : `it declares ${[...declared].map((n) => `\`${n}\``).join(", ")}`;
      // A channel path param is the likeliest miss in a lifecycle trigger, and
      // declaring it is not an option there — so name where it does live.
      const params =
        payloadKey === "trigger" && record.obj_type === "channel" && typeof record.obj_id === "string"
          ? channelInputs.get(record.obj_id)
          : undefined;
      const param = missing.find((m) => params?.has(m));
      const channelParam = param
        ? ` \`${param}\` is a channel path param, not a trigger input: read it from ` +
          `\`s.realtime.get_session\` as \`ref("session.params.${param}")\`.`
        : "";
      const near = didYouMean(missing[0]!, declared);
      // A dbLink input's own name binds nothing: its COLUMNS are the inputs.
      const links = new Set(
        (record.input as Array<{ name?: unknown; type?: unknown }>).flatMap((e) =>
          typeof e?.type === "string" && e.type.endsWith("_mvpschema") && typeof e.name === "string" ? [e.name] : [],
        ),
      );
      const link = missing.find((m) => links.has(m));
      const linkNote = link
        ? ` \`${link}\` is an \`input.dbLink\`: its columns bind as the inputs, so read one by its own name (\`inp("<column>")\`).`
        : "";
      // A trigger's inputs are fixed by what it is attached to — there is no
      // `input` to declare one in, so point at the trigger's own accessor.
      const remedy =
        payloadKey === "trigger"
          ? `read it with \`ref("<var>.${missing[0]}")\`; a trigger's own inputs are fixed, so read them through the ` +
            `\`(t) => [...]\` stack callback's accessor (\`t.new\`, \`t.action\`, …).`
          : `read it with \`ref("<var>.${missing[0]}")\`; if it really is a request input, declare it in this def's \`input\`.`;
      bag.warn(
        "stack.inp-undeclared",
        `${sdkKindName(payloadKey, record)} "${name}" reads ${missing.map((r) => `\`inp("${r}")\``).join(", ")}, ` +
          `which ${missing.length === 1 ? "is not a declared input" : "are not declared inputs"} ` +
          `here — ${declaredList}.${near ? ` Did you mean \`inp("${near}")\`?` : ""} This deploys clean and fails at runtime with ` +
          `\`Unable to locate input: ${missing[0]}\`. If the value comes from earlier in the ` +
          `stack rather than the request, ${remedy}` +
          linkNote +
          channelParam,
        record,
      );
    }
  }
}

/**
 * `col("…")` outside a database statement.
 *
 * A column operand means something only where the database evaluates it: a
 * `db.*` statement's search, join, sort or eval. Anywhere else — a
 * `s.conditional` condition, a `set_var`, a response field — the engine
 * resolves it to the column's NAME, a plain string. `expr(col("age"), ">=",
 * c.int(18))` then compares the text `"age"` and is always true, and a response
 * `{ echo: col("age") }` returns `"age"`. Nothing fails, so the only place the
 * mistake shows is here. `obj({ a: col("x") })` compiles to an expression
 * reading `$db.x`, which is the same mistake. A `db.*` statement's `input` is
 * runtime too, so it is checked like any other statement's.
 */
function checkColumnScope(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      if (!Array.isArray(record.run) && !Array.isArray(record.result)) continue;
      const reads: Array<{ column: string; where: string; inDb: boolean }> = [];
      // Iterative: a `raw()` envelope can nest deeper than the call stack.
      const pending: Array<[unknown, string | undefined]> = [[record.result, undefined], [record.run, undefined]];
      while (pending.length > 0) {
        const [node, outer] = pending.pop()!;
        if (Array.isArray(node)) {
          for (let i = node.length - 1; i >= 0; i--) pending.push([node[i], outer]);
          continue;
        }
        if (!node || typeof node !== "object") continue;
        const n = node as Record<string, unknown>;
        const statement = typeof n.name === "string" && n.name.startsWith("mvp:") ? n.name : outer;
        // The database evaluates everything in a `db.*` statement but its inputs.
        if (statement !== outer && statement!.startsWith("mvp:dbo_")) {
          pending.push([n.input, statement]);
          continue;
        }
        // Inside a `db.*` statement only its inputs are walked: the values it is given.
        const inDb = statement?.startsWith("mvp:dbo_") === true;
        const label = statement === undefined ? undefined : `\`${statementLabel(statement)}\``;
        const where = label === undefined ? "the response" : inDb ? `the values ${label} is given` : label;
        const column = n.tag === "col" ? (n.value ?? n.operand) : undefined;
        if (typeof column === "string") reads.push({ column, where, inDb });
        const text = typeof n.tag === "string" && n.tag.startsWith("const:expr") ? (n.value ?? n.operand) : undefined;
        if (typeof text === "string") for (const m of text.matchAll(/\$db\.([A-Za-z_][A-Za-z0-9_]*)/g)) reads.push({ column: m[1]!, where, inDb });
        const values = Object.values(n);
        for (let i = values.length - 1; i >= 0; i--) pending.push([values[i], statement]);
      }
      if (reads.length === 0) continue;
      const name = typeof record.name === "string" ? record.name : "?";
      const first = reads[0]!;
      const listed = [...new Set(reads.map((r) => `\`col("${r.column}")\` in ${r.where}`))];
      bag.error(
        "stack.col-outside-query",
        `${sdkKindName(payloadKey, record)} "${name}" reads ${listed.join(", ")}` +
          `${reads.some((r) => r.inDb) ? "" : ", outside any `db.*` statement"}. ` +
          `There \`col()\` is not the row's value: the engine reads it as the column NAME, the text "${first.column}", ` +
          `so a condition on it is decided by that text and a response returns it. \`col()\` belongs in a \`db.*\` ` +
          `statement's \`where\`/\`sort\`/\`eval\`` +
          `${reads.some((r) => r.inDb) ? " — not in the values it is given (a `row`, an input), which are evaluated before the database runs" : ""}. To use a row's value, fetch the row first (\`s.db.get({ …, as: "row" })\`) and read ` +
          `\`ref("row.${first.column}")\`; for a request input, \`inp("${first.column}")\`.`,
        record,
      );
    }
  }
}

/**
 * `env("NAME")` naming a variable the workspace config does not declare.
 *
 * `env()` is the one value tag with no compile-time or export-time guard.
 * `inp()` has `stack.inp-undeclared`, `ref()` has `stack.unbound-var`, and a
 * misspelled env name has had neither: it deploys clean and then resolves to
 * NULL on the first request — not an error, a missing value, so the failure
 * surfaces wherever the null eventually lands rather than at the typo.
 *
 * Once a config declares some, a name outside that set is either a typo or a
 * dashboard-only variable, and the message says so rather than asserting the
 * former. A config that says `env: {}` declares none on purpose, and is left
 * alone.
 *
 * A config with NO `env` at all, while a stack reads one, is the other case,
 * reported once for the whole export and worded by {@link EnvSource}: no config
 * attached (`workspace("app")` alone, or a `workspaceConfig({ env })` never
 * passed to `registerWorkspace()`), or an attached config with no `env` key.
 *
 * `setting()` and the `sys.*` accessors share the `setting` tag with `env()`, so
 * the encoded form cannot tell them apart. The `$` prefix can: every built-in
 * request/system variable is `$`-prefixed and no workspace env var is, so a
 * `$`-prefixed name is skipped. A bare `setting("FOO")` reads the same workspace
 * variable `env("FOO")` does, and is checked the same way — which is correct,
 * not collateral.
 */
/** One workspace env read: the name, and how the author spelled it. */
interface EnvRead {
  readonly name: string;
  /** `env("X")`, `{{ $env.X }}` or `$env.X` — as written, so the author can find it. */
  readonly spelled: string;
}

/** `$env.NAME` / `$env["NAME"]` inside a JavaScript body or a template. */
const ENV_MEMBER = /\$env\.([A-Za-z_][A-Za-z0-9_]*)|\$env\[\s*["']([^"']+)["']\s*\]/g;

/** Every `$env` read inside `{{ … }}` blocks of `text`, spelled as a template read. */
function templateEnvReads(text: string, into: EnvRead[]): void {
  // A Twig comment `{# … #}` renders nothing, including any `{{ }}` inside it.
  for (const block of text.replace(/\{#[\s\S]*?#\}/g, "").matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    for (const m of (block[1] ?? "").matchAll(ENV_MEMBER)) {
      const name = (m[1] ?? m[2])!;
      into.push({ name, spelled: `{{ $env.${name} }}` });
    }
  }
}

/**
 * Every `$env` read in a JavaScript body — code only: a `$env.X` inside a
 * comment or a string literal is text, while one inside a template literal's
 * `${…}` is a read. Masking keeps indices aligned, so a match counts when its
 * `$` survives the mask.
 */
function lambdaEnvReads(text: string, into: EnvRead[]): void {
  const code = maskNonCode(text);
  for (const m of text.matchAll(ENV_MEMBER)) {
    if (code[m.index] !== "$") continue;
    const name = (m[1] ?? m[2])!;
    into.push({ name, spelled: `$env.${name}` });
  }
}

/** The workspace env names one object's stack and response read, in source order, each once. */
function envReads(record: Record<string, unknown>): EnvRead[] {
  const read: EnvRead[] = [];
  for (const root of [record.run, record.result]) {
    walkNodes(root, (node) => {
      // A lambda body reads `$env.NAME` directly, and a direct query's SQL is a
      // template: both resolve an undeclared name to nothing, as `env()` does.
      if (node.name === "mvp:lambda") {
        for (const text of stringLeaves(node.input)) lambdaEnvReads(text, read);
      }
      // A lambda filter (`fl.map(({ $env }) => …)`) carries a body of its own.
      const site = typeof node.name === "string" && Object.hasOwn(LAMBDA_CODE_FILTERS, node.name)
        ? LAMBDA_CODE_FILTERS[node.name]
        : undefined;
      if (site !== undefined && Array.isArray(node.arg)) {
        const code = (node.arg[site.slot] as { value?: unknown } | undefined)?.value;
        if (typeof code === "string") lambdaEnvReads(code, read);
      }
      // `s.util.template_engine` renders its text as a template.
      if (node.name === "mvp:template_string") {
        for (const text of stringLeaves(node.input)) templateEnvReads(text, read);
      }
      // Only the `template_engine` parser renders the SQL; the default
      // (`prepared`) sends `{{ … }}` to the database as text.
      const sql = node.context as { code?: unknown; parser?: unknown } | undefined;
      if (node.name === "mvp:dbo_direct_query" && sql?.parser === "template_engine") {
        for (const text of stringLeaves(sql.code)) templateEnvReads(text, read);
      }
      const inExpr: string[] = [];
      exprReads(node, "env", inExpr);
      for (const name of inExpr) if (!name.startsWith("$")) read.push({ name, spelled: `env("${name}")` });
      if (node.tag !== "setting") return;
      for (const key of ["value", "operand"] as const) {
        const name = node[key];
        // A built-in is `$`-prefixed; a workspace variable never is.
        if (typeof name === "string" && name !== "" && !name.startsWith("$")) read.push({ name, spelled: `env("${name}")` });
      }
    });
  }
  // An agent's string settings are rendered as templates before the LLM call,
  // so `{{ $env.NAME }}` in a prompt, model or provider key reads the same
  // workspace variable `env("NAME")` does — and resolves to nothing when it is
  // not declared, just as silently.
  for (const text of stringLeaves(record.agent_settings)) templateEnvReads(text, read);
  // A microservice resolves `fromEnv` and a chart's `${env.NAME}` at DEPLOY time,
  // and a name the workspace does not define fails that deploy.
  const containers = (record.deployment as { containers?: unknown } | undefined)?.containers;
  for (const container of Array.isArray(containers) ? containers : []) {
    const envs = (container as { envs?: unknown } | null)?.envs;
    for (const e of Array.isArray(envs) ? envs : []) {
      const name = (e as { from_env?: unknown } | null)?.from_env;
      if (typeof name === "string" && name !== "") read.push({ name, spelled: `fromEnv: "${name}"` });
    }
  }
  const chart = (record.chart as { values?: unknown } | undefined)?.values;
  if (typeof chart === "string") {
    for (const m of chart.matchAll(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      read.push({ name: m[1]!, spelled: `\${env.${m[1]!}}` });
    }
  }
  const seen = new Set<string>();
  return read.filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

/**
 * Every workspace env name the bundle's objects read, each once, in payload
 * order — request/system settings excluded. What a `workspaceConfig({ env })`
 * has to declare for `stack.env-undeclared` to have nothing to say.
 */
export function envNamesRead(sections: Readonly<Record<string, unknown[] | undefined>>): string[] {
  const names = new Set<string>();
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      for (const r of envReads(obj as Record<string, unknown>)) {
        if (!isSysSettingName(payloadKey, r.name)) names.add(r.name);
      }
    }
  }
  return [...names];
}

/** Every string under `root`, depth first. */
function stringLeaves(root: unknown): string[] {
  if (typeof root === "string") return [root];
  if (root === null || typeof root !== "object") return [];
  return Object.values(root).flatMap(stringLeaves);
}

/**
 * Where the workspace's env declaration stands: the attached config names `env`
 * (`env: {}` included), a config is attached without an `env` key, or no config
 * is attached — only the `{ name }` that `workspace("app")` registers.
 */
export type EnvSource = "authored" | "no-env" | "unattached";

function checkEnvNames(
  workspaceConfig: Readonly<Record<string, unknown>>,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  envSource: EnvSource,
): void {
  const declared = new Set<string>();
  for (const entry of Array.isArray(workspaceConfig.env) ? workspaceConfig.env : []) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name === "string" && name !== "") declared.add(name);
  }
  checkEnvSysNames(declared, sections, bag);
  if (declared.size === 0) {
    if (envSource !== "authored") checkEnvAttached(sections, bag, envSource);
    return;
  }

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      const missing = envReads(record).filter((r) => !declared.has(r.name) && !isSysSettingName(payloadKey, r.name));
      if (missing.length === 0) continue;

      const name = typeof record.name === "string" ? record.name : "?";
      bag.warn(
        "stack.env-undeclared",
        `${sdkKindName(payloadKey, record)} "${name}" reads ${missing.map((r) => `\`${r.spelled}\``).join(", ")}, ` +
          `which ${missing.length === 1 ? "is not" : "are not"} among the ` +
          `${declared.size} environment variable${declared.size === 1 ? "" : "s"} this workspace ` +
          `config declares (${[...declared].map((n) => `\`${n}\``).join(", ")}). ` +
          (payloadKey === "microservice"
            ? `A microservice resolves it at deploy time, and a name the workspace does not define FAILS that deploy. `
            : `An env name that does not exist resolves to NULL rather than erroring, so the request succeeds ` +
              `and fails somewhere downstream of the value. `) +
          `If it is a typo, fix the spelling; if ` +
          `the variable is set in the dashboard rather than here, declare it in ` +
          `\`workspaceConfig({ env })\` to make it checkable, or accept the warning with ` +
          `\`workspaceConfig({ diagnostics: { allow: ["stack.env-undeclared"] } })\`` +
          (payloadKey === "microservice"
            ? ` — or for this microservice alone, \`microservice({ …, diagnostics: { allow: ["stack.env-undeclared"] } })\`.`
            : "."),
        record,
      );
    }
  }
}

/** The factory that authors a def of SDK kind `kind` — the kind's own name, but for a function. */
function factoryOf(kind: string): string {
  return kind === "function" ? "defineFunction" : kind;
}

/**
 * A request/system setting's name (`remote_ip`) read from a stack, which `env()`
 * does not reach. A microservice's deploy-time reference has no such setting.
 */
function isSysSettingName(payloadKey: string, name: string): boolean {
  return payloadKey !== "microservice" && sysAccessorFor(`$${name}`) !== undefined;
}

/**
 * `env("remote_ip")` (or `setting("remote_ip")`, stored identically) reads a
 * WORKSPACE variable of that name, not the request setting — undeclared, it resolves to NULL. Named with its `sys` accessor, the
 * same remedy `ref("$remote_ip")` gets.
 */
function checkEnvSysNames(
  declared: ReadonlySet<string>,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      const seen = new Set<string>();
      for (const r of envReads(record)) {
        if (declared.has(r.name) || seen.has(r.name) || !isSysSettingName(payloadKey, r.name)) continue;
        seen.add(r.name);
        bag.warn(
          "stack.env-undeclared",
          `${sdkKindName(payloadKey, record)} "${typeof record.name === "string" ? record.name : "?"}" reads ` +
            // `env("x")` and `setting("x")` store the same read — both are named.
            `${r.spelled.startsWith("env(") ? `\`${r.spelled}\` / \`setting("${r.name}")\`` : `\`${r.spelled}\``} — a workspace ` +
            `environment variable named \`${r.name}\`, not the request setting; undeclared, it resolves to NULL. ` +
            `Read the setting with \`sys.${sysAccessorFor(`$${r.name}`)}()\` (or \`setting("$${r.name}")\`).`,
          record,
        );
      }
    }
  }
}

/**
 * Stacks read `env()` and no attached config names `env` — one warning for the
 * whole export, naming the reads, where they are, and which of the two it is.
 */
function checkEnvAttached(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  envSource: Exclude<EnvSource, "authored">,
): void {
  const names = new Map<string, string>();
  const where: string[] = [];
  const readers: object[] = [];
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      const read = envReads(record).filter((r) => !isSysSettingName(payloadKey, r.name));
      if (read.length === 0) continue;
      const at = `${sdkKindName(payloadKey, record)} "${typeof record.name === "string" ? record.name : "?"}"`;
      // A def that accepted the code is left out — the warning carries no one
      // subject, so without this a per-def allow could never silence it.
      const accepted = () =>
        `${at} reads ${read.map((r) => `\`${r.spelled}\``).join(", ")}, and this export declares no environment variables.`;
      if (bag.isAccepted("stack.env-undeclared", accepted, record)) continue;
      for (const r of read) if (!names.has(r.name)) names.set(r.name, r.spelled);
      where.push(at);
      readers.push(record);
    }
  }
  if (names.size === 0) return;
  const listed = [...names.values()].map((spelled) => `\`${spelled}\``).join(", ");
  const one = names.size === 1;
  const envLiteral = `env: { ${[...names.keys()].map((n) => `${n}: ""`).join(", ")} }`;
  const head =
    `${listed} ${one ? "is" : "are"} referenced (${where.slice(0, 3).join(", ")}` +
    `${where.length > 3 ? `, and ${where.length - 3} more` : ""}), `;
  const body =
    envSource === "unattached"
      ? `but no workspaceConfig is attached with \`registerWorkspace()\` — this export declares no ` +
        `environment variables. Declare the name${one ? "" : "s"} in ` +
        `\`workspaceConfig({ ${envLiteral} })\` and pass it to \`registerWorkspace()\`.`
      : `but the workspaceConfig attached with \`registerWorkspace()\` has no \`env\` key — this export ` +
        `declares no environment variables. Add \`${envLiteral}\` to that config.`;
  bag.warn(
    "stack.env-undeclared",
    head + body + ` A config passing \`env: {}\` says none are declared here, and is not reported; ` +
      `\`diagnostics: { allow: ["stack.env-undeclared"] }\` on the workspaceConfig accepts every read, and on a def ` +
      `(\`${factoryOf(where[0]!.split(" ")[0]!)}({ …, diagnostics: { allow: ["stack.env-undeclared"] } })\`) that def's reads.`,
    // One reader is the def it is about; several leave it the export's.
    readers.length === 1 ? readers[0] : undefined,
  );
}

/**
 * A middleware's declared `input` is never bound, and `inp()` inside one fails
 * at runtime.
 *
 * Verified live: a middleware declaring `input: { probe: input.text({ default })
 * }` and reading `inp("probe")` returns
 * `500 Unable to locate input: probe` — the default does not even stand in. The
 * host request simply does not populate a middleware's inputs. The body is read
 * with `s.util.get_all_input`, which hands back a `{ type, vars }` envelope
 * whose `vars` is the request in `pre` and `{ status, result }` in `post` (see
 * {@link postEnvelopeMisreads}).
 *
 * **Warnings, not errors**, despite the field being useless at runtime. The
 * engine stores it and real workspaces carry one — a captured middleware in
 * this repo's own corpus declares `vars` and `type` inputs. Refusing it at
 * export would make such a workspace impossible to pull, edit and push back,
 * which is a worse failure than the one being reported: the SDK must be able to
 * represent what the engine holds.
 *
 * **Only for a middleware a host attaches.** `s.middleware.call` binds the
 * declared map (`input: { … }`) and `inp()` resolves there, and a middleware
 * test supplies its input the same way — both are documented. A middleware
 * nothing attaches runs only where it is bound, and `--strict` must not fail
 * the documented shape. But a call or a test binds the input on ITS path only:
 * the attached path (a `pre`/`post` slot, on an object, a group or the
 * workspace) still runs unbound and 500s, so a middleware that is both
 * attached and called still warns — the wording then names where the input
 * IS bound.
 */
function checkMiddleware(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  workspaceConfig: Readonly<Record<string, unknown>> = {},
): void {
  const { attached, called } = middlewareUses([...Object.values(sections), workspaceConfig]);
  for (const mw of sections.middleware ?? []) {
    if (!mw || typeof mw !== "object") continue;
    const record = mw as { name?: unknown; input?: unknown; run?: unknown; guid?: unknown; test?: unknown };
    const name = typeof record.name === "string" ? record.name : "?";
    const guid = typeof record.guid === "string" ? record.guid : undefined;
    if (guid === undefined || !attached.has(guid)) continue;
    // Where the input IS bound, if anywhere — the attached path still is not.
    const boundOnly = called.has(guid)
      ? ` It is bound only where it is called with \`s.middleware.call\`; every host it is attached to runs it unbound.`
      : testsSupplyInput(record.test)
        ? ` It is bound only in its tests; every host it is attached to runs it unbound.`
        : "";

    if (Array.isArray(record.input) && record.input.length > 0) {
      bag.warn(
        "middleware.input-never-bound",
        `middleware "${name}" declares \`input\`, which the host request never binds — ` +
          `\`inp()\` inside a middleware fails at runtime with \`Unable to locate input\`, and a ` +
          `declared default does not stand in.${boundOnly} Read the request body with ` +
          `\`s.util.get_all_input\` instead; it yields a \`{ type, vars }\` envelope (\`vars\` is ` +
          `the request in \`pre\`, \`{ status, result }\` in \`post\`). The field ` +
          `is kept because the engine stores it and existing workspaces carry one.`,
        mw,
      );
    }

    const refs: string[] = [];
    collectInputRefs(record.run, refs);
    const unique = [...new Set(refs)];
    if (unique.length > 0) {
      bag.warn(
        "middleware.inp-unresolvable",
        `middleware "${name}" reads ${unique.map((r) => `\`inp("${r}")\``).join(", ")}, which ` +
          `cannot resolve — an attached middleware has no bound inputs, so this fails at runtime with ` +
          `\`Unable to locate input: ${unique[0]}\`.${boundOnly} Use \`s.util.get_all_input\` and read the ` +
          `\`{ type, vars }\` envelope it binds — \`vars\` is the request in \`pre\` and ` +
          `\`{ status, result }\` in \`post\`, where the request is \`s.util.get_raw_input\`.`,
        mw,
      );
    }
  }
}

/**
 * A `post` middleware with `resultStrategy: "merge"` (the default) attached to
 * an endpoint whose response is a row LIST. The merge folds the middleware's
 * response into the result key by key, so the list arrives as an object keyed
 * by index (`{"0":{…},"1":{…},"mw":…}`) — verified live — while `InferResponse`
 * still types it as the list. Attached on the endpoint, on its api group, or on
 * the workspace tier the endpoint inherits when neither overrides `post`.
 *
 * A list here is a response that is statically one ({@link isStaticList});
 * anything else is left alone.
 */
function checkPostMergeOnList(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  workspaceConfig: Readonly<Record<string, unknown>> = {},
): void {
  const merging = new Map<string, string>();
  for (const mw of sections.middleware ?? []) {
    const rec = (mw ?? {}) as { guid?: unknown; name?: unknown; result_type?: unknown; result?: unknown };
    const merges = rec.result_type === undefined || rec.result_type === "merge";
    if (typeof rec.guid === "string" && merges && Array.isArray(rec.result) && rec.result.length > 0) {
      merging.set(rec.guid, typeof rec.name === "string" ? rec.name : "?");
    }
  }
  if (merging.size === 0) return;
  const postIds = (host: unknown): string[] => {
    const post = (host as { middleware?: { post?: unknown } } | null)?.middleware?.post;
    if (!Array.isArray(post)) return [];
    return post
      .map((st) => (st as { name?: unknown; disabled?: unknown; context?: { middleware?: { id?: unknown } } } | null))
      .filter((st) => st?.name === "mvp:middleware" && st.disabled !== true)
      .map((st) => st!.context?.middleware?.id)
      .filter((id): id is string => typeof id === "string" && merging.has(id));
  };
  const groups = new Map<string, unknown>();
  for (const g of sections.app ?? []) {
    const guid = (g as { guid?: unknown } | null)?.guid;
    if (typeof guid === "string") groups.set(guid, g);
  }
  const functions = new Map<string, unknown>();
  for (const fn of sections.function ?? []) {
    const guid = (fn as { guid?: unknown } | null)?.guid;
    if (typeof guid === "string") functions.set(guid, fn);
  }
  // The workspace tier's query `post` chain, which a query inherits unless it
  // or its group overrides the phase.
  const workspacePost = (workspaceConfig as { middleware?: { query_post?: unknown } }).middleware?.query_post;
  const overridesPost = (host: unknown): boolean =>
    (host as { middleware?: { post_customize?: unknown } } | null | undefined)?.middleware?.post_customize === true;
  for (const q of sections.query ?? []) {
    const rec = (q ?? {}) as { name?: unknown; verb?: unknown; app?: { id?: unknown }; result?: unknown; run?: unknown };
    const group = typeof rec.app?.id === "string" ? groups.get(rec.app.id) : undefined;
    const inherited = overridesPost(q) || overridesPost(group) ? [] : postIds({ middleware: { post: workspacePost } });
    const ids = new Set([...postIds(q), ...postIds(group), ...inherited]);
    if (ids.size === 0) continue;
    const whole = wholeResponse(rec.result);
    if (whole === undefined || !isStaticList(whole, rec.run, functions, 0)) continue;
    const names = [...ids].map((id) => `"${merging.get(id)}"`).join(", ");
    const wrapped = whole.tag === "var" ? `ref("${String(whole.value)}")` : "…";
    bag.warn(
      "middleware.post-merge-list",
      `query "${typeof rec.verb === "string" ? `${rec.verb} ` : ""}${typeof rec.name === "string" ? rec.name : "?"}" ` +
        `answers a list, and the post middleware ${names} merges its response into it: the list ` +
        `arrives as an object keyed by index (\`{"0":{…},"1":{…},…}\`), not the list \`InferResponse\` types. ` +
        `Give the middleware \`resultStrategy: "replace"\` and return the whole response, or wrap the list ` +
        `(\`response: { items: ${wrapped} }\`).`,
      q as object,
    );
  }
}

type ValueEntry = { name?: unknown; tag?: unknown; value?: unknown; filters?: unknown };

/** The single whole-value entry of an encoded response (`result: [{ name: "" … }]`), if that is its shape. */
function wholeResponse(result: unknown): ValueEntry | undefined {
  if (!Array.isArray(result) || result.length !== 1) return undefined;
  const whole = result[0] as ValueEntry;
  return whole?.name === "" ? whole : undefined;
}

/**
 * Whether an encoded value is statically a LIST: a list constant, a bracketed
 * list-literal expression (the WHOLE expression — `[1,2]|count` and `[1,2][0]`
 * are not lists), or a variable every binder of which produces one — an
 * unpaged (or envelope-less) `s.db.query` list, an `s.array.map`/`filter`/set
 * operation, an `s.set_var`/`s.update_var` of a list, or a synchronous
 * `s.function.run`/`s.function.call` whose target answers a list. A filtered
 * value, a binder with `asFilters`, and anything not provable, is not.
 */
function isStaticList(entry: ValueEntry, run: unknown, functions: ReadonlyMap<string, unknown>, depth: number): boolean {
  if (depth > 8) return false;
  if (Array.isArray(entry.filters) && entry.filters.length > 0) return false;
  if (typeof entry.tag !== "string" || typeof entry.value !== "string") return false;
  if (entry.tag === "const:array") return true;
  if (entry.tag === "const:expr2") return isListLiteral(entry.value);
  if (entry.tag !== "var") return false;
  const statements: EncodedStatement[] = [];
  collectStatements(run, statements);
  const binders = statements.filter((st) =>
    st.name === "mvp:update_var"
      ? (st.context as { name?: unknown } | undefined)?.name === entry.value
      : (st as { as?: unknown }).as === entry.value,
  );
  return binders.length > 0 && binders.every((st) => bindsList(st, run, functions, depth));
}

/** Is `source` one bracketed list literal and nothing after it? */
function isListLiteral(source: string): boolean {
  const src = source.trim();
  if (!src.startsWith("[")) return false;
  let level = 0;
  let quote: string | undefined;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== undefined) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") level++;
    else if (ch === "]" && --level === 0) return i === src.length - 1;
  }
  return false;
}

/** The statements that always bind a list (absent `asFilters`). */
const LIST_BINDERS = new Set(["mvp:array_map", "mvp:array_filter", "mvp:array_union", "mvp:array_intersection", "mvp:array_difference"]);

function bindsList(st: EncodedStatement, run: unknown, functions: ReadonlyMap<string, unknown>, depth: number): boolean {
  // `asFilters` reshape the result as it binds — `count`, `first` — so the
  // binder no longer proves a list.
  const asFilters = (st as { output?: { filters?: unknown } }).output?.filters;
  if (Array.isArray(asFilters) && asFilters.length > 0) return false;
  if (st.name === DB_QUERY) {
    type Ret = { type?: unknown; list?: { paging?: { enabled?: unknown; metadata?: unknown } } };
    const ret = (st.context as { return?: Ret } | undefined)?.return;
    const paging = ret?.list?.paging;
    return (ret?.type ?? "list") === "list" && !(paging?.enabled === true && paging.metadata !== false);
  }
  if (LIST_BINDERS.has(st.name)) return true;
  if (st.name === "mvp:set_var" || st.name === "mvp:update_var") return isStaticList(st.context as ValueEntry, run, functions, depth + 1);
  if (st.name === "mvp:function" || st.name === "mvp:workspace_run_function") {
    // An async run binds its job id, not the result.
    const mode = (st as { runtime?: { mode?: unknown } | null }).runtime?.mode;
    if (typeof mode === "string" && mode.startsWith("async")) return false;
    const ctx = st.context as { function?: { id?: unknown }; id?: unknown } | undefined;
    const id = st.name === "mvp:function" ? ctx?.function?.id : ctx?.id;
    const target = typeof id === "string" ? (functions.get(id) as { result?: unknown; run?: unknown } | undefined) : undefined;
    const whole = wholeResponse(target?.result);
    return whole !== undefined && isStaticList(whole, target!.run, functions, depth + 1);
  }
  return false;
}

/**
 * The input an encoded value reads: `inp("doc")` (or a dotted `inp("form.doc")`)
 * directly, or a variable whose every binder carries one — an unfiltered
 * `s.set_var`/`s.update_var` of one (`s.set_var("f", inp("doc"))` then
 * `ref("f")`), or the item of an `s.foreach` over one. Undefined when it reads
 * anything else.
 */
function inputBehind(entry: ValueEntry, statements: readonly EncodedStatement[], depth: number): string | undefined {
  if (depth > 8 || typeof entry.value !== "string") return undefined;
  if (Array.isArray(entry.filters) && entry.filters.length > 0) return undefined;
  if (entry.tag === "input") return entry.value;
  if (entry.tag !== "var") return undefined;
  // A member of a variable (`it.img`, a foreach item of a list of objects) is
  // that member of whatever input the variable holds.
  const dot = entry.value.indexOf(".");
  if (dot > 0) {
    const base = inputBehind({ tag: "var", value: entry.value.slice(0, dot) }, statements, depth + 1);
    return base === undefined ? undefined : `${base}${entry.value.slice(dot)}`;
  }
  const ctx = (st: EncodedStatement) => (st.context ?? {}) as { name?: unknown; as?: unknown; list?: unknown };
  const binders = statements.filter((st) =>
    st.name === "mvp:update_var"
      ? ctx(st).name === entry.value
      : st.name === "mvp:foreach"
        ? ctx(st).as === entry.value
        : (st as { as?: unknown }).as === entry.value,
  );
  if (binders.length === 0 || binders.some((st) => !["mvp:set_var", "mvp:update_var", "mvp:foreach"].includes(st.name))) return undefined;
  const sources = new Set(
    binders.map((st) => inputBehind((st.name === "mvp:foreach" ? (ctx(st).list ?? {}) : ctx(st)) as ValueEntry, statements, depth + 1)),
  );
  return sources.size === 1 ? [...sources][0] : undefined;
}

/** Every stored-file input (`blob*`) by its read path — `doc`, or `form.doc` inside an object input. */
function storedFileInputs(inputs: readonly unknown[], prefix = "", out = new Map<string, string>(), depth = 0): Map<string, string> {
  if (depth > 8) return out;
  for (const i of inputs) {
    const { name, type, children } = (i ?? {}) as { name?: unknown; type?: unknown; children?: unknown };
    if (typeof name !== "string" || typeof type !== "string") continue;
    if (type.startsWith("blob")) out.set(prefix + name, type);
    else if (type === "obj" && Array.isArray(children)) storedFileInputs(children, `${prefix}${name}.`, out, depth + 1);
  }
  return out;
}

/** The storage statements that store an UPLOAD — fed from the raw `input.file()`. */
const STORE_UPLOAD = new Set(["mvp:create_image", "mvp:create_video", "mvp:create_audio", "mvp:create_attachment"]);

/**
 * `s.storage.create_image|video|audio|attachment` fed straight from an
 * `input.image|video|audio|attachment()`. Those inputs take an ALREADY-STORED
 * file (`{ path, … }`), so a multipart upload to them is refused before the
 * stack runs — every request 400s `Missing param: path` (verified live). The
 * raw upload is `input.file()`.
 */
function checkStoreFromStoredFileInput(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const inputs = (obj as { input?: unknown }).input;
      if (!Array.isArray(inputs)) continue;
      const stored = storedFileInputs(inputs);
      if (stored.size === 0) continue;
      const statements: EncodedStatement[] = [];
      collectStatements((obj as { run?: unknown }).run, statements);
      for (const st of statements) {
        if (!STORE_UPLOAD.has(String(st.name))) continue;
        const source = inputBehind((st.context ?? {}) as ValueEntry, statements, 0);
        if (source === undefined || !stored.has(source)) continue;
        const kind = stored.get(source) === "blob" ? "attachment" : stored.get(source)!.replace(/^blob_(img)?/, (_m, img) => (img ? "image" : ""));
        const name = (obj as { name?: unknown }).name;
        bag.warn(
          "storage.stored-file-input",
          `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}": ` +
            `\`s.storage.${String(st.name).slice("mvp:".length)}\` reads \`inp("${source}")\`${(st.context as ValueEntry | undefined)?.tag === "var" ? ` (through \`ref("${String((st.context as ValueEntry).value)}")\`)` : ""}, an ` +
            `\`input.${kind}()\` — that input takes an already-stored file, so an upload to it is refused ` +
            `(\`400 Missing param: path\`) before the stack runs. Declare the upload as \`input.file()\`.`,
          obj,
        );
      }
    }
  }
}

/** Whether any of a middleware's stored tests supplies an input. */
function testsSupplyInput(tests: unknown): boolean {
  if (!Array.isArray(tests)) return false;
  return tests.some((t) => {
    const input = (t as { input?: unknown } | null)?.input;
    return Array.isArray(input) && input.length > 0;
  });
}

/**
 * The middleware guids a host ATTACHES (`mvp:middleware` in a `pre`/`post`
 * slot, anywhere — an object, an api group, the workspace config) and the ones
 * a stack CALLS (`s.middleware.call`, `mvp:workspace_run_middleware`).
 */
function middlewareUses(roots: readonly unknown[]): { attached: Set<string>; called: Set<string> } {
  const attached = new Set<string>();
  const called = new Set<string>();
  const stack: unknown[] = [...roots];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node as unknown[]) stack.push(item);
      continue;
    }
    const rec = node as { name?: unknown; context?: { id?: unknown; middleware?: { id?: unknown } } };
    if (rec.name === "mvp:middleware" && typeof rec.context?.middleware?.id === "string") {
      attached.add(rec.context.middleware.id);
    } else if (rec.name === "mvp:workspace_run_middleware" && typeof rec.context?.id === "string") {
      called.add(rec.context.id);
    }
    for (const value of Object.values(node)) stack.push(value);
  }
  return { attached, called };
}

/**
 * The keys a `post` chain's `get_all_input` envelope carries under `vars`:
 * `status` and `result` always, and `payload` when an API host failed with an
 * error that carries one.
 */
const POST_ENVELOPE_KEYS = new Set(["status", "result", "payload"]);

/**
 * The request-shaped reads a middleware makes out of `s.util.get_all_input` —
 * the refs that resolve in a `pre` chain and cannot in a `post` one.
 *
 * The envelope `get_all_input` binds differs by phase. In `pre` it is
 * `{ type, vars: <the request inputs> }`; in `post` it is
 * `{ type, vars: { status, result } }`, the host's own outcome (plus `payload`
 * when the host failed with an error payload). So
 * `ref("payload.vars.note")` reads a request field before the host and names
 * nothing after it. Verified live: under the default `rethrow` the post read
 * fails the request with `500 Unable to locate var` after the host's writes
 * have landed.
 *
 * Only a ref under a var this middleware binds with `get_all_input` counts, and
 * only one naming a key below `vars` other than `status`/`result`/`payload`. Whether the
 * middleware actually runs in `post` is the caller's question — the same
 * middleware attached to a `pre` chain reads correctly.
 */
export function postEnvelopeMisreads(middleware: unknown): string[] {
  const statements: EncodedStatement[] = [];
  collectStatements((middleware as { run?: unknown })?.run, statements);
  const bound = new Set<string>();
  for (const statement of statements) {
    const as = (statement as { as?: unknown }).as;
    if (statement.name === GET_ALL_INPUT && typeof as === "string" && as !== "") bound.add(as);
  }
  if (bound.size === 0) return [];

  const refs: string[] = [];
  collectVarRefs(middleware, refs);
  const misreads = refs.filter((path) => {
    const [base, vars, key] = path.split(".");
    return bound.has(base!) && vars === "vars" && key !== undefined && !POST_ENVELOPE_KEYS.has(key);
  });
  return [...new Set(misreads)];
}

/**
 * The reads a middleware makes STRAIGHT off its `s.util.get_all_input` var —
 * `payload.note` rather than `payload.vars.note`. The var holds the
 * `{ type, vars }` envelope in both phases, so any key beside those two names
 * nothing: a plain read fails with `Unable to locate var`, and a `get`-filter
 * read (`ref(…, { safe: true })`, `fl.get`) is `safe` — always null, silently.
 *
 * Only the RAW envelope counts. A `get_all_input` carrying `asFilters` (the
 * documented `fl.get("vars")` unwrap) binds something else, and a name any
 * other statement also binds — `as`, a loop's `context.as`, `s.update_var`'s
 * `context.name` — is skipped: which value the read sees is not knowable here.
 */
export function unnestedEnvelopeReads(middleware: unknown): { path: string; safe: boolean }[] {
  const statements: EncodedStatement[] = [];
  collectStatements((middleware as { run?: unknown })?.run, statements);
  const raw = (st: EncodedStatement): boolean => {
    const filters = (st as { output?: { filters?: unknown } }).output?.filters;
    return st.name === GET_ALL_INPUT && !(Array.isArray(filters) && filters.length > 0);
  };
  const bound = new Set<string>();
  for (const st of statements) if (raw(st) && typeof st.as === "string" && st.as !== "") bound.add(st.as);
  const other = collectBindings(statements.filter((st) => !raw(st)));
  const envelope = (base: string, key: string | undefined): boolean =>
    bound.has(base) && !other.has(base) && key !== undefined && key !== "vars" && key !== "type";
  const found = new Map<string, boolean>();
  const refs: string[] = [];
  collectVarRefs(middleware, refs);
  for (const path of refs) {
    const [base, key] = path.split(".");
    if (envelope(base!, key)) found.set(path, false);
  }
  walkNodes(middleware, (record) => {
    const get = (record.filters as { name?: unknown; arg?: { tag?: unknown; value?: unknown }[] }[] | undefined)?.[0];
    const key = get?.name === "get" && get.arg?.[0]?.tag === "const" ? get.arg[0].value : undefined;
    if (record.tag !== "var" || typeof record.value !== "string" || record.value.includes(".")) return;
    if (typeof key !== "string" || !envelope(record.value, key.split(".")[0])) return;
    const path = `${record.value}.${key}`;
    if (!found.has(path)) found.set(path, true);
  });
  return [...found].map(([path, safe]) => ({ path, safe }));
}

/**
 * A `cors: { mode: "custom" }` block that cannot answer a browser.
 *
 * Custom mode replaces the permissive default policy with the declared one, and
 * the origin list is matched as EXACT strings against the request's `Origin`.
 * A request the list does not match gets no CORS headers at all — not a
 * rejection the tooling can see, just an absent `access-control-allow-origin`
 * that only the browser console reports. Two shapes reach that state while
 * looking correct in every other surface:
 *
 *  - an EMPTY origin list, which matches nothing, so declaring CORS leaves the
 *    group less usable than declaring none;
 *  - `"*"` in the list, which is compared as a literal origin and therefore
 *    also matches nothing. It is the first thing an author writes to widen a
 *    policy, and `mode: "default"` is what actually means "any origin".
 *
 * The method map gates the REAL response as well as the preflight, so a group
 * that enables no method sends no `access-control-allow-methods` and a browser
 * preflight has nothing to approve against.
 *
 * Warnings rather than errors: an author who intends a closed policy can write
 * exactly these shapes, and the engine stores them, so a pulled workspace must
 * survive a round trip. What is reported is INTENT — nobody configures CORS
 * meaning for no origin to match.
 */
function checkApiGroupCors(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const app of sections.app ?? []) {
    if (!app || typeof app !== "object") continue;
    const record = app as { name?: unknown; cors?: unknown };
    const cors = record.cors as
      | { mode?: unknown; allowOrigins?: unknown; allowMethods?: Record<string, unknown> }
      | undefined;
    if (!cors || cors.mode !== "custom") continue;
    const name = typeof record.name === "string" ? record.name : "?";
    const origins = Array.isArray(cors.allowOrigins) ? cors.allowOrigins : [];

    if (origins.length === 0) {
      bag.warn(
        "api-group.cors-no-origins",
        `apiGroup "${name}": \`cors.mode: "custom"\` with an empty \`allowOrigins\` matches no ` +
          `request, so responses carry NO \`access-control-*\` headers and every browser call ` +
          `fails on a missing \`access-control-allow-origin\`. List the origins ` +
          `(\`allowOrigins: ["https://app.example.com"]\`), or drop to \`mode: "default"\` for ` +
          `the permissive policy.`,
        app,
      );
    } else if (origins.includes("*")) {
      bag.warn(
        "api-group.cors-wildcard-origin",
        `apiGroup "${name}": \`allowOrigins\` contains \`"*"\`, which is compared as a LITERAL ` +
          `origin under \`mode: "custom"\` — no browser sends \`Origin: *\`, so it matches ` +
          `nothing and those responses carry no \`access-control-*\` headers at all. Name each ` +
          `origin, or use \`mode: "default"\`, which is the any-origin policy.`,
        app,
      );
    }

    // Refused at registration unless the group accepts it (a pulled group stores it).
    const unmatchable = unmatchableOrigins(origins);
    if (unmatchable.length > 0) {
      bag.warn(CORS_UNMATCHABLE, `apiGroup "${name}": ${describeUnmatchableOrigins(unmatchable)}`, app);
    }

    const methods = cors.allowMethods ?? {};
    if (!Object.values(methods).some((v) => v === true)) {
      bag.warn(
        "api-group.cors-no-methods",
        `apiGroup "${name}": \`cors.mode: "custom"\` enables no \`allowMethods\`, so no ` +
          `\`access-control-allow-methods\` is sent and a preflight has nothing to approve. ` +
          `Enable every verb the group's queries use — the map also gates the REAL response, ` +
          `so a request whose method is off gets no CORS headers even after a passing preflight.`,
        app,
      );
    }
  }
}

/**
 * An envelope-rooted paged selection that still loses something: a row column
 * listed beside the counters (`["curPage", "id"]` — `id` is no envelope key, so
 * it is dropped), an `items.<col>` naming no column of the row, or a
 * `itemsTotal`/`pageTotal` kept while `totals` is off (the envelope never
 * carries them). Each deploys clean and answers without the key.
 */
function checkEnvelopeSelection(
  statement: EncodedStatement,
  owner: string,
  subject: object,
  envelope: readonly string[],
  roots: readonly string[],
  paging: Record<string, unknown>,
  tables: RowTables,
  bag: DiagnosticBag,
): void {
  const stray = roots.filter((root) => !envelope.includes(root));
  if (stray.length > 0) {
    bag.warn(
      "db.query-output-mixed-roots",
      `${owner}: \`s.db.query\` is PAGED, so \`output\` selects from the envelope (${envelope.map((n) => `"${n}"`).join(", ")}) — ` +
        `but ${stray.map((n) => `"${n}"`).join(", ")} ${stray.length > 1 ? "are row columns" : "is a row column"}, ` +
        `which no envelope key matches, so ${stray.length > 1 ? "they are" : "it is"} dropped from the result. ` +
        `Prefix ${stray.length > 1 ? "them" : "it"}: ${stray.map((n) => `"items.${n}"`).join(", ")}.`,
      subject,
    );
  }
  const totals = envelope.filter((root) => root === "itemsTotal" || root === "pageTotal");
  if (totals.length > 0 && paging.totals !== true) {
    bag.warn(
      "db.query-output-totals-off",
      `${owner}: \`output\` keeps ${totals.map((n) => `"${n}"`).join(", ")}, but the envelope carries ` +
        `${totals.length > 1 ? "them" : "it"} only when counting is on — the key is absent from the result. ` +
        `Set \`paging: { …, totals: true }\`, or drop ${totals.length > 1 ? "them" : "it"} from \`output\`.`,
      subject,
    );
  }
  const items = (statement.output as { items?: unknown[] }).items?.find(
    (item) => (item as { name?: unknown })?.name === "items",
  ) as { children?: unknown[] } | undefined;
  checkRowSelection(statement, owner, subject, items?.children ?? [], "items.", tables, bag);
}

/** Each table's columns and name, by guid — what a row selection is checked against. */
interface RowTables {
  readonly columns: TableColumns;
  readonly names: ReadonlyMap<string, string>;
}

function rowTablesOf(sections: Readonly<Record<string, unknown[] | undefined>>): RowTables {
  const names = new Map<string, string>();
  for (const t of sections.dbo ?? []) {
    const record = t as { guid?: unknown; name?: unknown } | null;
    if (typeof record?.guid === "string" && typeof record.name === "string") names.set(record.guid, record.name);
  }
  return { columns: tableColumnsOf(sections), names };
}

/**
 * Each selected row key that names no column, eval alias or addon alias of the
 * row — absent from the result. `prefix` is how the author spelled the path
 * (`items.` under a paged envelope). A join adds no key to the row, so a
 * selection rooted at a joined table's alias (`course_row.title`) is dropped
 * too — reported with the `eval` projection that does put it on the row.
 */
function checkRowSelection(
  statement: EncodedStatement,
  owner: string,
  subject: object,
  selected: readonly unknown[],
  prefix: string,
  tables: RowTables,
  bag: DiagnosticBag,
): void {
  const context = statement.context as { eval?: unknown; bind?: unknown } | undefined;
  const guid = statementTableGuid(statement);
  const columns = guid === undefined ? undefined : tables.columns.get(guid);
  if (!columns) return;
  const known = new Set(columns);
  const aliases = new Set<string>();
  for (const list of [context?.eval, (statement as { addon?: unknown }).addon]) {
    for (const e of Array.isArray(list) ? list : []) {
      const as = (e as { as?: unknown })?.as;
      if (typeof as !== "string") continue;
      known.add(as);
      aliases.add(as);
    }
  }
  // A joined table's alias: its `as`, else the table's own name.
  const joined = new Set<string>();
  for (const b of Array.isArray(context?.bind) ? context.bind : []) {
    const dbo = (b as { dbo?: { as?: unknown; id?: unknown } })?.dbo;
    const alias = typeof dbo?.as === "string" && dbo.as !== "" ? dbo.as : tables.names.get(String(dbo?.id));
    if (alias !== undefined) joined.add(alias);
  }
  for (const child of selected) {
    const node = child as { name?: unknown; children?: unknown };
    const name = node?.name;
    if (typeof name !== "string" || known.has(name)) continue;
    if (joined.has(name)) {
      const leaf = Array.isArray(node.children) ? (node.children[0] as { name?: unknown } | undefined)?.name : undefined;
      const path = typeof leaf === "string" ? `${name}.${leaf}` : `${name}.<column>`;
      const as = typeof leaf === "string" ? `${name}_${leaf}` : `${name}_col`;
      bag.warn(
        "db.query-output-joined-column",
        `${owner}: \`output\` selects "${prefix}${path}", a JOINED column — a join adds no key to the row, ` +
          `so it is dropped from the result with no error. Project it onto the row with \`eval\` and select ` +
          `the alias: \`eval: [{ name: "${path}", as: "${as}" }]\`, \`output: [..., "${prefix}${as}"]\`.`,
        subject,
      );
      continue;
    }
    // An `_alias` is where an addon's typo lands: match it against the aliases first.
    const near = (name.startsWith("_") ? didYouMean(name, aliases) : undefined) ?? didYouMean(name, known);
    bag.warn(
      statement.name === DB_QUERY ? "db.query-output-unknown-column" : "db.output-unknown-column",
      `${owner}: \`output\` selects "${prefix}${name}", but the row has no "${name}" — the key is absent from ` +
        `the result. ${near ? `Did you mean "${prefix}${near}"? ` : ""}The row carries ${[...known].map((c) => `\`${c}\``).join(", ")}.`,
      subject,
    );
  }
}

/**
 * A paged `s.db.query` whose `output` selection is rooted at the ROW.
 *
 * `output` selects from whatever the statement BINDS, and a paged read binds the
 * envelope, not the rows: the selection's roots have to be `items.<column>` plus
 * whichever counters you want kept. The engine's own tooling writes exactly that
 * — a stored selection for a paged query lists `itemsReceived`, `curPage`, … and
 * nests the columns under an `items` node.
 *
 * Root a paged selection at the row instead and the result is not "some columns"
 * — it is NOTHING. The projection is a whitelist over the bound value's keys, so
 * a list of column names run against `{items, curPage, …}` matches no key, drops
 * every one, and the endpoint answers `[]` at HTTP 200 with no error. A
 * `response` reading `ref("rows.items")` then dies with
 * `Unable to locate var: rows.items`, since the envelope it names is gone too.
 *
 * Probed live: the same query with `items.`-prefixed columns returns the narrowed
 * envelope, and with `metadata: false` the bare column list returns the rows —
 * so the fix is a prefix or the flag, and both halves are legitimate.
 *
 * A selection with NO envelope root at all is reported here. One that names
 * `items` (or a counter) is authored against the envelope, and
 * {@link checkEnvelopeSelection} reports what inside it still selects nothing.
 */
function checkPagedOutputRoot(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const tables = rowTablesOf(sections);
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        // Top-level names only: `items.id` is stored as an `items` node with an
        // `id` child, so the root is what `outputColumns` already reads.
        const roots = outputColumns(statement);
        if (roots === undefined || roots.size === 0) continue;
        // A single-row read or write: its `output` selects from that row.
        if (ROW_OUTPUT_STATEMENTS.has(String(statement.name))) {
          checkRowSelection(statement, owner, obj, (statement.output as { items: unknown[] }).items, "", tables, bag);
          continue;
        }
        if (statement.name !== DB_QUERY) continue;
        const paging = (
          statement.context as { return?: { list?: { paging?: Record<string, unknown> } } } | undefined
        )?.return?.list?.paging;
        if (!paging || paging.enabled !== true || paging.metadata !== true) {
          // Unpaged: the selection is the row's own keys. Only the row-shaped
          // return types select from a row.
          const type = (statement.context as { return?: { type?: unknown } } | undefined)?.return?.type;
          if (type === undefined || type === "list" || type === "single" || type === "stream") {
            checkRowSelection(statement, owner, obj, (statement.output as { items: unknown[] }).items, "", tables, bag);
          }
          continue;
        }
        const envelope = [...roots].filter((root) => (PAGING_ENVELOPE_ROOTS as readonly string[]).includes(root));
        if (envelope.length > 0) {
          checkEnvelopeSelection(statement, owner, obj, envelope, [...roots], paging, tables, bag);
          continue;
        }
        const cols = [...roots];
        bag.warn(
          "db.query-output-not-envelope-rooted",
          `${owner}: \`s.db.query\` is PAGED with an envelope (\`metadata: true\`, the default), ` +
            `so \`output\` selects from that envelope — but this selection is rooted at the row ` +
            `(${cols.map((n) => `"${n}"`).join(", ")}). No name matches an envelope key, so every ` +
            `key is dropped and the endpoint answers \`[]\` at HTTP 200 with no error; a ` +
            `\`response\` reading \`ref("<var>.items")\` then dies with ` +
            `\`Unable to locate var: <var>.items\`. Prefix the columns ` +
            `(\`output: [${cols.map((n) => `"items.${n}"`).join(", ")}]\`, adding "curPage"/` +
            `"itemsReceived"/… for the counters you want kept), or set \`metadata: false\` to ` +
            `bind the rows themselves and select them directly.`,
          obj,
        );
      }
    }
  }
}

/**
 * A paging-envelope read (`ref("rows.items")`) off an `s.db.query` that binds
 * the ROWS — no paging, or paging with `metadata: false`.
 *
 * Only a paged read with an envelope binds `{ items, curPage, … }`; every other
 * list read binds the row array itself, where `items` is no key. The drill
 * resolves to nothing and the response carries a null (or the request fails)
 * with no hint that the paging was what was missing. A name bound by any other
 * statement too is skipped: its shape at the read is not knowable here.
 */
function checkUnpagedEnvelopeReads(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const roots: readonly string[] = PAGING_ENVELOPE_ROOTS;
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      const rowsOnly = new Set<string>();
      const other = new Set<string>();
      /** Paged with `metadata: false` — dropping that flag is the whole fix. */
      const metadataOff = new Set<string>();
      for (const st of statements) {
        // Every name the statement binds, as `collectBindings` reads them.
        const ctx = st.context as { as?: unknown; name?: unknown } | undefined;
        const names = [st.as, ctx?.as, ctx?.name].filter((n): n is string => typeof n === "string" && n !== "");
        if (names.length === 0) continue;
        type Ret = { type?: unknown; list?: { paging?: { enabled?: unknown; metadata?: unknown } } };
        const ret = (st.context as { return?: Ret } | undefined)?.return;
        const listRead = st.name === DB_QUERY && (ret?.type ?? "list") === "list";
        const paging = ret?.list?.paging;
        const envelope = paging?.enabled === true && paging.metadata !== false;
        for (const n of names) {
          (listRead && !envelope ? rowsOnly : other).add(n);
          if (listRead && paging?.enabled === true && paging.metadata === false) metadataOff.add(n);
        }
      }
      if (rowsOnly.size === 0) continue;
      const refs: string[] = [];
      collectVarRefs(obj, refs);
      const reported = new Set<string>();
      for (const path of refs) {
        const [base, field] = path.split(".");
        if (!base || !field || !rowsOnly.has(base) || other.has(base) || !roots.includes(field)) continue;
        if (reported.has(path)) continue;
        reported.add(path);
        const name = (obj as { name?: unknown }).name;
        bag.warn(
          "db.query-envelope-read-unpaged",
          `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}": ` +
            `\`ref("${path}")\` reads the paging envelope, but \`s.db.query\` "${base}" is not paged with ` +
            `one, so it binds the row list and \`${field}\` is no key of it. Read \`ref("${base}")\` for the ` +
            (metadataOff.has(base)
              ? `rows, or drop \`metadata: false\` from its \`paging\` to bind \`{ items, … }\`.`
              : `rows, or page it (\`paging: { page, per_page }\`, envelope on by default) to bind \`{ items, … }\`.`),
          obj,
        );
      }
    }
  }
}

/**
 * A `tableTrigger` `search` reading a bare column. The condition is evaluated by
 * the database against the `NEW`/`OLD` pseudo-rows, so a column is only ever
 * `col("NEW.x")` or `col("OLD.x")` — a bare `col("x")` names neither row.
 * A warning, not a refusal at the factory: a pulled tree must still load.
 */
function checkTriggerSearchColumns(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const columnsByGuid = tableColumnsOf(sections);
  for (const obj of sections.trigger ?? []) {
    const record = obj as { name?: unknown; obj_id?: unknown; meta?: { database?: { search?: unknown } } } | null;
    const search = record?.meta?.database?.search;
    if (search === undefined) continue;
    const bare = new Map<string, string>();
    const unknown = new Set<string>();
    const columns = typeof record?.obj_id === "string" ? columnsByGuid.get(record.obj_id) : undefined;
    walkNodes(search, (node) => {
      if (node.tag !== "col" || typeof node.operand !== "string") return;
      // The engine binds the rows under the exact aliases `NEW`/`OLD`, so a
      // lowercase `new.x` names neither — the column is what gets suggested.
      const prefixed = /^(NEW|OLD)\.(.+)$/i.exec(node.operand);
      if (!prefixed || !/^(NEW|OLD)$/.test(prefixed[1]!)) {
        bare.set(node.operand, prefixed ? prefixed[2]! : node.operand);
      } else if (columns && !columns.includes(prefixed[2]!.split(".")[0]!)) {
        unknown.add(node.operand);
      }
    });
    for (const [operand, column] of bare) {
      bag.warn(
        "trigger.search-bare-column",
        `tableTrigger "${String(record?.name)}": \`search\` reads \`col("${operand}")\`, which names neither ` +
          `row the condition is tested against. Write \`col("NEW.${column}")\` for the row after the ` +
          `change, or \`col("OLD.${column}")\` for the row before it.`,
        record as object,
      );
    }
    for (const operand of unknown) {
      bag.warn(
        "trigger.search-unknown-column",
        `tableTrigger "${String(record?.name)}": \`search\` reads \`col("${operand}")\`, but its table has no ` +
          `column "${operand.slice(4).split(".")[0]}" — it declares ${columns!.map((c) => `\`${c}\``).join(", ")}. ` +
          `Name one of those.`,
        record as object,
      );
    }
  }
}

/**
 * A condition container whose terms do not all join the same way — what
 * `mixed(a, { or: b }, { and: c })` writes. Its meaning depends on where it
 * sits: a branch folds the terms left to right, a query filter applies
 * AND-before-OR, and the stored form records neither. Authored, it is a defect
 * in waiting; a pulled tree carries it and accepts the code on the def.
 */
function checkMixedJoins(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    // Not checked on a table view or an addon: a pulled one carries its
    // condition as stored, and a mixed filter there is left to the author.
    if (payloadKey === "dbo" || payloadKey === "addon") continue;
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      let found = false;
      walkNodes(obj, (node) => {
        const terms = node.expression;
        if (found || !Array.isArray(terms) || terms.length < 3) return;
        const joins = new Set(
          terms.slice(1).map((t) => (t as { or?: unknown } | null)?.or === true),
        );
        if (joins.size > 1 && terms.every((t) => typeof (t as { type?: unknown } | null)?.type === "string")) found = true;
      });
      if (!found) continue;
      const record = obj as Record<string, unknown>;
      bag.warn(
        "condition.mixed",
        `${sdkKindName(payloadKey, record)} "${typeof record.name === "string" ? record.name : "?"}": a condition ` +
          `mixes AND and OR at one level (\`mixed(...)\`). A branch reads it left to right, a query filter ` +
          `AND-before-OR, and the stored form says neither. Write \`and(or(a, b), c)\` or \`or(a, and(b, c))\` ` +
          `— each has one reading everywhere. To keep it as stored: \`diagnostics: { allow: ["condition.mixed"] }\` on the def.`,
        record,
      );
    }
  }
}

const VIEW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A table view the engine cannot hold as written: an `id` that is not a uuid
 * (the view is keyed by it), an id or name two views share, or a `hide`/`sort`/
 * `where` naming no column of the table. Each exports clean and then the view
 * shows the wrong rows, or collides with its twin. Warnings, so a pulled tree
 * whose table dropped a column a view still names keeps loading; a blank id is
 * the engine's own "none stored" and is not judged.
 */
function checkTableViews(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  const ids = new Map<string, string>();
  for (const t of sections.dbo ?? []) {
    const record = t as { name?: unknown; schema?: unknown; views?: unknown } | null;
    if (!record || !Array.isArray(record.views)) continue;
    const owner = `table "${String(record.name)}"`;
    const columns = new Set(
      (Array.isArray(record.schema) ? record.schema : []).flatMap((c) =>
        typeof (c as { name?: unknown })?.name === "string" ? [(c as { name: string }).name] : [],
      ),
    );
    const names = new Set<string>();
    record.views.forEach((raw, i) => {
      const view = raw as { id?: unknown; name?: unknown; hiddenCols?: unknown; sort?: unknown; expression?: unknown };
      const at = `${owner} \`views[${i}]\``;
      const id = typeof view.id === "string" ? view.id : "";
      if (id !== "" && !VIEW_UUID.test(id)) {
        bag.warn(
          "table.view-id-not-uuid",
          `${at}: \`id\` "${id}" is not a uuid, and the engine keys the view by it. Generate one once ` +
            `(\`crypto.randomUUID()\`) and keep it in the source.`,
          record,
        );
      }
      if (id !== "" && ids.has(id)) {
        bag.warn("table.view-duplicate", `${at}: \`id\` "${id}" is also the id of ${ids.get(id)} — each view needs its own uuid.`, record);
      } else if (id !== "") ids.set(id, `${owner} view "${String(view.name)}"`);
      if (typeof view.name === "string") {
        if (names.has(view.name)) {
          bag.warn("table.view-duplicate", `${at}: another view of this table is also named "${view.name}" — rename one.`, record);
        }
        names.add(view.name);
      }
      const named: Array<[string, string]> = [];
      for (const h of Array.isArray(view.hiddenCols) ? view.hiddenCols : []) if (typeof h === "string") named.push(["hide", h]);
      for (const e of Array.isArray(view.sort) ? view.sort : []) {
        const n = (e as { name?: unknown })?.name;
        if (typeof n === "string") named.push(["sort", n]);
      }
      walkNodes(view.expression, (node) => {
        if (node.tag === "col" && typeof node.operand === "string") named.push(["where", node.operand]);
      });
      for (const [field, column] of named) {
        const root = column.split(".")[0]!;
        if (columns.has(root)) continue;
        const near = didYouMean(root, columns);
        bag.warn(
          "table.view-unknown-column",
          `${at}: \`${field}\` names "${column}", which is not a column of this table` +
            `${near ? ` — did you mean "${near}"?` : "."} The view exports and then ${field === "hide" ? "hides nothing" : field === "sort" ? "does not sort" : "filters on nothing"}.`,
          record,
        );
      }
    });
  }
}

/**
 * Warn about the shapes that return HTTP 200 while destroying data, reading
 * nothing, or failing at runtime. All are statically detectable and none is
 * ever blocked — see the individual checks for why each stays a warning.
 */
export function checkStacks(
  tables: readonly TableDef[],
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  workspaceConfig: Readonly<Record<string, unknown>> = {},
  /** Where the env declaration stands — see {@link EnvSource}. */
  envSource: EnvSource = "authored",
): void {
  checkMiddleware(sections, bag, workspaceConfig);
  checkPostMergeOnList(sections, bag, workspaceConfig);
  checkStoreFromStoredFileInput(sections, bag);
  checkInputScope(sections, bag);
  checkColumnScope(sections, bag);
  // The env counterpart of `stack.inp-undeclared` — checkable only against a
  // config that declares names, which is why it takes one.
  checkEnvNames(workspaceConfig, sections, bag, envSource);
  // Needs no table definition — the selection and the paging flag are both on
  // the statement — so it runs before the `tables.length === 0` bail below.
  checkPagedOutputRoot(sections, bag);
  checkUnpagedEnvelopeReads(sections, bag);
  // Group config rather than a stack, but it shares the "deploys clean, fails
  // only in a browser" shape and belongs in the same set of findings.
  checkApiGroupCors(sections, bag);
  checkTriggerSearchColumns(sections, bag);
  checkTableViews(sections, bag);
  checkMixedJoins(sections, bag);
  checkBlankTableBindings(sections, bag);
  if (tables.length === 0) return;
  const tablesByGuid = new Map<string, TableDef>();
  for (const def of tables) tablesByGuid.set(resolveRef("dbo", def), def);

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      if (statements.length === 0) continue;
      for (const statement of statements) {
        if (statement.name === BULK_UPDATE) {
          checkBulkUpdate(statement, owner, obj, tablesByGuid, bag);
        }
      }
      checkInternalColumnReads(statements, owner, obj, tablesByGuid, bag);
    }
  }
}

/** The stored operand values the engine's `ignore_empty` reads as empty. */
const EMPTY_OPERANDS = new Set(["", "[]", "{}"]);

/**
 * The operator whose empty right side FLIPS the result set. `in []` matches no
 * row, so dropping the clause turns none into all. `not in []` is not in the
 * list on purpose: it already matches every row, so dropping it changes nothing
 * — that one gets the milder "constrains nothing" reading.
 */
const MEMBERSHIP_OPS = new Set(["in"]);

/**
 * `ignoreEmpty` on a STATICALLY empty operand: a clause that can only ever be
 * dropped, and on `in` that means the opposite of what it reads as.
 *
 * `ignoreEmpty` does not match zero rows — it removes the predicate from the
 * query. So `cmp(col("owner"), "in", allowedIds, { ignoreEmpty: true })` with an
 * empty `allowedIds` returns the UNFILTERED table: every row, to a caller who is
 * allowed none of them. Without the flag the same clause is `IN ()`, which
 * matches nothing. The two readings are exact opposites and the flag is the only
 * thing that says which one you get.
 *
 * Only a literal empty operand is reported. A `ref`/`inp` list — the case that
 * actually leaks in production, because the list comes from a lookup that
 * *sometimes* returns nothing — cannot be judged from the bundle, so this is a
 * warning about a shape that is provably a no-op today rather than a claim about
 * every use of the flag. The general hazard is documented, not guarded.
 */
function checkIgnoreEmptyOperand(
  node: { op?: unknown; left?: unknown; right?: unknown },
  owner: string,
  host: object,
  bag: DiagnosticBag,
): void {
  const right = node.right as { tag?: unknown; operand?: unknown; ignore_empty?: unknown } | undefined;
  if (!right || right.ignore_empty !== true) return;
  if (typeof right.tag !== "string" || !right.tag.startsWith("const")) return;
  if (typeof right.operand !== "string" || !EMPTY_OPERANDS.has(right.operand)) return;
  const op = typeof node.op === "string" ? node.op : "?";
  const left = (node.left as { operand?: unknown } | undefined)?.operand;
  const subject = typeof left === "string" && left !== "" ? `\`${left}\` ` : "";
  const consequence = MEMBERSHIP_OPS.has(op)
    ? `this clause selects EVERY row instead of none, the opposite of what \`${op} []\` reads as. ` +
      `On a permission filter that is the whole table handed to a caller entitled to none of it.`
    : `this clause is dropped from the query and constrains nothing.`;
  bag.warn(
    "expression.ignore-empty-static-empty",
    `${owner}: comparison ${subject}\`${op}\` sets \`ignoreEmpty\` on an operand that is EMPTY ` +
      `in the bundle. \`ignoreEmpty\` REMOVES the predicate when its operand resolves empty ` +
      `rather than matching zero rows, so ${consequence} Drop \`ignoreEmpty\` to keep the ` +
      `empty-list reading (\`in []\` matches nothing), or pass the list you meant.`,
    host,
  );
}

/**
 * Every comparison in the bundle, wherever it sits — a runtime condition, a
 * precondition, a `db.query`/`db.bulk.delete` search, a table view filter.
 */
export function checkExpressionOperands(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      walkNodes(obj, (record) => {
        // The engine's comparison node: `{op, left, right}` under `statement`.
        const statement = record.statement as { op?: unknown; left?: unknown; right?: unknown } | undefined;
        if (statement && typeof statement === "object" && "op" in statement) {
          checkIgnoreEmptyOperand(statement, owner, obj, bag);
        }
      });
    }
  }
}

/**
 * The JS-interpolation marker: a tagged value pulled through `String()` at
 * build time.
 *
 * `c.text(`Hi ${ref("u.name")}`)` and `"Hi " + ref("u.name")` both type-check —
 * TS permits any object where one `+`/template operand is a string — and both
 * evaluate BEFORE the factory runs, so what reaches the encoder is the plain
 * text `Hi [object Object]`. Nothing downstream can tell it from a deliberate
 * constant: it exports, imports, and is served verbatim. Verified by probe
 * during the 2026-08 grounding audit; the composition an author meant is
 * `withFilters` + `fl.concat`, an `obj({...})` member, or `c.expression`.
 *
 * The same accident reaches other string slots — a bare row cell wrapped by its
 * column type, a JSON member of `c.array`/`c.obj` (the string is no longer a
 * tagged value by the time their nested-value rejection looks), an expression
 * body — so the sweep is over every stored `{tag, value}` string rather than
 * `c.text` alone.
 *
 * WARNING, not an error: the substring is not proof of the accident (a lambda
 * body may compare against it deliberately), and a pulled workspace that
 * already carries one must stay representable — the report is equally right
 * about that stored garbage.
 */
const INTERPOLATED_OBJECT = "[object Object]";

export function checkInterpolatedValues(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      const samples: string[] = [];
      walkNodes(obj, (record) => {
        if (typeof record.tag !== "string" || typeof record.value !== "string") return;
        if (!record.value.includes(INTERPOLATED_OBJECT)) return;
        if (samples.length < 2) {
          const text = record.value.length > 60 ? `${record.value.slice(0, 57)}…` : record.value;
          samples.push(`\`${text}\` (tag \`${record.tag}\`)`);
        }
      });
      if (samples.length === 0) continue;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      bag.warn(
        "value.interpolated-object",
        `${owner} stores ${samples.join(" and ")} — \`[object Object]\` is the JS toString of a ` +
          `tagged value (\`ref()\`/\`inp()\`/\`c.*\`) interpolated into a template literal or \`+\` ` +
          `concatenation, which evaluates at BUILD time; the engine serves this text verbatim. ` +
          `Compose at runtime instead: \`withFilters(c.text("…"), fl.concat(ref("…")))\`, an ` +
          `\`obj({...})\` member, or \`c.expression\`.`,
        obj,
      );
    }
  }
}

/** A `set` path naming a canonical non-negative integer key: `["0"]`, `["12"]`. */
const INDEX_SET_PATH = /^\["(0|[1-9][0-9]*)"\]$/;

/** The keys of an object value stored as `{}` plus `set` filters, when every key is an index; `null` otherwise. */
function indexRunKeys(record: Record<string, unknown>): string[] | null {
  if (record.tag !== "const:obj" || record.value !== "{}" || !Array.isArray(record.filters)) return null;
  if (record.filters.length === 0) return null;
  const keys: string[] = [];
  for (const f of record.filters as Array<{ name?: unknown; arg?: unknown }>) {
    if (f?.name !== "set" || !Array.isArray(f.arg)) return null;
    const path = (f.arg[0] as { value?: unknown; tag?: unknown } | undefined) ?? {};
    const match = path.tag === "const" && typeof path.value === "string" ? INDEX_SET_PATH.exec(path.value) : null;
    if (match === null) return null;
    keys.push(match[1]!);
  }
  const indices = new Set(keys.map(Number));
  for (let i = 0; i < keys.length; i++) if (!indices.has(i)) return null;
  return keys;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A `c.int` constant outside the engine's signed 64-bit range. The engine
 * clamps such a value to the nearest bound — `9223372036854775808` and
 * `18446744073709551615` both read back `9223372036854775807` — at HTTP 200
 * with no error, so the stack computes with a number nobody wrote. `c.int`
 * still takes one (a pulled workspace may store it); the export names it.
 */
export function checkIntRange(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const out: string[] = [];
      walkNodes(obj, (record) => {
        if (record.tag !== "const:int") return;
        const raw = typeof record.value === "string" ? record.value : typeof record.operand === "string" ? record.operand : undefined;
        if (raw === undefined || !/^[+-]?\d+$/.test(raw)) return;
        const n = BigInt(raw);
        if ((n < INT64_MIN || n > INT64_MAX) && !out.includes(raw)) out.push(raw);
      });
      if (out.length === 0) continue;
      const name = (obj as { name?: unknown }).name;
      bag.warn(
        "value.int-out-of-range",
        `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof name === "string" ? name : "?"}" ` +
          `stores the integer ${out.map((v) => `\`${v}\``).join(", ")}, outside the signed 64-bit range ` +
          `(${INT64_MIN} to ${INT64_MAX}). The engine clamps it to the nearest bound with no error. Use a value in ` +
          `range, or c.decimal()/c.text() when the magnitude is the point.`,
        obj,
      );
    }
  }
}

/**
 * An object literal whose keys are a zero-based contiguous index run, so the
 * engine evaluates it as a LIST rather than the object it reads as.
 *
 * A numeric key IS an index in the engine's data model. The condition is
 * deliberately narrow: every key numeric AND the set exactly `0..n-1`. A
 * non-zero-based `{"2":…}` survives as a key, a gapped `{"0":…,"2":…}` is not an
 * index run, and a mixed `{"0":…,"x":…}` is an object. None of those warn.
 *
 * Read from the stored bytes, so it is raised about the def that carries the
 * value and that def's `diagnostics.allow` can accept it.
 */
export function checkZeroBasedObjects(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const samples: string[] = [];
      walkNodes(obj, (record) => {
        const keys = indexRunKeys(record);
        if (keys !== null && samples.length < 2) samples.push(`{${keys.map((k) => `${JSON.stringify(k)}: …`).join(", ")}}`);
      });
      if (samples.length === 0) continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      bag.warn(
        "value.obj-zero-based-numeric-keys",
        `${owner} stores the object ${samples.join(" and ")}, whose zero-based numeric keys make the ` +
          `engine evaluate it as a LIST, not an object. A numeric key IS an index in that data model, which is not ` +
          `something this encoding introduces. If you want the list, write c.array([…]) and the intent is on ` +
          `the page; if you want an object, prefix the keys so they are not an index run (e.g. "k0"). A ` +
          `non-zero-based numeric key ({"2": …}) survives as a key.`,
        obj,
      );
    }
  }
}

/**
 * A regex operand pair written backwards, caught in the BYTES.
 *
 * `withFilters` refuses the shape at build time, so authored code cannot reach
 * here — but a `rawValue`, a workspace decoded from a bundle, or a hand-built
 * envelope never passes through that guard, and the whole reason this bug was
 * reported is that it ships silently: the endpoint answers HTTP 200 with `false`
 * for every input, and a `if (matches) reject` precondition built on it permits
 * exactly the values it exists to refuse.
 *
 * A WARNING, matching how the bag treats every usually-wrong-but-legible shape:
 * the accusation reads a constant that carries delimiters AND a metacharacter,
 * which is strong evidence and not proof — a subject really can be the text
 * `/^a+$/`. `strict` promotes it, which is the answer to a report whose title is
 * that the shape exports clean under `--strict`.
 */
export function checkRegexOperandOrder(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      const seen = new Set<string>();
      walkNodes(obj, (record) => {
        if (typeof record.tag !== "string" || typeof record.value !== "string") return;
        if (!Array.isArray(record.filters)) return;
        const reversed = reversedRegexOperands(record as unknown as TaggedValue);
        if (!reversed) return;
        seen.add(`\`${reversed.filter}\` (pattern ${JSON.stringify(reversed.subject)})`);
      });
      if (seen.size === 0) continue;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      bag.warn(
        "value.regex-operands-reversed",
        `${owner} pipes a regex filter's SUBJECT and passes its PATTERN as the argument: ` +
          `${[...seen].join("; ")}. The regex family is pattern-piped — the piped value is the ` +
          `PATTERN and the argument is the text tested against it, the reverse of every other ` +
          `filter — so this answers false for every input with HTTP 200 and no error, and a ` +
          `precondition built on it lets through the values it exists to refuse. Swap the ` +
          `operands: \`withFilters(c.regex(…), fl.regex_test(subject))\`.`,
        obj,
      );
    }
  }
}

/** The argument slot holding a timezone, per filter that takes one. */
const TIMEZONE_ARG: Readonly<Record<string, number>> = {
  epochms_date: 1,
  epochms_from_format: 1,
  epochms_transform: 1,
  to_epoch_day: 0,
  to_epoch_hour: 0,
  to_epoch_minute: 0,
  to_epoch_ms: 0,
  to_epoch_sec: 0,
  to_epochms: 0,
};

let timeZones: readonly string[] | undefined;

/**
 * Whether the engine applies a timezone name: an IANA zone or link, matched
 * without regard to case (`America/New_York`, `europe/london`, `UTC`,
 * `Etc/GMT-5`, `EST`), plus `Z` and `Factory`. Measured live: anything else —
 * a numeric offset (`+05:30`), `GMT+5`/`UTC+5`, an abbreviation that is not a
 * zone of its own (`PDT`, `CEST`) — is not an error there; the date silently
 * formats in UTC.
 *
 * The zone list is this Node's ICU data, so a zone newer than it reads as
 * unknown here (a warning, never a refusal).
 */
export function isKnownTimezone(tz: string): boolean {
  // A name with no `/` is a zone only if the zone database lists it as one;
  // the date library here also maps abbreviations (`PST`) and offsets to a
  // zone, which the engine does not.
  if (!tz.includes("/")) return SLASHLESS_ZONES.has(tz.toLowerCase());
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone names with no `/` the engine applies: the zone database's own, plus `Z`. */
const SLASHLESS_ZONES: ReadonlySet<string> = new Set(
  (
    "Z Factory UTC UCT GMT GMT0 GMT+0 GMT-0 Greenwich Universal Zulu EST MST HST CET EET WET MET EST5EDT CST6CDT " +
    "MST7MDT PST8PDT Cuba Egypt Eire GB GB-Eire Hongkong Iceland Iran Israel Jamaica Japan Kwajalein Libya NZ " +
    "NZ-CHAT Navajo PRC Poland Portugal ROC ROK Singapore Turkey W-SU"
  )
    .split(" ")
    .map((z) => z.toLowerCase()),
);

/** The `Etc/GMT` zone for a whole-hour offset (`+5`, `UTC+05:00`) — whose sign POSIX inverts — if it is one. */
function etcZoneFor(tz: string): string | undefined {
  const m = /^(?:gmt|utc)?([+-])(\d{1,2})(?::?00)?$/i.exec(tz);
  if (m === null) return undefined;
  const h = Number(m[2]);
  if (h === 0) return "UTC";
  if (h > (m[1] === "+" ? 14 : 12)) return undefined;
  return `Etc/GMT${m[1] === "+" ? "-" : "+"}${h}`;
}

/**
 * A constant timezone argument the engine does not apply (`"America/NewYork"`,
 * `"+05:30"`, `"PDT"`). It exports, deploys and runs clean, formatting in UTC.
 * Names the near miss — for a whole-hour offset, its `Etc/GMT` zone.
 */
export function checkTimezoneArgs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const seen = new Map<string, string>();
      walkNodes(obj, (record) => {
        const at = typeof record.name === "string" && Array.isArray(record.arg) ? TIMEZONE_ARG[record.name] : undefined;
        if (at === undefined) return;
        const tz = (record.arg as Array<{ tag?: unknown; value?: unknown; filters?: unknown[] }>)[at];
        if (tz?.tag !== "const" || typeof tz.value !== "string" || tz.value === "" || (tz.filters?.length ?? 0) > 0) return;
        const name = tz.value;
        if (isKnownTimezone(name)) return;
        timeZones ??= typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
        const near = etcZoneFor(name) ?? nearestKey(name, timeZones);
        seen.set(`fl.${record.name as string}(…, ${JSON.stringify(name)})`, near ?? "");
      });
      for (const [call, near] of seen) {
        bag.warn(
          "value.timezone-unknown",
          `${sdkKindName(payloadKey, obj as { type?: unknown })} "${String((obj as { name?: unknown }).name ?? "?")}": ` +
            `${call} names a timezone the engine does not apply — it formats in UTC instead, without an error. ` +
            (near !== "" ? `Did you mean ${JSON.stringify(near)}?` : `Use an IANA name such as "America/New_York" or "UTC".`),
          obj,
        );
      }
    }
  }
}

/**
 * Run the seed checks on the programmatic export path too.
 *
 * `xanosdk export`/`deploy` materialise every table's seed and validate it —
 * unknown column, un-coercible value, an enum value outside its declared set, a
 * mix of explicit and omitted `id`. `app.export()` (and `emitBundle()` /
 * `writeBundle()`, which call it) did none of that, so the same workspace failed
 * loudly through one documented entry point and succeeded silently through the
 * other. `llms.txt` presents the three emitters as differing only in OUTPUT
 * FORMAT, and anyone scripting a build around `writeBundle` lost every seed
 * check without being told.
 *
 * The two paths now agree on what is LEGAL, even where they differ on what is
 * EMITTED — nothing here puts a seed row into the bundle, which is what keeps
 * seed values out of a frontend build.
 *
 * **Limit, by construction:** only a seed authored as a literal array is
 * reachable from a synchronous, `node:fs`-free export. A thunk (`() =>
 * import("./seed.json")`) or a `seedFile()` needs an await or the filesystem, so
 * it is still validated only by the CLI path. That is stated in `llms.txt`
 * rather than left to be discovered.
 *
 * ERRORS, matching the CLI: every one of these is data that vanishes or a
 * primary-key collision on deploy, not a judgement call.
 */
export function checkSeed(
  tables: readonly TableDef[],
  bag: DiagnosticBag,
  /** The workspace's `use_xdo`, which a table without its own `useXdo` inherits. */
  workspaceUseXdo = false,
): void {
  for (const def of tables) {
    checkPublicSeed(def, bag);
    const source = def.seed;
    // A thunk or a `seedFile()` cannot be resolved here — see the limit above.
    if (source === undefined || typeof source === "function" || isSeedFileSource(source)) continue;
    if (!Array.isArray(source) || source.length === 0) continue;
    try {
      const coerced = coerceSeedRowValues(def.name, tableColumns(def), source, { useXdo: def.useXdo ?? workspaceUseXdo });
      assertSeedIds(def.name, tableColumns(def), coerced);
      assertSeedUnique(def.name, tableIndexes(def), coerced);
    } catch (cause) {
      // Every bad row, one detail each — the same set the CLI path reports.
      if (cause instanceof DiagnosticError) for (const d of cause.details) bag.add(d);
      else bag.error("seed.invalid", (cause as Error).message);
    }
  }
}

/**
 * `publicSeed` exempts a column's seed values from the `deploy --static` scan,
 * so every entry has to exempt something. A name that is not a column, a column
 * that is already public, or a table with no seed would read as a declaration
 * and do nothing — the author believes a guard is waived (or a typo leaves the
 * real column guarded) and nothing says otherwise until a deploy.
 */
function checkPublicSeed(def: TableDef, bag: DiagnosticBag): void {
  if (def.publicSeed === undefined || def.publicSeed.length === 0) return;
  if (def.seed === undefined) {
    bag.error(
      "seed.public-seed",
      `Table "${def.name}" declares publicSeed but has no \`seed\`: there are no seed values to declare public.`,
    );
    return;
  }
  const columns = new Map(tableColumns(def).map((c) => [c.name, c]));
  for (const name of def.publicSeed) {
    const col = columns.get(name);
    if (col === undefined) {
      bag.error(
        "seed.public-seed",
        `Table "${def.name}" publicSeed names "${name}", which is not a column. Known columns: ` +
          `${[...columns.keys()].join(", ")}.`,
      );
    } else if (!isNonPublicColumn(col)) {
      bag.error(
        "seed.public-seed",
        `Table "${def.name}" publicSeed names "${name}", which is already public: its seed values ` +
          `are served by the API, and the static scan never looks for them. Remove it from publicSeed.`,
      );
    }
  }
}

/**
 * Column names the engine cannot carry through an insert.
 *
 * `run` is the key a block statement uses for its own sub-stack
 * (`context.if.run`, `context.else.run`, `context.run`), and an insert's
 * parameter map collides with it: EVERY `s.db.add` into a table holding a
 * column called `run` fails with HTTP 400, at every column type, whether the
 * statement supplies a value or leaves the declared default to stand in.
 *
 * The match is exact and case sensitive, and it is ONE name. 35 names were
 * measured against the same table and the same insert — `if`, `else`, `input`,
 * `as`, `value`, `stack`, `switch`, `default`, `return`, `this`, `index` and
 * the rest of the obvious set — and all of them passed, as did `Run`, `runs`
 * and `run_id`. So this is a literal, not a pattern, and widening it would be
 * guessing.
 *
 * The 400 names the column and talks about the VALUE (`Integer filter requires
 * a scalar value.`), so a reader spends the search on the value, which is not
 * the cause. That distance between the message and the cause is what makes it
 * worth saying at build time.
 */
const RESERVED_COLUMN_NAMES = new Set(["run"]);

/**
 * A column whose name the engine reserves — deploys clean, then 400s on every
 * insert.
 *
 * WARNING, not an error, and the reasoning is the module note's: this is a
 * defect in one engine code path, not a rule of the data model, and a hard
 * guard would have to be un-shipped the day it is fixed. What a warning costs
 * if the engine changes is one deleted check; what it saves today is a search
 * that starts at the value and never reaches the name. `export --strict` — what
 * a pipeline runs — turns it into a failed build, which is the "refuse it at
 * export time" the report asked for.
 */
export function checkReservedColumnNames(tables: readonly TableDef[], bag: DiagnosticBag): void {
  for (const def of tables) {
    for (const col of tableColumns(def)) {
      if (!RESERVED_COLUMN_NAMES.has(col.name)) continue;
      bag.warn(
        "table.reserved-column-name",
        `table "${def.name}": the column name \`${col.name}\` is reserved by the engine — it is ` +
          `the key a block statement stores its sub-stack under, and an insert's parameter map ` +
          `collides with it. The table deploys and reads back correctly, and then EVERY ` +
          `\`s.db.add\` into it fails with HTTP 400 naming \`${col.name}\` and complaining about ` +
          `the value — at every column type, and whether the statement supplies a value or ` +
          `leaves the default to stand in. Rename the column (\`${col.name}_id\`, ` +
          `\`${col.name}s\`); the match is exact and case sensitive, so nothing else is affected.`,
        def,
      );
    }
  }
}

/**
 * An active `cache` on a query or function whose ttl is not a positive whole
 * number. The engine stores a response only when ttl > 0, yet an active cache
 * still looks it up on every call — and costs a function its fast path — so
 * the cache holds nothing and costs every call. A WARNING: the engine accepts
 * the shape, so a fixture pinning that behavior accepts it with `diagnostics.allow`.
 */
export function checkCacheTtl(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const key of ["query", "function"] as const) {
    for (const obj of sections[key] ?? []) {
      const o = obj as { name?: unknown; cache?: { active?: unknown; ttl?: unknown } } | null;
      const ttl = o?.cache?.ttl;
      if (o?.cache?.active !== true || (Number.isInteger(ttl) && (ttl as number) > 0)) continue;
      bag.warn(
        "cache.ttl-not-positive",
        `${key} "${String(o.name)}": \`cache.ttl\` is ${JSON.stringify(ttl) ?? String(ttl)} — the engine stores a response only ` +
          `for a ttl of 1 or more whole seconds, so this cache never holds anything while every call still looks it up. ` +
          `Set a positive ttl (\`cache: { ttl: 60 }\`), or remove the \`cache\` block for no caching.`,
        obj as object,
      );
    }
  }
}

/**
 * A column whose name the rule refuses, kept because the table accepts
 * `table.column-name-unusable` — a pulled table carrying the live name. Raised
 * so the accept is used and listed; `table()` refuses the name without it.
 */
export function checkUnusableColumnNames(tables: readonly TableDef[], bag: DiagnosticBag): void {
  for (const def of tables) {
    for (const { name, why } of unusableColumns(def.schema)) {
      bag.warn(
        COLUMN_NAME_UNUSABLE,
        `table "${def.name}": the column name ${JSON.stringify(name)} ${why}. Renaming the column fixes it, and moves its data.`,
        def,
      );
    }
  }
}

/**
 * The same reserved key, reached through a call's input map (#480). A call
 * statement carries its arguments keyed by the callee's input names, and the
 * engine's argument walk skips a `run` key there exactly as it does in an
 * insert's parameter map — so the callee receives the unevaluated argument.
 *
 * Measured on an ephemeral through `s.function.run` and `s.function.call`: an
 * object input binds its children's defaults at HTTP 200 with no error, a text
 * input 400s naming `run`, and `run2` beside it binds. A query input `run`
 * bound over HTTP is fine — the request body is not an argument tree — so a
 * query's declaration is not flagged, only a call into it.
 */
const RESERVED_INPUT_NAMES = RESERVED_COLUMN_NAMES;

/**
 * An input the engine cannot fill because its name is reserved: a function
 * declaring one (a call is the only way to fill a function input), and any call
 * passing one. WARNING for the reason {@link checkReservedColumnNames} gives;
 * `export --strict` makes it a failed build.
 */
export function checkReservedInputNames(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  // Every statement that hands its `input[]` to another object as that object's
  // inputs. Built here because RUN_FAMILY is declared further down the module.
  const callsWithInput: Readonly<Record<string, string>> = { "mvp:function": "s.function.run", ...RUN_FAMILY };
  const fix = (name: string) =>
    `Rename the input (\`${name}_id\`, \`${name}s\`); the match is exact and case sensitive, so nothing else is affected.`;

  for (const fn of sections.function ?? []) {
    const { name, input } = (fn ?? {}) as { name?: unknown; input?: unknown };
    if (!Array.isArray(input)) continue;
    for (const param of input) {
      const paramName = (param as { name?: unknown } | null)?.name;
      if (typeof paramName !== "string" || !RESERVED_INPUT_NAMES.has(paramName)) continue;
      bag.warn(
        "function.reserved-input-name",
        `function "${String(name)}": the input name \`${paramName}\` is reserved by the engine — a call ` +
          `passes its arguments keyed by input name, and the engine skips a \`${paramName}\` key when it ` +
          `evaluates them, so the function receives the unevaluated argument. An object input binds its ` +
          `defaults with no error; a text input fails with HTTP 400 naming \`${paramName}\`. ${fix(paramName)}`,
        fn as object,
      );
    }
  }

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const objName = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof objName === "string" ? objName : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        const factory = callsWithInput[statement.name];
        if (factory === undefined) continue;
        for (const reserved of RESERVED_INPUT_NAMES) {
          if (statementInput(statement, reserved) === undefined) continue;
          bag.warn(
            "statement.reserved-input-name",
            `${owner}: \`${factory}\` passes an input named \`${reserved}\`, which is reserved by the ` +
              `engine — it skips a \`${reserved}\` key when it evaluates a call's arguments, so the ` +
              `callee receives the unevaluated argument: an object input binds its defaults with no ` +
              `error, a text input fails with HTTP 400 naming \`${reserved}\`. ${fix(reserved)}`,
            obj,
          );
        }
      }
    }
  }
}

/** Every `mvp:function` in `root` that runs: a disabled statement skips its whole subtree. */
function enabledFunctionRuns(root: unknown): EncodedStatement[] {
  const out: EncodedStatement[] = [];
  // Iterative: a pulled tree can nest far deeper than the call stack allows.
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) pending.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.startsWith("mvp:")) {
      if (record.disabled === true) continue;
      if (record.name === "mvp:function") out.push(record as unknown as EncodedStatement);
    }
    pending.push(...Object.values(record).reverse());
  }
  return out;
}

/** `<kind> "<name>"`, with a query's verb in the name (`query "POST labs"`) since the verb tells two apart. */
function sdkSubject(payloadKey: string, obj: Record<string, unknown>): string {
  const name = typeof obj.name === "string" ? obj.name : "?";
  const verb = payloadKey === "query" && typeof obj.verb === "string" && obj.verb !== "" ? `${obj.verb} ` : "";
  return `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${verb}${name}"`;
}

/** The hosts whose input bag is the raw request when they declare no inputs (measured live). */
const RAW_REQUEST_HOSTS: ReadonlySet<string> = new Set(["query", "tool", "prompt"]);

/**
 * The input names a call into `record` (a stored object of payload `section`)
 * binds — what {@link checkUnknownCallInputs} checks a call's keys against.
 * `null` when any key reaches it: a `dbLink` to a table `tableColumns` does not
 * carry, or a raw-request host that declares no inputs.
 */
export function callableInputNames(
  record: Record<string, unknown>,
  section: string,
  tableColumns: ReadonlyMap<string, readonly string[]>,
): Set<string> | null {
  const inputs = declaredInputNames(record, tableColumns);
  return inputs !== null && inputs.size === 0 && RAW_REQUEST_HOSTS.has(section) ? null : inputs;
}

/**
 * An `s.function.run` that leaves out an input its CALLER can fill.
 *
 * The engine binds an input the call omits from the calling def's own input
 * bag before it falls back to the target's default. Measured live:
 *
 *  - The caller DECLARES an input of the same name: the call takes the
 *    caller's value — and, when the request does not send it, that input's
 *    empty value (`0` for an int), so the target's default is lost too.
 *  - The caller is an endpoint, tool or prompt that declares NO inputs at all:
 *    its bag is the raw request (query string, body, MCP arguments), so any
 *    parameter the client sends under the target's input name is bound.
 *  - Otherwise — the caller declares inputs but not this one, or is a function,
 *    task, trigger or resource — the target's default applies. A function
 *    caller's bag is its own call's arguments, never its caller's request.
 *
 * A binding passed as `ignored()` always takes the target's default, so it is
 * not omitted. `id` is never bound this way. An `input.dbLink` on either side
 * counts as the columns it expands into.
 *
 * Warns because the pass-through is easy to miss, not because it is a defect:
 * a def that relies on it accepts it with
 * `diagnostics: { allow: ["statement.omitted-input"] }`. A target the bundle
 * does not carry is skipped, since its inputs are not visible here; so is one
 * whose inputs link a table the bundle does not carry.
 */
export function checkOmittedCallInputs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const tableColumns = tableColumnsOf(sections);
  const declared = new Map<string, { name: string; inputs: string[] }>();
  for (const fn of sections.function ?? []) {
    const record = (fn ?? {}) as Record<string, unknown>;
    if (typeof record.guid !== "string" || !Array.isArray(record.input)) continue;
    const names = declaredInputNames(record, tableColumns);
    if (names === null) continue;
    declared.set(record.guid, {
      name: typeof record.name === "string" ? record.name : "?",
      inputs: [...names].filter((input) => input !== "id"),
    });
  }

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const own = declaredInputNames(obj as Record<string, unknown>, tableColumns);
      if (own === null) continue;
      const raw = own.size === 0 && RAW_REQUEST_HOSTS.has(payloadKey);
      if (own.size === 0 && !raw) continue;
      const owner = sdkSubject(payloadKey, obj as Record<string, unknown>);
      for (const statement of enabledFunctionRuns(obj)) {
        const id = (statement.context as { function?: { id?: unknown } } | undefined)?.function?.id;
        const target = typeof id === "string" ? declared.get(id) : undefined;
        if (target === undefined) continue;
        const omitted = target.inputs.filter(
          (input) => (raw || own.has(input)) && statementInput(statement, input) === undefined,
        );
        if (omitted.length === 0) continue;
        const list = proseList(omitted.map((input) => `\`${input}\``), "and");
        const one = omitted.length === 1;
        const how = raw
          ? `This def declares no inputs, so the engine binds an omitted input from the raw request — a ` +
            `client sending ${one ? "it" : "any of them"} (query string, body or MCP arguments) sets ` +
            `${one ? "its" : "the"} value in the target.`
          : `${one ? "This def also declares it" : "This def also declares them"}, and the engine binds an ` +
            `omitted input from the caller's same-named input: its value, or that input's empty value when the ` +
            `caller did not receive one — the target's default is not used either way.`;
        bag.warn(
          "statement.omitted-input",
          `${owner}: \`s.function.run\` of function "${target.name}" does not pass ${list}. ${how} Pass ` +
            `${one ? "it" : "them"} explicitly (\`ignored()\` keeps the target's default). If the ` +
            `pass-through is what you want, accept it with ` +
            `\`diagnostics: { allow: ["statement.omitted-input"] }\`.`,
          obj,
        );
      }
    }
  }
}

/**
 * The call statements that bind a target's inputs by name, and where each keeps
 * its target: the stored name → [target section, path to the guid in `context`,
 * the authoring surface].
 */
const NAMED_INPUT_CALLS: Readonly<Record<string, readonly [string, "function.id" | "id", string]>> = {
  "mvp:function": ["function", "function.id", "s.function.run"],
  "mvp:workspace_run_function": ["function", "id", "s.function.call"],
  "mvp:workspace_run_endpoint": ["query", "id", "s.api.call"],
  "mvp:workspace_run_tool": ["tool", "id", "s.tool.call"],
  "mvp:workspace_run_middleware": ["middleware", "id", "s.middleware.call"],
  "mvp:workspace_run_addon": ["addon", "id", "s.addon.call"],
};

/**
 * A call that passes an input its target does not declare.
 *
 * The engine binds a call's inputs by the target's declared names and drops
 * every other key without a word, so a misspelt key (`wieght_kg`) leaves the
 * real input at its default. A WARNING, not an error: the engine accepts the
 * call and drops the key, so a fixture pinning that drop accepts it with
 * `diagnostics.allow`. Typed code is refused by the call's `input` type
 * already; this catches JavaScript, casts and name-addressed targets.
 *
 * An `input.dbLink` counts as the columns it expands into. Skipped: a target the
 * bundle does not carry, one whose dbLink table it does not carry, and an
 * endpoint or tool that declares no inputs — its bag is the raw request, so any
 * key reaches it.
 */
export function checkUnknownCallInputs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const tableColumns = tableColumnsOf(sections);
  const targets = new Map<string, Map<string, { name: string; inputs: Set<string> | null }>>();
  const targetsIn = (section: string): Map<string, { name: string; inputs: Set<string> | null }> => {
    let hit = targets.get(section);
    if (hit !== undefined) return hit;
    hit = new Map();
    for (const obj of sections[section] ?? []) {
      const record = (obj ?? {}) as Record<string, unknown>;
      if (typeof record.guid !== "string") continue;
      const inputs = declaredInputNames(record, tableColumns);
      const name = typeof record.name === "string" ? record.name : "?";
      hit.set(record.guid, {
        // An endpoint is qualified by its verb, as every other message names one.
        name: section === "query" && typeof record.verb === "string" ? `${record.verb} ${name}` : name,
        inputs: inputs !== null && inputs.size === 0 && RAW_REQUEST_HOSTS.has(section) ? null : inputs,
      });
    }
    targets.set(section, hit);
    return hit;
  };
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const owner = sdkSubject(payloadKey, obj as Record<string, unknown>);
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        if ((statement as { disabled?: unknown }).disabled === true) continue;
        const shape = NAMED_INPUT_CALLS[statement.name];
        if (shape === undefined || !Array.isArray(statement.input) || statement.input.length === 0) continue;
        const [section, path, surface] = shape;
        const context = (statement.context ?? {}) as { id?: unknown; function?: { id?: unknown } };
        const id = path === "id" ? context.id : context.function?.id;
        const target = typeof id === "string" ? targetsIn(section).get(id) : undefined;
        if (target === undefined || target.inputs === null) continue;
        const declared = [...target.inputs];
        for (const entry of statement.input) {
          const key = (entry as { name?: unknown })?.name;
          if (typeof key !== "string" || target.inputs.has(key)) continue;
          const near = nearestKey(key, declared);
          bag.warn(
            "statement.unknown-input",
            `${owner}: \`${surface}\` of ${sdkKindName(section, {})} "${target.name}" passes \`${key}\`, which ` +
              `that ${sdkKindName(section, {})} does not declare — the engine drops it, so the target never sees the ` +
              `value.` +
              (near !== undefined
                ? ` Did you mean \`${near}\`?`
                : declared.length === 0
                  ? ` It declares no inputs.`
                  : ` It declares ${proseList(declared.map((d) => `\`${d}\``), "and")}.`),
            obj,
          );
        }
      }
    }
  }
}

/**
 * A unit test that passes an input its object does not declare — the engine
 * drops it, so the test runs without the value it was written to send. An
 * endpoint declaring no inputs reads the raw request, so any key reaches it.
 * A test id is keyed per object, so tests on two objects may share one.
 */
export function checkUnitTests(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  const tableColumns = tableColumnsOf(sections);
  for (const [payloadKey, arr] of Object.entries(sections)) {
    if (payloadKey === "workflow_test") continue;
    for (const obj of arr ?? []) {
      const record = obj as Record<string, unknown> | null;
      if (!record || typeof record !== "object" || !Array.isArray(record.test)) continue;
      const owner = sdkSubject(payloadKey, record);
      const declared = declaredInputNames(record, tableColumns);
      const raw = declared !== null && declared.size === 0 && RAW_REQUEST_HOSTS.has(payloadKey);
      for (const t of record.test as Array<{ name?: unknown; input?: unknown }>) {
        if (declared === null || raw) continue;
        const test = `${owner} test "${String(t?.name)}"`;
        for (const entry of Array.isArray(t?.input) ? t.input : []) {
          const key = (entry as { name?: unknown })?.name;
          if (typeof key !== "string" || declared.has(key)) continue;
          const known = [...declared];
          const near = nearestKey(key, known);
          bag.warn(
            "test.unknown-input",
            `${test}: \`input\` passes \`${key}\`, which the ${sdkKindName(payloadKey, record)} does not declare — the engine ` +
              `drops it, so the test runs without it.` +
              (near !== undefined
                ? ` Did you mean \`${near}\`?`
                : known.length === 0
                  ? ` It declares no inputs.`
                  : ` It declares ${proseList(known.map((k) => `\`${k}\``), "and")}.`),
            record,
          );
        }
      }
    }
  }
}

/**
 * Two sibling attachments grafting under one `as`: the later overwrites the
 * earlier on every row. An attachment naming no addon (`id` 0 or blank) is
 * skipped — the engine runs nothing for it, so it grafts nothing to overwrite.
 * A WARNING: the engine stores and runs the pair, so a def that means it
 * accepts it with `diagnostics.allow`.
 */
function checkAddonAliases(owner: string, attached: readonly unknown[], subject: object, bag: DiagnosticBag): void {
  const seen = new Set<string>();
  for (const spec of attached) {
    const { as, id } = (spec ?? {}) as { as?: unknown; id?: unknown };
    if (typeof as !== "string" || as === "" || id === 0 || id === "" || id === undefined || id === null) continue;
    if (seen.has(as)) {
      bag.warn(
        "db.addon-duplicate-alias",
        `${owner}: two attached addons graft as "${as}" — the later overwrites the earlier on every row. Give each its own \`as\`.`,
        subject,
      );
    }
    seen.add(as);
  }
}

/**
 * An addon's own `output` selecting a column its table does not have — the
 * same check a `s.db.query` selection gets. Only a row-returning addon
 * (`list`/`single`) is checked; `count`/`exists`/`aggregate` select no columns.
 */
export function checkAddonOutput(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  const tables = rowTablesOf(sections);
  for (const obj of sections.addon ?? []) {
    const record = obj as Record<string, unknown> | null;
    if (!record || typeof record !== "object") continue;
    const output = record.output as { customize?: unknown; items?: unknown } | undefined;
    if (output?.customize !== true || !Array.isArray(output.items)) continue;
    const type = (record.context as { return?: { type?: unknown } } | undefined)?.return?.type;
    if (type !== undefined && type !== "list" && type !== "single") continue;
    const statement = { name: "addon", context: record.context, output } as unknown as EncodedStatement;
    checkRowSelection(statement, sdkSubject("addon", record), record, output.items, "", tables, bag);
  }
}

/**
 * An addon attached to a db statement (`addon: [{ addon, input }]`) whose
 * binding cannot reach it: an input key the addon does not declare, or an
 * `out("<column>")` naming no column of the row it reads.
 *
 * The engine binds an attachment's inputs by the addon's declared names and
 * reads `out()` off each parent row, so either typo grafts the addon with its
 * input unset — a silent `null` on every row. Both are WARNINGS, with the near
 * miss: the engine stores and runs the binding, so a def that means it — or a
 * pulled one whose table lost the column — accepts it with `diagnostics.allow`.
 *
 * A top-level attachment reads the statement's table; a nested one (`children`)
 * reads its parent addon's. `out()` is not checked where the parent row carries
 * columns the table does not (a join, an eval, a group), nor where the table is
 * not in the bundle.
 */
export function checkAddonAttachments(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const addons = new Map<string, Record<string, unknown>>();
  for (const a of sections.addon ?? []) {
    const record = (a ?? {}) as Record<string, unknown>;
    if (typeof record.guid === "string") addons.set(record.guid, record);
  }
  if (addons.size === 0) return;
  const tableColumns = tableColumnsOf(sections);
  const hasDerivedColumns = (context: unknown): boolean => {
    if (context === null || typeof context !== "object") return false;
    const c = context as Record<string, unknown>;
    const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false);
    return nonEmpty(c.join) || nonEmpty(c.eval) || nonEmpty(c.group) || JSON.stringify(c.return ?? {}).includes('"eval"');
  };
  const tableOf = (context: unknown): string | undefined => {
    const id = (context as { dbo?: { id?: unknown } } | null | undefined)?.dbo?.id;
    return typeof id === "string" ? id : undefined;
  };
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const owner = sdkSubject(payloadKey, obj as Record<string, unknown>);
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        const attached = (statement as { addon?: unknown }).addon;
        if (!Array.isArray(attached) || attached.length === 0) continue;
        checkAddonAliases(owner, attached, obj, bag);
        const derived = hasDerivedColumns(statement.context);
        const pending: Array<{ spec: unknown; rowTable: string | undefined; derived: boolean }> = attached.map((spec) => ({
          spec,
          rowTable: tableOf(statement.context),
          derived,
        }));
        while (pending.length > 0) {
          const { spec, rowTable, derived: rowDerived } = pending.shift()!;
          if (spec === null || typeof spec !== "object") continue;
          const a = spec as { id?: unknown; as?: unknown; input?: unknown; children?: unknown };
          const target = typeof a.id === "string" ? addons.get(a.id) : undefined;
          const label = `addon "${typeof target?.name === "string" ? target.name : String(a.id ?? "?")}"` +
            (typeof a.as === "string" && a.as !== "" ? ` (as "${a.as}")` : "");
          const declared = target === undefined ? null : declaredInputNames(target, tableColumns);
          const columns = rowTable === undefined || rowDerived ? undefined : tableColumns.get(rowTable);
          for (const entry of Array.isArray(a.input) ? a.input : []) {
            const e = entry as { name?: unknown; tag?: unknown; value?: unknown };
            if (declared !== null && typeof e.name === "string" && !declared.has(e.name)) {
              const known = [...declared];
              const near = nearestKey(e.name, known);
              bag.warn(
                "db.addon-unknown-input",
                `${owner}: the attached ${label} is passed \`${e.name}\`, which that addon does not declare — ` +
                  `the engine drops it, so the addon runs with its input unset and grafts nothing.` +
                  (near !== undefined
                    ? ` Did you mean \`${near}\`?`
                    : known.length === 0
                      ? ` It declares no inputs.`
                      : ` It declares ${proseList(known.map((k) => `\`${k}\``), "and")}.`),
                obj,
              );
            }
            if (columns !== undefined && e.tag === "output" && typeof e.value === "string" && e.value !== "") {
              const base = inputBase(e.value);
              if (columns.includes(base)) continue;
              const near = nearestKey(base, columns);
              bag.warn(
                "db.addon-unknown-column",
                `${owner}: the attached ${label} binds \`out("${e.value}")\`, but the rows it reads have no ` +
                  `\`${base}\` column — the binding is null on every row, so the addon grafts nothing.` +
                  (near !== undefined ? ` Did you mean \`out("${near}")\`?` : ` The columns are ${proseList(columns.map((c) => `\`${c}\``), "and")}.`),
                obj,
              );
            }
          }
          if (Array.isArray(a.children)) {
            checkAddonAliases(owner, a.children, obj, bag);
            const childTable = target === undefined ? undefined : tableOf(target.context);
            for (const child of a.children) {
              pending.push({ spec: child, rowTable: childTable, derived: target === undefined || hasDerivedColumns(target.context) });
            }
          }
        }
      }
    }
  }
}

/**
 * Warn when a realtime GATING trigger cannot say yes.
 *
 * `connect` and `join` are gates: the transport reads the stack's return, and
 * anything empty or falsy is a DENY. A trigger that declares one of those
 * actions and carries no `response` returns nothing on every run, so it refuses
 * every client — a lockout that presents as "realtime silently stopped working"
 * rather than as an error, because a refusal is a normal, expected outcome and
 * looks identical to a working gate rejecting a caller.
 *
 * It is a WARNING, not an error, and the split is the one KTD2c draws. The
 * engine accepts this shape and behaves exactly as documented; what the check
 * asserts is INTENT — that nobody writes a gate meaning to reject 100% of
 * traffic. That is a prediction, and predictions warn. Someone who really wants
 * a closed door answers `allowed: c.bool(false)` with a `reason` the client
 * sees, and this stays quiet; every other constant refusal — a whole `null`,
 * `false`, `""` or `0`, or an `allowed` of `null`, or `false` with no reason —
 * warns.
 *
 * Deliberately NOT checked: `leave`, `disconnect` (observational — the return is
 * ignored) and `deliver` (a missing return delivers the original payload
 * unchanged, which is a working default rather than a lockout).
 */
const GATING_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  realtime_server: ["connect"],
  channel: ["join"],
};

export function checkRealtimeGates(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; meta?: unknown; result?: unknown };
    if (Array.isArray(t.result) && t.result.length > 0) {
      checkGateAllowedLiteral(t, bag);
      continue;
    }
    // A response-bearing trigger encodes its response into `result[]`; a gating
    // trigger with none encodes an empty array, which is what returns nothing.
    if (!Array.isArray(t.result)) continue;
    const objType = typeof t.obj_type === "string" ? t.obj_type : "";
    const gating = (Object.hasOwn(GATING_ACTIONS, objType) ? GATING_ACTIONS[objType] : undefined);
    if (!gating) continue;
    const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)?.[
      objType
    ]?.action;
    const declared = gating.filter((a) => actions?.[a] === true);
    if (declared.length === 0) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    bag.warn(
      "realtime.gate-denies-everyone",
      `${sdkKindName("trigger", t)} "${name}" gates \`${declared.join("`/`")}\` but declares no \`response\`, so it ` +
        `returns nothing on every run — and an empty return is a DENY, which refuses every ` +
        `client. A crash denies too, so there is no shape of this trigger that admits anyone. ` +
        `Add \`response: () => obj({ allowed: c.bool(true) })\` (any truthy value admits; an ` +
        `\`allowed: false\` with a \`reason\` reaches the client). If refusing everyone is the ` +
        `intent, say so with \`response: () => obj({ allowed: c.bool(false), reason: c.text("…") })\`.`,
      obj,
    );
  }
}

/** The gating actions a realtime trigger declares, by its `obj_type`. */
function declaredGates(t: { obj_type?: unknown; meta?: unknown }): readonly string[] {
  const objType = typeof t.obj_type === "string" ? t.obj_type : "";
  const gating = Object.hasOwn(GATING_ACTIONS, objType) ? GATING_ACTIONS[objType] : undefined;
  if (!gating) return [];
  const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)?.[objType]?.action;
  return gating.filter((a) => actions?.[a] === true);
}

/**
 * What a literal `allowed` value is, when it is provably not a boolean: "a
 * number", "text", "an object", "a list". Undefined for a boolean, null, or
 * anything computed — an expression may well evaluate to a boolean.
 */
function nonBooleanKind(tag: string, value: string): string | undefined {
  if (tag === "const:int" || tag === "const:decimal") return "a number";
  if (tag === "const" || tag === "const:text") return "text";
  if (tag === "const:array") return "a list";
  if (tag === "const:obj" || tag === "const:object") return "an object";
  if (tag !== "const:expr2") return undefined;
  const v = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return "a number";
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return "text";
  if (v.startsWith("{") && v.endsWith("}")) return "an object";
  if (v.startsWith("[") && v.endsWith("]")) return "a list";
  return undefined;
}

/**
 * The value of the top-level `allowed` key in a literal-object expression
 * (`{ allowed: "yes", reason: "r" }`), or undefined.
 */
function allowedInObjectLiteral(text: string): string | undefined {
  const m = /^\s*\{(?:[^{}[\]"]|"(?:[^"\\]|\\.)*")*?\ballowed\s*:\s*/.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m[0].length);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return rest.slice(0, i).trim();
      depth--;
    } else if (ch === "," && depth === 0) return rest.slice(0, i).trim();
  }
  return undefined;
}

/**
 * The shown value of a response that is ONE falsy constant as a whole (`null`,
 * `false`, `""`, `0`), or undefined. A whole constant cannot carry a `reason`,
 * so unlike `allowed: false` with one it is never the deliberate closed door.
 */
function falsyWholeResponse(result: unknown[]): string | undefined {
  if (result.length !== 1) return undefined;
  const e = result[0] as { name?: unknown; tag?: unknown; value?: unknown; filters?: unknown };
  if (e.name !== "" || (Array.isArray(e.filters) && e.filters.length > 0)) return undefined;
  if (typeof e.tag !== "string" || typeof e.value !== "string") return undefined;
  const v = e.value.trim();
  if (e.tag === "const:null") return "null";
  if (e.tag === "const:bool") return v === "false" ? "false" : undefined;
  if (e.tag === "const" || e.tag === "const:text") return e.value === "" ? '""' : undefined;
  if (e.tag === "const:int" || e.tag === "const:decimal") return Number(v) === 0 ? v : undefined;
  if (e.tag === "const:expr2") return ["null", "false", '""', "0"].includes(v) ? v : undefined;
  return undefined;
}

/**
 * A gate whose response sets `allowed` to a value that is provably not a
 * boolean (`{ allowed: c.int(1) }`, `{ allowed: c.text("yes") }`,
 * `{ allowed: obj({…}) }`). Once the returned object carries `allowed`,
 * admission needs strictly `true`, so the gate refuses every client however
 * truthy the value reads. A computed value is not judged: it may well be a
 * boolean.
 */
function checkGateAllowedLiteral(t: { name?: unknown; obj_type?: unknown; meta?: unknown; result?: unknown }, bag: DiagnosticBag): void {
  const declared = declaredGates(t);
  if (declared.length === 0) return;
  let found: { shown: string; kind: string } | undefined;
  let closed: string | undefined;
  let reason = false;
  for (const entry of t.result as unknown[]) {
    const e = entry as { name?: unknown; tag?: unknown; value?: unknown; filters?: unknown };
    if (e.name === "reason") reason = true;
    if (Array.isArray(e.filters) && e.filters.length > 0) continue;
    if (typeof e.tag !== "string" || typeof e.value !== "string") continue;
    if (e.name === "allowed") {
      const kind = nonBooleanKind(e.tag, e.value);
      const isText = e.tag === "const" || e.tag === "const:text";
      if (kind) found = { shown: isText ? JSON.stringify(e.value) : e.value, kind };
      else if (e.tag === "const:null" || (e.tag === "const:bool" && e.value === "false")) closed = e.tag === "const:null" ? "null" : "false";
    } else if (e.name === "" && e.tag === "const:expr2") {
      // A literal object response: `{ allowed: <value>, … }`.
      const value = allowedInObjectLiteral(e.value);
      const kind = value === undefined ? undefined : nonBooleanKind("const:expr2", value);
      if (value !== undefined && kind) found = { shown: value, kind };
      else if (value === "null" || value === "false") closed = value;
      if (/^\s*\{(?:[^{}"]|"(?:[^"\\]|\\.)*")*?\breason\s*:/.test(e.value)) reason = true;
    }
  }
  const name = typeof t.name === "string" ? t.name : "?";
  const falsy = falsyWholeResponse(t.result as unknown[]);
  if (falsy !== undefined) {
    bag.warn(
      "realtime.gate-denies-everyone",
      `${sdkKindName("trigger", t)} "${name}" gates \`${declared.join("`/`")}\` and answers the constant ` +
        `\`${falsy}\` as its whole response — a falsy return is a DENY, so it refuses every client on every run. ` +
        `Compute the answer (\`allowed: ref("ok")\`, \`allowed: c.expression("$var.ok == true")\`), or — if a ` +
        `closed door is the intent — answer \`obj({ allowed: c.bool(false), reason: c.text("…") })\`, whose reason the client sees.`,
      t,
    );
    return;
  }
  // A constant refusal: `null` is never a deliberate answer, and a bare `false`
  // with no `reason` for the client reads as a placeholder. `allowed: false`
  // with a `reason` is a deliberate closed door and stays quiet.
  if (found === undefined && closed !== undefined && (closed === "null" || !reason)) {
    bag.warn(
      "realtime.gate-denies-everyone",
      `${sdkKindName("trigger", t)} "${name}" gates \`${declared.join("`/`")}\` and answers a constant ` +
        `\`allowed: ${closed}\`, which DENIES every client on every run. Compute the boolean (\`allowed: ref("ok")\`, ` +
        `\`allowed: c.expression("$var.ok == true")\`), or — if a closed door is the intent — answer ` +
        `\`allowed: c.bool(false)\` with a \`reason\` the client sees.`,
      t,
    );
    return;
  }
  if (found === undefined) return;
  bag.warn(
    "realtime.gate-denies-everyone",
    `${sdkKindName("trigger", t)} "${name}" gates \`${declared.join("`/`")}\` and answers \`allowed: ${found.shown}\` — ` +
      `once the response carries \`allowed\`, admission needs strictly \`true\`, so ${found.kind} there DENIES ` +
      `every client. Return \`allowed: c.bool(true)\`, or compute the boolean: \`allowed: c.expression("$var.ok == true")\`, ` +
      `or a variable bound to one (\`s.set_var("ok", expr(…))\` then \`allowed: ref("ok")\`).`,
    t,
  );
}

/**
 * A NON-nullable vector column with no default. An empty default becomes NULL
 * only when the column is nullable, and `''` is not a vector, so the table
 * fails to create on deploy. Warned rather than refused: a pulled workspace may
 * carry the shape, and a decode must round-trip it.
 */
export function checkNonNullVectorColumns(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.dbo ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const table = obj as { name?: unknown; schema?: unknown };
    for (const col of Array.isArray(table.schema) ? table.schema : []) {
      const field = col as { name?: unknown; type?: unknown; nullable?: unknown; default?: unknown };
      if (field?.type !== "vector" || field.nullable !== false || (field.default ?? "") !== "") continue;
      bag.warn(
        "field.vector-not-nullable",
        `table "${String(table.name)}", column "${String(field.name)}" is a vector with \`nullable: false\` ` +
          `and no default — an empty default becomes NULL only on a nullable column, and \`''\` is not ` +
          `a vector, so the table FAILS TO CREATE on deploy. Drop \`nullable: false\` (vectors are ` +
          `nullable by default).`,
        obj,
      );
    }
  }
}

/**
 * The realtime shapes the docs call silent — each accepted by the engine and
 * doing nothing, or the opposite of what it reads as:
 *
 *  - a server left `enabled: false` (the default, unlike every other `enabled`)
 *    while channels are registered on it — no client can connect to any of them;
 *  - `conversation: { enabled: true }` with no `limit` — `limit` defaults to 0,
 *    and 0 records and replays nothing;
 *  - `deliverTo: "explicit"` — nothing selects recipients, so it delivers to nobody;
 *  - a `deliver` trigger returning a constant `false`/`0`/`""` — only an explicit
 *    null drops a message, so it delivers the payload it was written to suppress.
 *
 * Warnings: every one of them is a legal bundle.
 */
export function checkRealtimeSilentShapes(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const nameOf = (o: { name?: unknown }): string => (typeof o.name === "string" ? o.name : "?");
  const channelsOn = new Map<string, number>();
  for (const obj of sections.channel ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const ch = obj as { name?: unknown; server?: { id?: unknown }; conversation?: { enabled?: unknown; limit?: unknown } };
    const server = ch.server?.id;
    if (typeof server === "string") channelsOn.set(server, (channelsOn.get(server) ?? 0) + 1);
    if (ch.conversation?.enabled === true && Number(ch.conversation.limit ?? 0) === 0) {
      bag.warn(
        "realtime.conversation-no-limit",
        `realtimeChannel "${nameOf(ch)}" sets \`conversation: { enabled: true }\` with no \`limit\` — ` +
          `\`limit\` defaults to 0 and 0 means retain NONE, so nothing is recorded or replayed. Pass a ` +
          `\`limit\` (e.g. \`conversation: { enabled: true, limit: 100 }\`).`,
        obj,
      );
    }
  }
  for (const obj of sections.realtime_server ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const server = obj as { name?: unknown; guid?: unknown; enabled?: unknown };
    const count = typeof server.guid === "string" ? (channelsOn.get(server.guid) ?? 0) : 0;
    if (server.enabled === true || count === 0) continue;
    bag.warn(
      "realtime.server-disabled",
      `realtimeServer "${nameOf(server)}" is not enabled — \`enabled\` defaults to FALSE, unlike every ` +
        `other \`enabled\` — but ${count} channel${count === 1 ? " is" : "s are"} registered on it, so no ` +
        `client can connect to ${count === 1 ? "it" : "any of them"}. Set \`enabled: true\`; if it is off ` +
        `on purpose, accept the warning on the server with \`diagnostics: { allow: ["realtime.server-disabled"] }\`.`,
      server,
    );
  }
  for (const obj of sections.message ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const msg = obj as { name?: unknown; deliver_to?: unknown };
    if (msg.deliver_to !== "explicit") continue;
    bag.warn(
      "realtime.deliver-explicit",
      `realtimeMessage "${nameOf(msg)}" sets \`deliverTo: "explicit"\`, which delivers to NOBODY — ` +
        `nothing selects recipients from inside a handler, and \`s.realtime.publish\` is not a ` +
        `substitute. Use \`"channel"\`, \`"others"\` or \`"sender"\`.`,
      obj,
    );
  }
  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; active?: unknown; meta?: unknown; result?: unknown };
    if (t.obj_type !== "channel" || t.active === false || !Array.isArray(t.result) || t.result.length !== 1) continue;
    const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)?.channel?.action;
    if (actions?.deliver !== true) continue;
    const only = t.result[0] as { name?: unknown; tag?: unknown; value?: unknown; filters?: unknown };
    if ((typeof only.name === "string" && only.name !== "") || (Array.isArray(only.filters) && only.filters.length > 0)) continue;
    const falsy =
      (only.tag === "const:bool" && (only.value === false || only.value === "false")) ||
      (only.tag === "const:int" && Number(only.value) === 0) ||
      (only.tag === "const" && only.value === "");
    if (!falsy) continue;
    bag.warn(
      "realtime.deliver-falsy-return",
      `realtimeChannelTrigger "${nameOf(t)}" gates \`deliver\` and returns \`${only.tag === "const:bool" ? "c.bool(false)" : only.tag === "const:int" ? "c.int(0)" : "c.text(\"\")"}\` — only an explicit ` +
        `NULL drops a message; \`false\`, \`0\` and \`""\` DELIVER IT UNCHANGED. Return \`c.null()\` to drop.`,
      obj,
    );
  }
}

/**
 * A channel trigger serving BOTH `join` and `deliver` whose response is an
 * object.
 *
 * One trigger has one response, and the two actions read it differently: `join`
 * reads it as the admit decision (`{ allowed: true }` admits), while `deliver`
 * reads an OBJECT as the recipient's new payload. So the admit object that makes
 * the join work also replaces every delivered message, for every recipient, with
 * `{ allowed: true }`. Both halves behave exactly as documented, which is why
 * this warns rather than refuses — the finding is that one response cannot mean
 * both things.
 *
 * Only a response that is recognisably an object is reported: a record
 * response (`response: { allowed }`), an `obj({…})`, or a `c.obj` constant. A
 * scalar or a variable the stack computed could be anything, and guessing at it
 * would warn about working triggers.
 */
export function checkRealtimeJoinDeliver(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; active?: unknown; meta?: unknown; result?: unknown };
    if (t.obj_type !== "channel" || t.active === false || !Array.isArray(t.result)) continue;
    const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)?.channel?.action;
    if (actions?.join !== true || actions?.deliver !== true) continue;
    if (!isObjectResult(t.result)) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    bag.warn(
      "realtime.join-deliver-object-response",
      `${sdkKindName("trigger", t)} "${name}" serves both \`join\` and \`deliver\` with one object response — \`join\` ` +
        `reads it as the admit decision, but \`deliver\` reads an object as the recipient's NEW ` +
        `payload, so every delivered message is replaced by it. Split it into two ` +
        `\`realtimeChannelTrigger\`s: one with \`actions: { join: true }\` returning the admit ` +
        `object, one with \`actions: { deliver: true }\` returning the redacted payload (or null to drop).`,
      obj,
    );
  }
}

/** A trigger `result[]` that is recognisably an object: a record, `obj({…})`, or a `c.obj` constant. */
function isObjectResult(result: readonly unknown[]): boolean {
  if (result.length === 0) return false;
  const entries = result as Array<{ name?: unknown; tag?: unknown; value?: unknown }>;
  // A record response encodes one NAMED entry per key.
  if (result.length > 1 || entries.some((e) => typeof e?.name === "string" && e.name !== "")) return true;
  const only = entries[0];
  if (only?.tag === "const:obj") return true;
  return only?.tag === "const:expr2" && typeof only.value === "string" && only.value.trimStart().startsWith("{");
}

/**
 * A `deliver` trigger that cannot run, and the flag that pays for nothing.
 *
 * The engine gates the per-recipient delivery path on BOTH halves: the channel
 * must set `delivery.perRecipient`, AND an ACTIVE `deliver` trigger must be
 * bound to it. With either half missing it takes the passthrough path and
 * delivers the message unchanged to every recipient.
 *
 * The two halves fail in opposite directions, which is why both are reported
 * and why they are worded differently:
 *
 *  - A trigger without the flag is the UNSAFE one. `deliver` is the per-viewer
 *    redaction tool — its whole job is stripping fields a recipient must not
 *    see — so a gate that silently does not run means every subscriber gets the
 *    UNREDACTED payload. There is no error, no log line and no failed request;
 *    the symptom is data reaching clients, which surfaces from the outside or
 *    not at all.
 *  - The flag without a trigger is merely WASTE. The engine collapses it to a
 *    plain broadcast rather than dropping everyone, so nothing breaks; the flag
 *    just costs nothing and does nothing.
 *
 * WARNINGS, and about Xano SDK's own cross-object contract rather than about what
 * the engine accepts — it accepts both shapes and behaves exactly as
 * documented. What the check asserts is INTENT: nobody writes a redaction gate
 * meaning for it never to fire. That is a prediction, and predictions warn.
 *
 * Scoped to a `workspace` bundle, and silent when the bound channel is not in
 * this bundle at all. A partial bundle legitimately references objects it does
 * not carry, and a binding that names nothing is `checkReferences`'s finding to
 * report in its own words — guessing about `perRecipient` on a channel we
 * cannot see would be a second, vaguer diagnostic about the same line.
 *
 * `active` is read on the trigger because the engine's own both-gates check
 * reads it. A trigger switched off deliberately does not satisfy the delivery
 * path, so the channel's flag really is inert — and the trigger itself is not a
 * surprise worth reporting.
 */
export function checkRealtimeDeliver(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  if (bundleType !== "workspace") {
    bag.skipped("realtime.deliver-without-per-recipient");
    bag.skipped("realtime.per-recipient-without-deliver");
    return;
  }

  const channels = new Map<string, { name: string; perRecipient: boolean; obj: object }>();
  for (const obj of sections.channel ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const ch = obj as { name?: unknown; guid?: unknown; delivery?: unknown };
    if (typeof ch.guid !== "string" || ch.guid === "") continue;
    channels.set(ch.guid, {
      name: typeof ch.name === "string" ? ch.name : "?",
      perRecipient: (ch.delivery as { per_recipient?: unknown } | undefined)?.per_recipient === true,
      obj,
    });
  }

  // Channels an ACTIVE `deliver` trigger is bound to — the second half of the
  // engine's gate, and what the inverse advisory below keys on.
  const delivered = new Set<string>();

  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; obj_id?: unknown; active?: unknown; meta?: unknown };
    if (t.obj_type !== "channel" || t.active === false) continue;
    const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)
      ?.channel?.action;
    if (actions?.deliver !== true) continue;
    if (typeof t.obj_id !== "string" || t.obj_id === "") continue;
    const channel = channels.get(t.obj_id);
    if (!channel) continue;
    delivered.add(t.obj_id);
    if (channel.perRecipient) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    bag.warn(
      "realtime.deliver-without-per-recipient",
      `${sdkKindName("trigger", t)} "${name}" gates \`deliver\` on channel "${channel.name}", but that channel does ` +
        `not set \`delivery: { perRecipient: true }\` — the engine runs the per-recipient path ` +
        `only when BOTH halves are present, so this trigger never runs and every subscriber ` +
        `receives the UNREDACTED payload. Nothing errors and nothing is logged. Add ` +
        `\`delivery: { perRecipient: true }\` to the channel, noting that it costs one stack ` +
        `per recipient per message. If the redaction is no longer wanted, remove the trigger ` +
        `rather than leaving it as a gate that does not gate.`,
      obj,
    );
  }

  for (const [guid, channel] of channels) {
    if (!channel.perRecipient || delivered.has(guid)) continue;
    bag.warn(
      "realtime.per-recipient-without-deliver",
      `realtimeChannel "${channel.name}" sets \`delivery: { perRecipient: true }\` but no active ` +
        `\`deliver\` trigger is bound to it, so the flag is a no-op — the engine falls back to ` +
        `a plain broadcast rather than dropping anyone. Remove it, or add a ` +
        `\`realtimeChannelTrigger({ channel, actions: { deliver: true } })\` to redact per ` +
        `recipient.`,
      channel.obj,
    );
  }
}

/**
 * The engine's own reserved namespaces, mapped to the accessor that reaches
 * each one — the `ref()` mistakes that are never a stack variable.
 *
 * `ref("auth.id")` looks like it reads the authenticated caller. It does not:
 * `ref` is the `var` tag, so the engine looks for a stack VARIABLE named `auth`
 * and, finding none, raises `Missing var entry: auth` (ERROR_FATAL, HTTP 500)
 * on the first request. Every name here has the same shape — a namespace the
 * engine addresses through its own tag, spelled as if it were a variable.
 *
 * Taken from the engine's var renderer, which escapes a variable whose first
 * segment collides with one of these to `$var.<name>` precisely because the
 * unescaped spelling means the namespace instead. That escape is also why the
 * refusal is scoped to a name nothing BINDS: a stack variable really named
 * `auth` is legal, and one a statement binds with `as` resolves correctly.
 *
 * `input` is not exempt from the unbound check. The file-upload recipe
 * `s.storage.create_image({ value: ref("input.avatar") })` does not work —
 * deployed, it returns `Missing var entry: input` — so an exemption would only
 * hide the bug. `inp("avatar")` is the spelling that
 * stores the upload.
 */
const RESERVED_VAR_NAMESPACES: Record<string, (path: string, base: string) => string> = {
  auth: (path) => `the authenticated caller — use \`auth("${tail(path)}")\``,
  input: (path) => `a request input — use \`inp("${tail(path) || "name"}")\``,
  env: (path) =>
    `a workspace env var — use \`env("${tail(path) || "NAME"}")\` ` +
    `(or \`sys.*\` for a request-context value)`,
  response: (path) => `the response under test — use \`resp("${tail(path)}")\``,
  output: (path) => `a statement output — use \`out("${tail(path) || "name"}")\``,
  error: (path) => `a caught error — use \`caught("${tail(path) || "message"}")\``,
  trycatch: (path) => `a caught error — use \`caught("${tail(path) || "message"}")\``,
  db: (path) => `a table column — use \`col("${tail(path) || "column"}")\``,
  toolset: (path) => `a toolset binding — use \`toolset("${tail(path) || "token"}")\``,
  var: (path, base) =>
    `the variable namespace itself — drop the \`${base}.\` prefix ` +
    `(\`ref("${tail(path)}")\`)`,
};

/**
 * Realtime trigger `obj_type`s. The platform runs these outside any request, so
 * NO auth is established: `auth("id")` reads 0 even for an authenticated
 * client, and the `auth(...)` remedy above would trade a 500 for a silent 0.
 * The caller is the connection's `client.permissions.row_id`.
 */
const REALTIME_TRIGGER_OBJ_TYPES: ReadonlySet<unknown> = new Set(["channel", "realtime_server", "workspace_realtime_channel"]);

/** The remedy for `ref("auth…")` in a realtime trigger, where there is no auth. */
function realtimeAuthRemedy(path: string): string {
  const field = tail(path);
  const lookup = field === "" || field === "id" ? "" : ` (look the row up with \`s.db.get\` for \`${field}\`)`;
  return (
    `the connecting client — a realtime trigger runs with NO auth, so \`auth("${field}")\` ` +
    `reads 0 here too. The caller's row id is \`t.client("permissions.row_id")\`${lookup}, or ` +
    `\`s.realtime.get_session\` → \`ref("session.client_id")\`; \`permissions.dbo_id\` is the ` +
    `auth TABLE's id, not the caller`
  );
}

/** The path minus its reserved base segment: `auth.id` → `id`, `auth` → `""`. */
function tail(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1);
}

/**
 * Every stack variable an object binds: a statement's top-level `as`, the loop
 * variable a `for`/`foreach` binds in `context.as`, and `context.name` — the
 * variable the mutation family (`s.math.*`, `s.text.append`, `s.array.push`,
 * `s.update_var`, …) writes THROUGH rather than binding with `as`.
 *
 * Deliberately flat rather than scoped. A loop variable is only readable inside
 * its own body, but treating it as visible everywhere costs one missed typo and
 * buys immunity to every scoping subtlety the encoder might grow — the trade a
 * warning wants, since a check that cries wolf is a check people learn to skip.
 * For the same reason `context.name` is read off EVERY statement rather than
 * only the mutation family: on a statement where that key means something else,
 * the cost is one unreported typo, not a false accusation.
 */
function collectBindings(statements: readonly EncodedStatement[]): Set<string> {
  const bound = new Set<string>();
  for (const statement of statements) {
    if (typeof statement.as === "string" && statement.as !== "") bound.add(statement.as);
    const context = statement.context as { as?: unknown; name?: unknown } | undefined;
    if (typeof context?.as === "string" && context.as !== "") bound.add(context.as);
    if (typeof context?.name === "string" && context.name !== "") bound.add(context.name);
  }
  return bound;
}

/**
 * The distance the did-you-mean ranks by, weighted as TypeScript's own spelling
 * suggestion is — an insertion or deletion costs 1, a substitution 2 (0.1 when
 * only the case differs) — plus a swap of two adjacent letters at 1. Ranked the
 * same way, the export's "Did you mean" names what `tsc` named for the same
 * typo: `acton` is one insertion from `action` and a substitution from `actor`,
 * and both now answer `action` (E2E pass 28).
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]!;
      const y = b[j - 1]!;
      const sub = x === y ? 0 : x.toLowerCase() === y.toLowerCase() ? 0.1 : 2;
      let best = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + sub);
      if (i > 1 && j > 1 && x === b[j - 2] && a[i - 2] === y) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      row[j] = best;
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

/** The closest bound name to `name`, when one is close enough to be the typo. */
function didYouMean(name: string, bound: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of bound) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // TypeScript's own cutoff, so a name `tsc` offers is offered here too: under
  // ~40% of the name's length — one substitution (2) at five letters, a dropped
  // letter or a transposition (1) at any length.
  return best !== undefined && bestDistance < Math.max(2, Math.floor(name.length * 0.4) + 1) ? best : undefined;
}

/** `$remote_ip` → `remoteIp`: the `sys` accessor for a setting spelled as a var. */
let sysAccessors: Map<string, string> | undefined;
function sysAccessorFor(name: string): string | undefined {
  sysAccessors ??= new Map(Object.entries(sys).map(([key, read]) => [read().value, key] as const));
  return sysAccessors.get(name);
}

/**
 * A `ref()` naming a variable nothing in the stack binds.
 *
 * `ref` takes a `string`, so TypeScript cannot check it, and the export pass
 * checked every other identifier in a stack — table columns, object references,
 * auth tables — except this one, which is the most frequent identifier in the
 * language. A typo therefore produced a clean bundle and an HTTP 500
 * (`Missing var entry: <name>`) on the deployed environment.
 *
 * The engine raises TWO different errors here and this guard fires on the
 * first: an unbound BASE is `Missing var entry: <base>`, while a base that IS
 * bound but whose path misses is `Unable to locate var: <path>`. Only the
 * second is the null-`db.get` drill that the docs prescribe
 * `ref(path, { safe: true })` for — applied to a name that binds nothing, that
 * escape hatch turns a loud 500 into a silent `null` and buries the bug. Quoting
 * the right one of the pair is what keeps an author grepping the real message
 * out of the wrong section.
 *
 * Scoped to what cannot false-positive:
 *  - the BASE segment only (`ref("run.result.priority")` is checked as `run`) —
 *    the tail is a path into a value, not a variable;
 *  - names not starting with `$`, which are statement-scoped bindings
 *    (`$this`/`$index` inside `s.array.map`) rather than stack variables;
 *  - a warning, never an error, so an unforeseen binding site cannot block a
 *    deploy.
 *
 * The one exception to that last point is a base in
 * {@link RESERVED_VAR_NAMESPACES} — `ref("auth.id")` and friends. Those are an
 * ERROR, because the trade the warning is hedging against does not exist there:
 * a reserved base that nothing binds has no shape in which it runs, and the
 * accessor that does work is known by name. Warning was the wrong severity for
 * exactly the case an author is most likely to hit.
 *
 * A `{ safe: true }` drill compiles to the base var plus a `get` filter, so it
 * is checked on the same base as everything else — which is the point: the
 * escape hatch was never meant to hide a name that binds nothing.
 */
export function checkUnboundVarRefs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      // No early exit on an empty stack: `response: ref("nothing")` with no
      // statement binds nothing and 500s just the same.
      const bound = collectBindings(statements);
      const subjects = existenceSubjects(statements);
      const refs: string[] = [];
      collectVarRefs(obj, refs, new Set(subjects.keys()));
      // A `to_be_defined` subject is still worth a word when nothing binds it,
      // just not the 500 the ordinary message promises. Checked AFTER the
      // ordinary reads, so a name also read elsewhere keeps that message.
      const assertedOnly: string[] = [];
      for (const [subject, role] of subjects) {
        const value = (subject as { value?: unknown }).value;
        if (role === "never-bound" && typeof value === "string") assertedOnly.push(value);
      }
      const reported = new Set<string>();
      const reads = [
        ...refs.map((path) => ({ path, asserted: false })),
        ...assertedOnly.map((path) => ({ path, asserted: true })),
      ];
      for (const { path, asserted } of reads) {
        const dot = path.indexOf(".");
        const base = dot === -1 ? path : path.slice(0, dot);
        if (base === "" || bound.has(base) || reported.has(base)) continue;
        if (base.startsWith("$")) {
          // A `$` name is a statement-scoped binding (`$this`, `$index`) — except
          // a request/system SETTING spelled as a var, which reads nothing.
          const accessor = sysAccessorFor(base);
          if (accessor !== undefined) {
            reported.add(base);
            bag.warn(
              "stack.unbound-var",
              `${owner}: \`ref("${path}")\` reads a stack variable named \`${base}\`, but \`${base}\` is a ` +
                `request/system setting, not a variable — it resolves to nothing. Read it with ` +
                `\`sys.${accessor}()\`.`,
              obj,
            );
          }
          continue;
        }
        reported.add(base);
        // A reserved namespace spelled as a variable: the author reached for a
        // namespace, not a typo, so name the accessor rather than offering to
        // bind a variable they never wanted.
        const reserved =
          base === "auth" && payloadKey === "trigger" && REALTIME_TRIGGER_OBJ_TYPES.has((obj as { obj_type?: unknown }).obj_type)
            ? realtimeAuthRemedy
            : Object.hasOwn(RESERVED_VAR_NAMESPACES, base)
              ? RESERVED_VAR_NAMESPACES[base]
              : undefined;
        if (reserved) {
          // An error where a stack runs; a warning on an object with none, where
          // the shape is a stored one a pull must still be able to carry (an MCP
          // trigger's default response over an emptied stack).
          (statements.length > 0 ? bag.error.bind(bag) : bag.warn.bind(bag))(
            "stack.reserved-var-namespace",
            `${owner}: \`ref("${path}")\` reads a STACK VARIABLE named \`${base}\`, and nothing ` +
              `in this stack binds one — so the engine raises \`Missing var entry: ${base}\` ` +
              `(ERROR_FATAL, HTTP 500) on the first request. \`ref\` only ever spells a stack ` +
              `variable. For ${reserved(path, base)}. (If you really do mean a stack variable ` +
              `named \`${base}\`, bind it first with \`as: "${base}"\` and this passes.)`,
            obj,
          );
          continue;
        }
        if (asserted) {
          bag.warn(
            "stack.unbound-var",
            `${owner}: \`s.expect.to_be_defined\` asserts that \`${base}\` is set, and nothing in ` +
              `this stack binds it with \`as\` — so the assertion is about a variable that is ` +
              `never set. Bind \`${base}\` before asserting on it, or assert ` +
              `\`to_not_be_defined\` if its absence is what you mean.`,
            obj,
          );
          continue;
        }
        const suggestion = didYouMean(base, bound);
        bag.warn(
          "stack.unbound-var",
          `${owner}: \`ref("${path}")\` names a variable that nothing in this stack binds with ` +
            `\`as\`. At runtime this raises \`Missing var entry: ${base}\` — an HTTP 500 on ` +
            `the deployed environment.${suggestion ? ` Did you mean "${suggestion}"?` : ""} ` +
            `Bind it first (\`as: "${base}"\` on the statement that produces it). Do NOT reach ` +
            `for \`ref(…, { safe: true })\` here: that is for drilling into a value that may be ` +
            `null, and against a name that binds nothing it just turns the 500 into a silent ` +
            `\`null\`.`,
          obj,
        );
      }
    }
  }
}

/**
 * A login stack taking its submitted password through `input.password()`.
 *
 * `input.password` hashes the submission on bind, and an `f.password()` column
 * hashed on write, so `s.security.check_password` compares two different hashes
 * and a CORRECT password always fails. Nothing errors: the query exports, the
 * deploy succeeds, and the endpoint answers `ok:false` on a row it found — which
 * reads as a wrong password rather than as a broken comparison, so the author
 * debugs the credential instead of the type.
 *
 * The plaintext is what `check_password` wants; it does the comparison hash
 * itself. So the fix is `input.text()` for the submitted value, which looks like
 * the less careful choice and is the correct one.
 *
 * Scoped to a `text_password` that reads a declared input DIRECTLY. A value
 * arriving through a stack variable is not traced — what happened to it in
 * between is not readable here, and a check that guesses at it would report the
 * shapes that already work.
 */
export function checkPasswordInputHashing(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      if (!Array.isArray(record.input)) continue;

      const passwordInputs = new Set<string>();
      for (const entry of record.input) {
        const declared = entry as { name?: unknown; type?: unknown };
        if (typeof declared?.name === "string" && declared.type === "password") {
          passwordInputs.add(declared.name);
        }
      }
      if (passwordInputs.size === 0) continue;

      const name = record.name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);

      const reported = new Set<string>();
      for (const statement of statements) {
        if (statement.name !== "mvp:check_pass") continue;
        const cell = statementInput(statement, "text_password");
        if (cell?.tag !== "input" || typeof cell.value !== "string") continue;
        const declaredName = inputBase(cell.value);
        if (!passwordInputs.has(declaredName)) continue;
        if (reported.has(declaredName)) continue;
        reported.add(declaredName);
        bag.warn(
          "stack.password-input-double-hash",
          `${owner}: \`s.security.check_password\` reads \`inp("${cell.value}")\`, and the input ` +
            `\`${declaredName}\` is declared \`input.password()\`. That hashes the submission on ` +
            `bind, and the stored \`f.password()\` column hashed on write, so \`check_password\` ` +
            `compares two DIFFERENT hashes and a correct password always fails — the endpoint ` +
            `answers false on a row it found, which reads as a wrong credential. Declare it ` +
            `\`input.text()\` and pass the plaintext: \`check_password\` does the comparison hash ` +
            `itself.`,
          obj,
        );
      }
    }
  }
}

/**
 * A zip statement stored with no `password` (or `password_encryption`) key.
 *
 * The engine reads these context keys unconditionally, so a statement without
 * one exports and deploys clean and then answers every request `400 Missing
 * param`. An omitted field is written as the empty constant; the key goes
 * missing only through an explicit `null` — the spelling a pull uses to
 * reproduce a statement stored that way — so this names the remedy.
 */
export function checkZipPasswordKeys(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      let owner: string | undefined;
      for (const statement of statements) {
        const fields = READ_UNCONDITIONALLY[statement.name];
        if (!fields) continue;
        const context = (statement as { context?: unknown }).context;
        const record = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
        const missing = fields.filter((field) => record[field] === undefined);
        if (missing.length === 0) continue;
        const name = (obj as { name?: unknown }).name;
        owner ??= `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
        const list = missing.map((field) => `\`${field}\``).join(" and ");
        bag.warn(
          "stack.zip-password-absent",
          `${owner}: \`${statementLabel(statement.name)}\` sends no ${list} key (\`${missing[0]}: null\`), ` +
            `and the engine rejects that at run time with \`Missing param: ${missing[0]}\`. Omit the field to ` +
            `send an empty password, or pass a value.`,
          obj,
        );
      }
    }
  }
}

/**
 * A `to_throw` body reading a variable bound OUTSIDE it.
 *
 * `s.expect.to_throw` runs its `body` in an isolated var stack, so a variable
 * bound earlier in the test is not visible inside it. The stack still exports
 * clean and still deploys, and the runtime failure names the wrong problem:
 *
 * ```
 * to_throw failed - expected "belongs to someone else" not found in error "Missing var entry: listing"
 * ```
 *
 * which reads as "the guard under test did not fire" when what actually
 * happened is that the setup never ran. An author who trusts that message goes
 * looking at the guard, and the fix is a deploy cycle away from where they are
 * looking. Reported here, before the deploy, naming the isolation.
 *
 * Only the bound-outside case is reported. A name nothing binds anywhere is
 * {@link checkUnboundVarRefs}'s, whose message is already right for it — this
 * one exists for the name that IS bound, just not where the body can see it.
 *
 * A warning rather than an error, on the same reasoning as every other var
 * check: the binding sites are read structurally, so an unforeseen one must not
 * be able to block a deploy.
 */
export function checkToThrowScope(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;

      const all: EncodedStatement[] = [];
      collectStatements(obj, all);
      const toThrows = all.filter((st) => st.name === "mvp:test_expect_to_throw");
      if (toThrows.length === 0) continue;

      // Everything the enclosing object binds — the outer stack plus the bodies
      // themselves. A base absent from this binds nowhere, which is the other
      // guard's finding, not this one's.
      const boundAnywhere = collectBindings(all);

      for (const toThrow of toThrows) {
        const body = (toThrow.context as { run?: unknown } | undefined)?.run;
        if (!Array.isArray(body) || body.length === 0) continue;

        const inside: EncodedStatement[] = [];
        collectStatements(body, inside);
        const boundInside = collectBindings(inside);

        const refs: string[] = [];
        collectVarRefs(body, refs);

        const reported = new Set<string>();
        for (const path of refs) {
          const dot = path.indexOf(".");
          const base = dot === -1 ? path : path.slice(0, dot);
          if (base === "" || base.startsWith("$")) continue;
          // A reserved namespace is not a stack variable, so the isolation does
          // not apply to it. `auth.id` reads the same inside the body as out.
          if ((Object.hasOwn(RESERVED_VAR_NAMESPACES, base) ? RESERVED_VAR_NAMESPACES[base] : undefined)) continue;
          if (boundInside.has(base)) continue;
          if (!boundAnywhere.has(base)) continue;
          if (reported.has(base)) continue;
          reported.add(base);
          bag.warn(
            "stack.to-throw-isolated-var",
            `${owner}: \`ref("${path}")\` inside an \`s.expect.to_throw\` body names \`${base}\`, ` +
              `which is bound OUTSIDE the body. \`to_throw\` runs its \`body\` in an ISOLATED var ` +
              `stack, so \`${base}\` is not visible in there: the body raises ` +
              `\`Missing var entry: ${base}\` before reaching the statement under test, and the ` +
              `test reports \`to_throw failed - expected "…" not found in error "Missing var ` +
              `entry: ${base}"\` — which reads as the guard not firing. Bind what the body needs ` +
              `INSIDE the body, or pass the value as a literal.`,
            obj,
          );
        }
      }
    }
  }
}

/**
 * A db lookup's MATCH value — the statement input the engine requires a real
 * scalar in — keyed by the statement that takes one: `field_value`, the pair
 * half of every by-field op.
 *
 * Keyed by STATEMENT rather than by input name, because the name alone is
 * ambiguous: `db.add` emits one input per ROW COLUMN, so a table with an `id`
 * column (every one of them) sends an `id` input that is a value being written,
 * not a value being matched on — and a column named `field_value` would read
 * the same way. Matching on the name alone reported every `db.add` that lets
 * the engine assign the key.
 */
const DB_MATCH_ARG: Readonly<Record<string, string>> = {
  "mvp:dbo_getby": "field_value",
  "mvp:dbo_delby": "field_value",
  "mvp:dbo_hasby": "field_value",
  "mvp:dbo_editby": "field_value",
  "mvp:dbo_patch": "field_value",
  "mvp:dbo_addoreditby": "field_value",
};

/**
 * Is this input cell a null-safe drill — `ref(path, { safe: true })`?
 *
 * That compiles to the base var carrying a `get` filter whose default is
 * `null` (`$ticket|get:"board":null`), so the shape is what identifies it. A
 * `get` filter with a NON-null default is deliberately not matched: it resolves
 * to that default rather than to null, so it never produces the failure below.
 */
function isNullSafeDrill(cell: unknown): boolean {
  const value = cell as { tag?: unknown; filters?: unknown } | undefined;
  if (value?.tag !== "var" || !Array.isArray(value.filters)) return false;
  return value.filters.some((entry) => {
    const filter = entry as { name?: unknown; arg?: unknown } | undefined;
    if (filter?.name !== "get") return false;
    const fallback = Array.isArray(filter.arg) ? filter.arg[1] : undefined;
    if (fallback === undefined) return true;
    return (fallback as { tag?: unknown }).tag === "const:null";
  });
}

/**
 * A `{ safe: true }` ref used as a `db.*` match argument.
 *
 * The null-safe drill is an EXPRESSION opt-in: it yields `null` where a raw
 * `ref("ticket.board")` would raise `Unable to locate var` (HTTP 500), so a
 * precondition reads `false` instead of throwing. Fed to a db lookup it fails
 * differently and earlier — the engine refuses the null outright with HTTP 400
 * `Missing param: field_value`, one statement BEFORE the guard that was
 * supposed to answer. Net effect is the documented 500: the ownership check
 * never runs. Only an id matching no row reaches it, so the shape deploys,
 * passes `tsc`, passes unit tests over the pure logic, and fails against the
 * first unknown id in production.
 *
 * Statically unambiguous — null is never a legal value in that position — but a
 * warning, in line with every other guard here: an export must not be blocked
 * on an inference about author intent.
 */
export function checkSafeRefMatchArgs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        const matchArg = (Object.hasOwn(DB_MATCH_ARG, statement.name) ? DB_MATCH_ARG[statement.name] : undefined);
        if (matchArg === undefined || !Array.isArray(statement.input)) continue;
        for (const entry of statement.input) {
          const cell = entry as { name?: unknown; value?: unknown } | undefined;
          if (cell?.name !== matchArg) continue;
          if (!isNullSafeDrill(cell)) continue;
          const base = typeof cell.value === "string" ? cell.value : "the base";
          const arg = matchArg === "id" ? "`id`" : "`fieldValue`";
          bag.warn(
            "db.safe-ref-match-arg",
            `${owner}: a \`ref(…, { safe: true })\` is the ${arg} of \`${statement.name}\`. ` +
              `That opt-in exists to produce \`null\` when \`${base}\` is null, and \`null\` is ` +
              `never a legal match value — the engine rejects the request with HTTP 400 ` +
              `\`Missing param: ${matchArg}\` before any later statement runs, so a following ` +
              `precondition never gets to answer and the caller sees an internal-sounding 400 ` +
              `instead of your 404. \`{ safe: true }\` is for an EXPRESSION operand (a ` +
              `precondition/condition, an \`obj()\` member), not a db match argument. Guard ` +
              `existence first — \`s.precondition({ expr: expr(ref("${base}"), "!=", c.null()), ` +
              `error_type: "notfound", … })\` — then drill WITHOUT \`safe\`, since the base is ` +
              `known non-null by then.`,
            obj,
          );
        }
      }
    }
  }
}

/**
 * A LITERAL `c.null()` used as a `db.*` match argument.
 *
 * The sibling of {@link checkSafeRefMatchArgs}, and the decidable one: the
 * operand is a constant, so there is no dataflow to trace and no reading under
 * which the author meant something else. The engine refuses the request with
 * HTTP 400 `Missing param: field_value` — so unlike the safe-ref shape, which
 * only fails on an id matching no row, this one fails on the endpoint's FIRST
 * call, with a message that reads as a bad request from the caller and names an
 * argument they never sent.
 *
 * The shape an author reaches it through is an optional foreign key: a
 * `f.tableRef` stores an int, `nullable: true` type-checks, and null then looks
 * like the spelling for "not set yet" — but nothing can read the column back by
 * that value. A `0` sentinel is the shape that works end to end, so the warning
 * names it.
 *
 * A warning rather than an error, in line with every other guard here: whether
 * the engine accepts a null in that slot is the engine's rule to change, and a
 * warning does not have to be un-shipped if it ever means "where this column is
 * null". `export --strict` turns it into a failed build for a pipeline that
 * wants one.
 *
 * Only a BARE null fires. A null carrying filters (`c.null()` piped through
 * `first_notempty`) can resolve to a real scalar, which is the whole reason the
 * filters are there.
 */
export function checkNullMatchArgs(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        const matchArg = (Object.hasOwn(DB_MATCH_ARG, statement.name) ? DB_MATCH_ARG[statement.name] : undefined);
        if (matchArg === undefined || !Array.isArray(statement.input)) continue;
        for (const entry of statement.input) {
          const cell = entry as { name?: unknown; tag?: unknown; filters?: unknown } | undefined;
          if (cell?.name !== matchArg) continue;
          if (cell.tag !== "const:null") continue;
          if (Array.isArray(cell.filters) && cell.filters.length > 0) continue;
          const arg = matchArg === "id" ? "`id`" : "`fieldValue`";
          bag.warn(
            "db.null-match-arg",
            `${owner}: \`c.null()\` is the ${arg} of \`${statement.name}\`. \`null\` is never a ` +
              `legal match value — the engine rejects the request with HTTP 400 \`Missing param: ` +
              `${matchArg}\` on the FIRST call, and the caller sees an input error naming an ` +
              `argument they never sent. \`null\` belongs in an EXPRESSION operand (a ` +
              `precondition/condition, an \`obj()\` member), not in a lookup's match slot. ` +
              `Modelling an optional link? Store the sentinel instead — ` +
              `\`f.tableRef(users, { required: true, default: 0 })\` — and match on ` +
              `\`c.int(0)\`, which finds no row and binds \`null\`, the answer the null was after.`,
            obj,
          );
        }
      }
    }
  }
}

/**
 * The verbs that carry no request body, so every value they take rides the URL.
 * A body-carrying verb is excluded deliberately: a `POST login` looking a row up
 * by `inp("email")` is addressing nothing — the value is a credential in the
 * body, and `login/{email}` would put it in the request line and the access log.
 */
const URL_ONLY_VERBS = new Set(["GET", "DELETE", "HEAD"]);

/** The name-parts of an input that is personal data or a secret: a URL path is logged. */
const SENSITIVE_INPUT_PARTS = new Set([
  "email", "mail", "password", "passwd", "pwd", "pass", "token", "code", "secret", "key",
  "phone", "mobile", "ssn", "otp", "pin", "nonce", "signature", "hash",
  // Session/auth handles, payment and identity documents, and personal data.
  "session", "sid", "auth", "magic", "jwt", "credential", "card", "cvv", "cvc", "iban", "bic", "swift", "passport",
  "tax", "tin", "vat", "nin", "dob", "birth", "birthday", "birthdate", "address", "ip", "salary",
]);

/**
 * A field that holds personal data or a secret by its TYPE or flag rather than
 * its name: `input.email()`, `input.password()`, a `sensitive: true` column.
 */
function isSensitiveField(field: { type?: unknown; sensitive?: unknown } | undefined): boolean {
  return field?.sensitive === true || field?.type === "email" || field?.type === "password";
}

/** `rows` (an encoded `input`/`schema` list) by name. */
function fieldsByName(rows: unknown): Map<string, { type?: unknown; sensitive?: unknown }> {
  const map = new Map<string, { type?: unknown; sensitive?: unknown }>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { name?: unknown; type?: unknown; sensitive?: unknown } | null;
    if (typeof r?.name === "string") map.set(r.name, r);
  }
  return map;
}

/** Whether an input's name (`invite_code`, `resetToken`, `email`) marks it sensitive. */
function isSensitiveInputName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => SENSITIVE_INPUT_PARTS.has(part));
}

/**
 * An input that ADDRESSES one row but reaches the endpoint as a query-string
 * param instead of a path segment.
 *
 * The endpoint works either way — Xano serves `/blog?blog_id=1` exactly as
 * happily as `/blog/1` — so this is a shape warning, not a correctness one. What
 * it costs is real all the same: the route stops being addressable the way every
 * REST client, cache key, and log line expects, and `getPath()` types as STATIC,
 * so the frontend cannot pass the value positionally and has to hand-append a
 * query string that nothing type-checks.
 *
 * The signal is DELIBERATELY not the input's name. A path segment is any value
 * that names which resource is wanted — `blog/{category}`, `shop/{country}`,
 * `posts/{slug}` are the same shape as `blog/{blog_id}` — so matching `*_id`
 * would both miss most of them and fire on `?owner_id=` filters that are
 * correctly query-string params.
 *
 * What the guard reads instead is what the stack DOES with the input: it fires
 * only when the value lands in the match argument of a by-one-row db lookup
 * ({@link DB_MATCH_ARG} — `db.get` and the by-field
 * edit/patch/delete family). Those statements mean "find THE row with this
 * value", which is precisely what a path segment is for. A `db.query` is
 * excluded for the same reason: it searches a LIST, and narrowing a list is
 * exactly what a query-string filter should do. `db.has` is excluded too — an
 * existence check (`email-available`) validates a value rather than addressing
 * a resource — and so is an input that is personal data or a secret, which a
 * path would write to logs: by name (`email`, `invite_code`, `session_id`,
 * `card_number`), by declared type (`input.email()`/`password()`), or by the
 * column it is matched against (`sensitive: true`, email, password). Kept a
 * deny-list rather than inverted to "id-like names only": the address a path
 * carries is as often a `slug`, `category` or `country`, and inverting would
 * drop exactly those.
 *
 * One diagnostic per input per query, and only for an input the path does not
 * already bind — so `blog/{blog_id}/comments` still reports a `comment_id` that
 * addresses a second row.
 */
/**
 * What the request parser does with query-string param `name`, as the tail of
 * "`?name=…` …" — undefined when it arrives unchanged. Leading spaces
 * are dropped; before the first `[`, `.` and space become `_`; a `[` with a
 * later `]` nests the value under the name before it; a `[` without one
 * becomes `_`, as does every later `.`, space and `[`.
 */
function queryStringKey(name: string): string | undefined {
  const key = name.replace(/^ +/, "");
  const open = key.indexOf("[");
  const base = (open === -1 ? key : key.slice(0, open)).replace(/[. ]/g, "_");
  if (base === "") return "is dropped";
  if (open !== -1) {
    if (key.indexOf("]", open) !== -1) return `arrives nested under \`${base}\`, not as \`${name}\``;
    return `arrives as \`${base}_${key.slice(open + 1).replace(/[. []/g, "_")}\``;
  }
  return base === name ? undefined : `arrives as \`${base}\``;
}

export function checkPathSegmentCandidates(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const columns = new Map<string, Map<string, { type?: unknown; sensitive?: unknown }>>();
  for (const table of sections["dbo"] ?? []) {
    const t = table as { guid?: unknown; schema?: unknown } | null;
    if (typeof t?.guid === "string") columns.set(t.guid, fieldsByName(t.schema));
  }
  for (const obj of sections["query"] ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const query = obj as { name?: unknown; verb?: unknown; input?: unknown };
    const name = typeof query.name === "string" ? query.name : "";
    const verb = typeof query.verb === "string" ? query.verb : "";
    if (!URL_ONLY_VERBS.has(verb)) continue;
    const inputs = fieldsByName(query.input);
    for (const input of inputs.keys()) {
      if (name.includes(`{${input}}`)) continue;
      const arrives = queryStringKey(input);
      if (arrives === undefined) continue;
      bag.warn(
        "query.input-name-mangled",
        `query "${name}" (${verb}) has an input named ${JSON.stringify(input)}, which a query string cannot ` +
          `deliver — the request parser rewrites param names, so \`?${input}=…\` ${arrives} and the input stays ` +
          `empty. Rename the input with "_" or "-".`,
        obj,
      );
    }

    const statements: EncodedStatement[] = [];
    collectStatements(obj, statements);
    const addressing = new Set<string>();
    for (const statement of statements) {
      const matchArg = (Object.hasOwn(DB_MATCH_ARG, statement.name) ? DB_MATCH_ARG[statement.name] : undefined);
      // `db.has` answers "does it exist" — an availability or validation check,
      // not the resource the route addresses.
      if (matchArg === undefined || statement.name === "mvp:dbo_hasby") continue;
      const cell = statementInput(statement, matchArg);
      // `inp("x")` encodes as `{ tag: "input", value: "x" }`. Anything else in
      // that slot — a const, a stack var, an expression — is not an input the
      // caller supplies, so there is nothing to move into the path.
      if ((cell as { tag?: unknown } | undefined)?.tag !== "input") continue;
      if (typeof cell?.value !== "string" || cell.value === "") continue;
      // A path lands in access logs, proxies and browser history, so a value
      // that is personal data or a secret stays out of it.
      // Judged three ways: the input's name, its declared type, and the
      // column it is matched against (`sensitive: true`, email, password).
      if (isSensitiveInputName(cell.value) || isSensitiveField(inputs.get(cell.value))) continue;
      const column = statementInput(statement, "field_name");
      const table = (statement as { context?: { dbo?: { id?: unknown } } }).context?.dbo?.id;
      if (typeof column?.value === "string" && typeof table === "string") {
        if (isSensitiveField(columns.get(table)?.get(column.value))) continue;
      }
      // Already a segment. Substring rather than a parse: a pulled bundle may
      // carry a name whose markers Xano SDK cannot parse, and a guard must not
      // throw on one.
      if (name.includes(`{${cell.value}}`)) continue;
      addressing.add(cell.value);
    }

    for (const param of addressing) {
      bag.warn(
        "query.path-segment-candidate",
        `query "${name}" (${verb}) looks up one row by the \`${param}\` input, but the path ` +
          `declares no \`{${param}}\` segment — so the value arrives as \`?${param}=…\` instead of ` +
          `addressing the resource. The endpoint works, but the route is not addressable the way a ` +
          `REST client expects, and \`getPath()\` types as static, so a caller cannot pass the value ` +
          `positionally. Put it in the path: \`name: "${name}/{${param}}"\` (the segment may sit ` +
          `anywhere — \`"${name}/{${param}}/edit"\` routes too), keeping the \`${param}\` input as it ` +
          `is; the segment binds to the input of the same name. If \`${param}\` really is a ` +
          `query-string param rather than part of the address, accept the warning on the query with ` +
          `\`diagnostics: { allow: ["query.path-segment-candidate"] }\`.`,
        obj,
      );
    }
  }
}

/**
 * Two objects of one kind sharing a name but carrying different guids — a
 * bundle that exports today and cannot be locked.
 *
 * A lock entry is keyed by `<payloadKey>:<name>` and holds ONE guid, so a pair
 * sharing a name has no representation there and `export --lock` refuses it:
 * two same-identity objects each pinning an explicit guid. (Query and realtime
 * lock names carry their composed identity, so a verb pair or one message name
 * on two channels is two representable entries.)
 *
 * The lock is the recommended workflow (opt in early, commit `xano.lock`), so
 * this belongs on the UNLOCKED export, where a rename is still cheap, rather
 * than at the first locked one.
 *
 * Only a pair with DIFFERENT guids is reported: identical guids are the
 * un-pinned same-name case, and `buildBundle` already hard-errors on those in
 * its own words.
 */
export function checkSameNameSiblings(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const appNames = identityNamesByGuid(sections);
  for (const [payloadKey, arr] of Object.entries(sections)) {
    const guidsByName = new Map<string, Set<string>>();
    const kindsByName = new Map<string, Set<string>>();
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const { name, guid } = obj as { name?: unknown; guid?: unknown };
      if (typeof name !== "string" || name === "" || typeof guid !== "string") continue;
      // Group by the LOCK identity, not the display name: a query's lock key
      // carries its composed (group, verb, name), so a GET/POST pair — or one
      // path across two groups — is two representable entries and no longer a
      // hazard. What still warns is two objects composing the SAME identity
      // behind distinct explicit guids, which no lock entry can hold.
      const identity = lockNameForObject(payloadKey, obj as { name: string }, appNames);
      const guids = guidsByName.get(identity) ?? new Set<string>();
      guids.add(guid);
      guidsByName.set(identity, guids);
      kindsByName.set(identity, (kindsByName.get(identity) ?? new Set()).add(sdkKindName(payloadKey, obj)));
    }
    for (const [name, guids] of guidsByName) {
      if (guids.size < 2) continue;
      // SDK kind names, not the storage key: an agent + MCP server pair is one
      // `toolset` key and read as "2 toolset objects".
      const kinds = [...kindsByName.get(name)!];
      const kind = kinds.join(" / ");
      const advice = `Rename one of them — an explicit \`guid\` clears the export-time collision but not this one.`;
      bag.warn(
        "lock.same-name-siblings",
        `${guids.size} ${kind} objects share the identity "${name}" while carrying ` +
          `different guids${kinds.length > 1 ? " (agents and MCP servers share ONE name space)" : ""}. ` +
          `This bundle exports, but a lock entry is keyed by \`${kinds[0]}:${name}\` and holds ONE guid, so \`xanosdk export --lock\` REFUSES ` +
          `the pair — and a committed \`xano.lock\` is the recommended workflow. ${advice} ` +
          `Fixing it now costs a rename; at the first locked export it costs the lock.`,
      );
    }
  }
}

/**
 * One character a route segment can consume: any non-`/` character, a digit, or
 * one literal character. Query names are limited to `A-Za-z0-9_-/{}`, so the
 * literal text carries no pattern syntax.
 */
type RouteChar = { kind: "any" } | { kind: "digit" } | { kind: "char"; c: string };

/** An NFA over one path segment: `edges[state]` lists `[class, next]`. */
type SegmentNfa = { edges: Array<Array<[RouteChar, number]>>; accept: Set<number> };

function routeCharsMeet(a: RouteChar, b: RouteChar): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "digit" && b.kind === "digit") return true;
  if (a.kind === "char" && b.kind === "char") return a.c === b.c;
  const c = a.kind === "char" ? a.c : (b as { c: string }).c;
  return c >= "0" && c <= "9";
}

/**
 * Compile one segment the way the router reads it. The router's marker is
 * greedy within a segment — from the first `{` to the last `}` — so
 * `"{a}-{b}"` is ONE marker whose name matches no input. A marker matches one
 * or more non-`/` characters, narrowed to digits for an `int` input and to
 * `digits[.digits]` for a `decimal` one, but only the inputs in `narrowed`.
 */
function compileSegment(segment: string, narrowed: ReadonlyMap<string, "int" | "decimal">): SegmentNfa {
  const edges: Array<Array<[RouteChar, number]>> = [[]];
  // The states the text so far can end in — more than one after a decimal,
  // whose fraction is optional.
  let at = [0];
  const step = (cls: RouteChar): number => {
    edges.push([]);
    const next = edges.length - 1;
    for (const from of at) edges[from]!.push([cls, next]);
    at = [next];
    return next;
  };
  // `cls+`: one required step, then a self-loop.
  const plus = (cls: RouteChar): number => {
    const loop = step(cls);
    edges[loop]!.push([cls, loop]);
    return loop;
  };
  const literal = (text: string): void => {
    for (const c of text) step({ kind: "char", c });
  };
  const open = segment.indexOf("{");
  const close = segment.lastIndexOf("}");
  if (open === -1 || close <= open + 1) {
    literal(segment);
    return { edges, accept: new Set(at) };
  }
  literal(segment.slice(0, open));
  const type = narrowed.get(segment.slice(open + 1, close));
  if (type === "int") {
    plus({ kind: "digit" });
  } else if (type === "decimal") {
    // `digits`, optionally followed by `.digits*`.
    const whole = plus({ kind: "digit" });
    const fraction = step({ kind: "char", c: "." });
    edges[fraction]!.push([{ kind: "digit" }, fraction]);
    at = [whole, fraction];
  } else {
    plus({ kind: "any" });
  }
  literal(segment.slice(close + 1));
  return { edges, accept: new Set(at) };
}

/**
 * A request segment both patterns match, or `undefined` when none exists — a
 * product walk of the two segment NFAs. The witness goes in the message, so an
 * author sees a concrete path rather than an abstract overlap.
 */
function segmentOverlap(a: SegmentNfa, b: SegmentNfa): string | undefined {
  const seen = new Map<string, string>([["0,0", ""]]);
  const queue: Array<[number, number]> = [[0, 0]];
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head]!;
    const text = seen.get(`${x},${y}`)!;
    if (a.accept.has(x) && b.accept.has(y)) return text;
    for (const [ca, nx] of a.edges[x] ?? []) {
      for (const [cb, ny] of b.edges[y] ?? []) {
        if (!routeCharsMeet(ca, cb)) continue;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        const digit = ca.kind === "digit" || cb.kind === "digit";
        const ch = ca.kind === "char" ? ca.c : cb.kind === "char" ? cb.c : digit ? "1" : "x";
        seen.set(key, text + ch);
        queue.push([nx, ny]);
      }
    }
  }
  return undefined;
}

/**
 * Two queries in one api group and verb that a single request path can match.
 *
 * The router walks a group's routes in creation order and serves the FIRST that
 * matches — a literal route gets no precedence over a `{param}` sibling. So
 * `x/runs/{id}` (a text `id`) created before `x/runs/trend` answers
 * `GET /x/runs/trend` itself, and the literal route is unreachable.
 *
 * Not reordered: creation order is `registerQueries` order only on a fresh
 * deploy. A merge (`release`, `deploy --keep-data`) updates existing routes in
 * place, so a route that is already deployed stays ahead of a sibling added
 * later whatever order the bundle carries. No emit order is safe; only disjoint
 * paths are.
 *
 * A WARNING: the engine stores and serves both routes, and making them disjoint
 * renames a route clients already call — so a pair that is live accepts it with
 * `diagnostics.allow` on either query. One diagnostic per colliding pair.
 */
export function checkRouteShadowing(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  type Route = { name: string; verb: string; segments: SegmentNfa[]; record: object };
  const appNames = appNamesByGuid(sections["app"]);
  const byGroupVerb = new Map<string, Route[]>();
  for (const obj of sections["query"] ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const query = obj as { name?: unknown; verb?: unknown; app?: unknown; input?: unknown };
    if (typeof query.name !== "string" || query.name === "") continue;
    const verb = typeof query.verb === "string" ? query.verb : "";
    // The router narrows a `{p}` only when the input's stored key is the bare
    // name — required, non-nullable, not a list — and it is an int or decimal.
    // An optional `input.int()` does NOT narrow, and a table reference stores
    // as its own type, so neither protects a word-shaped sibling.
    const narrowed = new Map<string, "int" | "decimal">();
    for (const entry of Array.isArray(query.input) ? query.input : []) {
      const { name, type, required, nullable, style, methods } = (entry ?? {}) as {
        name?: unknown;
        type?: unknown;
        required?: unknown;
        nullable?: unknown;
        style?: { type?: unknown };
        methods?: unknown;
      };
      if (typeof name !== "string" || required !== true || nullable === true) continue;
      if (style?.type === "list") continue;
      if (Array.isArray(methods) && methods.some((m) => (m as { name?: unknown })?.name === "@")) continue;
      const stored = type === "" && name === "id" ? "int" : type;
      if (stored === "int" || stored === "decimal") narrowed.set(name, stored);
    }
    // The query identity minus its name: (api group, verb), resolved the way the lock keys it.
    const key = lockNameForObject("query", { name: "", verb, app: query.app }, appNames);
    const routes = byGroupVerb.get(key) ?? [];
    routes.push({
      name: query.name,
      verb,
      segments: query.name.split("/").map((segment) => compileSegment(segment, narrowed)),
      record: obj,
    });
    byGroupVerb.set(key, routes);
  }

  for (const routes of byGroupVerb.values()) {
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i]!;
        const b = routes[j]!;
        // Identical names are one identity, refused by the bundle builder in its own words.
        if (a.name === b.name || a.segments.length !== b.segments.length) continue;
        const witness: string[] = [];
        for (let k = 0; k < a.segments.length; k++) {
          const hit = segmentOverlap(a.segments[k]!, b.segments[k]!);
          if (hit === undefined) break;
          witness.push(hit);
        }
        if (witness.length !== a.segments.length) continue;
        const path = `/${witness.join("/")}`;
        const disjoint = disjointRouteExample(a.name, b.name);
        const message = () =>
          `queries "${a.name}" and "${b.name}" (${a.verb}, same api group) can both match ` +
            `\`${a.verb} ${path}\`. Xano serves the FIRST route that matches in creation order — a ` +
            `literal route gets no precedence over a \`{param}\` one — so one of them silently ` +
            `answers the other's requests. Creation order is \`registerQueries\` order only on a ` +
            `fresh deploy; a release or \`deploy --keep-data\` keeps an existing route first, so ` +
            `reordering does not fix it. Make the paths disjoint: move the param route under its ` +
            `own segment${disjoint === undefined ? "" : ` (\`"${disjoint}"\`)`}, rename the literal, or — when the param is ` +
            `numeric — declare it \`input.int({ required: true })\`: only a REQUIRED int or ` +
            `decimal segment is narrowed to digits; an optional one matches any text.`;
        if (bag.isAccepted("query.route-shadowed", message, a.record)) continue;
        bag.warn("query.route-shadowed", message(), b.record);
      }
    }
  }
}

/**
 * The shadowing pair's param route moved under its own segment — `runs/{id}`
 * beside `runs/trend` → `runs/by-id/{id}` — so the remedy names the author's
 * route rather than a fixed example. `undefined` when neither route has a
 * `{param}` opposite a literal.
 */
function disjointRouteExample(a: string, b: string): string | undefined {
  const as = a.split("/");
  const bs = b.split("/");
  for (const [mine, theirs] of [[as, bs], [bs, as]] as const) {
    const k = mine.findIndex((seg, i) => seg.startsWith("{") && !(theirs[i] ?? "").startsWith("{"));
    if (k !== -1) return [...mine.slice(0, k), `by-${mine[k]!.slice(1, -1)}`, ...mine.slice(k)].join("/");
  }
  return undefined;
}

/** The statement `s.realtime.publish` encodes to. */
const REALTIME_PUBLISH = "mvp:realtime_publish";

/**
 * A `{value, tag}` cell whose value is a compile-time constant, or `undefined`.
 *
 * A FILTER CHAIN disqualifies it. `withFilters(c.text("rides/"),
 * fl.concat(ref("ride.id")))` — the only spelling that builds a per-row channel
 * path, since `getChannel()` needs the id at author time — still carries
 * `tag: "const"` and `value: "rides/"`, with the chain alongside. Reading the
 * base alone treats a COMPUTED value as the whole literal, and a per-row path
 * base can never match a registered template, so every correct publish warned.
 */
function constantCell(cell: unknown): string | undefined {
  const c = cell as { tag?: unknown; value?: unknown; filters?: unknown } | undefined;
  if (typeof c?.tag !== "string" || !c.tag.startsWith("const")) return undefined;
  if (Array.isArray(c.filters) && c.filters.length > 0) return undefined;
  return typeof c.value === "string" && c.value !== "" ? c.value : undefined;
}

/**
 * Does a concrete path address this channel? A registered channel name is a
 * TEMPLATE (`rooms/{room_id}`), and a `{param}` matches one path segment — the
 * same rule the router applies, so a param never spans a `/`.
 */
function channelPathMatches(template: string, path: string): boolean {
  const pattern = template
    .split(/\{[^{}]*\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * A `realtime.publish` whose `server`/`channel` names nothing this bundle
 * carries.
 *
 * Both are stored as plain NAMES resolved by the engine at request time, so
 * neither goes through the guid check every other cross-object reference gets —
 * a typo, or a channel that was never registered, exports clean. And the engine
 * is deliberately FAIL-SOFT here: a missing server or a path nobody is
 * subscribed to is logged engine-side and returns quietly, with no result in
 * the stack to check. So a mis-targeted publish is silent end to end, and its
 * symptom is "the UI just never updates" — the class of bug with the worst
 * diagnosis cost, and one export is the only place in the chain positioned to
 * say anything.
 *
 * Warnings, not errors, and constants only. A `ref`/`inp` channel is computed
 * at runtime and is deliberately untouched; a workspace may also legitimately
 * publish onto a server that lives outside this bundle, which is why the more
 * confident spelling would be wrong here even though the reference-guid check
 * is an error.
 */
export function checkRealtimePublish(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  // A partial bundle may reference realtime objects it does not carry; a
  // `workspace` bundle is what `deploy` ships and must be self-contained.
  if (bundleType !== "workspace") {
    bag.skipped("realtime.publish-unknown-server");
    bag.skipped("realtime.publish-unknown-channel");
    return;
  }

  const objName = (obj: unknown): string | undefined => {
    const name = (obj as { name?: unknown })?.name;
    return typeof name === "string" ? name : undefined;
  };
  const servers = (sections.realtime_server ?? []).map(objName).filter((n) => n !== undefined);
  const serverByGuid = new Map<unknown, string | undefined>(
    (sections.realtime_server ?? []).map((s) => [(s as { guid?: unknown })?.guid, objName(s)]),
  );
  // Each channel with its server's name: a path is registered per server, and a
  // publish names both.
  const channelRows = (sections.channel ?? []).flatMap((c) => {
    const name = objName(c);
    const server = serverByGuid.get((c as { server?: { id?: unknown } })?.server?.id);
    return name === undefined ? [] : [{ name, server }];
  });
  const channels = channelRows.map((c) => c.name);

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const owner = `${payloadKey} "${objName(obj) ?? "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const statement of statements) {
        if (statement.name !== REALTIME_PUBLISH) continue;
        const context = (statement.context ?? {}) as Record<string, unknown>;

        const server = constantCell(context.realtime_server);
        if (server !== undefined && !servers.includes(server)) {
          bag.warn(
            "realtime.publish-unknown-server",
            `${owner}: \`s.realtime.publish\` targets realtime server "${server}", which this ` +
              `workspace does not register. The engine resolves the server by NAME and FAILS ` +
              `SOFT — a miss is swallowed with nothing returned to the stack — so this publish ` +
              `goes nowhere and reports nothing. Pass the \`realtimeServer()\` handle rather ` +
              `than a bare name so a rename cannot break it.${
                servers.length > 0 ? ` Registered: ${servers.map((n) => `"${n}"`).join(", ")}.` : ""
              }`,
            obj,
          );
        }

        const channel = constantCell(context.channel);
        // With a registered server named, only that server's channels take the
        // publish: a path held by another server reaches none of its clients.
        const holders =
          channel === undefined ? [] : channelRows.filter((c) => channelPathMatches(c.name, channel));
        if (
          channel !== undefined &&
          server !== undefined &&
          servers.includes(server) &&
          holders.length > 0 &&
          !holders.some((c) => c.server === server)
        ) {
          const own = channelRows.filter((c) => c.server === server).map((c) => `"${c.name}"`);
          bag.warn(
            "realtime.publish-unknown-channel",
            `${owner}: \`s.realtime.publish\` targets channel path "${channel}" on realtime server ` +
              `"${server}", but that path is a channel of ${[...new Set(holders.map((c) => `"${c.server ?? "?"}"`))].join(", ")} ` +
              `only, so no client of "${server}" can be subscribed to it — and the publish is swallowed ` +
              `silently rather than failing. Publish on the server that owns the channel.` +
              (own.length > 0 ? ` "${server}" registers: ${own.join(", ")}.` : ""),
            obj,
          );
        } else if (channel !== undefined && holders.length === 0) {
          bag.warn(
            "realtime.publish-unknown-channel",
            `${owner}: \`s.realtime.publish\` targets channel path "${channel}", which matches ` +
              `no \`realtimeChannel()\` on this workspace, so no client can be subscribed to it ` +
              `— and the publish is swallowed silently rather than failing. Build the path with ` +
              `\`channel.getChannel({ … })\` instead of writing it out.${
                channels.length > 0
                  ? ` Registered: ${channels.map((n) => `"${n}"`).join(", ")}.`
                  : ""
              }`,
            obj,
          );
        }
      }
    }
  }
}

/**
 * Trigger types that fire ON a specific object, and the authoring argument that
 * binds one. The other three (`workspace`, `error`, and the workspace-realtime
 * lifecycle type) fire on the workspace itself and store `obj_id: 0` correctly.
 */
const TRIGGER_BINDINGS: Readonly<Record<string, string>> = {
  database: "table",
  realtime_server: "realtimeServer",
  channel: "channel",
  toolset: "mcpServer` / `agent",
};

/**
 * A trigger that fires on an object but names none.
 *
 * `objId` is optional on every factory, so omitting the binding exports cleanly
 * and deploys a trigger attached to nothing — it never fires, and nothing says
 * so. The toolset pair is where this bit: `llms.txt` documented the binding as
 * `objId` (a raw number, which is not knowable from a def), so an author
 * following it reached for the one argument that cannot work and got no signal
 * when they left it out entirely.
 *
 * A warning rather than an error: a partial bundle may legitimately carry a
 * trigger whose target it does not, and a raw `objId: 0` stays authorable.
 */
export function checkTriggerBindings(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; obj_id?: unknown; active?: unknown; meta?: unknown };
    const objType = typeof t.obj_type === "string" ? t.obj_type : "";
    // Every action off: the engine has nothing to fire it on. Omitted `actions`
    // and a misspelt one both land here.
    const flags = (t.meta as Record<string, { action?: Record<string, unknown> } | undefined> | undefined)?.[objType]?.action;
    if (t.active !== false && objType !== "toolset" && flags && Object.values(flags).every((v) => v !== true)) {
      bag.warn(
        "trigger.no-action",
        `${sdkKindName("trigger", t)} "${typeof t.name === "string" ? t.name : "?"}" enables no action, so it ` +
          `deploys and never fires. Set at least one in \`actions\`: ${Object.keys(flags).map((k) => `\`${k}: true\``).join(", ")}.`,
        obj,
      );
    }
    const arg = (Object.hasOwn(TRIGGER_BINDINGS, objType) ? TRIGGER_BINDINGS[objType] : undefined);
    if (!arg) continue;
    if (t.obj_id !== 0 && t.obj_id !== "" && t.obj_id !== undefined && t.obj_id !== null) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    bag.warn(
      "trigger.unbound",
      `${sdkKindName("trigger", t)} "${name}" names no object to fire on, so it ` +
        `deploys bound to nothing and never runs. Bind it with \`${arg}\` — pass the def handle ` +
        `(or its name) and it resolves to the target's guid at export, surviving a \`--reset\` ` +
        `deploy. A raw numeric \`objId\` is the escape hatch, and is rarely what you want: ids ` +
        `are assigned at import and are not knowable from a def.`,
      obj,
    );
  }
}

/**
 * Refuse a bundle carrying a statement the engine will not read back.
 *
 * `mvp:placeholder` is the whole population today: the engine writes one into an
 * export in place of a statement it could not resolve, so the export stays
 * well-formed — and then refuses those same bytes on import, because there is no
 * statement class behind the name. A bundle containing one can only fail with
 * `Missing statement: mvp:placeholder`, after a destructive full-replace has
 * begun.
 *
 * This clears the KTD2c bar without asserting anything about what the engine
 * accepts: Xano's own CLI blocks a push whose preview names `mvp:placeholder`,
 * as a critical error, in the same breath as a syntax error. The rule is
 * upstream's. Xano SDK cannot even author one — there is no `s.` surface — so
 * the only way a bundle acquires one is a pull that carried it through `raw()`,
 * which is exactly the case worth stopping.
 */
export function checkDecodeOnlyStatements(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const objName = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof objName === "string" ? objName : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      // One diagnostic per distinct statement name per object: three copies of
      // the same unresolved slot is one thing to go fix, not three.
      const found = new Set(
        statements.map((s) => s.name).filter((name) => DECODE_ONLY_STATEMENTS.has(name)),
      );
      for (const name of found) {
        bag.error(
          "statement.decode-only",
          `${owner} contains \`${name}\`, which is ${DECODE_ONLY_STATEMENTS.get(name)}. It ` +
            `reached this bundle from a pulled workspace — Xano SDK has no factory for it — and ` +
            `the generated source carries it as a \`raw({ name: "${name}", … })\` call. Replace ` +
            `that call with the statement it stands in for.`,
        );
      }
    }
  }
}

/** An engine object guid: 32 lowercase hex characters. */
const GUID_RE = /^[0-9a-f]{32}$/;

/**
 * Keys whose subtrees carry AUTHOR VALUES, never object references.
 *
 * A reference is structural — the encoder puts it there. Anything under these
 * keys came from the author, so a 32-hex string in one is a coincidence, not a
 * dangling pointer. This is not hypothetical: `examples/sandbox` has an
 * auth-token example whose statement input value is a literal 32-hex string.
 * Skipping these subtrees is what lets the check be an ERROR rather than a
 * warning nobody trusts.
 */
const VALUE_KEYS = new Set([
  "input",
  "value",
  // The same tagged value under the name a COMPARISON gives it
  // (`statement.left.operand` / `statement.right.operand`). Missing here made
  // any workspace that compares against a hash, a checksum, an API key or a hex
  // token fail its export outright — `md5("hello world")` asserted in a
  // precondition read as a pointer at an object that was never registered.
  // `normalize` already pairs the two keys for the same reason.
  "operand",
  "default",
  "filters",
  "search",
  "docs",
  "description",
  "mocks",
  // A saved unit test's subtree: its `input[]` and its assertions' `vars[]` are
  // author values like any other, and its `id` is the test's OWN identity, not
  // a pointer at another object — the same case as `guid` below. Without this a
  // pulled test's 32-hex id read as a reference to an object nothing registers,
  // which is a hard export error.
  "test",
  "tag",
  "settings_registry",
  // An object's own identity, not a pointer at another object.
  "guid",
]);

/**
 * Reference keys whose target legitimately lives OUTSIDE the workspace, so an
 * unresolved guid is expected rather than a mistake. `run_version` is a
 * marketplace action-package version — installed on the instance, never part of
 * a bundle Xano SDK emits.
 */
const EXTERNAL_REF_KEYS = new Set(["run_version"]);

/**
 * A reference the encoder embedded INSIDE a string rather than storing bare.
 *
 * Two forms, both pointing at a table:
 * - `"dbo=<guid>"` — a foreign key. `f.tableRef` persists the link as a trailing
 *   `@` method whose single arg is this, and the engine parses it back into the
 *   column's `tableref_id` on import.
 * - `"<guid>_mvpschema"` — the stored TYPE of an `input.dbLink`, the input that
 *   expands into one entry per column of the linked table.
 *
 * Neither is a bare guid, so both walked straight past the check below: a
 * mistyped table name produced a perfectly well-formed guid pointing at nothing,
 * the bundle exported clean, and the import failed with `Invalid database
 * reference. Try importing: <guid>` after a fresh ephemeral had already been
 * allocated.
 *
 * Matched only in the 32-hex form: `dbo=14` is a pulled workspace's LOCAL row id
 * (see `normalize`'s `LOCAL_DBO_REF`) and a bare `dbo=` is an FK the editor left
 * unbound — neither is a guid to resolve.
 */
const EMBEDDED_REF_RE = /^(?:dbo=([0-9a-f]{32})|([0-9a-f]{32})_mvpschema)$/;

/** The guid a string refers to, or `null` when it is not a reference at all. */
function refGuid(value: string, allowBare: boolean): string | null {
  const embedded = EMBEDDED_REF_RE.exec(value);
  if (embedded) return embedded[1] ?? embedded[2]!;
  return allowBare && GUID_RE.test(value) ? value : null;
}

/** One dangling reference: where it was found and what it points at. */
interface DanglingRef {
  readonly owner: string;
  readonly path: string;
  /** Where in the AUTHORED code: statement and argument, never the stored path. */
  readonly location: string;
  readonly guid: string;
}

/** A statement's stored context key → the `s.` argument that wrote it. */
const CONTEXT_KEY_ARG: Readonly<Record<string, string>> = {
  dbo: "table",
  function: "fn",
  middleware: "middleware",
  realtime_server: "server",
  addon: "addon",
  bind: "bind",
  auth: "authTable",
};
/** A call statement's `context.id` → the argument naming its target. */
const CALL_TARGET_ARG: Readonly<Record<string, string>> = {
  "s.function.call": "fn",
  "s.api.call": "api",
  "s.task.call": "task",
  "s.tool.call": "tool",
  "s.trigger.call": "trigger",
  "s.middleware.call": "middleware",
  "s.addon.call": "addon",
  "s.workflow_test.call": "workflowTest",
};
/** The authored name of a nested statement list, by the stored key that holds it. */
const NESTED_LIST: Readonly<Record<string, string>> = { if: "then", else: "else", try: "try", catch: "catch", finally: "finally" };

/**
 * Translate a stored path (`$.run[2].context.if.run[0].context.dbo.id`) into
 * where the author wrote it: `s.db.get at stack[2] → then[0], argument "table"`.
 * The stored path names engine keys that appear nowhere in authored code.
 */
function sdkLocation(root: unknown, path: string, owner: string, guid?: string): string {
  const tokens = [...path.replace(/^\$\.?/, "").matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) =>
    m[2] !== undefined ? Number(m[2]) : m[1]!,
  );
  let node: unknown = root;
  const where: string[] = [];
  let statement: string | undefined;
  let field: string | undefined;
  let prevKey: string | undefined;
  let beforePrev: string | undefined;
  for (const tok of tokens) {
    node = node !== null && typeof node === "object" ? (node as Record<string | number, unknown>)[tok] : undefined;
    if (typeof tok === "number" && prevKey === "run") {
      where.push(`${statement === undefined ? "stack" : ((Object.hasOwn(NESTED_LIST, beforePrev ?? "") ? NESTED_LIST[beforePrev ?? ""] : undefined) ?? "body")}[${tok}]`);
      const name = (node as { name?: unknown } | undefined)?.name;
      statement = typeof name === "string" ? statementLabel(name) : undefined;
      field = undefined;
    } else if (typeof tok === "string" && statement !== undefined && field === undefined && tok !== "context" && tok !== "run" && !(Object.hasOwn(NESTED_LIST, tok))) {
      field = tok === "id" ? ((Object.hasOwn(CALL_TARGET_ARG, statement) ? CALL_TARGET_ARG[statement] : undefined) ?? "id") : ((Object.hasOwn(CONTEXT_KEY_ARG, tok) ? CONTEXT_KEY_ARG[tok] : undefined) ?? tok);
    }
    if (typeof tok === "string") {
      beforePrev = prevKey;
      prevKey = tok;
    }
  }
  if (statement === undefined) return `${owner}, ${objectField(root, tokens, guid)}`;
  return `${statement} at ${where.join(" → ")}${field === undefined ? "" : `, argument "${field}"`}`;
}

/**
 * The authored field an object-level reference sits in, from its stored path.
 * `app.id` is the wire spelling of what the author wrote as `apiGroup`; an
 * input's stored `type` is the `input.dbLink(table)` they declared.
 */
function objectField(root: unknown, tokens: ReadonlyArray<string | number>, guid?: string): string {
  const [head, index] = tokens;
  // An input's stored `type`, and a column's stored methods/type, are where the
  // author declared the reference — named by the input or column they wrote.
  if ((head === "input" || head === "schema") && typeof index === "number") {
    const list = (root as Record<string, Array<{ name?: unknown }> | undefined> | null)?.[head] ?? [];
    const name = list[index]?.name;
    const noun = head === "input" ? "input" : "column";
    return typeof name === "string" ? `${noun} "${name}"` : `${noun} [${index}]`;
  }
  // A trigger's target is stored as `obj_id` whatever it binds to; the authored
  // field is the one its trigger type takes (`tableTrigger({ table })`, …).
  if (head === "obj_id") {
    const objType = (root as { obj_type?: unknown } | null)?.obj_type;
    // A toolset is an MCP server or an agent; the factory that bound this
    // guid recorded which field it took.
    const bound = objType === "toolset" && guid !== undefined ? toolsetTargetField(guid) : undefined;
    const authoredTarget = bound ?? (typeof objType === "string" ? (Object.hasOwn(TRIGGER_TARGET_FIELD, objType) ? TRIGGER_TARGET_FIELD[objType] : undefined) : undefined);
    if (authoredTarget !== undefined) return `field \`${authoredTarget}\``;
  }
  // An agent's or MCP server's tool list is stored as `tool[i].id`.
  if (head === "tool" && typeof index === "number") return `field \`tools[${index}]\``;
  // An MCP server's prompt and resource lists, the same way.
  if ((head === "prompt" || head === "resource") && typeof index === "number") return `field \`${head}s[${index}]\``;
  const authored = typeof head === "string" ? (Object.hasOwn(OBJECT_REF_FIELD, head) ? OBJECT_REF_FIELD[head] : undefined) : undefined;
  if (authored !== undefined) return `field \`${authored}\``;
  const stored = tokens.map((t) => (typeof t === "number" ? `[${t}]` : `.${t}`)).join("").replace(/^\./, "");
  return `at ${stored}`;
}

/** An object's stored reference key → the field the author wrote. */
const OBJECT_REF_FIELD: Readonly<Record<string, string>> = {
  app: "apiGroup",
  auth: "auth",
  dbo: "table",
  middleware: "middleware",
  addon: "addon",
  realtime_server: "server",
  server: "server",
  channel: "channel",
  tool: "tools",
};

/** A trigger's stored `obj_type` → the field its factory binds the target with. */
const TRIGGER_TARGET_FIELD: Readonly<Record<string, string>> = {
  database: "table",
  realtime_server: "realtimeServer",
  channel: "channel",
  toolset: "mcpServer`/`agent",
};

/**
 * The register call that adds an object of a payload kind to the workspace —
 * what a def handle that is not registered is missing.
 */
const REGISTER_CALL: Readonly<Record<string, string>> = {
  dbo: "registerTables",
  app: "registerApiGroups",
  query: "registerQueries",
  function: "registerFunctions",
  task: "registerTasks",
  middleware: "registerMiddleware",
  addon: "registerAddons",
  trigger: "registerTriggers",
  tool: "registerTools",
  prompt: "registerPrompts",
  resource: "registerResources",
  workflow_test: "registerWorkflowTests",
  realtime_server: "registerRealtimeServers",
  channel: "registerRealtimeChannels",
  message: "registerRealtimeMessages",
  microservice: "registerMicroservices",
  knowledge: "registerKnowledge",
};

/**
 * One pending step of the {@link collectDanglingRefs} walk. A string is queued
 * rather than resolved on the spot so siblings report in source order (see
 * below), carrying the `allowBare` its position already decided.
 */
type RefWalkFrame =
  | { readonly node: unknown; readonly path: string; readonly embeddedOnly: boolean }
  | { readonly text: string; readonly path: string; readonly allowBare: boolean };

/**
 * Collect every guid-valued reference under `node` that resolves to nothing.
 *
 * Walked with an explicit stack rather than by recursion. The tree this crosses
 * is as deep as the AUTHOR's expression tree, and a rule set folded into a
 * left-nested `and(and(and(…)))` — the shape an agent composing predicates from
 * a list produces naturally — blew the JavaScript call stack at roughly a
 * thousand terms. That surfaced as a bare `RangeError: Maximum call stack size
 * exceeded` out of a guard the author never called, which is neither actionable
 * nor recoverable in an automated build. Depth is bounded by heap
 * here, not by the stack.
 *
 * Children are pushed in reverse so they pop in order: the diagnostics this
 * feeds are reported in the order the references were found, and a stack that
 * reversed sibling order would silently reorder an author's error list.
 */
function collectDanglingRefs(
  node: unknown,
  path: string,
  owner: string,
  known: ReadonlySet<string>,
  out: DanglingRef[],
  // Inside an author-VALUE subtree (see {@link VALUE_KEYS}) only the embedded
  // reference forms are read. A bare 32-hex string there is author data; an
  // embedded one is a shape the encoder writes and an author does not.
  embeddedOnly = false,
): void {
  const stack: RefWalkFrame[] = [{ node, path, embeddedOnly }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("text" in frame) {
      const guid = refGuid(frame.text, frame.allowBare);
      if (guid && !known.has(guid)) out.push({ owner, path: frame.path, location: sdkLocation(node, frame.path, owner, guid), guid });
      continue;
    }
    const current = frame.node;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        const item = current[i];
        const itemPath = `${frame.path}[${i}]`;
        // A string ELEMENT is only ever read in its embedded form, for the same
        // reason: a field method's argument is as free-form as any value, and
        // this check earns its keep as an ERROR, so it stays off shapes it
        // cannot tell apart.
        stack.push(
          typeof item === "string"
            ? { text: item, path: itemPath, allowBare: false }
            : { node: item, path: itemPath, embeddedOnly: frame.embeddedOnly },
        );
      }
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const entries = Object.entries(current as Record<string, unknown>);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, value] = entries[i]!;
      if (EXTERNAL_REF_KEYS.has(key)) continue;
      // A value subtree is DESCENDED INTO rather than skipped: an object's
      // `input` schema is a value key (a statement's inputs carry author
      // values), but a query/function input declared with `input.dbLink(table)`
      // stores its target as the input's TYPE — `<guid>_mvpschema` — and
      // skipping the subtree meant a mistyped table name there failed only at
      // import. Descending with `embeddedOnly` reads exactly the
      // encoder-written forms and leaves every author value alone.
      const inValue = frame.embeddedOnly || VALUE_KEYS.has(key);
      const valuePath = `${frame.path}.${key}`;
      stack.push(
        typeof value === "string"
          ? { text: value, path: valuePath, allowBare: !inValue }
          : { node: value, path: valuePath, embeddedOnly: inValue },
      );
    }
  }
}

/**
 * Every cross-object reference must name an object this bundle emits.
 *
 * A reference is stored as the target's guid, and `resolveRef` derives that
 * guid from a name with **no registry visibility** — so `s.addon.call({ addon:
 * "ex_author_addon" })` against an addon actually named `ex_kind_author_addon`
 * produces a perfectly well-formed guid pointing at nothing. It exports clean
 * and then fails the import with `Invalid addon reference. Try importing:
 * <guid>`, after the full replace has begun. The author is handed a guid, which
 * is exactly the thing they cannot map back to their typo.
 *
 * `export()` already cross-checked one reference kind (a query's `auth` table)
 * and nothing else. This generalises it: the registry is fully known here, so
 * every reference is checkable. Five of these were live in `examples/sandbox`.
 *
 * Scoped to the full `workspace` bundle, which is what `deploy` ships and which
 * must be self-contained. A partial bundle (`schema`/`content`/`share`) may
 * legitimately reference an object it does not carry.
 */
/**
 * A FUNCTION anywhere in an encoded object: JSON writes one in a list as `null`
 * and drops one from a record, so whatever the author wrote there never reaches
 * the engine — and the pull that reads the bundle back finds a hole where a
 * value was. The live case was a trigger input accessor (`t.action`), which is a
 * callable Value, passed as a filter argument (`fl.concat(t.action)` stored
 * `"arg":[null]`). Every embedder flattens those now (`toPlainValue`); this is
 * the backstop that keeps the whole class from ever shipping silently again —
 * an error, because there is no bundle to write that says what was meant.
 *
 * Iterative and in source order, like the other walkers here.
 */
export function checkNonJsonValues(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  /** The encoded workspace config — its free-form `settings`/`realtime` blocks are the author's JSON too. */
  workspaceConfig?: Readonly<Record<string, unknown>>,
): void {
  const objects: Array<[string, unknown]> = Object.entries(sections).flatMap(([key, arr]) =>
    (arr ?? []).map((obj): [string, unknown] => [key, obj]),
  );
  if (workspaceConfig !== undefined) objects.push(["workspace", workspaceConfig]);
  for (const [payloadKey, obj] of objects) {
    if (!obj || typeof obj !== "object") continue;
    const name = (obj as { name?: unknown }).name;
    const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
    for (const stringified of findStringifiedDefaults(obj)) {
      // A warning, not an error: a pulled workspace may hold this text already,
      // and a decode must round-trip what it read. `--strict` fails on it.
      // `[object X]` can only be a cast; a comma join may be one (an array
      // stringifies to it) or text typed that way — the bundle cannot tell.
      const cast = stringified.text.startsWith("[object ");
      bag.warn(
        "field.default-not-text",
        `The \`default\` at ${sdkLocation(obj, stringified.path, owner)} ` +
          (cast
            ? `was stored as ${JSON.stringify(stringified.text)} — a field's default is TEXT (a string, number or boolean), and ` +
              `an object, Map, Set or class instance passed there through a cast is stringified into that. `
            : `is the comma-joined text ${JSON.stringify(stringified.text)}, which is what an array passed through a cast ` +
              `becomes — a field's default is ONE text value (a string, number or boolean), stored as written, even on an ` +
              `\`array: true\` field. If you typed that text, it is stored as-is. `) +
          `For a JSON default, pass its text: \`default: JSON.stringify(value)\`.`,
        obj,
      );
    }
    for (const off of findEnumDefaultsOffList(obj)) {
      bag.warn(
        "field.enum-default-not-a-value",
        `The \`default\` at ${sdkLocation(obj, off.path, owner)} is ${JSON.stringify(off.text)}, which is not ` +
          `one of the enum's values (${off.values.map((v) => JSON.stringify(v)).join(", ")}) — a value no request ` +
          `can send back. Use one of them, or add it to the values.`,
        obj,
      );
    }
    for (const off of findEmailDefaultsMalformed(obj)) {
      bag.warn(
        "field.email-default-invalid",
        `The \`default\` at ${sdkLocation(obj, off.path, owner)} is ${JSON.stringify(off.text)}, which is not an email ` +
          `address — every insert or request that leaves the field out is refused "Invalid email format.". Use an address, or no default.`,
        obj,
      );
    }
    if (payloadKey !== "dbo") {
      for (const off of findInputDefaultsRefused(obj)) {
        bag.warn(
          "field.input-default-invalid",
          `The \`default\` at ${sdkLocation(obj, off.path, owner)} is ${JSON.stringify(off.text)}, which ${off.why} — ` +
            `every request that leaves the input out is refused. Use ${off.want}, or no default.`,
          obj,
        );
      }
    }
    const found = findNonJson(obj);
    if (found === undefined) continue;
    bag.error(
      typeof found.value === "function" ? "bundle.function-value" : "bundle.non-json-value",
      nonJsonMessage(owner, sdkLocation(obj, found.path, owner), found.value),
    );
  }
}

/**
 * Every field `default` that is the stringification of a non-primitive, in
 * source order — `"[object Object]"`, `"[object Map]"`, or an array's `"1,2"`
 * on a `json`, numeric or `array: true` field (a bare comma list is neither valid JSON nor a
 * number, so no real default there spells it). The encoder stores a default as
 * text, so the value that was passed is gone by the time the bundle exists; its
 * fingerprint is not. Found here rather than in the field encoder, which ships
 * in every client bundle.
 */
function findStringifiedDefaults(root: unknown): Array<{ path: string; text: string }> {
  const hits: Array<{ path: string; text: string }> = [];
  walkPaths(root, (node, path) => {
    const value = (node as { default?: unknown }).default;
    const field = node as { type?: unknown; style?: { type?: unknown } };
    if (typeof value === "string" && isStringifiedDefault(value, field.type, field.style?.type === "list")) {
      hits.push({ path: path === "" ? "default" : `${path}.default`, text: value });
    }
  });
  return hits;
}

/** Every enum field whose non-empty `default` is not one of its `values`, in source order. */
function findEnumDefaultsOffList(root: unknown): Array<{ path: string; text: string; values: unknown[] }> {
  const hits: Array<{ path: string; text: string; values: unknown[] }> = [];
  walkPaths(root, (node, path) => {
    const field = node as { type?: unknown; default?: unknown; values?: unknown };
    if (
      field.type === "enum" &&
      Array.isArray(field.values) &&
      typeof field.default === "string" &&
      field.default !== "" &&
      !field.values.some((v) => String(v) === field.default)
    ) {
      hits.push({ path: path === "" ? "default" : `${path}.default`, text: field.default, values: field.values });
    }
  });
  return hits;
}

/** Every `email` field whose non-empty `default` does not read as an address, in source order. */
function findEmailDefaultsMalformed(root: unknown): Array<{ path: string; text: string }> {
  const hits: Array<{ path: string; text: string }> = [];
  walkPaths(root, (node, path) => {
    const field = node as { type?: unknown; default?: unknown };
    if (field.type !== "email" || typeof field.default !== "string") return;
    if (!emailAddress(field.default)) hits.push({ path: path === "" ? "default" : `${path}.default`, text: field.default });
  });
  return hits;
}

/**
 * Every input whose non-empty `default` its own type or methods refuse, in
 * source order. The default goes through the same check a sent value does, so
 * a request that omits the input fails it. Read: an int or decimal default must
 * be numeric text and sit inside its `min`/`max`; a uuid must be one; a text
 * default (trimmed when the input trims) must meet its `min`/`max` length and
 * `startsWith`. Dates, timestamps and json are left alone — their check reads
 * relative dates, rolls an impossible day over and keeps unparsed JSON as text.
 */
function findInputDefaultsRefused(root: unknown): Array<{ path: string; text: string; why: string; want: string }> {
  const hits: Array<{ path: string; text: string; why: string; want: string }> = [];
  walkPaths(root, (node, path) => {
    const field = node as { type?: unknown; default?: unknown; methods?: unknown; style?: { type?: unknown } };
    if (!Array.isArray(field.methods) || field.style?.type === "list") return;
    if (typeof field.default !== "string" && typeof field.default !== "number") return;
    const text = String(field.default);
    if (text === "") return;
    const arg = (name: string): number | string | undefined => {
      const method = (field.methods as Array<{ name?: unknown; disabled?: unknown; arg?: unknown }>).find(
        (m) => m.name === name && m.disabled !== true,
      );
      const first = Array.isArray(method?.arg) ? (method.arg as unknown[])[0] : undefined;
      return typeof first === "number" || typeof first === "string" ? first : undefined;
    };
    const bound = (name: string): number | undefined => {
      const value = arg(name);
      return value === undefined || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value);
    };
    const at = path === "" ? "default" : `${path}.default`;
    const hit = (why: string, want: string) => hits.push({ path: at, text, why, want });
    const [min, max] = [bound("min"), bound("max")];
    if (field.type === "int" || field.type === "decimal") {
      if (!isNumericText(text)) return hit("is not a number", "a number");
      const n = field.type === "int" ? Math.trunc(Number(text)) : Number(text);
      if (min !== undefined && n < min) hit(`is below its \`min\` of ${min}`, `a value of at least ${min}`);
      else if (max !== undefined && n > max) hit(`is above its \`max\` of ${max}`, `a value of at most ${max}`);
    } else if (field.type === "uuid") {
      if (!isUuid(text.trim())) hit("is not a uuid", 'a uuid ("0b2d382e-dd81-4d56-a291-ecf899ca1d33")');
    } else if (field.type === "text") {
      const value = arg("trim") !== undefined || field.methods.some((m: { name?: unknown }) => m.name === "trim") ? phpTrim(text) : text;
      const length = [...value].length;
      const prefix = arg("startsWith");
      if (min !== undefined && length < min) hit(`is shorter than its \`min\` length of ${min}`, `at least ${min} characters`);
      else if (max !== undefined && length > max) hit(`is longer than its \`max\` length of ${max}`, `at most ${max} characters`);
      else if (typeof prefix === "string" && prefix !== "" && !value.startsWith(prefix)) {
        hit(`does not start with its \`startsWith\` ${JSON.stringify(prefix)}`, "a value with that prefix");
      }
    }
  });
  return hits;
}

/**
 * Whether `text` reads as a plain number (sign, digits, optional point and
 * exponent, surrounding whitespace) — the column decimal-default rule. Strict:
 * `Number()` also reads `0x10`/`0b1`, which a numeric input refuses.
 */
function isNumericText(text: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text);
}

/** `text` with the ASCII whitespace and NUL an input's `trim` removes taken off both ends. */
function phpTrim(text: string): string {
  return text.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");
}

/**
 * Visit every object node with its path, in source order — iterative, since a
 * bundle can nest deeper than the call stack, with children pushed in reverse
 * so they pop in order.
 */
function walkPaths(root: unknown, visit: (node: object, path: string) => void): void {
  const stack: Array<[unknown, string]> = [[root, ""]];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const [node, path] = stack.pop()!;
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    visit(node, path);
    const entries = Object.entries(node);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, value] = entries[i]!;
      stack.push([value, Array.isArray(node) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`]);
    }
  }
}

/** `[object X]` anywhere; an array's comma join where the field's type admits no bare comma list. */
function isStringifiedDefault(text: string, type: unknown, list = false): boolean {
  if (/^\[object [A-Za-z]*\]$/.test(text)) return true;
  if (!/^[^[\]{}"]*,[^[\]{}"]*$/.test(text)) return false;
  // A list field of any type: a cast array reaches it as its comma join.
  if (list || type === "int" || type === "decimal") return true;
  if (type !== "json") return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

export function checkReferences(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  workspaceGuid: unknown,
  bag: DiagnosticBag,
): void {
  if (bundleType !== "workspace") return;

  const known = new Set<string>();
  if (typeof workspaceGuid === "string") known.add(workspaceGuid);
  for (const arr of Object.values(sections)) {
    for (const obj of arr ?? []) {
      const guid = (obj as { guid?: unknown })?.guid;
      if (typeof guid === "string") known.add(guid);
    }
  }

  const dangling: DanglingRef[] = [];
  for (const [payloadKey, arr] of Object.entries(sections)) {
    // File-library rows reference nothing; their `canonical` is a content hash
    // that merely has a guid's shape.
    if (payloadKey === "vault") continue;
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      collectDanglingRefs(obj, "$", owner, known, dangling);
    }
  }

  // One diagnostic per distinct target: a single mistyped name referenced from
  // three statements is one thing to fix, not three.
  const byGuid = new Map<string, DanglingRef[]>();
  for (const ref of dangling) {
    const bucket = byGuid.get(ref.guid);
    if (bucket) bucket.push(ref);
    else byGuid.set(ref.guid, [ref]);
  }

  for (const [guid, refs] of byGuid) {
    const owners = [...new Set(refs.map((r) => r.owner))];
    const from =
      owners.length === 1
        ? owners[0]!
        : `${owners.slice(0, 3).join(", ")}${owners.length > 3 ? `, +${owners.length - 3} more` : ""}`;
    // The name this bundle derived the guid from, when something derived it —
    // the author's typo, spelled back to them. A hint, so its absence changes
    // nothing but the wording (see `guidSeedHint`).
    const seed = guidSeedHint(guid);
    const seedKind = seed?.slice(0, seed.indexOf(":"));
    // A toolset is stored under one type for two SDK kinds; the trigger that
    // bound it recorded which (`mcpServer` / `agent`), so the message names the
    // kind the author wrote rather than the stored `toolset`.
    const toolsetField = seedKind === "toolset" ? toolsetTargetField(guid) : undefined;
    const targetKind = toolsetField ?? (seedKind === undefined ? undefined : sdkKindName(seedKind));
    const target = seed
      ? `${targetKind} "${seed.slice(seed.indexOf(":") + 1)}" (guid ${guid})`
      : `an object with guid ${guid}`;
    // The one register call for this target's kind; the generic list only when
    // the kind is not known here (a toolset no trigger here bound).
    const call =
      toolsetField !== undefined
        ? toolsetField === "agent"
          ? "registerAgents"
          : "registerMcpServers"
        : seedKind === undefined
          ? undefined
          : (Object.hasOwn(REGISTER_CALL, seedKind) ? REGISTER_CALL[seedKind] : undefined);
    const registerHint =
      call !== undefined
        ? `\`${call}([…])\``
        : seedKind === "toolset"
          ? `\`registerMcpServers([…])\` or \`registerAgents([…])\``
          : `its register call (\`registerTables([…])\` for a table, \`registerFunctions([…])\` for a function, …)`;
    // Worded by what was passed: a bare name can be a typo, a def handle cannot —
    // it can only be missing from the workspace. Advising "pass the def handle"
    // to someone who did was advice they had already taken.
    const spelling = refSpelling(guid);
    const remedy =
      spelling === "handle"
        ? `The def handle was passed, so the target exists in your code but is not registered on ` +
          `this workspace — add it with ${registerHint} so the bundle carries it. Otherwise the ` +
          `import fails with an invalid-reference error after it has begun.`
        : `A reference by NAME resolves to a guid with no registry lookup, so a mistyped name ` +
          `produces a valid-looking guid that only fails at deploy, with an invalid-reference error ` +
          `naming nothing but that guid, after the import has begun. Check the name for a typo and ` +
          `register the target${call !== undefined ? ` (\`${call}([…])\`)` : ""}` +
          `${spelling === "name" ? "; passing the def handle instead of the name lets a rename never break the reference" : ""}.`;
    bag.error(
      "reference.unresolved",
      `${from} references ${target}, which is not registered on this workspace. ${remedy} ` +
        `Referenced from ${refs[0]!.location}.`,
    );
  }
}

/**
 * A `s.microservice.request` whose `host` was built from a `microservice()` def
 * that is not registered on this workspace. The host binds by NAME, so the
 * guid-based {@link checkReferences} never sees it, and the bundle would call a
 * microservice it does not carry — every request a transport failure. A host
 * written as a string is the unchecked spelling and stays unchecked.
 */
export function checkMicroserviceReferences(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  if (bundleType !== "workspace") return;
  const registered = new Set(
    (sections.microservice ?? []).map((row) => (row as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string"),
  );
  const missing = new Map<string, Set<string>>();
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      for (const st of statements) {
        const target = microserviceHandleName(st);
        if (target === undefined || registered.has(target)) continue;
        const name = (obj as { name?: unknown }).name;
        const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
        const owners = missing.get(target) ?? new Set<string>();
        owners.add(owner);
        missing.set(target, owners);
      }
    }
  }
  for (const [target, owners] of missing) {
    const from = [...owners];
    bag.error(
      "reference.unresolved",
      `${from.slice(0, 3).join(", ")}${from.length > 3 ? `, +${from.length - 3} more` : ""} calls microservice "${target}" ` +
        `(\`s.microservice.request\`), which is not registered on this workspace. The def handle was passed, so the ` +
        `microservice exists in your code — add it with \`registerMicroservices([…])\` so the bundle carries it. ` +
        `Otherwise every call fails at request time with status 0.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Loop control outside a loop
// ---------------------------------------------------------------------------

/** The nullary statements whose meaning depends entirely on their container. */
const LOOP_CONTROL_STATEMENTS = new Map([
  ["mvp:foreach_break", "s.foreach_break()"],
  ["mvp:foreach_continue", "s.foreach_continue()"],
  ["mvp:foreach_remove", "s.foreach_remove()"],
]);

/** What each loop-control statement acts on, for the outside-a-loop message. */
const LOOP_CONTROL_EFFECT = new Map([
  ["mvp:foreach_break", "break out of"],
  ["mvp:foreach_continue", "skip to the next item of"],
  ["mvp:foreach_remove", "remove the current item from"],
]);

/**
 * The statements whose `context.run` IS a loop body.
 *
 * Read off the encoders in `statements/special/loops.ts`: all three store their
 * body under `context.run`, and `mvp:group` — which stores a sub-stack the same
 * way — is deliberately absent, because a group inside a loop is still in the
 * loop and a group outside one establishes nothing.
 */
const LOOP_STATEMENTS = new Set(["mvp:for", "mvp:foreach", "mvp:while"]);

/**
 * Report a loop-control statement that sits outside every loop body.
 *
 * `s.foreach_break()` and its siblings take no arguments and carry no reference
 * to what they break out of, so nothing about the statement itself is wrong —
 * only its position is. That position is invisible where the statement is built
 * and visible here, over the encoded bundle, which is why this is an export
 * pass rather than an authoring guard.
 *
 * An ERROR, not a warning: outside a loop these have no defined engine
 * behaviour, and unlike the warnings around them there is no reading under
 * which an author meant it.
 *
 * The traversal is depth-tracking rather than the flat {@link collectStatements}
 * used by its neighbours — a flat walk cannot tell a break inside a loop from
 * one beside it. Depth rises only when descending a loop's `run`; every other
 * container (a conditional's branches, a group, a try/catch arm) is descended at
 * the SAME depth, so a break nested in a branch inside a loop is correctly silent.
 *
 * Bias: any container this walk does not recognize is descended at the current
 * depth. That direction is safe — an unrecognized substack inside a loop keeps
 * the depth it inherited, so the failure mode is a missed detection rather than
 * an error on valid code.
 *
 * Known false negative, shared with {@link stackReferencesAuth}: a break inside
 * a FUNCTION called from a loop is not seen, because `s.function.run` stores a
 * guid rather than inlining the callee's stack. The callee is walked as its own
 * object from its own root, where the break is genuinely outside a loop — so
 * that case is reported against the function, which is the honest location.
 */
/**
 * A `s.switch` case that omits `break: true` and has somewhere to fall INTO.
 *
 * The engine's default is fallthrough, and nothing else in the toolchain says
 * so: the shape type-checks, the encoder has no opinion, and the bundle imports
 * clean. The failure only appears as duplicated work at runtime — a matched case
 * running the bodies of every case after it, so whatever those bodies write gets
 * written two or three times over.
 *
 * Live-verified on a deployed ephemeral: a three-case switch with no `break`
 * matched on its FIRST case ran all three bodies; matched on its second, the
 * last two. With `break: true` on every case, only the matched body ran. A
 * trailing case also falls into the `default` block — a two-case switch matched
 * on its LAST case ran that body and then `default`.
 *
 * Which is why "has somewhere to fall into" is the condition rather than "is not
 * the last case": a final break-less case is harmless only when there is also no
 * `default`. Reported when there is a later case OR a non-empty default, so a
 * one-case switch with no default — where fallthrough cannot reach anything —
 * stays quiet.
 *
 * A WARNING, not an error: cascading cases is a legitimate (if rare) shape, and
 * the author who means it should not have to work around the guard. `--strict`
 * promotes it, which is the setting an unattended build should be running.
 */
/**
 * Timestamp filters that evaluate only in the REQUEST, used on an operand that
 * is compiled into SQL.
 *
 * A `where` / `additionalWhere` (and the same `search` block on
 * `s.db.bulk.delete` and an `addon`) becomes part of the statement the database
 * runs. Most filters survive that trip — the engine has SQL forms for the string
 * and arithmetic helpers — which is why this guard is NOT "no filters in a
 * where". Live-verified on a deployed ephemeral: `trim`, `concat`, `upper` and
 * `lower` on a search operand all returned 200, and a bare `c.now()` operand has
 * always worked.
 *
 * The timestamp family is the exception, and it splits in two. The SQL-side
 * spellings (`epochms_add_day`, `epochms_sub_month`, `epochms_year`, … — the set
 * {@link isQueryExpressionFilter} knows) compile and return 200. Their
 * request-time counterparts (`epochms_transform`, `epochms_add_ms`,
 * `epochms_add_secs`, `epochms_date`, `epochms_from_format`) have no SQL form,
 * and the engine does not degrade gracefully: the request dies with a bare
 * `ERROR_FATAL` naming nothing. All four of the first names were confirmed live
 * at HTTP 500 against the same table where `epochms_add_day` returned rows.
 *
 * Nothing else in the toolchain sees it — the operand type-checks, and the
 * bundle imports clean — so an author gets a 500 with no line number and no
 * indication that the filter, rather than the predicate, is the problem.
 *
 * Derived from the two catalogs rather than hardcoded, so a timestamp filter
 * added to the runtime catalog later is covered without an edit here.
 *
 * A WARNING rather than an error: the set is derived, and a filter the engine
 * later teaches to compile should not become un-authorable. `--strict` promotes
 * it.
 */
const REQUEST_ONLY_TIME_FILTERS: ReadonlySet<string> = new Set(
  FILTER_NAMES.filter((n) => n.startsWith("epochms_") && !isQueryExpressionFilter(n)),
);

/** Every `{name}` in an operand's `filters[]`, at any nesting depth. */
function operandFilterNames(operand: unknown, out: string[]): void {
  if (!operand || typeof operand !== "object") return;
  const filters = (operand as { filters?: unknown }).filters;
  if (!Array.isArray(filters)) return;
  for (const f of filters) {
    if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string") {
      out.push((f as { name: string }).name);
    }
  }
}

/**
 * A request-only timestamp filter on a search operand: HTTP 500, no diagnostic.
 * See {@link REQUEST_ONLY_TIME_FILTERS}.
 */
export function checkSearchOperandFilters(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  if (REQUEST_ONLY_TIME_FILTERS.size === 0) return;
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      walkNodes(obj, (record) => {
        // Only the SEARCH block compiles to SQL. A `set_var` feeding the same
        // value into the same predicate is the documented workaround, so
        // matching every operand everywhere would flag the fix as the defect.
        const context = record.context as { search?: unknown } | undefined;
        if (!context || typeof context.search !== "object" || context.search === null) return;
        const found: string[] = [];
        walkNodes(context.search as Record<string, unknown>, (node) => {
          const statement = node.statement as { left?: unknown; right?: unknown } | undefined;
          if (!statement || typeof statement !== "object") return;
          operandFilterNames(statement.left, found);
          operandFilterNames(statement.right, found);
        });
        const offending = [...new Set(found)].filter((n) => REQUEST_ONLY_TIME_FILTERS.has(n));
        for (const filter of offending) {
          bag.warn(
            "search.request-only-filter",
            `${owner} pipes a search operand through \`${filter}\`, which evaluates only in the ` +
              `request. A \`where\` is compiled into SQL, where that filter has no form — the ` +
              `endpoint deploys clean and then fails the request with a bare fatal naming ` +
              `nothing. Either use the SQL-side spelling (\`epochms_add_day\`, ` +
              `\`epochms_sub_month\`, and the rest of that family) or compute the value in an ` +
              `earlier \`s.set_var\` and reference it with \`ref()\` in the \`where\`.`,
            obj,
          );
        }
      });
    }
  }
}

export function checkSwitchFallthrough(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      walkNodes(obj, (node) => {
        if (node.name !== "mvp:switch") return;
        const context = node.context as
          | { elif?: { run?: unknown }; else?: { run?: unknown } }
          | undefined;
        const cases = context?.elif?.run;
        if (!Array.isArray(cases)) return;
        const hasDefault = Array.isArray(context?.else?.run) && context.else.run.length > 0;

        cases.forEach((entry, i) => {
          if (!entry || typeof entry !== "object") return;
          const record = entry as Record<string, unknown>;
          // A disabled case does not run, so its `break` cannot matter — the
          // same carve-out the loop-control and middleware guards make.
          if (record.disabled === true) return;
          const caseContext = record.context as { break?: unknown } | undefined;
          if (caseContext?.break === true) return;
          // Nothing after it to fall into: the one shape where omitting `break`
          // is provably harmless.
          const fallsInto = i < cases.length - 1 || hasDefault;
          if (!fallsInto) return;
          const target =
            i < cases.length - 1
              ? `case ${i + 2} of ${cases.length}`
              : "the `default` block";
          bag.warn(
            "switch.missing-break",
            `${owner} has a \`s.switch\` whose case ${i + 1} omits \`break: true\`, so a match ` +
              `there FALLS THROUGH and also runs ${target}. The engine's default is fallthrough, ` +
              `not stop — every statement in the later bodies runs as well, which duplicates ` +
              `whatever they write. Add \`break: true\` to that case. If the cascade IS ` +
              `deliberate, accept it on the def with \`diagnostics: { allow: ["switch.missing-break"] }\`.`,
            obj,
          );
        });
      });
    }
  }
}

/**
 * `s.foreach_break` / `s.foreach_continue` with no enclosing loop. A WARNING:
 * the engine stores and runs the statement, with no defined effect — so a
 * pulled workspace that carries one still builds, and says so.
 */
export function checkLoopControl(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      // The SDK's kind name (`table`, `workflowTest`) — the author wrote
      // `table()`, not the bundle's `dbo` payload key.
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      walkLoopDepth(obj, 0, owner, bag, obj);
    }
  }
}

/**
 * Iterative for the same reason {@link walkNodes} is — the shape
 * being crossed is the author's, and a deep expression tree or a hand-built
 * `raw()` payload made the recursive form die with a bare `RangeError` from
 * inside a guard nobody called. It cannot simply USE `walkNodes`, because the
 * loop depth is per-branch rather than per-node, so each frame carries the depth
 * it was pushed at. Children are pushed in reverse so they pop in source order:
 * the diagnostics are reported in discovery order, and reversing siblings would
 * silently reorder an author's error list.
 */
function walkLoopDepth(root: unknown, rootDepth: number, owner: string, bag: DiagnosticBag, subject: object): void {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: rootDepth }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth });
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const statement = typeof record.name === "string" ? record.name : undefined;

    // A disabled statement does not run, so its position cannot break anything —
    // the same carve-out the middleware attachment guard makes. Parking a
    // statement with `disabled` is a normal editing state, and erroring on one
    // would make the guard fire on code that is switched off.
    const disabled = record.disabled === true;

    if (!disabled && statement !== undefined && LOOP_CONTROL_STATEMENTS.has(statement) && depth === 0) {
      const spelling = LOOP_CONTROL_STATEMENTS.get(statement)!;
      bag.warn(
        "stack.loop-control-outside-loop",
        `${owner} runs \`${spelling}\` outside any loop. Loop control is only defined inside the ` +
          `body of \`s.foreach\`, \`s.for\` or \`s.while\` — with no loop to ${LOOP_CONTROL_EFFECT.get(statement) ?? "act on"}, ` +
          `what it does is undefined rather than a no-op, and nothing reports it at deploy or at ` +
          `request time. Move it into a loop body, or delete it. (A conditional or group ` +
          `INSIDE a loop is still inside the loop; this fires only when no loop encloses it at all.)`,
        subject,
      );
    }

    if (statement !== undefined && LOOP_STATEMENTS.has(statement)) {
      const context = record.context;
      const body = (context as { run?: unknown } | undefined)?.run;
      // Pushed back-to-front, so the pops read own keys, then the rest of
      // `context`, then the body — the order the recursive form visited them.
      //
      // The body is the only part that establishes loop context. The loop's own
      // `list`/`cnt`/`expr` are values, walked at the depth the loop itself sits
      // at, so a break smuggled into one is still reported.
      stack.push({ node: body, depth: depth + 1 });
      if (context && typeof context === "object") {
        const inner = Object.entries(context as Record<string, unknown>);
        for (let i = inner.length - 1; i >= 0; i--) {
          const [key, value] = inner[i]!;
          if (key === "run") continue;
          stack.push({ node: value, depth });
        }
      }
      const own = Object.entries(record);
      for (let i = own.length - 1; i >= 0; i--) {
        const [key, value] = own[i]!;
        if (key === "context") continue;
        stack.push({ node: value, depth });
      }
      continue;
    }

    const values = Object.values(record);
    for (let i = values.length - 1; i >= 0; i--) stack.push({ node: values[i], depth });
  }
}

/**
 * True when a chart's values, once every `${env.NAME}` reference is removed,
 * hold nothing that could be a secret — i.e. the values carry references and
 * YAML structure only. The pattern mirrors the engine's own
 * (`[A-Za-z_][A-Za-z0-9_]*`), so what counts as a reference here is what the
 * engine will actually substitute.
 */
function isOnlyEnvReferences(values: string): boolean {
  const withoutRefs = values.replace(/\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}/g, "");
  // A reference had to be there in the first place, and what surrounds it must
  // be YAML scaffolding: keys, punctuation, whitespace — never a bare literal.
  if (withoutRefs === values) return false;
  return !/[A-Za-z0-9]/.test(withoutRefs.replace(/^[^:]*:/gm, ""));
}

/**
 * Say, at the moment the bytes are written, that a microservice's private-registry
 * credential or Helm values are in this bundle.
 *
 * Both fields are carried VERBATIM, deliberately: dropping them would mean a
 * pulled microservice could not be redeployed. What that costs is that the
 * bundle — and any tree generated from one — holds a live credential. A
 * `process.env.X` read in the workspace source does not help: it resolves at
 * EXPORT time and bakes the literal in, which is the pattern that looks safe and
 * is not.
 *
 * `chart.values` has a real alternative — a `${env.NAME}` reference the engine
 * substitutes at DEPLOY time from the workspace environment — so values built
 * ENTIRELY of references carry no secret and are not reported. Values holding
 * anything else are, and the notice names the reference form. `registryAuth`
 * has no such form; it is not scanned for references.
 *
 * NOTICE, not a warning: shipping a private-registry microservice is a
 * legitimate end state with nothing to fix, and `--strict` must not turn it into
 * a CI failure. The point is that it can never happen silently.
 */
export function checkMicroserviceSecrets(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const rows = sections.microservice;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "(unnamed)";
    const carried: string[] = [];
    const auth = record["registry_auth"] as Record<string, unknown> | undefined;
    if (typeof auth?.["dockerconfigjson"] === "string" && auth["dockerconfigjson"] !== "") {
      carried.push("`registryAuth.dockerconfigjson`");
    }
    const chart = record["chart"] as Record<string, unknown> | undefined;
    const values = chart?.["values"];
    // Values that are nothing BUT `${env.NAME}` references (plus the YAML around
    // them) hold no secret: only the names travel, and the engine substitutes at
    // deploy. Strip the references and see whether anything secret-bearing is
    // left before claiming this bundle carries one.
    if (typeof values === "string" && values !== "" && !isOnlyEnvReferences(values)) {
      carried.push("`chart.values`");
    }
    if (carried.length === 0) continue;
    bag.notice(
      "microservice.secret-in-bundle",
      `microservice "${name}" writes ${carried.join(" and ")} into this bundle verbatim — the ` +
        `engine stores the value as given, so a \`process.env\` read here resolves at export, ` +
        `not on the tenant. Treat the bundle (and any tree pulled from it) as secret material: ` +
        `keep it out of git, or rotate the credential after it lands there. What the engine DOES ` +
        `resolve at deploy is a reference to a workspace env var (\`workspaceConfig({ env })\`): ` +
        `spell it \`fromEnv: "NAME"\` on a container env entry, or \`\${env.NAME}\` inside ` +
        `\`chart.values\` — only the name travels. \`registryAuth\` has no such form.`,
    );
  }
}

/**
 * The two microservice blocks the AUTHORING SURFACE must stop recommending, and
 * the one-off notice that says the surface is early.
 *
 * `configs` and `volumes` are typed, autocomplete beside fields that work, and
 * type-check — and a workspace carrying either is rejected when it is imported,
 * after provisioning has begun. A type that compiles and then fatals at deploy
 * is a recommendation the SDK cannot honor, so the refusal moves to the one
 * place it can still be acted on: the build.
 *
 * ERROR, not a warning: there is no reading under which the shape ships. Both
 * blocks stay typed and keep round-tripping — a pulled workspace that somehow
 * holds one must still decode to something, and a `@deprecated` marker on the
 * field is what an author sees before ever reaching this — but an export
 * carrying a populated one does not produce a bundle.
 *
 * The workaround is named because it exists at container level: a value the
 * workload reads is a container `env` entry, and storage is a container
 * `volumes` entry (`emptyDir`/`persistent`/`config`). Neither is a full
 * replacement — a shared secret and a claim outliving the pod are exactly what
 * the microservice-level blocks are for — but they are what deploys today.
 */
export function checkMicroserviceBlocks(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const rows = sections.microservice;
  if (!Array.isArray(rows) || rows.length === 0) return;

  // One notice for the workspace, not one per microservice: the surface is
  // early as a whole, and repeating it per row would train people to skim it.
  // NOTICE for the same reason the secret report is one — nothing here is
  // wrong, and `--strict` must not turn "declared a microservice" into a CI
  // failure. The docs said this before; they said it where it is read BEFORE
  // writing, which is not where the author is when it matters.
  bag.notice(
    "microservice.early-surface",
    `this workspace declares ${rows.length === 1 ? "a microservice" : `${rows.length} microservices`} — ` +
      `an EARLY platform surface whose stored shape is expected to change. What deploys today is a ` +
      `\`builtin\` microservice's \`deployment\`/\`ingresses\` and a \`helm\` one's \`chart\`; ` +
      `\`configs\`/\`volumes\` are refused at export because the engine rejects an import carrying ` +
      `them. Pin \`@xano/sdk\` for reproducible builds and re-read the microservice section on upgrade.`,
  );

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "(unnamed)";
    const populated = (["configs", "volumes"] as const).filter((key) => {
      const value = record[key];
      return Array.isArray(value) && value.length > 0;
    });
    if (populated.length === 0) continue;
    const fields = populated.map((key) => `\`${key}\``).join(" and ");
    const workaround = populated
      .map((key) =>
        key === "configs"
          ? "a value the workload reads goes in a container's `env` (`deployment.containers[].env`)"
          : "storage goes in a container's own `volumes` (`emptyDir`, `persistent`, or `config`)",
      )
      .join("; ");
    bag.error(
      "microservice.unsupported-block",
      `microservice "${name}" declares ${fields}, which the engine refuses on import — the ` +
        `workspace fatals mid-deploy, after provisioning has begun. Refused here instead, where ` +
        `nothing has been created yet. Workaround: ${workaround}. Both fields are typed and ` +
        `\`@deprecated\` because a pulled workspace can still carry them; neither can be deployed ` +
        `by this SDK today.`,
    );
  }
}

/**
 * The `workspace run` statement family, by statement name → the factory an
 * author writes. Every one of these resolves its target out of the engine's
 * runtime registry rather than inlining the callee, which is what makes where
 * they can appear a real question (see {@link RUNS_OUTSIDE_A_WORKFLOW_TEST}).
 *
 * `s.function.run` (`mvp:function`) is deliberately NOT here — it is the
 * ordinary way to invoke a function from any stack and is unaffected.
 */
const RUN_FAMILY: Readonly<Record<string, string>> = {
  "mvp:workspace_run_function": "s.function.call",
  "mvp:workspace_run_tool": "s.tool.call",
  "mvp:workspace_run_middleware": "s.middleware.call",
  "mvp:workspace_run_endpoint": "s.api.call",
  "mvp:workspace_run_task": "s.task.call",
  "mvp:workspace_run_trigger": "s.trigger.call",
  "mvp:workspace_run_workflow_test": "s.workflow_test.call",
  "mvp:workspace_run_addon": "s.addon.call",
};

/**
 * The members that execute from an ORDINARY stack — an endpoint, a function, a
 * task, a tool, anything that is not a workflow test.
 *
 * The split is not a guess and it is not per-host-kind. Each of these statements
 * resolves `"<type>:<id>"` out of the runtime object registry, and what that
 * registry holds is decided by the ENTRYPOINT that is executing — these four
 * types are registered for an API request, a scheduled task, an async function
 * and a deferred function alike, so the answer does not change with the kind of
 * object the statement is written in (verified: the same `s.api.call` fails
 * identically from a query and from a function that query runs).
 *
 * A workflow test is the exception: it executes through the runner, which loads
 * the whole workspace first, so every member resolves there.
 */
const RUNS_OUTSIDE_A_WORKFLOW_TEST = new Set([
  "mvp:workspace_run_function",
  "mvp:workspace_run_tool",
  "mvp:workspace_run_middleware",
  "mvp:workspace_run_addon",
]);

/** `a, b and c` / `a, b or c` — a prose list, for the remediation text below. */
function proseList(parts: readonly string[], conjunction: "and" | "or"): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} ${conjunction} ${parts[parts.length - 1]}`;
}

/**
 * The remediation prose, DERIVED from the set rather than restated beside it.
 *
 * Both halves were once written out by hand and both drifted: the registry list
 * and the factory list each dropped `addon`, so the guard named three of the
 * four members that actually work and sent authors away from a legal one. The
 * set is the single source of truth for what runs where, so the sentence that
 * describes it is built from the set.
 */
const ORDINARY_STACK_FACTORY_LIST: readonly string[] = [...RUNS_OUTSIDE_A_WORKFLOW_TEST]
  .map((name) => (Object.hasOwn(RUN_FAMILY, name) ? RUN_FAMILY[name] : undefined))
  .filter((factory): factory is string => factory !== undefined)
  .sort();

/** `functions, tools, middleware and addons` — the registry's contents, in prose. */
const ORDINARY_STACK_TYPES = proseList(
  ORDINARY_STACK_FACTORY_LIST.map((factory) => {
    const type = factory.slice("s.".length, factory.lastIndexOf(".call"));
    return type === "middleware" ? type : `${type}s`;
  }),
  "and",
);

/**
 * The same set as factory names, with `s.function.run` folded in — it is not a
 * family member (it is the ordinary invocation) but it is the first thing an
 * author reaching for `s.function.call` from a plain stack actually wants.
 */
const ORDINARY_STACK_FACTORIES = proseList(
  ["s.function.run", ...ORDINARY_STACK_FACTORY_LIST].sort().map((factory) => `\`${factory}\``),
  "or",
);

/**
 * A workflow test, or a saved unit test on a query/function/middleware, run
 * against the `"live"` datasource — see {@link liveDatasourceMessage}. Raised
 * here rather than while encoding, so the owning def's `diagnostics.allow` is
 * counted like every other def's.
 *
 * Deliberately narrow: warning on EVERY non-empty datasource would fire on
 * legitimate fixture datasources and train the warning away. `"live"` is the
 * value that reliably means production. It is only ever a warning — `"live"` is
 * a workspace-renameable label, so the SDK has no standing to refuse it.
 */
export function checkLiveDatasourceTests(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const test of sections.workflow_test ?? []) {
    if (!test || typeof test !== "object") continue;
    const record = test as Record<string, unknown>;
    if (typeof record.datasource !== "string" || !isLiveDatasource(record.datasource)) continue;
    bag.warn(
      "workflow-test.live-datasource",
      // The shared text, plus the allow form this def takes.
      liveDatasourceMessage(`workflowTest "${typeof record.name === "string" ? record.name : "?"}"`) +
        ' Intended? `diagnostics: { allow: ["workflow-test.live-datasource"] }` on it accepts it.',
      record,
    );
  }
  for (const [payloadKey, arr] of Object.entries(sections)) {
    if (payloadKey === "workflow_test") continue;
    for (const obj of arr ?? []) {
      const record = obj as Record<string, unknown> | null;
      if (!record || typeof record !== "object" || !Array.isArray(record.test)) continue;
      const live = (record.test as Array<{ name?: unknown; datasource?: unknown }>).filter(
        (t) => typeof t?.datasource === "string" && isLiveDatasource(t.datasource),
      );
      for (const t of live) {
        bag.warn(
          "test.live-datasource",
          liveDatasourceMessage(`${sdkSubject(payloadKey, record)} test "${typeof t.name === "string" ? t.name : "?"}"`) +
            ' Intended? `diagnostics: { allow: ["test.live-datasource"] }` on the def accepts it.',
          record,
        );
      }
    }
  }
}

/**
 * A `workspace run` statement in a stack that cannot run it.
 *
 * This is a Xano SDK CONTRACT rule, not the "engine currently rejects this" guard
 * the header warns against. The `Run …` family is Xano's testing surface — the
 * builder files every member of it, and the `expect` assertions, under one
 * `test` category — and Xano SDK scopes it accordingly: a workflow test may run
 * anything, and any other stack may only run what actually executes there. The
 * rule is what is being asserted; the live behaviour below is why it is worth
 * asserting rather than what it is derived from.
 *
 * What the author gets today without this: a bundle that exports, imports and
 * deploys clean, and then answers the first real request with a fatal
 * `ERROR_FATAL: <Type> does not exist: <type>:<n>` naming an internal id. The
 * same stack passes from the builder — whose runner registers the whole
 * workspace — so the failure appears only in production, on a step that was
 * tested and looked fine.
 */
export function checkRunFamilyHosts(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    // A workflow test runs through the runner, which loads the whole workspace
    // before executing — every member of the family resolves there.
    if (payloadKey === "workflow_test") continue;

    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const objName = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof objName === "string" ? objName : "?"}"`;

      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);

      // One diagnostic per distinct statement per object: three `s.task.call`s
      // in one function is one thing to go move, not three.
      const found = new Set(
        statements
          .map((s) => s.name)
          .filter((name) => Object.hasOwn(RUN_FAMILY, name) && !RUNS_OUTSIDE_A_WORKFLOW_TEST.has(name)),
      );

      for (const name of found) {
        const factory = (Object.hasOwn(RUN_FAMILY, name) ? RUN_FAMILY[name] : undefined);
        bag.error(
          "statement.run-family-host",
          `${owner} contains \`${factory}\`, which only runs inside a workflow test. ` +
            `Outside one the engine resolves this step against a registry holding only ` +
            `${ORDINARY_STACK_TYPES}, so it deploys clean, passes from the builder ` +
            `(whose runner loads the whole workspace), and then fails the first real request ` +
            `with \`ERROR_FATAL: … does not exist\`. Move it into a \`workflowTest({ … })\`, ` +
            `where the whole family is available. From an ordinary stack use ` +
            `${ORDINARY_STACK_FACTORIES}.`,
        );
      }
    }
  }
}

/**
 * An `s.expect.*` assertion in a stack that is not a workflow test's.
 *
 * It is not inert there: a failing assertion raises and aborts the stack, so a
 * query answers HTTP 500 with the assertion's message, and a function or task
 * fails its caller. A warning — a passing assertion does nothing — that
 * `--strict` fails on. A unit test's own expectations (`tests:`) are not in the
 * stack and are not read here.
 */
export function checkAssertionsOutsideTests(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    if (payloadKey === "workflow_test") continue;
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const run = (obj as { run?: unknown }).run;
      if (!Array.isArray(run)) continue;
      const statements: EncodedStatement[] = [];
      collectStatements(run, statements);
      const found = [
        ...new Set(
          statements
            .filter((st) => (st as { disabled?: unknown }).disabled !== true && st.name.startsWith("mvp:test_expect_"))
            .map((st) => `s.expect.${st.name.slice("mvp:test_expect_".length)}`),
        ),
      ];
      if (found.length === 0) continue;
      bag.warn(
        "stack.expect-outside-test",
        `${sdkSubject(payloadKey, obj as Record<string, unknown>)} runs ${proseList(found.map((f) => `\`${f}\``), "and")} in its ` +
          `stack. An assertion is not inert outside a workflow test: a failing one aborts the stack, so the ` +
          `request fails (HTTP 500 with the assertion's message). Move it into a \`workflowTest({ … })\` that ` +
          `calls this object, or check the value with \`s.precondition\` if the stack should refuse it.`,
        obj,
      );
    }
  }
}

/**
 * Characters the platform accepts in a knowledge name: letters, digits, and
 * ``/ _ - { } . `` plus space.
 *
 * This is an ERROR because of how the platform fails, which is worse than a
 * refusal. Measured against a live instance: an import carrying a name with
 * `:`, `,` or `#` returns SUCCESS and the record is simply never created. The
 * deploy reports a clean run, the workspace comes up, and the agent silently
 * has no instructions — with nothing anywhere saying why. A build-time error
 * naming the offending character is the only place that failure is visible.
 */
const KNOWLEDGE_NAME_OK = /^[A-Za-z0-9/_\-{}. ]+$/;
const KNOWLEDGE_NAME_MAX = 200;

/**
 * Knowledge authoring mistakes, at the point the author can still act on them.
 *
 * The split between error and warning is the usual one: an ERROR is a shape the
 * platform refuses (so the deploy would fail anyway, just later and with a worse
 * message), a WARNING is a shape that deploys clean and then does less than the
 * author expected.
 *
 * `resolved` says whether knowledge bodies were read off disk for this export.
 * A plain browser-safe `export()` carries empty bodies by design, so the
 * empty-body check would fire on every item and mean nothing.
 *
 * NOT checked, deliberately: a `:` or a quote in a description. Both were
 * suspected of breaking the markdown frontmatter the platform writes on its
 * git-sync path, and both were measured round-tripping verbatim — a flat parser
 * splitting on the FIRST colon keeps everything after it. Guarding them would
 * have blocked descriptions that deploy perfectly. A NEWLINE is the one that
 * genuinely cannot survive a line-oriented parser, so that is what is warned on.
 */
export function checkKnowledge(
  sections: Partial<Record<string, unknown[]>>,
  bag: DiagnosticBag,
  opts: { resolved: boolean },
): void {
  const items = (sections.knowledge ?? []) as Array<Record<string, unknown>>;
  if (items.length === 0) return;
  // No body was read, so there is none to judge — and an allow naming it is not stale.
  if (!opts.resolved) bag.skipped("knowledge.empty-body");

  const agentsMd = items.filter((i) => i.knowledge_type === "agents.md");
  if (agentsMd.length > 1) {
    bag.error(
      "knowledge.multiple-agents-md",
      `A workspace can have at most one \`type: "agents.md"\` knowledge item, and this one ` +
        `declares ${agentsMd.length}: ${agentsMd.map((i) => `"${i.name as string}"`).join(", ")}. ` +
        `AGENTS.md is the workspace's standing instructions — merge them into one item, or make ` +
        `the others \`type: "skill"\`.`,
    );
  }

  for (const item of items) {
    const name = String(item.name ?? "");
    const label = `knowledge "${name}"`;

    if (name.length > KNOWLEDGE_NAME_MAX) {
      bag.error(
        "knowledge.name-too-long",
        `${label}: name is ${name.length} characters; the platform accepts at most ` +
          `${KNOWLEDGE_NAME_MAX}.`,
      );
    } else if (!KNOWLEDGE_NAME_OK.test(name)) {
      const bad = [...new Set([...name].filter((c) => !KNOWLEDGE_NAME_OK.test(c)))];
      bag.error(
        "knowledge.name-charset",
        `${label}: name contains ${bad.map((c) => JSON.stringify(c)).join(", ")}. The platform ` +
          `accepts the deploy and then silently DROPS the item — the agent ends up with no such ` +
          `knowledge and nothing reports an error. Names may use ASCII letters (no accented ones), digits, and ` +
          `\`/ _ - { } . \` or a space.`,
      );
    }

    // Ignored at runtime rather than rejected, so this is a misunderstanding to
    // surface, not a build to fail: an AGENTS.md is injected in full every turn
    // whatever `mode` says.
    if (item.knowledge_type === "agents.md" && item.mode !== "auto") {
      bag.warn(
        "knowledge.agents-md-mode",
        `${label}: \`mode: "${item.mode as string}"\` has no effect on an \`agents.md\` item — ` +
          `its body is injected in full on every turn regardless. Drop \`mode\`, or make this a ` +
          `\`skill\` if you wanted the item loaded on demand.`,
        item,
      );
    }

    for (const [field, value] of [
      ["name", name],
      ["description", String(item.description ?? "")],
    ] as const) {
      if (value.includes("\n")) {
        bag.warn(
          "knowledge.newline",
          `${label}: \`${field}\` contains a newline. It deploys, but the platform writes these ` +
            `into a line-oriented markdown header when a workspace is synced to files, and a ` +
            `newline does not survive that round trip.`,
          item,
        );
      }
    }

    if (opts.resolved) {
      if (String(item.content ?? "").trim() === "") {
        bag.warn(
          "knowledge.empty-body",
          `${label}: the markdown body is empty. An enabled item still occupies a slot in the ` +
            `agent's menu and contributes nothing when loaded.`,
          item,
        );
      }
    }
  }
}

/**
 * A tool that reads `auth()` behind an entry that names no auth table.
 *
 * A toolset entry's `auth` is not only an access gate — it is what gives the
 * tool's stack a CALLER. Without it the stack runs public, and `auth()` there
 * does not resolve to null: the tool call comes back as a NORMAL result whose
 * body is `{"code":"ERROR_FATAL","message":""}`. No throw, no HTTP error, no
 * empty message to read. The model receives what looks like a successful tool
 * result and reports success to the user, while nothing the tool was supposed
 * to write was written.
 *
 * Verified on a live instance (`scripts/probe-tool-auth.ts`), against one MCP
 * server whose three tools differ only in their entry:
 *
 * | entry | credential | result |
 * |---|---|---|
 * | none, no `auth()` | none | `{"ok":"pong"}` — the control |
 * | none, reads `auth()` | none | `{"code":"ERROR_FATAL","message":""}` |
 * | none, reads `auth()` | a valid caller token | `{"code":"ERROR_FATAL","message":""}` |
 * | names the auth table | none | `ERROR_CODE_UNAUTHORIZED` |
 * | names the auth table | a valid caller token | `{"id":1}` |
 *
 * The agent path was run separately — one stored shape does not prove one
 * runtime. A model calling the same bare-entry tool received that fatal as a
 * tool-RESULT, finished the step with `finishReason: "tool-calls"`, and answered
 * the user from it. That is the reported symptom exactly: a confident reply
 * about work that never happened.
 *
 * Two things that table settles. A caller token does NOT rescue a bare entry —
 * the entry is the only thing that supplies identity, so this is not a
 * "the client forgot to authenticate" problem an integrator can fix from the
 * outside. And the gated tool refuses cleanly when unauthenticated, which is why
 * naming the table is the whole fix.
 *
 * The same family as `Xano.validateMiddlewareAuth`: a stack that reads the
 * caller, mounted somewhere with no caller to read.
 *
 * WARNS rather than throws: a tool may legitimately read `auth()` inside a
 * `try_catch`, and an entry authored as a raw `id` against an engine-side
 * toolset has no def here to inspect. The shape is also reachable by pulling a
 * workspace that already contains it, which must stay round-trippable.
 */
export function checkToolAuthIdentity(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const tools = sections.tool ?? [];
  if (tools.length === 0) return;
  // Tools are addressed from an entry by the guid the reference resolved to.
  const byGuid = new Map<string, Record<string, unknown>>();
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const guid = (t as { guid?: unknown }).guid;
    if (typeof guid === "string" && guid !== "") byGuid.set(guid, t as Record<string, unknown>);
  }

  for (const obj of sections.toolset ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const set = obj as { name?: unknown; type?: unknown; tool?: unknown };
    if (!Array.isArray(set.tool)) continue;
    const setName = typeof set.name === "string" ? set.name : "?";
    // `agent` and `mcp` are one stored object; the message names which one the
    // author wrote, because the fix is spelled in that factory's `tools`.
    const kind = set.type === "agent" ? "agent" : "mcp server";
    for (const entry of set.tool) {
      if (!entry || typeof entry !== "object") continue;
      const ref = entry as { id?: unknown; auth?: unknown; enabled?: unknown };
      // A disabled entry is not exposed, so it has no failure mode to warn
      // about — and an author who turned one off does not need telling why the
      // thing they turned off would not have worked.
      if (ref.enabled === false) continue;
      // `false` is the only "no auth table" the encoder writes; a guid, a raw
      // `dbo.id`, or anything else names one.
      if (ref.auth !== false) continue;
      if (typeof ref.id !== "string" || ref.id === "") continue;
      const tool = byGuid.get(ref.id);
      if (tool === undefined) continue;
      if (!readsAuth(tool)) continue;
      const toolName = typeof tool.name === "string" ? tool.name : "?";
      bag.warn(
        "toolset.tool-reads-auth-ungated",
        `${kind} "${setName}": tool "${toolName}" reads \`auth()\`, but its entry names no auth ` +
          `table, so the tool runs with no caller. \`auth()\` there does not return null — the ` +
          `call answers a normal result carrying \`{"code":"ERROR_FATAL","message":""}\`, so the ` +
          `model reads a successful tool result and reports success while nothing is written. A ` +
          `caller token does not rescue it; the entry is the gate. Wrap the entry with the auth ` +
          `table: \`{ tool: <the ${toolName} handle>, auth: <auth table> }\`.`,
        obj,
      );
    }
  }
}

/**
 * An MCP server `prompts`/`resources` entry naming no auth table, whose prompt
 * or resource reads `auth()` — the prompt/resource half of
 * {@link checkToolAuthIdentity}.
 *
 * The failure differs from a tool's and is loud rather than silent: measured on
 * a live engine, every `prompts/get` / `resources/read` of such a target answers
 * a JSON-RPC error, `-32603 "Access Denied"`, while the same server's prompts
 * that read no caller keep working. The export still succeeds, so this names
 * the fix before the first call does. Warns, like the tool guard, because an
 * entry authored as a raw `id` has no def here to inspect and a pulled
 * workspace can already hold the shape.
 */
export function checkPrimitiveAuthIdentity(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const kind of ["prompt", "resource"] as const) {
    const byGuid = new Map<string, Record<string, unknown>>();
    for (const obj of sections[kind] ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const guid = (obj as { guid?: unknown }).guid;
      if (typeof guid === "string" && guid !== "") byGuid.set(guid, obj as Record<string, unknown>);
    }
    if (byGuid.size === 0) continue;
    const call = kind === "prompt" ? "prompts/get" : "resources/read";
    for (const set of sections.toolset ?? []) {
      if (!set || typeof set !== "object") continue;
      const { name, [kind]: entries } = set as Record<string, unknown>;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const ref = entry as { id?: unknown; auth?: unknown; enabled?: unknown } | null;
        if (!ref || ref.enabled === false || ref.auth !== false || typeof ref.id !== "string") continue;
        const target = byGuid.get(ref.id);
        if (target === undefined || !readsAuth(target)) continue;
        const targetName = typeof target.name === "string" ? target.name : "?";
        bag.warn(
          "toolset.primitive-reads-auth-ungated",
          `mcpServer "${typeof name === "string" ? name : "?"}": ${kind} "${targetName}" reads \`auth()\`, but ` +
            `its entry names no auth table, so it runs with no caller and every \`${call}\` answers ` +
            `\`-32603 "Access Denied"\`. The entry is what supplies the caller — wrap it with the auth ` +
            `table: \`{ ${kind}: <the ${targetName} handle>, auth: <auth table> }\`.`,
          set,
        );
      }
    }
  }
}

/**
 * An `auth()`-keyed `s.redis.ratelimit` written DIRECTLY in the stack of a host
 * with no caller identity — a query with no auth table, or a task. The same
 * failure `Xano.validateMiddlewareAuth` reports for an attached middleware: the
 * key cannot resolve, so the first call 403s under `max` and the host never
 * runs. Warns, never throws — a branch the host never takes fails nothing.
 */
export function checkStackAuthRatelimit(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const hosts: Array<[string, string, string]> = [
    ["query", "this endpoint has no auth table", "key off sys.remoteIp(), or name an auth table on the query"],
    ["task", "a task is scheduled/background and never has a request identity", "key it off a fixed value"],
  ];
  for (const [kind, reason, remedy] of hosts) {
    for (const obj of sections[kind] ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const host = obj as { name?: unknown; auth?: unknown; run?: unknown };
      if (kind === "query" && host.auth) continue;
      let hit = false;
      walkNodes(host.run, (record) => {
        if (record.name === "mvp:redis_ratelimit" && readsAuth(record)) hit = true;
      });
      if (!hit) continue;
      bag.warn(
        "stack.auth-null-host",
        `${kind} "${String(host.name)}": an \`s.redis.ratelimit\` in its stack keys off auth(), where ` +
          `${reason}. auth() cannot resolve there and the request FAILS (403) rather than degrading ` +
          `to a shared key — ${remedy}.`,
        obj,
      );
    }
  }
}

/**
 * Does anything in host `root` other than statement `except` read stack
 * variable `name` — a `ref` value or condition operand (`ok`, `ok.x`), or
 * `$var.ok` inside expression or lambda source? The readers are every other
 * statement plus the host's response (`result`).
 */
function statementsRead(root: unknown, name: string, except: object): boolean {
  const statements: object[] = [];
  collectStatements(root, statements as EncodedStatement[]);
  const result = (root as { result?: unknown } | null)?.result;
  if (result && typeof result === "object") statements.push(result);
  const source = new RegExp(`\\$var\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
  const named = (v: unknown) => typeof v === "string" && (v === name || v.startsWith(`${name}.`));
  return statements.some((st) => {
    if (st === except) return false;
    let hit = false;
    walkNodes(st, (record) => {
      if (hit) return;
      if (record.tag === "var" && (named(record.value) || named(record.operand))) hit = true;
      else if (Object.values(record).some((v) => typeof v === "string" && source.test(v))) hit = true;
    });
    return hit;
  });
}

/**
 * An `s.redis.ratelimit` with no `error`. The engine throws (HTTP 429) only
 * when the limit is hit AND `error` is set; without it the statement binds
 * `false` to its `as` and the request carries on — a limiter that never limits.
 * Measured live: calls over `max` answered 200. Binding the boolean and
 * branching on it, or returning it, is a legitimate use, so a bound limiter
 * whose variable any other statement or the response reads is left alone.
 */
export function checkRatelimitWithoutError(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [kind, objs] of Object.entries(sections)) {
    for (const obj of objs ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const bound: string[] = [];
      let unbound = false;
      walkNodes(obj, (record) => {
        if (record.name !== "mvp:redis_ratelimit" || !Array.isArray(record.input)) return;
        const error = (record.input as { name?: unknown; value?: unknown; tag?: unknown }[]).find((e) => e?.name === "error");
        const set = error !== undefined && !(error.tag === "const" && (error.value === "" || error.value === undefined));
        if (set) return;
        if (typeof record.as === "string" && record.as !== "") {
          if (!statementsRead(obj, record.as, record)) bound.push(record.as);
        } else unbound = true;
      });
      if (bound.length === 0 && !unbound) continue;
      const binds =
        bound.length > 0
          ? `only binds \`false\` to ${bound.map((a) => `"${a}"`).join(", ")} and the request carries on`
          : "binds nothing (no `as`) and the request carries on";
      bag.warn(
        "redis.ratelimit-no-error",
        `${kind} "${String((obj as { name?: unknown }).name)}": an \`s.redis.ratelimit\` has no \`error\`, so it never ` +
          `stops a request — over \`max\` it ${binds}. Pass \`error: c.text("Too many requests.")\` to answer ` +
          `429 once the limit is hit, or branch on the bound value.`,
        obj,
      );
    }
  }
}

/**
 * `auth()` read DIRECTLY in the stack of a host that never has a caller: a query
 * with no auth table, a task, or a realtime server/channel lifecycle trigger
 * (join/leave, connect/disconnect — a gate establishes no auth, so `auth("id")`
 * reads 0 even for an authenticated client). It deploys clean and reads empty on
 * every run, so an ownership check keyed on it silently matches nothing — or
 * everyone. Functions are never flagged: one inherits its caller's identity. A
 * `deliver` trigger runs per recipient and is left alone, as is a host whose only
 * read is an `s.redis.ratelimit` key (`stack.auth-null-host` names that one).
 */
export function checkAuthNoCaller(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const RT = "read the client's identity from `t.client(\"permissions.row_id\")` or `s.realtime.get_session`";
  const hosts: Array<[string, string, string]> = [
    ["query", "it names no auth table, so no caller is ever resolved", "name an auth table on the query (`auth: <table>`)"],
    ["task", "a task runs on a schedule with no caller", "carry the user id in the data the task reads"],
    ["trigger", "a realtime lifecycle trigger establishes no auth (it reads 0)", RT],
  ];
  for (const [kind, reason, remedy] of hosts) {
    for (const obj of sections[kind] ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const host = obj as { name?: unknown; auth?: unknown; obj_type?: unknown; meta?: unknown };
      if (kind === "query" && host.auth) continue;
      if (kind === "trigger") {
        const t = host.obj_type;
        const deliver = (host.meta as { channel?: { action?: { deliver?: unknown } } } | undefined)?.channel?.action
          ?.deliver;
        if (!(t === "realtime_server" || (t === "channel" && deliver !== true))) continue;
      }
      let ratelimit = false;
      walkNodes(host, (record) => {
        if (record.name === "mvp:redis_ratelimit" && readsAuth(record)) ratelimit = true;
      });
      if (ratelimit || !readsAuth(host)) continue;
      bag.warn(
        "stack.auth-no-caller",
        `${kind} "${String(host.name)}" reads \`auth()\`, but ${reason}: it deploys clean and never ` +
          `holds the caller's identity. Fix: ${remedy}.`,
        obj,
      );
    }
  }
}

/** Does any value in this tool's encoded body reference `auth()`? */
function readsAuth(tool: Record<string, unknown>): boolean {
  let found = false;
  walkNodes(tool, (record) => {
    if (record.tag !== "auth") return;
    // `tag` is not a unique marker: a tool's own TAGS encode as `[{tag: "auth"}]`,
    // so `tags: ["auth"]` would otherwise read as a caller reference. A VALUE
    // carries the path with it, spelled `value` ordinarily and `operand` in a
    // comparison — an `if`/`while` condition, a `precondition`, a `where`, an
    // `array.*` predicate — which is where half of them sit (see
    // {@link collectVarRefs}).
    if (typeof record.value === "string" || typeof record.operand === "string") found = true;
  });
  return found;
}

// --- documentation gate ------------------------------------------------------

/**
 * A documentation token spelled out in source.
 *
 * ERROR, not a warning, and deliberately not deprecated. The project's guard
 * convention keeps a shape at warning severity when it has a legitimate use the
 * author may mean; once the sidecar carries the value, a literal token has none
 * — declaring the gate covers every case, and the literal form's only
 * distinguishing property is that it commits a secret. The SDK has no installed
 * base to
 * grandfather, so the clean shape wins over a compatible one. The convention's
 * other note applies too: this SDK's main audience is an agent that never reads
 * stderr, so an advisory would not land.
 *
 * Both scopes, not just the reported one. Fixing the workspace token while an
 * API group's kept leaking would ship a half-closed hole under a security-fix
 * headline.
 */
export function checkDocumentationTokens(
  workspace: Readonly<Record<string, unknown>>,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  remedy: SecretsRemedy = SCAFFOLD_SECRETS_REMEDY,
): void {
  const report = (scope: DocumentationScope, file: string): void => {
    bag.error(
      "documentation.literal-token",
      `${documentationScopeLabel(scope)} spells a documentation token literally in ` +
        `${file}. That value is a secret and this is committed source. Declare only the gate — ` +
        `\`documentation: { require_token: true }\` — and let the value live in ` +
        `\`${remedy.file}\`, which is gitignored: \`xanosdk pull\` writes it there, and ` +
        `every build reads it back. To supply it by hand instead, pass ` +
        `\`${supplyTokenRemedy(remedy, scope.kind === "workspace" ? "workspace" : scope.name)}\`. If ` +
        `this token has already been committed, treat it as disclosed and rotate it in Xano.`,
    );
  };

  if (documentationTokenLiteral(workspace.documentation) !== undefined) {
    report({ kind: "workspace" }, "`workspaceConfig({ documentation })`");
  }
  for (const group of sections.app ?? []) {
    if (!group || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    if (documentationTokenLiteral(record.documentation) === undefined) continue;
    const scope = apiGroupScope(record);
    report(scope, `\`apiGroup({ name: "${scope.name}", documentation })\``);
  }
}

/**
 * Whether a string reads as a credential: a known provider key prefix, or a
 * long unbroken run of key characters mixing letters and digits. A Twig
 * placeholder (`{{ $env.NAME }}`), a masked value and prose never match.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.includes("{{") || /\s/.test(value)) return false;
  if (/^(sk-|sk_|xai-|gsk_|AIza|ghp_|github_pat_|xox[bpa]-)[A-Za-z0-9_-]{8,}/.test(value)) return true;
  return value.length >= 32 && /^[A-Za-z0-9_\-.]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * An agent whose `llm.apiKey` spells a provider key literally. The def is
 * committed source, so the key ships to everyone who can read the repository —
 * refused, as a literal documentation token is. The value belongs in the
 * workspace env, read back with a placeholder.
 */
export function checkAgentApiKeys(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const obj of sections.toolset ?? []) {
    const t = (obj ?? {}) as { name?: unknown; type?: unknown; agent_settings?: { type?: unknown; configs?: unknown } };
    if (t.type !== "agent") continue;
    const settings = t.agent_settings;
    const provider = typeof settings?.type === "string" ? settings.type : "";
    const config = (settings?.configs as Record<string, { apiKey?: unknown } | undefined> | undefined)?.[provider];
    const key = config?.apiKey;
    if (typeof key !== "string" || !looksLikeSecret(key)) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    const envName = `${provider.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
    bag.error(
      "agent.literal-api-key",
      `agent "${name}" spells its \`llm.apiKey\` literally. That value is a secret and this is committed ` +
        `source. Read it from the workspace env instead: \`apiKey: "{{ $env.${envName} }}"\`, with ` +
        `\`${envName}\` declared in \`workspaceConfig({ env })\` and its value in \`xano/.env\`. ` +
        `If this key has already been committed, treat it as disclosed and rotate it.`,
      obj as object,
    );
  }
}

/**
 * API groups whose documentation this deploy leaves publicly readable.
 *
 * Reports the OUTCOME, not a downgrade. A downgrade needs the target's prior
 * state, which a deploy never reads; the resulting state is already fully
 * determined by the bundle, so the question is answerable offline — which is
 * what keeps this guard in the same family as every other one here.
 *
 * WARNING, not an error: public API documentation is frequently the intent,
 * unlike the literal token above, which has no legitimate use once the by-name
 * form exists. `--strict` promotes it, which is the answer for CI.
 *
 * ONE aggregated line naming the groups, not one per group. A public API has
 * many such groups, and a guard that fires ten times a build is one nobody
 * reads.
 *
 * The condition is the engine's own: a group's `swagger` publishes its docs, and
 * `require_token` gates them only alongside a non-empty token — `require_token`
 * with an empty token is no gate at all. This runs after documentation tokens
 * are resolved, so a name that resolved to a real value reads as gated and one
 * that resolved to nothing reads as what it will be.
 */
export function checkApiGroupDocsExposure(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
  declaredButUnresolved: ReadonlySet<string> = new Set(),
  remedy: SecretsRemedy = SCAFFOLD_SECRETS_REMEDY,
): void {
  const open: string[] = [];
  const openGroups: object[] = [];
  const broken: string[] = [];
  for (const group of sections.app ?? []) {
    if (!group || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    if (record.swagger !== true) continue;
    const doc = record.documentation as Record<string, unknown> | undefined;
    const token = typeof doc?.token === "string" ? doc.token : "";
    if (doc?.require_token === true && token !== "") continue;
    const name = typeof record.name === "string" ? record.name : "(unnamed)";
    // An author who DECLARED a token by name and is shipping ungated anyway is
    // not exercising a legitimate choice — their stated intent is being
    // inverted. That is the one case here that is not a warning.
    if (declaredButUnresolved.has(name)) broken.push(name);
    // Accepted per group: public docs are a live setting, not a defect.
    else if (!bag.isAccepted("api-group.docs-public", () => `apiGroup "${name}" publishes its documentation with no token gate.`, record)) {
      open.push(name);
      openGroups.push(record);
    }
  }
  if (broken.length > 0) {
    const one = broken.length === 1;
    bag.error(
      "api-group.docs-gate-unresolved",
      `${broken.length} API group${one ? "" : "s"} declare${one ? "s" : ""} a documentation gate ` +
        `(\`require_token: true\`), but no token was supplied for it — ${safeNames(broken)}.\n` +
        `Omitting a group's \`documentation\` block does NOT leave the target alone the way the ` +
        `workspace's does: an absent key on a group is written as the engine default on import, so ` +
        `these bytes would CLEAR that group's gate and publish every endpoint, input and response ` +
        `shape in it.\n` +
        `There is no safe bundle to write here, which is why this fails rather than warns — a bundle ` +
        `FILE carries no source for a later \`deploy --bundle\` to refuse on. Run \`${remedy.fill}\` ` +
        `to mint the value into \`${remedy.file}\` for a gate declared in code (\`xanosdk pull\` ` +
        `stores a live backend's existing one there instead), pass it with ` +
        `\`${supplyTokenRemedy(remedy, one ? broken[0]! : "<group name>")}\`, or — if opening ` +
        `${one ? "that group" : "those groups"} is what you meant — ` +
        `\`${allowEmptyTokenRemedy(remedy, one ? broken[0]! : "<group name>")}\`.`,
    );
  }
  if (open.length === 0) return;
  const one = open.length === 1;
  bag.warn(
    "api-group.docs-public",
    `after this deploy, ${open.length} API group${one ? "'s" : "s'"} documentation will be ` +
      `PUBLICLY READABLE — ${safeNames(open)}. ${one ? "It publishes" : "They publish"} docs ` +
      `(\`swagger: true\`) with no token gate, so anyone with the URL can read every endpoint, ` +
      `input and response shape in ${one ? "it" : "them"}. If that is intended, accept it with ` +
      `\`diagnostics: { allow: ["api-group.docs-public"] }\` on the group (or on the workspaceConfig, for every group). ` +
      `To gate ${one ? "it" : "them"}, set \`documentation: { require_token: true }\` on the group ` +
      `and run \`${remedy.fill}\` to mint its token into \`${remedy.file}\`; to stop ` +
      `publishing, set \`swagger: false\`. Note that \`require_token\` without a token value is ` +
      `not a gate.`,
    // One group is the def it is about; several leave it the export's.
    openGroups.length === 1 ? openGroups[0] : undefined,
  );
}

/** Stored statements that write, for the write-before-elicit warning (`api.request` is decided by its method). */
const ELICIT_WRITES: Readonly<Record<string, string>> = {
  "mvp:dbo_add": "s.db.add",
  "mvp:dbo_addoreditby": "s.db.add_or_edit",
  "mvp:dbo_editby": "s.db.edit",
  "mvp:dbo_patch": "s.db.patch",
  "mvp:dbo_delby": "s.db.del",
  "mvp:dbo_truncate": "s.db.truncate",
  "mvp:dbo_increment": "s.db.increment",
  "mvp:dbo_bulkadd": "s.db.bulk.add",
  "mvp:dbo_bulkdelete": "s.db.bulk.delete",
  "mvp:dbo_bulkpatch": "s.db.bulk.patch",
  "mvp:dbo_bulkupdate": "s.db.bulk.update",
  "mvp:dbo_direct_query": "s.db.direct_query",
  "mvp:dbo_external_mssql_query": "s.db.external.mssql.direct_query",
  "mvp:dbo_external_mysql_query": "s.db.external.mysql.direct_query",
  "mvp:dbo_external_oracle_query": "s.db.external.oracle.direct_query",
  "mvp:dbo_external_postgres_query": "s.db.external.postgres.direct_query",
  "mvp:dbo_external_snowflake_query": "s.db.external.snowflake.direct_query",
  "mvp:send_email": "s.util.send_email",
  // Conservative: what a called function or tool does is not visible from here.
  // (`s.api.call` is left out: it runs only in a workflow test, which never elicits.)
  "mvp:function": "s.function.run",
  "mvp:workspace_run_function": "s.function.call",
  "mvp:workspace_run_tool": "s.tool.call",
};

/** The `s.` factory of a write statement, or undefined when the statement does not write. */
function elicitWrite(statement: EncodedStatement): string | undefined {
  if (statement.name === "mvp:api_request") {
    // A plain literal GET/HEAD reads; any other method — or one computed or
    // filtered at run time — may write.
    const method = statementInput(statement, "method") as { tag?: unknown; value?: unknown; filters?: unknown } | undefined;
    if (method === undefined) return undefined;
    const plain = method.tag === "const" && (!Array.isArray(method.filters) || method.filters.length === 0);
    const verb = typeof method.value === "string" ? method.value.toUpperCase() : "";
    return plain && (verb === "GET" || verb === "HEAD") ? undefined : "s.api.request";
  }
  return Object.hasOwn(ELICIT_WRITES, statement.name) ? ELICIT_WRITES[statement.name] : undefined;
}

/**
 * A write that runs BEFORE an `s.mcp.elicit` in the same stack.
 *
 * When the client answers an elicit, the platform runs the WHOLE stack again
 * from the top, with the elicit returning the answer. So every write before it
 * runs once per round trip: a row added and then confirmed is added twice.
 * Each elicit is checked against the writes since the previous one — the ones
 * before an earlier elicit were already reported there. Statements are read in
 * source order, nested blocks included. Warns: a write that is idempotent, or
 * one the author wants repeated, is legitimate — accepted on the def with
 * `diagnostics: { allow: ["mcp.write-before-elicit"] }`.
 */
export function checkWriteBeforeElicit(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements((obj as { run?: unknown }).run, statements);
      if (!statements.some((st) => st.name === "mvp:mcp_elicit")) continue;
      const objName = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown; obj_type?: unknown })} "${typeof objName === "string" ? objName : "?"}"`;
      let writes: string[] = [];
      for (const st of statements) {
        if (st.name === "mvp:mcp_elicit") {
          if (writes.length > 0) {
            const key = statementInput(st, "key")?.value;
            bag.warn(
              "mcp.write-before-elicit",
              `${owner}: ${proseList([...new Set(writes)].map((w) => `\`${w}\``), "and")} runs before ` +
                `\`s.mcp.elicit\`${typeof key === "string" && key !== "" ? ` "${key}"` : ""}. When the client answers, ` +
                `the whole stack runs again from the top, so that write runs once per round trip (a row ` +
                `added before a confirmation is added twice). Ask first, then act: move the elicit above ` +
                `the write. If the write is idempotent or meant to repeat, accept it with ` +
                `\`diagnostics: { allow: ["mcp.write-before-elicit"] }\`.`,
              obj,
            );
          }
          writes = [];
          continue;
        }
        const write = elicitWrite(st);
        if (write !== undefined) writes.push(write);
      }
    }
  }
}

/** The hosts an `s.mcp.elicit` can never reach a client from: no MCP call runs them. */
const NO_MCP_CALLER: ReadonlySet<string> = new Set(["query", "task"]);

/**
 * The MCP shapes that deploy clean and then fail every call:
 *
 * - a `prompt` with no `response` and no top-level `s.return` — every
 *   `prompts/get` fails, since a prompt's messages ARE its answer;
 * - two `s.mcp.elicit` with the same literal `key` that can both run in one
 *   call (not exclusive `s.conditional` branches), or one inside a loop — the
 *   key is how the re-run finds an answer, so a repeat reads the first's;
 * - an `s.mcp.elicit` in a query or task stack — no MCP client is there to ask.
 *
 * Warnings, not errors: a pulled workspace can carry any of them, and it has to
 * round-trip.
 */
export function checkMcpStackHazards(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const p of sections.prompt ?? []) {
    if (!p || typeof p !== "object") continue;
    const result = (p as { result?: unknown }).result;
    if (Array.isArray(result) && result.length > 0) continue;
    // A top-level `s.return` answers `prompts/get` with its value (measured live).
    const run = (p as { run?: unknown }).run;
    if (Array.isArray(run) && run.some((st) => (st as { name?: unknown; disabled?: unknown } | null)?.name === "mvp:return" && (st as { disabled?: unknown }).disabled !== true)) continue;
    bag.warn(
      "mcp.prompt-no-response",
      `${sdkSubject("prompt", p as Record<string, unknown>)} has no \`response\` and no top-level \`s.return\`, so every ` +
        `\`prompts/get\` of it fails: a prompt's messages are its answer. Return a text value (\`response: c.text("…")\`) ` +
        `or a list of \`{ role, content }\` messages (\`response: ref("messages")\`).`,
      p,
    );
  }
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const statements: EncodedStatement[] = [];
      collectStatements((obj as { run?: unknown }).run, statements);
      const elicits = statements.filter((st) => st.name === "mvp:mcp_elicit");
      if (elicits.length === 0) continue;
      const owner = sdkSubject(payloadKey, obj as Record<string, unknown>);
      if (NO_MCP_CALLER.has(payloadKey)) {
        bag.warn(
          "mcp.elicit-outside-mcp",
          `${owner}: \`s.mcp.elicit\` runs in a ${sdkKindName(payloadKey)} stack, which no MCP client calls, so ` +
            `there is nobody to ask and it answers \`{ action: "cancel" }\` every time. Elicit from a tool, prompt ` +
            `or resource stack.`,
          obj,
        );
      }
      const byKey = new Map<string, PlacedElicit[]>();
      for (const placed of placedElicits((obj as { run?: unknown }).run)) {
        const key = statementInput(placed.statement, "key") as { tag?: unknown; value?: unknown; filters?: unknown } | undefined;
        if (key?.tag !== "const" || typeof key.value !== "string") continue;
        if (Array.isArray(key.filters) && key.filters.length > 0) continue;
        byKey.set(key.value, [...(byKey.get(key.value) ?? []), placed]);
      }
      const repeated: string[] = [];
      const looped: string[] = [];
      for (const [key, list] of byKey) {
        if (list.some((p) => p.inLoop)) looped.push(key);
        else if (list.some((a, i) => list.slice(i + 1).some((b) => !exclusiveBranches(a, b)))) repeated.push(key);
      }
      const keys = (list: string[]) => proseList(list.map((k) => `"${k}"`), "and");
      if (repeated.length > 0) {
        bag.warn(
          "mcp.elicit-duplicate-key",
          `${owner}: ${keys(repeated)} ${repeated.length === 1 ? "is the `key` of" : "are each the `key` of"} ` +
            `more than one \`s.mcp.elicit\` that can run in one call. The key is how the re-run after an answer ` +
            `finds that answer, so the later elicit reads the earlier one's and never asks. Give each elicit its own key.`,
          obj,
        );
      }
      if (looped.length > 0) {
        bag.warn(
          "mcp.elicit-duplicate-key",
          `${owner}: the \`s.mcp.elicit\` keyed ${keys(looped)} runs inside a loop, so every pass after the first ` +
            `reads the first pass's answer by that key and never asks. Elicit once before the loop, or build the ` +
            `key from the loop variable.`,
          obj,
        );
      }
    }
  }
}

/** An `s.mcp.elicit`, with the conditional branches that lead to it and whether a loop repeats it. */
interface PlacedElicit {
  readonly statement: EncodedStatement;
  /** `[conditional, branch]` pairs from the stack's top down. */
  readonly branches: ReadonlyArray<readonly [object, number]>;
  readonly inLoop: boolean;
}

/** Every enabled elicit in `run`, placed by the `s.conditional` branches above it. */
function placedElicits(run: unknown): PlacedElicit[] {
  const out: PlacedElicit[] = [];
  const visit = (node: unknown, branches: ReadonlyArray<readonly [object, number]>, inLoop: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, branches, inLoop);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.startsWith("mvp:") ? record.name : undefined;
    if (name === undefined) {
      for (const value of Object.values(record)) visit(value, branches, inLoop);
      return;
    }
    if (record.disabled === true) return;
    if (name === "mvp:mcp_elicit") {
      out.push({ statement: record as unknown as EncodedStatement, branches, inLoop });
      return;
    }
    const context = (record.context ?? {}) as { if?: { run?: unknown }; elif?: { run?: unknown }; else?: { run?: unknown } };
    if (name === "mvp:conditional") {
      visit(context.if?.run, [...branches, [record, 0]], inLoop);
      const elifs = Array.isArray(context.elif?.run) ? context.elif.run : [];
      elifs.forEach((elif, i) => {
        if ((elif as { disabled?: unknown })?.disabled === true) return;
        visit((elif as { context?: { if?: { run?: unknown } } })?.context?.if?.run, [...branches, [record, i + 1]], inLoop);
      });
      visit(context.else?.run, [...branches, [record, -1]], inLoop);
      return;
    }
    visit(Object.values(record), branches, inLoop || LOOP_STATEMENTS.has(name));
  };
  visit(run, [], false);
  return out;
}

/** Whether two elicits sit in different branches of one `s.conditional`, so no call runs both. */
function exclusiveBranches(a: PlacedElicit, b: PlacedElicit): boolean {
  return a.branches.some(([node, branch]) => b.branches.some(([other, theirs]) => other === node && theirs !== branch));
}

/**
 * Two resources with the same `uri` on one MCP server.
 *
 * A client addresses a resource by its URI, so the second one is unreachable,
 * and the platform refuses the push. An ERROR, because the deploy fails anyway —
 * this names the server and both resources.
 */
export function checkMcpResourceUris(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const byGuid = new Map<string, { name: string; uri: string }>();
  for (const r of sections.resource ?? []) {
    if (!r || typeof r !== "object") continue;
    const { guid, name, uri } = r as { guid?: unknown; name?: unknown; uri?: unknown };
    if (typeof guid === "string" && typeof uri === "string") byGuid.set(guid, { name: String(name ?? "?"), uri });
  }
  for (const set of sections.toolset ?? []) {
    if (!set || typeof set !== "object") continue;
    const { name, resource } = set as { name?: unknown; resource?: unknown };
    if (!Array.isArray(resource)) continue;
    const seen = new Map<string, string>();
    for (const entry of resource) {
      // The platform refuses a duplicate only among ENABLED references.
      if ((entry as { enabled?: unknown })?.enabled === false) continue;
      const id = (entry as { id?: unknown })?.id;
      const target = typeof id === "string" ? byGuid.get(id) : undefined;
      if (target === undefined) continue;
      const first = seen.get(target.uri);
      if (first !== undefined) {
        bag.error(
          "mcp.resource-uri-duplicate",
          `mcpServer "${String(name ?? "?")}": resources "${first}" and "${target.name}" share the uri ` +
            `"${target.uri}". A client reads a resource BY its uri, so one of them could never be read, and ` +
            `the platform refuses the push. Give each resource on a server its own uri.`,
        );
        continue;
      }
      seen.set(target.uri, target.name);
    }
  }
}

/**
 * `guard.role` on a table passed by NAME: the role column and the role values
 * are checked here, once the name resolves to a registered table — a handle is
 * checked when the guard is built. Read off the three steps the guard emits: a
 * row fetched by `auth("id")`, its existence check, then a precondition
 * comparing `<as>.<field>` with the roles (`=` one, or a list filtered by `in`). An unknown column fails every request;
 * a role outside an enum column's values denies every caller.
 */
export function checkGuardRoleColumns(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  tables: readonly TableDef[],
  bag: DiagnosticBag,
): void {
  const byGuid = new Map<string, TableDef>();
  for (const entry of sections.dbo ?? []) {
    const e = entry as { guid?: unknown; name?: unknown };
    const def = tables.find((t) => t.name === e.name);
    if (typeof e.guid === "string" && def !== undefined) byGuid.set(e.guid, def);
  }
  if (byGuid.size === 0) return;
  for (const [kind, objs] of Object.entries(sections)) {
    if (kind === "dbo") continue;
    for (const host of objs ?? []) {
      const statements: EncodedStatement[] = [];
      collectStatements(host, statements);
      // Only the exact three steps `guard.role` emits are judged: an addon-free
      // fetch of the caller's row, its existence check, then the role check. A
      // hand-written precondition on the same row may read an addon's alias.
      for (let i = 0; i + 2 < statements.length; i++) {
        const st = statements[i]!;
        if (st.name !== "mvp:dbo_getby" || typeof st.as !== "string" || st.as === "") continue;
        const addons = (st as { addon?: unknown }).addon;
        if (Array.isArray(addons) && addons.length > 0) continue;
        const value = statementInput(st, "field_value");
        const guid = statementTableGuid(st);
        const def = guid !== undefined ? byGuid.get(guid) : undefined;
        if (def === undefined || value?.tag !== "auth" || value.value !== "id") continue;
        if (!isFoundCheck(statements[i + 1]!, st.as)) continue;
        const roleStep = statements[i + 2]!;
        if (roleStep.name !== "mvp:precondition") continue;
        const check = roleCheckOf(roleStep);
        if (check === undefined) continue;
        const dot = check.path.indexOf(".");
        if (check.path.slice(0, dot) !== st.as) continue;
        const field = check.path.slice(dot + 1);
        const problem = roleColumnProblem(def, field, check.roles, field !== "role");
        if (problem !== undefined) bag.error("guard.role-unsatisfiable", problem, host as object);
      }
    }
  }
}

/** Whether `st` is the guards' existence step on `as` (`<as> != null`). */
function isFoundCheck(st: EncodedStatement, as: string): boolean {
  if (st.name !== "mvp:precondition") return false;
  const expression = (st.context as { expr?: { expression?: unknown } } | undefined)?.expr?.expression;
  if (!Array.isArray(expression) || expression.length !== 1) return false;
  const cmp = (expression[0] as { statement?: { op?: unknown; left?: { tag?: unknown; operand?: unknown }; right?: { tag?: unknown } } }).statement;
  return cmp?.op === "!=" && cmp.left?.tag === "var" && cmp.left.operand === as && cmp.right?.tag === "const:null";
}

/** The `<as>.<field>` path and role values of a `guard.role` precondition, or undefined. */
function roleCheckOf(st: EncodedStatement): { path: string; roles: string[] } | undefined {
  const expression = (st.context as { expr?: { expression?: unknown } } | undefined)?.expr?.expression;
  if (!Array.isArray(expression) || expression.length !== 1) return undefined;
  const cmp = (expression[0] as { statement?: { op?: unknown; left?: Operand; right?: Operand } }).statement;
  type Operand = { tag?: unknown; operand?: unknown; filters?: Array<{ name?: unknown; arg?: Array<{ tag?: unknown; value?: unknown }> }> };
  if (cmp?.op !== "=" || cmp.left === undefined || cmp.right === undefined) return undefined;
  const { left, right } = cmp;
  const dotted = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(v);
  if (left.tag === "var" && dotted(left.operand) && (left.filters ?? []).length === 0 && right.tag === "const" && typeof right.operand === "string") {
    return { path: left.operand, roles: [right.operand] };
  }
  const filter = left.filters?.length === 1 ? left.filters[0] : undefined;
  const arg = filter?.arg?.length === 1 ? filter.arg[0] : undefined;
  if (left.tag === "const:array" && filter?.name === "in" && arg?.tag === "var" && dotted(arg.value) && right.tag === "const:bool" && right.operand === "true") {
    try {
      const roles = JSON.parse(String(left.operand)) as unknown;
      if (Array.isArray(roles) && roles.every((r) => typeof r === "string")) return { path: arg.value, roles };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A tool whose `output` schema its own literal `response` record cannot meet:
 * a required output key the record never sets, or a record key a near spelling
 * of a declared key the record leaves unset (`verison` for `version`). A result
 * missing a required key fails the client's output validation on every call;
 * extra keys are allowed, so a key next to the declared one it resembles
 * (`carriers` beside `carrier`) or its plural (`ids` for `id`) is not judged. A
 * computed response is not judged.
 */
export function checkToolOutputSchema(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.tool ?? []) {
    const t = (obj ?? {}) as { name?: unknown; output_schema?: unknown; result?: unknown };
    if (!Array.isArray(t.output_schema) || t.output_schema.length === 0) continue;
    if (!Array.isArray(t.result) || t.result.length === 0) continue;
    const keys = (t.result as Array<{ name?: unknown }>).map((e) => e?.name);
    if (keys.some((k) => typeof k !== "string" || k === "")) continue;
    const declared = (t.output_schema as Array<{ name?: unknown; required?: unknown }>).filter((f) => typeof f?.name === "string");
    const names = declared.map((f) => f.name as string);
    const missing = declared.filter((f) => f.required === true && !keys.includes(f.name)).map((f) => f.name as string);
    const unset = names.filter((n) => !keys.includes(n));
    const misspelt = (keys as string[])
      .filter((k) => !names.includes(k))
      .map((k) => [k, nearestKey(k, unset)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
      // `ids` beside `id` is a second word, not a misspelling of the first.
      .filter(([k, near]) => k !== `${near}s` && near !== `${k}s`);
    if (missing.length === 0 && misspelt.length === 0) continue;
    const parts = [
      ...(missing.length > 0 ? [`never sets the required output ${missing.length === 1 ? "key" : "keys"} ${missing.map((m) => `\`${m}\``).join(", ")}`] : []),
      ...misspelt.map(([k, near]) => `sets \`${k}\` (did you mean \`${near}\`)`),
    ];
    bag.warn(
      "tool.output-mismatch",
      `tool "${String(t.name)}": its \`response\` ${parts.join("; ")}. The \`output\` schema declares ` +
        `${names.map((n) => `\`${n}\``).join(", ")}` +
        (missing.length > 0 ? `, and a result missing a required key fails the client's output check on every call` : `, which the response leaves unset`) +
        `. Return the keys \`output\` declares, or change \`output\`.`,
      obj as object,
    );
  }
}

/**
 * The top-level keys of an object-literal expression (`{ doc_id: $input.d,
 * "x": 1 }`), or undefined when it is not a plain literal — a spread, a
 * computed key, or anything but `{ … }`.
 */
function objectLiteralKeys(text: string): string[] | undefined {
  const src = text.trim();
  if (!src.startsWith("{") || !src.endsWith("}")) return undefined;
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      let close = i + 1;
      while (close < src.length && src[close] !== ch) close += src[close] === "\\" ? 2 : 1;
      if (close >= src.length) return undefined;
      if (depth === 1 && expectKey) {
        keys.push(src.slice(i + 1, close).replace(/\\(.)/g, "$1"));
        expectKey = false;
      }
      i = close;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ",") expectKey = true;
    else if (expectKey && /\S/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(src.slice(i));
      if (!m) return undefined;
      keys.push(m[0]);
      i += m[0].length - 1;
      expectKey = false;
    }
  }
  return keys;
}

/**
 * An agent prompt reading `{{ $args.x }}` that an `s.ai.agent.run` of it never
 * passes, when the run's `args` is a literal whose keys are known. The
 * placeholder resolves to nothing on that run, so the agent is prompted without
 * the value — usually a near spelling (`docid` for `doc_id`), which is named.
 */
export function checkAgentArgPlaceholders(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const reads = new Map<string, { name: string; keys: Set<string> }>();
  for (const ts of sections.toolset ?? []) {
    const t = (ts ?? {}) as { guid?: unknown; name?: unknown };
    if (typeof t.guid !== "string") continue;
    const keys = new Set<string>();
    // Only the agent's settings are rendered as a template (prompts, model,
    // provider config); `description`/`docs` are text for people.
    const settings = (ts as { agent_settings?: unknown }).agent_settings;
    if (settings !== null && typeof settings === "object") {
      walkNodes(settings, (record) => {
        for (const v of Object.values(record)) {
          if (typeof v !== "string") continue;
          for (const key of unguardedArgPlaceholders(v)) keys.add(key);
        }
      });
    }
    if (keys.size > 0) reads.set(t.guid, { name: String(t.name), keys });
  }
  if (reads.size === 0) return;
  for (const [kind, objs] of Object.entries(sections)) {
    if (kind === "toolset") continue;
    for (const host of objs ?? []) {
      const statements: EncodedStatement[] = [];
      collectStatements(host, statements);
      for (const st of statements) {
        if (st.name !== "mvp:call_agent") continue;
        const id = (st.context as { toolset?: { id?: unknown } } | undefined)?.toolset?.id;
        const agent = typeof id === "string" ? reads.get(id) : undefined;
        const args = statementInput(st, "args");
        if (agent === undefined || args === undefined || typeof args.value !== "string") continue;
        if (args.tag !== "const:expr2" && args.tag !== "const:obj") continue;
        if (Array.isArray((args as { filters?: unknown }).filters) && ((args as { filters: unknown[] }).filters.length > 0)) continue;
        const passed = args.tag === "const:obj" ? jsonObjectKeys(args.value) : objectLiteralKeys(args.value);
        if (passed === undefined) continue;
        for (const key of agent.keys) {
          if (passed.includes(key)) continue;
          const near = nearestKey(key, passed) ?? passed.find((p) => p.replace(/_/g, "").toLowerCase() === key.toLowerCase());
          const ident = /^[A-Za-z_]\w*$/.test(key);
          const access = ident ? `.${key}` : `['${key}']`;
          bag.warn(
            "agent.args-placeholder-unpassed",
            `${sdkKindName(kind, host as { type?: unknown })} "${String((host as { name?: unknown }).name)}": ` +
              `\`s.ai.agent.run\` of agent "${agent.name}" passes args ${passed.length > 0 ? passed.map((p) => `\`${p}\``).join(", ") : "(none)"}, ` +
              `but the agent's prompt reads \`{{ $args${access} }}\`, which this run never passes, so it resolves to nothing.` +
              (near !== undefined
                ? ` Did you mean \`${near}\`? Rename the arg or the placeholder so they match.`
                : ident
                  ? ` Pass \`${key}\` in \`args\`.`
                  : ` \`args\` keys must be identifiers, except in a constant \`c.obj({ "${key}": … })\`; otherwise rename the placeholder to an identifier.`),
            host as object,
          );
        }
      }
    }
  }
}

/** The top-level keys of a JSON object string, or undefined. */
function jsonObjectKeys(text: string): string[] | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : undefined;
  } catch {
    return undefined;
  }
}
