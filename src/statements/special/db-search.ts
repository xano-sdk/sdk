/**
 * Shared db-search authoring primitives — the `where`/`sort` surface used by
 * both `s.db.query` (`./db.ts`) and a table-bound `addon()`
 * (`../../kinds/addon.ts`). Extracted here so the addon kind can reuse the exact
 * same builders without importing `db.ts` (which imports the addon kind — a
 * cycle).
 *
 * The boolean-expression algebra (`cmp`/`and`/`or`, the node types, the tree
 * walk) lives in {@link ../expression.js}; this module keeps the db-specific
 * pieces — `where`/`additionalWhere` merge, sort, eval — and supplies the
 * filter-rejecting operand encoder to the shared walk.
 */
import type { Value } from "../../values/value.js";
import type { QueryFilterName } from "../../values/query-filters.js";
import type { QueryFilterResults } from "../../values/generated/query-filters.generated.js";
import type { Prettify } from "../../fields/value-types.js";
import type { QualifiedCol } from "./output-select.js";
import { describeEntry } from "../args.js";
import {
  type SearchNode,
  isValue,
  isGroup,
  isMixed,
  isCmpNode,
  encodeExpression,
} from "../expression.js";

// Re-export the shared algebra so existing `db-search.js` importers (incl. the
// public `index.ts` surface) keep resolving from here.
export { cmp, and, or, mixed } from "../expression.js";
export type {
  SearchOp,
  SearchComparison,
  SearchGroup,
  SearchNode,
  MixedGroup,
  MixedTerm,
} from "../expression.js";

/** Sort direction for a {@link SortDirective} — the engine's `orderBy` values. */
export type SortDir = "asc" | "desc" | "rand";

/**
 * One sort directive: order the returned rows by `sortBy`, ascending, descending,
 * or random. `dir` maps to the engine's `orderBy`; the encoded element is the
 * `mvp_sort` shape `{ sortBy, orderBy }`. Each caller places that element
 * differently — `db.query` under `context.return.list.sort` (via
 * the engine's context-to-config conversion), an `addon()` at top-level `context.sort` — so
 * this doc stays placement-neutral; see each caller's own doc for where it lands.
 */
export interface SortDirective<C extends string = string> {
  /**
   * The column to sort by, or a dotted path qualifying one — a joined table's
   * column (its `bind` alias), or the bound table's own `tableAlias`
   * (`"comments.id"`), which is the form Xano's editor writes. A column of the
   * bound table is BARE unless the query sets `tableAlias`; see
   * {@link QualifiedCol}.
   */
  sortBy: QualifiedCol<C>;
  /** Direction (`"asc"` | `"desc"` | `"rand"`); defaults to ascending. */
  dir?: SortDir;
}

/**
 * A `db.query`/addon filter. Author it as a comparison (or several, ANDed) with
 * `expr(col("status"), "=", c.text("published"))` or, for the full operator set,
 * `cmp(col("tags"), "overlaps", inp("t"))`. Compose nested boolean logic with
 * `and(...)` / `or(...)`. A raw `Value` stays the escape hatch for a pre-built
 * clause. Encoded into the engine's operand-based `{expression:[…]}` search shape.
 */
export type DbWhere = Value | SearchNode | SearchNode[];

/**
 * Constant tags that can never be a pre-built search clause.
 *
 * The raw-`Value` `where` is a deliberate escape hatch — `inp("clause")` or
 * `ref("built_where")` hands the engine a search expression assembled earlier —
 * and this guard exists to keep that hatch while closing the case it was never
 * for. A FIXED literal is not a clause under any reading: `where: c.bool(true)`
 * is an author reaching for "match every row", and what they get is a
 * `context.search` the engine reads as garbage.
 *
 * A narrow deny-list rather than "every tag starting with const", because
 * several constant tags ARE legitimate here and the cost of wrongly refusing
 * valid code is higher than the cost of missing one more spelling of the bug:
 *
 *   • `const` (text) is how a hand-written clause is spelled —
 *     `where: c.text("id > 0")` is the escape hatch's own worked example.
 *   • `const:expr` / `const:expr2` carry an expression STRING the engine's
 *     parser evaluates; `c.expression(...)` and `obj({...})` both emit one.
 *   • `const:obj` / `const:array` could carry a hand-built search STRUCTURE,
 *     and there is no evidence here that they cannot.
 *
 * What is left is the set that cannot be a clause under any reading: a bare
 * scalar literal. That covers the reported bug — `where: c.bool(true)`, an
 * author reaching for "match every row" and getting a `context.search` the
 * engine reads as garbage. An unlisted tag stays allowed by design.
 */
const CONSTANT_WHERE_TAGS = new Set([
  "const:bool",
  "const:int",
  "const:decimal",
  "const:null",
  "const:epochms",
]);

/**
 * Encode `where` (+ an optional `additionalWhere`) into the single
 * `context.search` the engine reads (`mvp_search` = `{ expression: [...] }`).
 * Comparison clauses from both args concatenate into one `expression[]`, ANDed
 * (`or:false`) — the engine has exactly one `search`, so there is no separate
 * `additional_where`. A raw `Value` (escape hatch) passes through as
 * `context.search` directly, but cannot be combined with comparison clauses.
 */
export function encodeSearch(where?: DbWhere, additionalWhere?: DbWhere, owner = "db search"): unknown {
  const nodes: SearchNode[] = [];
  let raw: unknown;
  for (const [field, w] of [["where", where], ["additionalWhere", additionalWhere]] as const) {
    if (!w) continue;
    if (Array.isArray(w)) {
      // Each entry is a clause: `[null]` reached a property read deep in the
      // expression encoder and reported `reading 'right'`.
      (w as unknown[]).forEach((entry, i) => {
        if (!(isGroup(entry as never) || isMixed(entry as never) || isCmpNode(entry as never))) {
          throw new Error(
            `${owner}: \`${field}[${i}]\` must be an expr(...)/cmp(...) comparison or an and()/or() group — got ${describeEntry(entry)}.`,
          );
        }
      });
      nodes.push(...w);
    }
    else if (isGroup(w) || isMixed(w) || isCmpNode(w)) nodes.push(w);
    else if (isValue(w)) {
      if (CONSTANT_WHERE_TAGS.has(w.tag)) {
        throw new Error(
          `${owner}: \`${field}\` is the constant ${w.tag}:${JSON.stringify(w.value)}, which cannot ` +
            `be a search clause — a fixed literal states no condition, and the engine reads the ` +
            `resulting \`context.search\` as neither a predicate nor an absent one. To match ` +
            `EVERY row, omit \`${field}\` entirely (an empty search is how "no filter" is spelled). ` +
            `To filter, use expr(col("x"), "=", …), cmp(...), or an and()/or() group. The raw ` +
            `Value form is the escape hatch for a clause built elsewhere — inp("clause"), ` +
            `ref("built_where"), or an expression value — not for a literal.`,
        );
      }
      raw = w;
    } else {
      // Not comparison/group-shaped and not a tagged `Value` — a malformed `where`
      // (e.g. `op` mistyped as `operator`) would otherwise slip through as a
      // garbage `context.search`. Fail at the authoring site, not deep in the engine.
      throw new Error(
        `${owner}: \`${field}\` must be an expr(...)/cmp(...) comparison, an and()/or() group, an ` +
          `array of those, or a tagged Value (inp/ref/col/c.*) — got ${typeof w === "object" ? "an object that is neither. Check for a typo (e.g. `operator` instead of `op`)." : `${describeEntry(w)}.`}`,
      );
    }
  }
  if (raw !== undefined && nodes.length) {
    throw new Error(
      `${owner}: a raw Value \`where\` cannot be combined with expr()/cmp()/and()/or() clauses — ` +
        "use one form or the other.",
    );
  }
  // Top-level siblings are ANDed (the engine has exactly one `search`, so
  // `where` + `additionalWhere` concatenate into one ANDed `expression[]`).
  // Routed through `encodeExpression` rather than `encodeContainer` so a lone
  // root `or(...)` splices its children flat here exactly as it does in a
  // conditional — the two must not disagree about what `or(...)` means.
  if (nodes.length) {
    const encoded = encodeExpression(nodes);
    assertNoBareRightColumn(encoded);
    return encoded;
  }
  if (raw !== undefined) return raw;
  return undefined;
}

/** The directions the engine's sort accepts — lowercase, exactly these three. */
const SORT_DIRS: readonly SortDir[] = ["asc", "desc", "rand"];

/**
 * Refuse a sort list the engine cannot read, naming the statement and entry.
 *
 * `dir: "sideways"` or `"DESC"` used to be stored verbatim — the engine's sort
 * accepts only lowercase `asc`/`desc`/`rand` — and a missing `sortBy`, or a
 * `col("x")` in its place, reached a string method and threw `path.indexOf is
 * not a function`. `sortBy` is the column path as a STRING.
 */
export function assertSortList(statement: string, name: string, sort: unknown): void {
  if (sort === undefined || sort === null) return;
  const at = `Statement "${statement}": argument "${name}`;
  if (!Array.isArray(sort)) {
    throw new Error(`${at}" must be an array of { sortBy, dir? } — got ${describeEntry(sort)}.`);
  }
  sort.forEach((entry: unknown, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at}[${i}]" must be { sortBy, dir? } — got ${describeEntry(entry)}.`);
    }
    const { sortBy, dir } = entry as { sortBy?: unknown; dir?: unknown };
    if (typeof sortBy !== "string" || sortBy === "") {
      throw new Error(
        `${at}[${i}].sortBy" must be the column name as a string (\`"created_at"\`, or \`"alias.column"\` for a join) — got ${describeEntry(sortBy)}` +
          (typeof sortBy === "object" && sortBy !== null ? ". A `col(…)` is a value, not a column name." : "."),
      );
    }
    if (dir !== undefined && !(typeof dir === "string" && (SORT_DIRS as readonly string[]).includes(dir))) {
      const lower = typeof dir === "string" ? dir.toLowerCase() : undefined;
      throw new Error(
        `${at}[${i}].dir" accepts only "asc" | "desc" | "rand" — got ${typeof dir === "string" ? JSON.stringify(dir) : describeEntry(dir)}` +
          (lower !== undefined && (SORT_DIRS as readonly string[]).includes(lower) ? ` (lowercase: "${lower}").` : "."),
      );
    }
  });
}

/** The operator that keeps a comparison's meaning when its sides swap. */
const MIRRORED_OP: Readonly<Record<string, string>> = {
  "=": "=", "==": "==", "!=": "!=", "<": ">", ">": "<", "<=": ">=", ">=": "<=",
};

/** An encoded operand spelled back as the authoring call that produced it. */
function operandSource(operand: { tag?: unknown; operand?: unknown }): string {
  const name = JSON.stringify(operand.operand);
  if (operand.tag === "input") return `inp(${name})`;
  if (operand.tag === "var") return `ref(${name})`;
  if (operand.tag === "col") return `col(${name})`;
  if (operand.tag === "const") return `c.text(${name})`;
  if (typeof operand.tag === "string" && operand.tag.startsWith("const:")) {
    return `c.${operand.tag.slice(6)}(${String(operand.operand)})`;
  }
  return "<value>";
}

/**
 * Refuse a comparison whose RIGHT operand is a bare column.
 *
 * The engine resolves a column by name only on the LEFT. On the right a `col`
 * operand is unwrapped to its plain name, and a name that is not dotted with an
 * alias parses as a TEXT literal — so `expr(inp("s"), "=", col("t"))` compares
 * the input to the string "t". With a text value that answers HTTP 200 with the
 * wrong rows (every row for exactly one input, none for the rest); with an int it
 * fails every request with `Invalid value for param:<the value>`, naming the
 * value rather than the mistake. A dotted right operand (`col("t2.id")`, a join
 * alias or `tableAlias`) is a real column and is left alone.
 *
 * Walks the ENCODED tree, so groups, `additionalWhere`, and a join's `where`
 * are all covered by the one check.
 */
function assertNoBareRightColumn(search: unknown): void {
  if (search === null || typeof search !== "object") return;
  if (Array.isArray(search)) {
    for (const item of search) assertNoBareRightColumn(item);
    return;
  }
  const node = search as Record<string, unknown>;
  const cmp = node.statement as { op?: unknown; left?: Record<string, unknown>; right?: Record<string, unknown> } | undefined;
  const right = cmp?.right;
  if (right && right.tag === "col" && typeof right.operand === "string" && !right.operand.includes(".")) {
    const op = typeof cmp!.op === "string" ? cmp!.op : "?";
    const column = `col(${JSON.stringify(right.operand)})`;
    const left = cmp!.left ?? {};
    const mirrored = MIRRORED_OP[op];
    const fix =
      left.tag !== "col" && mirrored !== undefined
        ? `Put the column on the left: \`expr(${column}, "${mirrored}", ${operandSource(left)})\`.`
        : `Put the column on the left, or qualify a joined column with its alias (\`col("<alias>.${right.operand}")\`).`;
    throw new Error(
      `db search: the comparison \`${op}\` has ${column} on its right. The engine reads a column ` +
        `by name only on the LEFT; on the right an undotted name is a text literal, so this ` +
        `compares against the string "${right.operand}" — HTTP 200 with the wrong rows for a text ` +
        `value, a 400 \`Invalid value for param\` for a number. ${fix}`,
    );
  }
  for (const value of Object.values(node)) assertNoBareRightColumn(value);
}

/** Encode sort directives to the `mvp_sort` element shape `{ sortBy, orderBy }`. */
export function encodeSort(sort?: SortDirective[], statement = "s.db.query", name = "sort"): Array<{ sortBy: string; orderBy: SortDir }> {
  assertSortList(statement, name, sort);
  return (sort ?? []).map((s) => ({ sortBy: s.sortBy, orderBy: s.dir ?? "asc" }));
}

// ---------------------------------------------------------------------------
// Eval / computed-column primitives — shared by `s.db.query` (`context.eval[]`,
// aggregate `group`/`eval`) and `addon()` (same). Lives here (not db.ts) so the
// addon kind can reuse it without importing db.ts (a cycle).
// ---------------------------------------------------------------------------

/** One step of an eval filter pipeline (`{ name, arg, disabled? }`) — engine `mvp_filter`. */
export interface DbEvalFilter {
  /**
   * The filter to apply. This pipeline is compiled into SQL, so it resolves
   * against the query-expression registry — the `fl.*` runtime names PLUS the
   * SQL-only ones in {@link QueryFilterName} (vector distance, geo, aggregates,
   * `search_rank`). Open to any string: the two registries are the engine's, and
   * an unknown name is reported at export rather than blocked here.
   *
   * **Prefer `qf.*` to writing this shape by hand.** Each `qf` factory returns
   * exactly this object — same bytes — with the name, the argument COUNT and any
   * enumerated argument checked at the call site instead of at request time:
   *
   * ```ts
   * s.db.query({
   *   table: chunk,
   *   eval: [{ name: "embedding", as: "distance", filters: [qf.vector_cos_distance(inp("q"))] }],
   *   sort: [{ sortBy: "distance", dir: "asc" }],   // nearest first
   * })
   * ```
   * The ranking runs in the database over the `f.vector` column's index — not by
   * reading candidate rows into the request to score them.
   */
  name: QueryFilterName;
  /** Filter args as tagged values (encoded `{value,tag,filters}`). */
  arg?: Value[];
  /** Skip this step (kept in the stored pipeline as `disabled:true`). */
  disabled?: boolean;
}

/**
 * A computed output column (`context.eval[]`): source column/path `name`, output
 * alias `as`, and an optional `filters` pipeline. The `as` grafts onto the
 * returned row as an `unknown`-typed key. Also used for aggregate `group`/`eval`.
 */
export interface DbEval {
  /** Source column or dotted path (e.g. `"book.name"`). */
  name: string;
  /** Output alias — the row key this eval lands under. */
  as: string;
  /** Optional filter pipeline applied to the value. */
  filters?: DbEvalFilter[];
}

/**
 * Encode `context.eval[]` — one `{ as, name, filters }` per computed column. Each
 * filter step is `{ name, arg, disabled? }` with `arg` a list of tagged values;
 * `disabled` is dropped at its default. Byte shape from the `list-evals` golden.
 */
export function encodeEval(evals?: readonly DbEval[]): unknown[] | undefined {
  if (!evals?.length) return undefined;
  return evals.map((e) => ({
    as: e.as,
    name: e.name,
    filters: (e.filters ?? []).map((f) => ({
      name: f.name,
      arg: (f.arg ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
      ...(f.disabled ? { disabled: true } : {}),
    })),
  }));
}

/**
 * Alias-qualify aggregate `group`/`eval` column names. The engine rejects a bare
 * (dotless) column in an aggregate with `Unsupported param format - <col>`; a name
 * must be `<tableAlias>.<column>`. A bare author name is prefixed with the query's
 * primary table alias (`primaryAlias` — `tableAlias`, else the table name); a
 * name the author already dotted (a `bind`ed/joined column) passes through.
 *
 * ⚠ Prefixing alone is not enough: the engine resolves the qualifier against the
 * alias the STATEMENT declares, so `db.query` also emits `dbo.as` whenever this
 * function adds a prefix — otherwise the qualified name fails at runtime with
 * `Unsupported object reference - <alias>.<column>`. The two are a pair;
 * changing one without the other re-breaks the statement. The
 * result is guarded to a real `<alias>.<col>` shape so an unresolvable name fails
 * at export instead of 500ing at runtime. Used by both `db.query` aggregate and
 * the `cardinality:"aggregate"` addon.
 */
export function qualifyAggregateEvals(
  evals: readonly DbEval[] | undefined,
  primaryAlias: string,
  kind: "group" | "eval" | "query eval",
): DbEval[] | undefined {
  if (!evals?.length) return evals as DbEval[] | undefined;
  return evals.map((e) => {
    const name = e.name.includes(".") ? e.name : `${primaryAlias}.${e.name}`;
    // Emulates the engine's own check: the qualified name must be a real
    // `<alias>.<column>` (non-empty on both sides of the dot). Trips when the
    // primary alias is unresolvable or the author's dotted name is malformed.
    if (!/^[^.]+\.[^.].*$/.test(name)) {
      throw new Error(
        `${kind === "query eval" ? "db.query eval" : `aggregate ${kind}`}: name "${e.name}" must ` +
          `be an alias-qualified column (e.g. "${primaryAlias || "<table>"}.${e.name}") — the ` +
          `engine rejects a bare column name there (\`Unsupported param format\`). Qualify it ` +
          `with the table alias, or the bind alias for a joined column.`,
      );
    }
    return { ...e, name };
  });
}

/**
 * The keys a set of `eval` (or aggregate `group`/`eval`) columns graft onto a
 * row. Each entry's `as` alias becomes a key valued `unknown` — a filter
 * pipeline's output isn't statically knowable. An absent set contributes none.
 */
export type EvalFields<E> = E extends readonly [infer H, ...infer Rest]
  ? (H extends { as: infer S extends string } ? { [K in S]: unknown } : object) & EvalFields<Rest>
  : object;

/**
 * The row an aggregate query/addon yields — keyed by every `group` and `eval`
 * alias; a filtered alias types from its pipeline's last step. Reuses {@link EvalFields}; absent group/eval → no keys.
 */
export type AggregateRow<AG, Row = unknown> = AG extends { group?: infer G; eval?: infer EV }
  ? Prettify<GroupFields<G, Row> & AggregateEvalFields<EV>>
  : Record<string, unknown>;

/**
 * The type a filter pipeline's LAST step declares ({@link QueryFilterResults}):
 * `qf.count()` → `number`, `qf.epochms_month("UTC")` → `number`. A step whose
 * result is not statically known (a `json` result, a name built at runtime)
 * stays `unknown`.
 */
type PipelineResult<F> = F extends readonly [...unknown[], infer Last]
  ? Last extends { name: infer N extends string }
    ? N extends keyof QueryFilterResults
      ? QueryFilterResults[N]
      : unknown
    : unknown
  : unknown;

/** An aggregate `eval` alias, typed from its pipeline's last step. */
type AggregateEvalFields<E> = E extends readonly [infer H, ...infer Rest]
  ? (H extends { as: infer S extends string } ? { [K in S]: PipelineResult<H extends { filters: infer F } ? F : []> } : object) &
      AggregateEvalFields<Rest>
  : object;

/**
 * A `group` alias with no filter pipeline carries its column's value, so it is
 * typed from the row (`name` bare or alias-qualified); a filtered one, or a
 * column the row does not declare, stays `unknown`.
 */
type GroupFields<G, Row> = G extends readonly [infer H, ...infer Rest]
  ? (H extends { as: infer S extends string; name: infer N extends string }
      ? { [K in S]: H extends { filters: infer F extends readonly [unknown, ...unknown[]] } ? GroupResult<F, RowColumn<Row, N>> : RowColumn<Row, N> }
      : object) &
      GroupFields<Rest, Row>
  : object;

/** A filtered group: its pipeline's result, null where the grouped column can be. */
type GroupResult<F, Col> = unknown extends PipelineResult<F>
  ? unknown
  : PipelineResult<F> | (null extends Col ? (unknown extends Col ? never : null) : never);

type RowColumn<Row, N extends string> = N extends keyof Row
  ? Row[N]
  : N extends `${string}.${infer C}`
    ? C extends keyof Row
      ? Row[C]
      : unknown
    : unknown;
