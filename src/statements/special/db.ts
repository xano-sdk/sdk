/**
 * Hand-authored database statements — the `!map:dbo` family: read/delete/
 * exists/patch/truncate/schema against a table. Codegen defers these because the
 * target table is a `!map:dbo context.dbo.id` reference; with the guid
 * foundation (refs/guid.ts) the table resolves to its deterministic guid.
 *
 * All six share one rich envelope (engine-class metadata, not in the transform
 * schema — confirmed against the Xano engine's persisted shape): `description:""`,
 * `settings_registry:[]`, an `output` block (`{customize:false,filters:[],items:[]}`
 * by default; a statement with column selection — `db.get`'s `output` arg — emits
 * `{customize:true, items:[{name,children:[]}]}` per the engine's persisted golden),
 * `addon:[]`, an always-present `as` (""-default), and `context:{dbo:{id:guid}}`.
 * Input entries are the rich form `{name,value,tag,filters,ignore,expand,children}`.
 *
 * The row-data writes (`db.add`/`db.edit`/`db.add_or_edit`) carry the row as
 * explicit input entries — one per field, each with an optional `ignore` flag
 * (system/readonly columns like `id` are stored with `ignore:true`). Authors can
 * either list the entries exactly (`data: DbField[]`) or pass a *partial* row
 * (`row: { … }`) and let {@link expandRow} fill it against the table's declared
 * columns with type defaults + a documented `ignore` heuristic. The latter is a
 * DX convenience, not a byte-clone of the engine's editor template (see
 * {@link expandRow} for why that template isn't reproducible — it's a frontend
 * artifact, and the engine's import path accepts whatever entries it's given).
 *
 * Scope: `db.add_or_edit` (extra `context.dbo.as` + inconsistent entries),
 * `db.bulk*` (array-of-rows), `db.query` (structural !function), and
 * `db.direct_query`/external SQL/`db.transaction` are deferred.
 */
import { withArticle } from "../../util/article.js";
import { assertKnownKeys } from "../../util/known-keys.js";
import type { Statement, AsShapeBrand, BodyBrand } from "../statement.js";
import { encodeStatement, registerStatement, statementLabel } from "../statement.js";
import type { Value } from "../../values/value.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import { c, isTaggedValue, lossyIntegerProblem } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { encodeAddons } from "./addon-encode.js";
import type { AddonSpec } from "./addon-encode.js";
import type { AddonDef } from "../../kinds/addon.js";
import { assertInputValue, leanInput } from "../lean-input.js";
import type { LeanInput } from "../lean-input.js";
import { tableColumns } from "../../kinds/table.js";
import type { ColumnDef, TableDef, InferRow, InternalColsOf } from "../../kinds/table.js";
import type { NoExtraKeys, Prettify, ProtoKeySafe } from "../../fields/value-types.js";
import { isListColumn } from "../../fields/field.js";
import { encodeOutputItems } from "./output-select.js";
import { coerceCell, coerceScalar, type ScalarCell } from "./coerce.js";
import type { OutputPath, OutputRoot, PagingEnvelopeField, QualifiedCol } from "./output-select.js";
import { and, assertSortList, encodeSearch, encodeSort, encodeEval, qualifyAggregateEvals } from "./db-search.js";
import type { DbWhere, SortDirective, DbEval, EvalFields, AggregateRow } from "./db-search.js";
import { annotate } from "../statement.js";
import type { StatementAnnotations, StatementOptions } from "../statement.js";
import { argsOrEmpty, assertArg, assertListArg, assertOneOf, assertStatements, assertValueArg, describeArg, describeEntry, isRecordArg, isTaggedArg, type ListItemRule } from "../args.js";

/**
 * The `fieldName` a keyed db statement looks its row up by, as its stored text
 * constant. Absent and `null` are the `id` default; anything but a string is a
 * named error — `c.text(5)` used to answer with a message naming no statement.
 */
function fieldNameText(statement: string, v: unknown): Value {
  if (v === undefined || v === null) return c.text("id");
  if (typeof v !== "string") {
    throw new Error(`Statement "${statement}": argument "fieldName" must be the column name as a string — got ${describeEntry(v)}.`);
  }
  return c.text(v);
}

/**
 * An optional boolean flag (`lock`, `reset`, `allowIdField`) as its stored
 * constant, or `undefined` when absent. `null` is absent too; anything but a
 * boolean is a named error — `c.bool(null)` used to name no statement.
 */
function optionalFlag(statement: string, name: string, v: unknown): Value | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new Error(`Statement "${statement}": argument "${name}" must be true or false — got ${describeEntry(v)}.`);
  }
  return c.bool(v);
}
export type { DbWhere, SortDir, SortDirective, DbEval, DbEvalFilter } from "./db-search.js";

/**
 * The column-name type for a db op's `table` argument: a typed `table()` handle
 * narrows to its declared columns (+ system columns); a bare name or an untyped
 * ref falls back to any `string`. Drives schema-aware typing of `fieldName`,
 * `output`, `sortBy`, and `row` keys.
 */
type ColsOf<T> = T extends TableDef<infer C> ? C : string;

/**
 * The aliases a query's own `eval` declares — computed columns that exist on the
 * result but on no table.
 *
 * `eval: [{name: "…$searchindex", as: "rank", filters: [{name: "search_rank"}]}]`
 * makes `rank` selectable and sortable in the SAME call, and the engine's docs
 * (and this SDK's) say so: each `as` grafts onto the row. Typed only against the
 * table's columns, `sortBy: "rank"` did not compile — six selections in one real
 * workspace, all of them valid.
 */
type EvalAliases<E> = E extends readonly (infer Item)[]
  ? Item extends { as: infer A extends string }
    ? A
    : never
  : never;

/**
 * The single-row shape a db read yields, for `InferResponse`'s trace: the
 * table's {@link InferRow}, narrowed to the selected `Cols` when an `output`
 * list is given, else the full row. A named column is kept even when it is
 * `access:"internal"` — `output` overrides visibility, and that is how a login
 * reads the password hash. A bare-name / raw-`ColumnDef[]` table has no
 * field brands, so `InferRow` is `never` → `unknown` (nothing to infer).
 */
type RowShapeOf<T extends ObjectRef, Cols extends readonly string[]> = [
  InferRow<T>,
] extends [never]
  ? unknown
  : Cols["length"] extends 0
    ? ReadRow<T>
    : Pick<InferRow<T>, Extract<OutputRoot<Cols[number]>, keyof InferRow<T>>>;

/** The row a read returns: {@link InferRow} less the `access:"internal"` columns the engine never sends. */
type ReadRow<T> = [InternalColsOf<T>] extends [never] ? InferRow<T> : Prettify<Omit<InferRow<T>, InternalColsOf<T>>>;

/**
 * The full-row shape a write binds when it carries no column selection —
 * `db.add_or_edit` (upserted row, which has no `output` envelope at all in its
 * leaner serialization) and the bulk ops. The whole {@link InferRow}, or
 * `unknown` for an unbranded bare-name table. Expressed via {@link RowShapeOf}
 * with an empty `Cols` so the `never`→`unknown` guard is shared with the reads.
 * (`db.del` is deliberately *not* here — it binds `null`; see {@link dbDel}.)
 */
type FullRowShapeOf<T extends ObjectRef> = RowShapeOf<T, readonly []>;

/**
 * The alias segment of a dotted addon `as` — the part after the last dot
 * (`"items._book"` → `"_book"`, `"_book"` → `"_book"`). This is the key the addon
 * grafts onto the row.
 */
type AddonAlias<S extends string> = S extends `${string}.${infer Rest}`
  ? AddonAlias<Rest>
  : S;

/** True only for `unknown` (not `any`, not a concrete type) — guards the graft narrowing below. */
type IsUnknown<T> = 0 extends 1 & T ? false : unknown extends T ? true : false;

/**
 * Narrow a graft `G` to the attachment's `output` column whitelist `O`. The
 * runtime intersects the def's selected columns with the attachment whitelist,
 * so the type picks `O ∩ keyof G`. Applied to the element
 * of a list graft (`Shape[]`) or a single graft (`Shape`). An `unknown` graft
 * (bare-name reference, or a def with no typed `output`) stays `unknown` — never
 * collapse it to `{}`.
 */
type NarrowGraft<G, O extends readonly string[]> = IsUnknown<G> extends true
  ? unknown
  : G extends readonly (infer E)[]
    ? Prettify<Pick<E, Extract<OutputRoot<O[number]>, keyof E>>>[]
    : G extends object
      ? Prettify<Pick<G, Extract<OutputRoot<O[number]>, keyof G>>>
      : G;

/**
 * The graft shape one attached addon lands on the row. A typed
 * {@link AddonDef} handle carries its shape (`Pick<row, output>`, an object or
 * array per its cardinality); a bare name/`ObjectRef` reference carries none, so
 * it grafts `unknown` — the honest floor (narrow it at the call site). An
 * attachment-level `output` further restricts the graft to those columns
 * ({@link NarrowGraft}).
 */
type GraftOf<H> = H extends { addon: AddonDef<infer G> }
  ? H extends { output: infer O extends readonly string[] }
    ? NarrowGraft<G, O>
    : G
  : unknown;

/**
 * The keys a set of attached addons graft onto each returned row. Each addon's
 * alias (the last segment of its `as`) becomes a key valued by {@link GraftOf}.
 *
 * Mirrors where the engine places an addon — the alias always lands on
 * the *row element*. With paging the engine wraps rows under `items` (returnAs),
 * so `as:"items._book"` puts `_book` inside each `items[]` element = each row;
 * without paging `as:"_book"` puts it on each bare row. Both reduce to "the row
 * gains the alias key". Nested `children` addons enrich the addon's own result
 * (under the alias), so they add no parent-visible keys.
 */
type AddonFields<A> = A extends readonly [infer H, ...infer Rest]
  ? (H extends { envelope: true }
      ? object
      : H extends { as: infer S extends string }
        ? { [K in AddonAlias<S>]: GraftOf<H> }
        : object) &
      AddonFields<Rest>
  : object;

/** The keys `envelope: true` addons graft onto a query's paging envelope (see {@link AddonSpec.envelope}). */
type EnvelopeAddonFields<A> = A extends readonly [infer H, ...infer Rest]
  ? (H extends { envelope: true; as: infer S extends string } ? { [K in AddonAlias<S>]: GraftOf<H> } : object) &
      EnvelopeAddonFields<Rest>
  : object;

/**
 * A row shape augmented with any addon-grafted alias keys. With no addons
 * (`A = readonly []`) it is the row unchanged, so the non-addon path — and every
 * existing caller — keeps its exact shape.
 *
 * The graft **overrides** any base column of the same name rather than
 * intersecting with it (`Omit<Row, alias> & AddonFields`): the engine overwrites
 * the field with the addon result at runtime, so when an alias shadows an
 * existing column the honest type is the graft (`unknown`), not the base column.
 * An intersection would collapse `unknown & string` back to the base column and
 * silently desync the type from runtime.
 */
type WithAddons<Row, A> = [keyof AddonFields<A>] extends [never]
  ? Row
  : Prettify<Omit<Row, keyof AddonFields<A>> & AddonFields<A>>;

/**
 * A row shape augmented with any `eval` alias keys. With no evals it is the row
 * unchanged. Like {@link WithAddons}, an eval alias **overrides** a base column of
 * the same name (the engine computes over it), so the honest type is the graft.
 */
type WithEval<Row, E> = [keyof EvalFields<E>] extends [never]
  ? Row
  : Prettify<Omit<Row, keyof EvalFields<E>> & EvalFields<E>>;

/**
 * The paging metadata envelope a `db.query` returns when `paging` is set with
 * metadata on. The result
 * list lives under `items`; `totals:true` adds `itemsTotal`/`pageTotal`. A query
 * with no `paging`, or `paging:{ metadata:false }`, returns the bare list instead.
 *
 * **Has-next signal:** read `nextPage` — it is `number` when
 * another page exists and `null` on the last page (the engine fetches one extra
 * row to decide, so this needs no second scan). For a total count, set
 * `paging:{ totals:true }` and read `itemsTotal`/`pageTotal`. Both are typed on
 * this envelope by `InferResponse`, so a client can drive "load more" straight
 * off the typed response without hand-declaring the shape.
 */
type PagingEnvelope<Items, Totals extends boolean> = Prettify<
  {
    items: Items;
    itemsReceived: number;
    curPage: number;
    nextPage: number | null;
    prevPage: number | null;
    offset: number;
    perPage: number;
  } & (Totals extends true ? { itemsTotal: number; pageTotal: number } : object)
>;

/**
 * Whether a `paging` arg carries a page/per_page/offset field (static or a
 * `Value`) — the runtime gate that activates pagination. A `search`/`sort`-only
 * `paging` has no such field, so it does not produce the envelope.
 */
type HasPageFieldT<P> = P extends { page: unknown }
  ? true
  : P extends { per_page: unknown }
    ? true
    : P extends { offset: unknown }
      ? true
      : false;

/**
 * Whether a `paging` arg produces the metadata envelope: it activates pagination
 * (a page/per_page/offset field is present) and is not explicitly `metadata:false`
 * (the engine default is `metadata:true`).
 */
type HasPagingEnvelope<P> = P extends undefined
  ? false
  : P extends { metadata: false }
    ? false
    : HasPageFieldT<P> extends true
      ? true
      : false;

/** The `totals` flag of a `paging` arg — literal `true` only when set explicitly. */
type PagingTotals<P> = P extends { totals: true } ? true : false;

/**
 * The engine's `context.return.type` for a `db.query` — the return-type
 * discriminant. `"list"` is the default (a row array or paging envelope);
 * `"single"` a first-match object; `"count"`/`"exists"` a scalar; `"stream"` a
 * (pageable) row array with no metadata envelope.
 */
export type DbReturnType = "list" | "single" | "count" | "exists" | "stream" | "aggregate";

/** Distinct-row handling (`context.return.<list|stream>.distinct`): engine default `"auto"`. */
export type DbDistinct = "auto" | "yes" | "no";

/** A `db.query` sort directive — a {@link SortDirective} plus the joined-query `qualify` switch. */
export interface DbSortDirective<C extends string = string> extends SortDirective<C> {
  /**
   * On a joined list/stream query a bare own-column `sortBy` is emitted
   * qualified (`title` → `<table>.title`) so `distinct: "auto"` dedupes.
   * `false` keeps it bare, and then `"auto"` returns one row per join match.
   * Pulled code sets it to reproduce a statement stored bare; new code should
   * leave it out (use `distinct: "no"` to keep join duplicates).
   */
  qualify?: boolean;
}

/** Aggregate paging (`context.return.aggregate.paging`) — no `offset`/`totals` (engine schema). */
export interface DbAggregatePaging {
  page?: number;
  per_page?: number;
  /** Wrap the result in the metadata envelope (engine default `true`). */
  metadata?: boolean;
  /**
   * The engine's gate. Every field here is read ONLY when this is on, so
   * `enabled:false` parks a configured block without applying it — the state the
   * editor leaves behind when pagination is switched back off. Defaults to `true`
   * (passing `paging` at all is the usual way to ask for it); set `false` only to
   * reproduce that parked state.
   */
  enabled?: boolean;
}

/**
 * Aggregate/group-by config for `returnType:"aggregate"` (`context.return.aggregate`).
 * `group` are the group-by columns and `eval` the aggregator columns (each
 * `{ name, as, filters }` — an aggregator like `sum`/`count` rides `filters`).
 * Both `as` sets graft onto the aggregate row (a plain group typed by its column). Write `name` as
 * a bare column (`"status"`) — it is alias-qualified to `"<table>.status"` on emit
 * (the engine requires the qualified form) and the statement declares that alias
 * so the qualified name resolves; pass an already-dotted `name` for a
 * `bind`ed/joined column and it is left as-is (and declares nothing, which is
 * what keeps a pulled workspace byte-exact).
 */
export interface DbAggregate {
  group?: DbEval[];
  eval?: DbEval[];
  sort?: SortDirective[];
  paging?: DbAggregatePaging;
}

/** Each entry of an `eval`/`group` list checked for keys {@link DbEval} does not declare. */
type EvalListKeys<E> = E extends readonly unknown[]
  ? { readonly [I in keyof E]: NoExtraKeys<E[I], DbEval, "name | as | filters"> }
  : unknown;

/**
 * The nested records of `s.db.query` held to their declared keys. Each is a
 * const-inferred parameter, so a typo inside one (`paging: { perPage }`, an eval
 * `filter:`) widened the parameter instead of failing, and was dropped on emit.
 */
type QueryNestedKeys<P, E, AG> = {
  paging?: NoExtraKeys<P, DbPaging, "page | per_page | offset | totals | metadata | enabled | search | sort">;
  eval?: EvalListKeys<E>;
  aggregate?: NoExtraKeys<AG, DbAggregate, "group | eval | sort | paging"> &
    (AG extends DbAggregate
      ? {
          group?: EvalListKeys<AG["group"]>;
          eval?: EvalListKeys<AG["eval"]>;
          paging?: NoExtraKeys<AG["paging"], DbAggregatePaging, "page | per_page | metadata | enabled">;
        }
      : unknown);
};

/** A join type for a {@link DbBind} — the engine's `bind[].join`. */
export type DbJoin = "inner" | "left" | "right";

/**
 * A db statement's target table — a def handle or name, or `null` for the
 * engine's own empty binding (`context.dbo.id: ""`).
 *
 * ⚠ **Do not author `null`.** It is a BROKEN state in Xano, not a neutral one:
 * the statement is bound to no table and does nothing wherever it runs. It exists
 * on these types so `codegen` can represent a broken statement faithfully rather
 * than degrade the whole thing to `raw()` — a pulled `table: null` is a defect to
 * fix in the pulled workspace, not a shape to copy.
 *
 * It is what a statement degrades to when the table it referenced is deleted, and
 * also where a freshly-dropped one starts. The engine clears the id rather than
 * recording a tombstone, so those two are the same bytes: `null` means "unbound",
 * never "was deleted". The same contract as an addon's `table` (see
 * {@link addon}), which is where this pattern comes from.
 *
 * An unbound table has no schema, so `row:` (which expands the typed row against
 * the table's columns) is unavailable with it — use `data:`.
 */
type DbTableRef<T extends ObjectRef = ObjectRef> = T | null;

/**
 * A join (`context.bind[]`): join `table` (aliased by `as`) with `join` kind and
 * an optional `where` join condition (same search surface as the query). Joins
 * widen what `where`/`sort`/`eval` can address by dotted path (`"author.id"`);
 * they do not by themselves change the returned row shape.
 *
 * ⚠ **The two sides of a join condition are spelled differently**.
 * The JOINED column takes the dotted alias path; the query's OWN column stays
 * BARE:
 *
 * ```ts
 * s.db.query({
 *   table: doc,                                   // columns of `doc` are bare
 *   bind: [{ table: team, as: "team_row", join: "left",
 *            where: expr(col("team"), "=", col("team_row.id")) }],
 * })
 * ```
 *
 * Qualifying your own column with the table's name (`col("doc.team")`) resolves
 * only when the query also sets {@link DbQueryArgs.tableAlias} — the engine
 * matches the qualifier against the alias the statement declares, and a query
 * without `tableAlias` declares none. Unqualified, the engine treats the operand
 * as a text literal and the request fails with `ParseError: Invalid value for
 * param:"…"` naming the OTHER operand. Both spellings are checked at export.
 */
export type DbBind = DbTableBind | DbExpandBind;

/** A {@link DbBind} that joins a table. */
export interface DbTableBind {
  /**
   * The table to join, or `null` when unbound — see {@link DbTableRef} for the
   * contract, which is the same one the query's own `table` holds. ⚠ Do not
   * author `null`; it exists so a join whose table was deleted round-trips
   * instead of taking the whole statement to `raw()`.
   */
  table: DbTableRef;
  expand?: never;
  /** SQL alias for the joined table — defaults to the table name. Two binds to the same table need distinct aliases. */
  as?: string;
  /** Join kind (default `"inner"`). */
  join?: DbJoin;
  /** Join condition — same `where`/`cmp`/`and`/`or` surface as the query. */
  where?: DbWhere;
}

/**
 * A {@link DbBind} that expands a LIST column of a table already in the query
 * into one joined row per element, addressable by dotted path under `as`:
 *
 * ```ts
 * s.db.query({
 *   table: blog, tableAlias: "blog",
 *   bind: [{ expand: "blog.categories", as: "blog_categories" }],
 *   where: cmp(col("blog_categories.category_id"), "=", inp("category_id")),
 * })
 * ```
 *
 * `expand` is `<alias>.<column>` — the query's `tableAlias` or a joined table's
 * `as`, then a list column of it. A column that is not a list fails the query.
 */
export interface DbExpandBind {
  /** The list column to expand, as `<alias>.<column>`. */
  expand: string;
  table?: never;
  /** The alias each element is addressed under. Required. */
  as: string;
  /** Join kind (default `"inner"`). */
  join?: DbJoin;
  /** Join condition — same `where`/`cmp`/`and`/`or` surface as the query. */
  where?: DbWhere;
}

/**
 * The full `db.query` result shape, discriminated by return type `RT`:
 * `count → number`, `exists → boolean`, `single → row | null`, `stream → row[]`,
 * and `list → row[]` or the {@link PagingEnvelope} when `paging` requests
 * metadata. The row is always the addon-augmented row.
 */
type QueryResult<Row, A, P, RT extends DbReturnType, E = readonly [], AG = unknown, Cols extends readonly string[] = readonly []> = RT extends "count"
  ? number
  : RT extends "exists"
    ? boolean
    : RT extends "aggregate"
      ? AggregateRow<AG, Row>[]
      : WithAddons<WithEval<Row, E>, A> extends infer R
        ? RT extends "single"
          ? R | null
          : RT extends "stream"
            ? R[]
            : HasPagingEnvelope<P> extends true
              ? PickEnvelope<
                  [keyof EnvelopeAddonFields<A>] extends [never]
                    ? PagingEnvelope<R[], PagingTotals<P>>
                    : Prettify<PagingEnvelope<R[], PagingTotals<P>> & EnvelopeAddonFields<A>>,
                  Cols
                >
              : R[]
        : never;

/**
 * A PAGED read's `output` selects from the envelope, so its row selection is the
 * `items.<col>` paths with `items.` dropped (`items` whole keeps the full row).
 * An unpaged read (or no selection) selects from the row as written.
 */
type QueryRow<T extends ObjectRef, Cols extends readonly string[], P, RT> = RT extends "list"
  ? HasPagingEnvelope<P> extends true
    ? Cols["length"] extends 0
      ? RowShapeOf<T, Cols>
      : "items" extends Cols[number]
        ? RowShapeOf<T, readonly []>
        : RowShapeOf<T, readonly ItemsCol<Cols[number]>[]>
    : RowShapeOf<T, Cols>
  : RowShapeOf<T, Cols>;

/** The row column an `items.<col>` envelope path names. */
type ItemsCol<S> = S extends `items.${infer R}` ? R : never;

/**
 * A PAGED read's `output` held to the envelope once it names an envelope root:
 * a row column beside the counters (`["curPage", "id"]`) is dropped by the
 * engine, and an `items.<col>` naming no row key selects nothing. Each such
 * entry is typed as the message saying so. A selection with no envelope root
 * is left to the export check, which prints the whole prefixed list.
 */
type PagedOutputCheck<Cols extends readonly string[], P, RT, Row extends string> = [RT] extends ["list"]
  ? HasPagingEnvelope<P> extends true
    ? [Extract<OutputRoot<Cols[number]>, PagingEnvelopeField>] extends [never]
      ? unknown
      : { output?: { [I in keyof Cols]: PagedEntry<Cols[I], Row> } }
    : unknown
  : unknown;

type PagedEntry<E, Row extends string> = E extends PagingEnvelopeField
  ? E
  : E extends `items.${infer Col}`
    ? Col extends `${string}.${string}` | Row
      ? E
      : Refused<E, `"items.${Col}": the row has no "${Col}"`>
    : Refused<E, `"${E & string}" is dropped from a paged envelope — write "items.${E & string}"`>;

/**
 * A refused entry, carrying its message. Branded rather than replaced by the
 * message literal: `"x" & "message"` is `never`, and one `never` element
 * reduces the whole `output` tuple to `never` — every entry then errored.
 */
type Refused<E, M extends string> = E & { readonly error: M };

/** The row keys the addons of a query graft (each `as`'s last segment). */
type AddonAliases<A> = A extends readonly (infer H)[] ? (H extends { as: infer S extends string } ? AddonAlias<S> : never) : never;

/** The envelope keys an `output` selection keeps — all of them when nothing is selected. */
type PickEnvelope<Env, Cols extends readonly string[]> = Cols["length"] extends 0
  ? Env
  : Prettify<Pick<Env, Extract<OutputRoot<Cols[number]>, keyof Env>>>;

/**
 * A db read statement branded — **at the type level only** — via the shared
 * {@link AsShapeBrand} contract (the stack variable it binds + the shape it
 * produces). The runtime statement is a plain {@link Statement}, so
 * `encodeStatement` is unchanged.
 */
export type DbResult<As extends string, Shape> = Statement & AsShapeBrand<As, Shape>;

/** A stored rich input entry (db ops carry the expanded `{ignore,expand,children}` form). */
interface RichInput {
  name: string;
  value: string;
  tag: string;
  filters: unknown[];
  ignore: boolean;
  expand: boolean;
  children: RichInput[];
}

/**
 * One stored input entry. `children` marks the entry **expanded**: the engine
 * assembles the column's value as an object from the child entries, keyed by
 * each child's name, recursively. `expand` is not authored separately — it is
 * exactly "this entry has children", which is the only combination real
 * workspaces store (an expanded entry always carries children, and an
 * unexpanded one never does).
 */
function entry(name: string, v: Value, ignore = false, children: RichInput[] = []): RichInput {
  // Not redundant with the types: a `row` value silenced past them (or reached
  // from JS) would copy `undefined` into all three keys and emit a slot the
  // engine answers `Unable to locate input:` on — see {@link assertInputValue}.
  assertInputValue(name, v);
  return {
    name,
    value: v.value,
    tag: v.tag,
    filters: v.filters,
    ignore,
    expand: children.length > 0,
    children,
  };
}

/**
 * Optional envelope extras for a db op: `output` restricts the returned columns;
 * `addon` attaches addons. Both default to absent (full record, empty `addon:[]`).
 * Grouped into one options bag so a statement that wants only `addon` needn't
 * thread a positional `undefined` past `output`.
 */
interface EnvelopeOpts {
  output?: readonly string[];
  addon?: readonly AddonSpec[];
  /** Paging-envelope offset (`"items[]"`) prefixed onto top-level addons when the
   * query returns a metadata paging envelope. Set only by `dbQuery`. */
  addonOffset?: string;
}

/**
 * The shared db-op envelope fields (everything except name/context/as/input).
 * `output` switches the output block to the engine's customized form (byte shape
 * per the engine's persisted golden); omitted, it stays the full-record default.
 * A dotted entry selects sub-keys of an object column ({@link encodeOutputItems}).
 */
function envelope(
  opts: EnvelopeOpts = {},
): Pick<Statement, "description" | "settings_registry" | "output" | "addon"> {
  const { output: outputCols, addon: addons, addonOffset } = opts;
  return {
    description: "",
    settings_registry: [],
    // An empty selection normalizes to the full-record default — `[]` must not
    // emit the degenerate `{customize:true, items:[]}` shape no golden attests.
    output: outputCols?.length
      ? { customize: true, filters: [], items: encodeOutputItems(outputCols) }
      : { customize: false, filters: [], items: [] },
    // `encodeAddons` returns `[]` when omitted, preserving the empty-`addon:[]`
    // default byte-for-byte for statements that attach none.
    addon: encodeAddons(addons, addonOffset),
  };
}

/**
 * Reject an addon whose alias (the final `as` segment) shadows a column already
 * on the queried table. The engine grafts the addon result over that field at
 * runtime, so the base column silently disappears — almost always a mistake.
 * Only top-level aliases are checked against the query's table;
 * a bare-name table (no schema) is skipped since its columns are unknown, and
 * nested `children` graft onto their own addon's shape (not this table).
 */
/** An `output` entry: a column path string. `col("name")` is a value, not a path. */
const OUTPUT_ITEM: ListItemRule = {
  test: (v) => typeof v === "string" && v !== "",
  want: 'a column path string ("name", or "meta.country" for a key of an object column)',
};
/** An `addon` entry: `{ addon, as, … }`. */
const ADDON_ITEM: ListItemRule = {
  test: (v) => isRecordArg(v) && typeof v.as === "string",
  want: "an addon spec ({ addon, as })",
};

/** A direct query's positional `args` entry: a tagged value bound to one `?`. */
const SQL_ARG_ITEM: ListItemRule = {
  test: isTaggedArg,
  want: "a tagged value (`inp()`, `ref()`, `c.*`, …)",
};

/** An `eval`/`aggregate.group`/`aggregate.eval` entry: `{ name, as, filters? }`. */
const EVAL_ITEM: ListItemRule = {
  test: (v) => isRecordArg(v) && typeof v.name === "string" && typeof v.as === "string",
  want: '{ name, as } (name: the column, as: the alias it is bound to)',
};
/** The keys of a {@link DbEval} entry and of a {@link DbPaging} block. */
const EVAL_KEYS = ["name", "as", "filters"];
const PAGING_KEYS = ["page", "per_page", "offset", "totals", "metadata", "enabled", "search", "sort"];
/** A `bind` entry: a join `{ table, as?, join?, where? }` or an expansion `{ expand, as, join?, where? }`. */
const BIND_ITEM: ListItemRule = {
  test: (v) => isRecordArg(v) && ("table" in v || "expand" in v),
  want: "a join ({ table, as?, join?, where? }) or a list expansion ({ expand, as, join?, where? })",
};
/** An entry of an array-form `where`: a comparison, a group, or a tagged value. */
const WHERE_ITEM: ListItemRule = {
  test: (v) => isRecordArg(v) || isTaggedArg(v),
  want: "a comparison (expr()/cmp()), an and()/or() group, or a tagged value",
};

/**
 * Every argument of `s.db.query` a wrapper maps over or reads a field off,
 * checked up front so a wrong shape through `any` is a named statement error —
 * never `(args.eval ?? []).some is not a function` or `path.indexOf is not a
 * function` from deep in an encoder.
 */
function assertQueryArgShapes(args: {
  readonly [k: string]: unknown;
}): void {
  const st = "s.db.query";
  assertEnvelopeLists(st, args);
  assertListArg(st, "eval", args.eval, EVAL_ITEM);
  const evalKeys = (at: string, list: unknown): void => {
    if (Array.isArray(list)) list.forEach((e, i) => assertKnownKeys(`Statement "${st}": argument "${at}[${i}]"`, e, EVAL_KEYS));
  };
  evalKeys("eval", args.eval);
  assertKnownKeys(`Statement "${st}": argument "paging"`, args.paging, PAGING_KEYS);
  assertListArg(st, "bind", args.bind, BIND_ITEM);
  assertSortList(st, "sort", args.sort);
  if (Array.isArray(args.sort)) {
    args.sort.forEach((entry: unknown, i) => {
      const qualify = (entry as { qualify?: unknown }).qualify;
      if (qualify !== undefined && typeof qualify !== "boolean") {
        throw new Error(
          `Statement "${st}": argument "sort[${i}].qualify" must be a boolean — got ${describeEntry(qualify)}.`,
        );
      }
    });
  }
  for (const key of ["where", "additionalWhere"] as const) {
    if (Array.isArray(args[key])) assertListArg(st, key, args[key], WHERE_ITEM);
  }
  const agg = args.aggregate;
  if (agg !== undefined && agg !== null) {
    if (!isRecordArg(agg)) throw new Error(`Statement "${st}": argument "aggregate" must be { group, eval, sort?, paging? } — got ${describeEntry(agg)}.`);
    assertKnownKeys(`Statement "${st}": argument "aggregate"`, agg, ["group", "eval", "sort", "paging"]);
    assertKnownKeys(`Statement "${st}": argument "aggregate.paging"`, agg.paging, ["page", "per_page", "metadata", "enabled"]);
    assertListArg(st, "aggregate.group", agg.group, EVAL_ITEM);
    assertListArg(st, "aggregate.eval", agg.eval, EVAL_ITEM);
    evalKeys("aggregate.group", agg.group);
    evalKeys("aggregate.eval", agg.eval);
    assertSortList(st, "aggregate.sort", agg.sort);
    assertPagingShape(st, "aggregate.paging", agg.paging);
  }
  assertPagingShape(st, "paging", args.paging);
  const ext = args.external;
  if (ext !== undefined && ext !== null && !(isRecordArg(ext) && isTaggedArg(ext.value))) {
    throw new Error(
      `Statement "${st}": argument "external" must be { value, permissions? } with a tagged value (e.g. \`{ value: inp("filters") }\`) — got ${describeEntry(ext)}.`,
    );
  }
}

/**
 * A `paging` block's page/per_page/offset: a non-negative integer (per_page at
 * least 1) or a tagged value. `per_page: "x"` fell back to 25 in silence, and
 * `-1` was stored for the engine to reject on every request.
 */
function assertPagingShape(statement: string, name: string, paging: unknown): void {
  if (paging === undefined || paging === null) return;
  if (!isRecordArg(paging)) {
    throw new Error(`Statement "${statement}": argument "${name}" must be { page?, per_page?, … } — got ${describeEntry(paging)}.`);
  }
  for (const key of ["page", "per_page", "offset"] as const) {
    const v = paging[key];
    if (v === undefined || isTaggedArg(v)) continue;
    const min = key === "per_page" ? 1 : 0;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
      throw new Error(
        `Statement "${statement}": argument "${name}.${key}" must be an integer of at least ${min}, or a tagged value (\`inp("${key}")\`) — got ${describeEntry(v)}.`,
      );
    }
  }
  // The two flags: `totals: "yes"` and `metadata: 1` were stored as given, and
  // the envelope type read them as `false`.
  for (const key of ["totals", "metadata"] as const) {
    const v = paging[key];
    if (v === undefined || v === null || typeof v === "boolean") continue;
    throw new Error(`Statement "${statement}": argument "${name}.${key}" must be true or false — got ${describeEntry(v)}.`);
  }
}

/** Refuse a wrong-shaped `output`/`addon` before the envelope maps over them, naming the statement. */
function assertEnvelopeLists(statement: string, opts: { output?: unknown; addon?: unknown }): void {
  assertListArg(statement, "output", opts.output, OUTPUT_ITEM);
  assertListArg(statement, "addon", opts.addon, ADDON_ITEM);
}

function assertNoAddonShadow(table: ObjectRef, addons?: readonly AddonSpec[]): void {
  if (!addons?.length) return;
  if (typeof table === "string" || !("schema" in table)) return;
  const cols = new Set(tableColumns(table as TableDef).map((col) => col.name));
  for (const spec of addons) {
    // An envelope graft lands beside `items`, never on a row.
    if (spec.envelope === true) continue;
    const as = spec.as;
    const dot = as.lastIndexOf(".");
    const alias = dot === -1 ? as : as.slice(dot + 1);
    if (cols.has(alias)) {
      throw new Error(
        `addon: alias "${alias}" (from as:"${as}") shadows an existing "${table.name}" column — ` +
          `the graft overwrites it at runtime and desyncs the row type. Rename the alias ` +
          `(Xano convention: a "_" prefix, e.g. as:"${dot === -1 ? "" : as.slice(0, dot + 1)}_${alias}").`,
      );
    }
  }
}

/**
 * The `context.dbo` binding: the table's guid, plus the SQL alias when one is set.
 *
 * `as` is a **SQL alias**, not the table's SQL name. The engine derives the real
 * table name from the table itself (its own SQL-name setting) and then appends
 * ` as <alias>` to it, producing the ordinary `FROM users as u` — the alias never
 * replaces the name. It is also dropped when it equals the table name, so an
 * alias that merely restates the name is a no-op.
 *
 * Because it is a per-statement alias, duplicates across the workspace are
 * normal SQL and are not an error — two unrelated queries may each alias their
 * table `u`. Alias collisions matter only among the joins of a single statement,
 * where the engine keys the `join` block by alias name; the addon path already
 * guards that (see {@link assertNoAddonShadow}).
 *
 * Xano does **not** write `as` uniformly. Measured read-only across four
 * engine-authored workspaces: `dbo_getby` appears 4 times with it and 9 times
 * without, and `dbo_add` 8 times without it entirely. So it is per-statement
 * data, not a function of the table — emitting it unconditionally would diverge
 * from the majority exactly as omitting it diverges from the rest. It is
 * authored instead, and absent unless asked for.
 */
function dboBinding(table: ObjectRef | null, tableAlias?: string, stmtName?: string): Record<string, unknown> {
  // `null` writes the engine's own empty binding rather than a resolved guid —
  // `resolveRef` would reject a target with neither a name nor a guid. Same
  // representation-of-a-broken-state contract as an addon's `table: null`.
  const where = stmtName === undefined ? undefined : `Statement "${statementLabel(stmtName)}": argument "table"`;
  const dbo: Record<string, unknown> = { id: table === null ? "" : resolveRef("dbo", table, where) };
  if (tableAlias !== undefined) dbo.as = tableAlias;
  return dbo;
}

/** Assemble a `!map:dbo` statement: table ref → `context.dbo` + rich envelope. */
function dboStatement(
  name: string,
  table: ObjectRef | null,
  as: string | undefined,
  input: RichInput[],
  opts: EnvelopeOpts = {},
  tableAlias?: string,
  enforceHiddenFields?: boolean,
): Statement {
  assertEnvelopeLists(statementLabel(name), opts);
  if (table !== null) assertNoAddonShadow(table, opts.addon);
  return {
    name,
    context: {
      dbo: dboBinding(table, tableAlias, name),
      // Written only when ON. The engine declares `enforce_hidden_fields?=false`
      // and reads it as `?? false`, so absent IS off — and every one of the 557
      // stored `dbo_add` statements in the offline corpus omits it.
      ...(enforceHiddenFields === true ? { enforce_hidden_fields: true } : {}),
    },
    as: as ?? "",
    input,
    ...envelope(opts),
  };
}

export interface DbGetArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  /** The target table (def handle or name). */
  table: DbTableRef<T>;
  /**
   * The lookup field (defaults to the primary key `id`). A dotted path reaches a
   * sub-key of an object column (`"google_oauth.id"`) or a joined table's column
   * — see {@link QualifiedCol}.
   */
  fieldName?: QualifiedCol<ColsOf<T>>;
  /** The value to match. */
  fieldValue: Value;
  /** Acquire a row lock for the transaction. */
  lock?: boolean;
  /**
   * Restrict the returned columns (XanoScript `output = [...]`). Encoded into
   * the customized output envelope — `{customize:true, items:[{name,children:[]}]}`
   * (byte shape per the engine's persisted golden). Omitting it
   * returns the full record (`customize:false`). Note: an explicit `output`
   * list overrides column visibility — listing an `internal` column (e.g. a
   * password hash) pulls it into the statement result. Captured literally so
   * `InferResponse` narrows a traced row to exactly these columns.
   */
  output?: Cols;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/**
 * A `where` handed to a single-row op (through a cast or plain JS), which takes
 * no condition: it matches ONE row by `fieldName`/`fieldValue`. Without this the
 * refusal was `required argument "fieldValue" is missing`, which never names the
 * argument the author actually wrote.
 */
/**
 * How to write the rows a condition matches: no bulk write takes a `where` (the
 * bulk writes take `items`, each row carrying its id), so the rows are read
 * first and written back by id.
 */
const BULK_BY_CONDITION =
  '`s.db.query({ table, where, as: "rows" })` then `s.foreach` over `rows` with `s.db.patch` per id ' +
  "(or `s.db.increment({ table, where, … })` to add to a numeric column) to change the rows matching a condition";

/** The keys a bulk write declares — every other key would be dropped on emit. */
const BULK_WRITE_KEYS = ["disabled", "description", "mock", "asFilters", "uncheckedAs", "tableAlias", "table", "items", "as"];

/**
 * Refuse an argument a bulk write does not declare. A `where` gets its own
 * message: bulk writes take `items`, and a filter there would be dropped on emit.
 */
function assertBulkWriteKeys(label: string, args: object, extra: readonly string[] = []): void {
  if ((args as { where?: unknown }).where !== undefined) {
    throw new Error(
      `Statement "${label}": \`where\` is not an argument of ${label} — it writes the rows \`items\` lists, ` +
        `each carrying its id, and a filter would be dropped on emit. Use ${BULK_BY_CONDITION}.`,
    );
  }
  assertKnownKeys(`Statement "${label}"`, args, [...BULK_WRITE_KEYS, ...extra]);
}

function assertNoWhere(label: string, args: unknown, alternative: string): void {
  const a = (args ?? {}) as { where?: unknown; fieldValue?: unknown };
  if (a.where === undefined) return;
  throw new Error(
    `Statement "${label}": \`where\` is not an argument of ${label} — it matches one row by ` +
      `\`fieldName\`/\`fieldValue\` (the id by default). ` +
      (a.fieldValue !== undefined
        ? `Drop \`where\` to match on \`fieldValue\` alone, or use ${alternative}.`
        : `Use ${alternative}, or pass \`fieldValue\`.`),
  );
}

const DB_GET_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, fieldName: 1, fieldValue: 1, lock: 1, output: 1, addon: 1, as: 1 } satisfies Record<keyof DbGetArgs, 1>);

/** `db.get <table>` — fetch a single record by a field match (`mvp:dbo_getby`).
 * Returns a {@link DbResult} branded with `as` + the (optionally narrowed) row
 * shape **`| null`** so `InferResponse` can type a response that returns this
 * variable. `dbo_getby` binds **`null` on a miss** (no row matched) rather than
 * throwing — confirmed live — so the honest shape is `Row | null`, matching
 * `db.query`'s `returnType:"single"` ({@link QueryResult}). Contrast the row
 * **writes** (`db.add`/`edit`/`patch`/`add_or_edit`), which bind the full
 * written row rather than null and so stay non-nullable — a genuine miss throws
 * instead of yielding null (`NotFound`/404 for `edit`/`patch`; a
 * unique-constraint error for `add`; `add_or_edit` upserts, so it never misses).
 */
export function dbGet<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbGetArgs<T, As, Cols, A> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A> | null, Fs>> {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.get", args, '`s.db.query({ table, where, returnType: "single" })` for the first row matching a condition');
  assertKnownKeys(`Statement "s.db.get"`, args, DB_GET_KEYS);
  assertArg("s.db.get", "table", args.table, { nullable: true });
  assertValueArg("s.db.get", "fieldValue", args.fieldValue);
  return annotate(dboStatement(
    "mvp:dbo_getby",
    args.table,
    args.as,
    [
      entry("field_name", fieldNameText("s.db.get", args.fieldName)),
      entry("field_value", args.fieldValue),
      // `lock?=false` in the engine schema, and Xano's own editor omits the entry
      // when it is not set. Writing it unconditionally is a divergence, not a
      // clarification — so it is written only when the author asks for a lock.
      ...(optionalFlag("s.db.get", "lock", args.lock) === undefined ? [] : [entry("lock", c.bool(args.lock!))]),
    ],
    { output: args.output, addon: args.addon },
    args.tableAlias,
  ) as DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A> | null, Fs>>, args);
}

export interface DbDelArgs<T extends ObjectRef = ObjectRef> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /** The lookup field. A dotted path reaches an object column's sub-key or a joined table's column ({@link QualifiedCol}). */
  fieldName?: QualifiedCol<ColsOf<T>>;
  fieldValue: Value;
  as?: string;
}

const DB_DEL_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, fieldName: 1, fieldValue: 1, as: 1 } satisfies Record<keyof DbDelArgs, 1>);

/**
 * `db.del <table>` — delete a single record by a field match (`mvp:dbo_delby`);
 * throws `NotFound`/404 when nothing matches.
 *
 * Left **unbranded** (plain {@link Statement}), unlike the other single-record
 * writes: the engine declares no output schema for this statement and returns
 * nothing once the row is gone, so the bound `as` variable holds **`null`**, not
 * the deleted row. `InferResponse` therefore resolves a returned del var to
 * `unknown` — matching where the engine's own OpenAPI walk falls back to `json`.
 * (Contrast `db.add`/`edit`/`patch`/`add_or_edit`, which each return the written
 * row and so bind the full record.)
 */
export function dbDel<T extends ObjectRef>(args: DbDelArgs<T>): Statement {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.del", args, '`s.db.bulk.delete({ table, where })` to delete the rows matching a condition');
  assertKnownKeys(`Statement "s.db.del"`, args, DB_DEL_KEYS);
  assertArg("s.db.del", "table", args.table, { nullable: true });
  assertValueArg("s.db.del", "fieldValue", args.fieldValue);
  return annotate(dboStatement(
    "mvp:dbo_delby",
    args.table,
    args.as,
    [entry("field_name", fieldNameText("s.db.del", args.fieldName)), entry("field_value", args.fieldValue)],
    {},
    args.tableAlias,
  ), args);
}

export interface DbHasArgs<T extends ObjectRef = ObjectRef, As extends string = string> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /** The lookup field. A dotted path reaches an object column's sub-key or a joined table's column ({@link QualifiedCol}). */
  fieldName?: QualifiedCol<ColsOf<T>>;
  fieldValue: Value;
  /** Capture the existence boolean into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

const DB_HAS_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, fieldName: 1, fieldValue: 1, as: 1 } satisfies Record<keyof DbHasArgs, 1>);

/** `db.has <table>` — test whether a record exists by a field match (`mvp:dbo_hasby`).
 * Binds a **boolean** (the engine's `__self: bool` output), so it's branded with
 * `as` + `boolean` for `InferResponse` — table-independent, unlike the row ops. */
export function dbHas<T extends ObjectRef, const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbHasArgs<T, As> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<boolean, Fs>> {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.has", args, '`s.db.query({ table, where, returnType: "exists" })` to test a condition');
  assertKnownKeys(`Statement "s.db.has"`, args, DB_HAS_KEYS);
  assertArg("s.db.has", "table", args.table, { nullable: true });
  assertValueArg("s.db.has", "fieldValue", args.fieldValue);
  return annotate(dboStatement(
    "mvp:dbo_hasby",
    args.table,
    args.as,
    [entry("field_name", fieldNameText("s.db.has", args.fieldName)), entry("field_value", args.fieldValue)],
    {},
    args.tableAlias,
  ) as DbResult<As, ApplyFilters<boolean, Fs>>, args);
}

export interface DbPatchArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /** The lookup field. A dotted path reaches an object column's sub-key or a joined table's column ({@link QualifiedCol}). */
  fieldName?: QualifiedCol<ColsOf<T>>;
  fieldValue: Value;
  /** The partial row to merge (an object value). */
  data: Value;
  /**
   * Restrict the columns of the RETURNED row (XanoScript `output = [...]`) —
   * the confirmation response only; it does not change what is written. Same
   * customized envelope as {@link DbGetArgs.output}, and offered on exactly the
   * write ops whose result is a row rather than a scalar: the editor hides the
   * customize control when a statement's whole output is a single `bool`/`int`
   * scalar (`db.del`, `db.has`), which is why those take no `output`.
   */
  output?: Cols;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the post-patch row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

const DB_PATCH_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, fieldName: 1, fieldValue: 1, data: 1, output: 1, addon: 1, as: 1 } satisfies Record<keyof DbPatchArgs, 1>);

/** `db.patch <table>` — partial-update a record by a field match (`mvp:dbo_patch`).
 * Binds the **full post-patch row**, so it's branded with `as` +
 * the row shape for `InferResponse` (throws `NotFound`/404 when nothing matches). */
export function dbPatch<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbPatchArgs<T, As, Cols, A> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>> {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.patch", args, BULK_BY_CONDITION);
  assertKnownKeys(`Statement "s.db.patch"`, args, DB_PATCH_KEYS);
  assertArg("s.db.patch", "table", args.table, { nullable: true });
  assertValueArg("s.db.patch", "fieldValue", args.fieldValue);
  assertValueArg("s.db.patch", "data", args.data);
  return annotate(dboStatement(
    "mvp:dbo_patch",
    args.table,
    args.as,
    [
      entry("field_name", fieldNameText("s.db.patch", args.fieldName)),
      entry("field_value", args.fieldValue),
      entry("item", args.data),
    ],
    { output: args.output, addon: args.addon },
    args.tableAlias,
  ) as DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>>, args);
}

export interface DbTruncateArgs extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef;
  /** Reset auto-increment counters. */
  reset?: boolean;
  as?: string;
}

const DB_TRUNCATE_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, reset: 1, as: 1 } satisfies Record<keyof DbTruncateArgs, 1>);

/** `db.truncate <table>` — empty a table (`mvp:dbo_truncate`). */
export function dbTruncate(args: DbTruncateArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.truncate"`, args, DB_TRUNCATE_KEYS);
  assertArg("s.db.truncate", "table", args.table, { nullable: true });
  // `reset?=false` — omitted when unset, matching the engine schema and editor.
  return annotate(dboStatement(
    "mvp:dbo_truncate",
    args.table,
    args.as,
    optionalFlag("s.db.truncate", "reset", args.reset) === undefined ? [] : [entry("reset", c.bool(args.reset!))],
    {},
    args.tableAlias,
  ), args);
}

/** One field of a row write: a column name, its value, and whether to skip it. */
export interface DbField {
  name: string;
  value: Value;
  /** Store with `ignore:true` (system/readonly column not written), e.g. `id`. */
  ignore?: boolean;
  /**
   * Sub-entries for an object column: the engine builds the column's value from
   * these, keyed by each child's name, recursively (stored `expand:true`). The
   * entry's own `value` is still written — real workspaces carry either an empty
   * constant or a reference to the object the children were derived from — so it
   * stays authored rather than derived.
   */
  children?: DbField[];
}

function rowEntries(data: DbField[]): RichInput[] {
  return data.map((f) =>
    entry(f.name, f.value, f.ignore ?? false, f.children ? rowEntries(f.children) : []),
  );
}

/**
 * A row cell: any authored {@link Value} **except** a `col()` reference. A `col()`
 * (bare or wrapped in `withFilters`) does not resolve to the row's stored value
 * inside a `db.edit`/`db.add` `row` — it evaluates to `null` at runtime and a
 * following `fl.add(1)` aborts the engine. The `__col?: never` bound
 * turns that live-only failure into a compile error; read the row first and pipe
 * `ref("...")` through the filter instead.
 */
export type RowCell = Value & { readonly __col?: never };

/**
 * A nested cell: sub-keys written into an object column, keyed by name. Each
 * leaf is still a {@link RowCell}, so the `col()` guard above holds at every
 * depth — nesting adds a level, never an escape hatch.
 *
 * The column's own stored value is written as an empty constant, which is what
 * the overwhelming majority of real expanded entries carry. The one shape this
 * cannot express is an expanded column whose own value is a reference (the
 * editor seeds the children from it); author that through `data:` with explicit
 * `children`, which controls every byte.
 */
export type NestedCell<C extends string = string> = { readonly [K in C]?: RowCell | NestedCell };

/** Recover a table handle's inferred row type, falling back to `unknown` for a bare name. */
type RowsOf<T> = T extends TableDef<string, infer Row> ? Row : unknown;

/**
 * A partial row keyed by column name — the values to write. Unspecified columns
 * get a type default on `db.add`; on `db.edit` they are marked `ignore:true` and
 * keep their stored value instead (see `expandRow`).
 *
 * A cell is a tagged {@link Value}, a {@link NestedCell}, or a bare
 * JS literal typed against that column ({@link ScalarCell}), which `expandRow`
 * coerces to the constant the author would otherwise have written by hand.
 */
export type RowMap<C extends string = string, Row = unknown> = Partial<{
  [K in C]: ProtoKeySafe<K, RowCell | NestedCell | ScalarCell<K extends keyof Row ? Row[K] : unknown>>;
}>;

/**
 * Schema-driven row expansion (DX convenience — *reachable, not byte-verified*).
 *
 * Authoring `data: DbField[]` gives exact control over every entry; passing
 * `row: { … }` instead lets xanosdk expand a *partial* row against the table's
 * own declared columns: it emits one entry per column (in schema order), using
 * the author's value where given and, for unmentioned columns, a documented type
 * default on `add` — or `ignore:true` on `edit` (preserving the stored value; see
 * the `ignore` heuristic below).
 *
 * This is **not** a byte-for-byte clone of the engine's editor template. That
 * template (column ordering, the injected `@meta` system column, and the per-op
 * `ignore` flags) is produced by the frontend, not by any engine rule, and the
 * persisted goldens disagree on it — so we don't chase it. The engine's import
 * path accepts whatever `input[]` entries it's given, so this expansion is
 * correct-by-construction for import; it just won't equal a captured UI fixture.
 *
 * Defaults: the column's declared `default` (as a const) if non-empty, else
 * `[]` for list/array columns, `{}` for `obj`/`json`, else `null`. The `ignore`
 * heuristic marks the primary-key `id` (always) and, on edit, `created_at` —
 * the read-only/system columns the engine never writes. On **edit**, a column
 * the author did not mention is *also* marked `ignore:true`: a partial edit
 * touches only the keys supplied, so an unmentioned column keeps its stored
 * value instead of being overwritten with a type default. On
 * **add** there is no stored value to preserve, so unmentioned columns still
 * emit their type default (`ignore:false`) to fill the new row.
 *
 * Both rules were DX guesses — no engine rule produces them — and both were
 * measured against a live engine on 2026-08-26 by
 * `scripts/probe-row-expansion.ts`, which carries the run's output.
 *
 * The `ignore` heuristic holds: a partial `edit` naming one column wrote that
 * column and left nine others byte-identical, across every scalar type plus
 * nullable, list and json columns. Expansion is accepted and not lossy.
 *
 * The type defaults hold too, but read the word "null" above precisely — it is
 * what the SDK EMITS, not what the row ends up holding. The engine applies the
 * column's own nullability to it: a nullable column keeps `null`, and a
 * non-nullable one coerces to that type's zero value. So an unmentioned column
 * on `add` lands as `""` (text), `0` (int/decimal/timestamp), `false` (bool),
 * `[]` (list) or `{}` (json) unless the column is nullable. Author the row
 * through `data: DbField[]` when a specific stored value matters more than the
 * convenience.
 */
const SYSTEM_IGNORE: Record<"add" | "edit", ReadonlySet<string>> = {
  add: new Set(["id"]),
  edit: new Set(["id", "created_at"]),
};

function defaultCell(col: ColumnDef): Value {
  if (col.default !== undefined && col.default !== "") return c.text(String(col.default));
  if (isListColumn(col)) return c.array([]);
  if (col.type === "obj" || col.type === "json") return c.obj({});
  return c.null();
}

/** Resolve the table's column list, requiring the full table def (a bare name carries no schema). */
function columnsOf(table: ObjectRef, statement: string): ColumnDef[] {
  if (typeof table === "object" && "schema" in table && (table as TableDef).schema) {
    return tableColumns(table as TableDef);
  }
  throw new Error(
    `Statement "${statement}": \`row\` expansion needs the table definition (with a schema). Pass the table object, ` +
      "or author the row explicitly via `data: [...]`.",
  );
}

/**
 * Narrow an unbound (`null`) table where a bound one is structurally required.
 *
 * `table: null` exists to REPRESENT a broken statement, not to author one, so the
 * surfaces that read the table's schema — `row:`'s column expansion — have
 * nothing to work from. A decoded broken statement always carries `data:` (the
 * stored `input[]` verbatim) and never `row:`, so this is unreachable from the
 * read path and only fires on a hand-authored `null`.
 */
function requireBoundTable(table: ObjectRef | null, argName: string, statement: string): ObjectRef {
  if (table === null) {
    throw new Error(
      `Statement "${statement}": \`${argName}\` needs the table's columns, but \`table\` is null (an unbound ` +
        "statement). `table: null` represents a statement whose table was deleted — fix the " +
        `binding, or pass the row values as \`data:\` instead of \`${argName}:\`.`,
    );
  }
  return table;
}

/**
 * The field list a row write stores: `row:` expanded against the table's
 * columns, else `data:` checked. A `row: null` (through `any`) is refused by
 * name rather than falling into the expansion and blaming the table.
 */
function rowFields(
  statement: string,
  op: "add" | "edit",
  // `unknown`: a generic `RowMap<ColsOf<T>>` does not assign to `RowMap<string>`
  // once a prototype-named key widens its cell; the checks below narrow it.
  args: { table: ObjectRef | null; row?: unknown; data?: DbField[] },
): DbField[] {
  if (args.row === null) {
    throw new Error(
      `Statement "${statement}": argument "row" must be a record of column values — got null. ` +
        "Pass `row: { … }`, or the field list as `data: [...]`.",
    );
  }
  // Through `any`, `row: 5` read as a record with no keys (an all-default row)
  // and `row: "x"` as `{ 0: "x" }` (`row "0" is not a column`). A tagged value
  // is refused here too: it is one value, not a record of column values.
  if (args.row !== undefined && (!isRecordArg(args.row) || isTaggedArg(args.row))) {
    throw new Error(
      `Statement "${statement}": argument "row" must be a record of column values — got ${describeEntry(args.row)}. ` +
        "Pass `row: { column: value, … }`, or the field list as `data: [...]`.",
    );
  }
  return args.row !== undefined
    ? expandRow(requireBoundTable(args.table, "row", statement), args.row as RowMap, op, statement)
    : fieldList(args.data, statement);
}

/**
 * A row write's `data`, checked to be the field list it is typed as.
 *
 * `data` is `[{ name, value }]` and `row` is the column-keyed record; the two
 * read alike, and a compile without a typecheck (the CLI's `export`/`deploy`)
 * lets a record through as `data`, where it failed as a bare
 * `data.map is not a function`. Name the argument and the fix instead.
 */
function fieldList(data: DbField[] | undefined, statement: string): DbField[] {
  if (data === undefined) return [];
  const hint =
    `Statement "${statement}": \`data\` takes the field list \`[{ name: "col", value: ... }]\`, but got ` +
    `${Array.isArray(data) ? "" : "an object"}`;
  const fix = " To write a row keyed by column name, pass it as `row: { ... }`.";
  if (!Array.isArray(data)) throw new Error(`${hint}.${fix}`);
  const bad = (data as unknown[]).findIndex(
    (entry) => !entry || typeof entry !== "object" || typeof (entry as { name?: unknown }).name !== "string",
  );
  if (bad !== -1) throw new Error(`${hint}entry ${bad} with no string \`name\`.${fix}`);
  return data;
}

function expandRow(table: ObjectRef, row: RowMap, op: "add" | "edit", statement: string): DbField[] {
  const cols = columnsOf(table, statement);
  const colNames = new Set(cols.map((col) => col.name));
  for (const key of Object.keys(row)) {
    if (!colNames.has(key)) {
      const name = typeof table === "string" ? table : table.name;
      throw new Error(`Statement "${statement}": row "${key}" is not a column of table "${name}".`);
    }
  }
  const systemIgnore = SYSTEM_IGNORE[op];
  return cols.map((col) => {
    // An OWN key only: a column named after an `Object.prototype` member
    // (`constructor`, `toString`) that the row omits read the inherited function
    // and was refused as "expected a tagged value, got a function".
    const cell = Object.hasOwn(row, col.name) ? row[col.name] : undefined;
    const supplied = cell !== undefined;
    // On edit, a column the author didn't mention must be left untouched
    // (`ignore:true`) — otherwise the partial edit overwrites it with a type
    // default, wiping the stored value. On add there is nothing to
    // preserve, so unmentioned columns still emit their type default.
    const ignore = systemIgnore.has(col.name) || (op === "edit" && !supplied);
    if (supplied) assertCellShape(statement, col.name, cell);
    if (supplied && isNestedCell(cell)) {
      return { name: col.name, value: c.text(""), ignore, children: nestedFields(cell, statement, col.name) };
    }
    // A supplied cell that is neither an object nor a FUNCTION is a bare literal
    // (or `null`), which is accepted and `coerceCell` turns into the constant the
    // column declares. Everything else is already a `Value` and passes through
    // untouched.
    //
    // The function arm is load-bearing: a trigger field accessor (`t.new`) is a
    // CALLABLE Value carrying `{value,tag,filters}` as properties, so
    // a `typeof === "object"` test alone drops it into the literal path and
    // refuses a cell that has always encoded correctly.
    const isCell = typeof cell === "object" ? cell !== null : typeof cell === "function";
    const value = !supplied
      ? defaultCell(col)
      : isCell
        ? (cell as RowCell)
        : coerceCell(table, col, cell as string | number | boolean | null);
    return { name: col.name, value, ignore };
  });
}

/**
 * A cell is nested when it is a plain object that is not a {@link Value}. Tested
 * against the whole `Value` shape rather than the presence of `tag` alone: a
 * nested cell's keys are sub-key names, and one of them may well *be* `"tag"` —
 * but its own value is then a cell (an object), never the string a `Value` holds.
 *
 * A non-object cell is never nested, whatever the types were told.
 * A bare string reached this as "not a Value, so it must be nested" and was
 * walked key-by-key — `Object.entries("a@b.com")` yields its characters, each a
 * string, each nested again — until the stack ran out. Falling through to the
 * value path instead hands it to {@link assertInputValue}, which names the column.
 */
function isNestedCell(cell: unknown): cell is NestedCell {
  if (typeof cell !== "object" || cell === null || Array.isArray(cell)) return false;
  // Only a PLAIN object is a sub-key map. A Date has no own keys, so it was
  // "nested" with no children and encoded silently as "".
  const proto = Object.getPrototypeOf(cell) as object | null;
  if (proto !== null && proto !== Object.prototype) return false;
  const v = cell as Partial<Value>;
  return !(typeof v.tag === "string" && typeof v.value === "string" && Array.isArray(v.filters));
}

/**
 * Refuse, by column path, a cell no encoding carries: a class instance (a
 * `Date`, a `Map`, a `URL`) that is neither a tagged value nor a plain
 * `{ sub: cell }` map, and a bigint or symbol, which have no bare-literal form.
 * Reachable through `any`; a `Date` encoded silently as `""`, and a bigint
 * crashed inside the refusal's own `JSON.stringify`.
 */
function assertCellShape(statement: string, path: string, cell: unknown): void {
  if (typeof cell === "bigint" || typeof cell === "symbol") {
    throw new Error(
      `Statement "${statement}": row "${path}" is ${describeEntry(cell)}, which has no bare-literal form — ` +
        "write it as a tagged value (`c.int(…)`, `c.text(…)`).",
    );
  }
  if (typeof cell !== "object" || cell === null || Array.isArray(cell) || isTaggedArg(cell)) return;
  const proto = Object.getPrototypeOf(cell) as object | null;
  if (proto === null || proto === Object.prototype) return;
  const hint =
    cell instanceof Date
      ? " For a timestamp write `c.text(date.toISOString())` or `c.int(date.getTime())`, or `c.now()` for the request time."
      : "";
  throw new Error(
    `Statement "${statement}": row "${path}" is ${describeArg(cell)} — a cell is a tagged value (\`c.*\`, \`ref()\`, ` +
      `\`inp()\`, …), a bare literal, or a plain \`{ sub: cell }\` object.${hint}`,
  );
}

/** Expand a nested cell into child entries, recursing through deeper nesting. */
function nestedFields(cell: NestedCell, statement: string, path: string): DbField[] {
  return Object.entries(cell).map(([name, value]) => {
    const child = value as RowCell | NestedCell;
    assertCellShape(statement, `${path}.${name}`, child);
    return isNestedCell(child)
      ? { name, value: c.text(""), children: nestedFields(child, statement, `${path}.${name}`) }
      : { name, value: child };
  });
}

export interface DbAddArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  /**
   * Refuse to auto-wire request inputs the endpoint did not explicitly bind.
   *
   * A row write auto-wires any column whose name matches an incoming request
   * input, which is convenient and is also how a caller can reach a column the
   * endpoint never meant to expose. With this on, the engine consults the
   * endpoint's declared inputs and skips auto-wiring anything outside them;
   * explicit `data`/`row` entries are unaffected, because those are bindings you
   * wrote.
   *
   * Off by default, matching the engine's own default — so leaving it unset
   * writes nothing and changes nothing. Reach for it on any write whose table
   * has a column a caller must not set (`role`, `is_admin`, `credits`).
   */
  enforceHiddenFields?: boolean;

  table: DbTableRef<T>;
  /** The row to insert as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /** A partial row keyed by column name; expanded against the table's declared columns. */
  row?: RowMap<ColsOf<T>, RowsOf<T>>;
  /**
   * Restrict the columns of the RETURNED row (XanoScript `output = [...]`) —
   * the confirmation response only; it does not change what is written. Same
   * customized envelope as {@link DbGetArgs.output}, and offered on exactly the
   * write ops whose result is a row rather than a scalar: the editor hides the
   * customize control when a statement's whole output is a single `bool`/`int`
   * scalar (`db.del`, `db.has`), which is why those take no `output`.
   */
  output?: Cols;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the inserted row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

const DB_ADD_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, enforceHiddenFields: 1, table: 1, data: 1, row: 1, output: 1, addon: 1, as: 1 } satisfies Record<keyof DbAddArgs, 1>);

/** `db.add <table>` — insert a record (`mvp:dbo_add`). Binds the **full inserted
 * row** (including the auto-assigned `id`/`created_at`), so it's branded with
 * `as` + the row shape for `InferResponse`. */
export function dbAdd<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbAddArgs<T, As, Cols, A> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.add"`, args, DB_ADD_KEYS);
  assertArg("s.db.add", "table", args.table, { nullable: true });
  const data = rowFields("s.db.add", "add", args);
  return annotate(dboStatement(
    "mvp:dbo_add",
    args.table,
    args.as,
    rowEntries(data),
    { output: args.output, addon: args.addon },
    args.tableAlias,
    args.enforceHiddenFields,
  ) as DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>>, args);
}

export interface DbEditArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  /**
   * Refuse to auto-wire request inputs the endpoint did not explicitly bind.
   *
   * A row write auto-wires any column whose name matches an incoming request
   * input, which is convenient and is also how a caller can reach a column the
   * endpoint never meant to expose. With this on, the engine consults the
   * endpoint's declared inputs and skips auto-wiring anything outside them;
   * explicit `data`/`row` entries are unaffected, because those are bindings you
   * wrote.
   *
   * Off by default, matching the engine's own default — so leaving it unset
   * writes nothing and changes nothing. Reach for it on any write whose table
   * has a column a caller must not set (`role`, `is_admin`, `credits`).
   */
  enforceHiddenFields?: boolean;

  table: DbTableRef<T>;
  /** The lookup field. A dotted path reaches an object column's sub-key or a joined table's column ({@link QualifiedCol}). */
  fieldName?: QualifiedCol<ColsOf<T>>;
  fieldValue: Value;
  /** The new field values as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /**
   * A **partial** row keyed by column name: only the columns you list are
   * written. Columns you omit are emitted with `ignore:true` and keep their
   * stored value — a `{ votes }` edit updates `votes` alone and leaves every
   * other column intact. Expanded against the table's declared
   * columns. Use `data` for byte-exact control over each entry's `ignore` flag.
   */
  row?: RowMap<ColsOf<T>, RowsOf<T>>;
  /**
   * Restrict the columns of the RETURNED row (XanoScript `output = [...]`) —
   * the confirmation response only; it does not change what is written. Same
   * customized envelope as {@link DbGetArgs.output}, and offered on exactly the
   * write ops whose result is a row rather than a scalar: the editor hides the
   * customize control when a statement's whole output is a single `bool`/`int`
   * scalar (`db.del`, `db.has`), which is why those take no `output`.
   */
  output?: Cols;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the post-mutation row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

const DB_EDIT_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, enforceHiddenFields: 1, table: 1, fieldName: 1, fieldValue: 1, data: 1, row: 1, output: 1, addon: 1, as: 1 } satisfies Record<keyof DbEditArgs, 1>);

/** `db.edit <table>` — update a record matched by a field (`mvp:dbo_editby`).
 * Binds the **full post-mutation row** (the freshly-written values), so it's
 * branded with `as` + the row shape for `InferResponse` (throws `NotFound`/404
 * when nothing matches). */
export function dbEdit<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbEditArgs<T, As, Cols, A> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>> {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.edit", args, BULK_BY_CONDITION);
  assertKnownKeys(`Statement "s.db.edit"`, args, DB_EDIT_KEYS);
  assertArg("s.db.edit", "table", args.table, { nullable: true });
  assertValueArg("s.db.edit", "fieldValue", args.fieldValue);
  const data = rowFields("s.db.edit", "edit", args);
  return annotate(dboStatement(
    "mvp:dbo_editby",
    args.table,
    args.as,
    [
      entry("field_name", fieldNameText("s.db.edit", args.fieldName)),
      entry("field_value", args.fieldValue),
      ...rowEntries(data),
    ],
    { output: args.output, addon: args.addon },
    args.tableAlias,
    args.enforceHiddenFields,
  ) as DbResult<As, ApplyFilters<WithAddons<RowShapeOf<T, Cols>, A>, Fs>>, args);
}

/**
 * `db.add_or_edit` (`mvp:dbo_addoreditby`) — upsert: edit the row matched by
 * `fieldName`/`fieldValue` if it exists, else insert. Its persisted fixture is a
 * *leaner* serialization generation than the `dbo_add`/`dbo_editby` family:
 *
 * - input entries are the lean `{name,value,tag,filters}` form (no
 *   `expand`/`children`), and only the row `data` entries carry an `ignore`
 *   flag — the `field_name`/`field_value` lookup pair never do;
 * - `context.dbo` additionally carries the table's `as` (its name) beside `id`;
 * - there is no rich `description`/`settings_registry`/`output`/`addon` envelope.
 *
 * Matched correct-by-construction against the golden, same posture as the rest
 * of the db family.
 */

export interface DbAddOrEditArgs<T extends ObjectRef = ObjectRef, As extends string = string> extends StatementOptions {
  /**
   * Refuse to auto-wire request inputs the endpoint did not explicitly bind.
   *
   * A row write auto-wires any column whose name matches an incoming request
   * input, which is convenient and is also how a caller can reach a column the
   * endpoint never meant to expose. With this on, the engine consults the
   * endpoint's declared inputs and skips auto-wiring anything outside them;
   * explicit `data`/`row` entries are unaffected, because those are bindings you
   * wrote.
   *
   * Off by default, matching the engine's own default — so leaving it unset
   * writes nothing and changes nothing. Reach for it on any write whose table
   * has a column a caller must not set (`role`, `is_admin`, `credits`).
   */
  enforceHiddenFields?: boolean;

  table: DbTableRef<T>;
  /** The match field (defaults to the primary key `id`). */
  /** The lookup field. A dotted path reaches an object column's sub-key or a joined table's column ({@link QualifiedCol}). */
  fieldName?: QualifiedCol<ColsOf<T>>;
  /** The value to match for the edit branch. */
  fieldValue: Value;
  /** The row to upsert as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /** A partial row keyed by column name; expanded against the table's declared columns. */
  row?: RowMap<ColsOf<T>, RowsOf<T>>;
  /** Capture the upserted row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;
}

const DB_ADD_OR_EDIT_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, enforceHiddenFields: 1, table: 1, fieldName: 1, fieldValue: 1, data: 1, row: 1, as: 1 } satisfies Record<keyof DbAddOrEditArgs, 1>);

/** `db.add_or_edit <table>` — upsert a record by a field match (`mvp:dbo_addoreditby`).
 * Binds the **full upserted row** (`$inst->toArray()`, the edit-or-insert result),
 * so it's branded with `as` + the row shape for `InferResponse`. */
export function dbAddOrEdit<T extends ObjectRef, const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbAddOrEditArgs<T, As> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<FullRowShapeOf<T>, Fs>> {
  args = argsOrEmpty(args);
  assertNoWhere("s.db.add_or_edit", args, '`s.db.query({ table, where, returnType: "single" })` first to find the row');
  assertKnownKeys(`Statement "s.db.add_or_edit"`, args, DB_ADD_OR_EDIT_KEYS);
  assertArg("s.db.add_or_edit", "table", args.table, { nullable: true });
  assertValueArg("s.db.add_or_edit", "fieldValue", args.fieldValue);
  const data = rowFields("s.db.add_or_edit", "edit", args);
  const input: Array<LeanInput & { ignore?: boolean }> = [
    leanInput("field_name", fieldNameText("s.db.add_or_edit", args.fieldName)),
    leanInput("field_value", args.fieldValue),
    ...data.map((f) => ({ ignore: f.ignore ?? false, ...leanInput(f.name, f.value) })),
  ];
  return annotate({
    name: "mvp:dbo_addoreditby",
    context: {
      dbo: dboBinding(args.table, args.tableAlias, "mvp:dbo_addoreditby"),
      ...(args.enforceHiddenFields === true ? { enforce_hidden_fields: true } : {}),
    },
    as: args.as ?? "",
    input,
  } as DbResult<As, ApplyFilters<FullRowShapeOf<T>, Fs>>, args);
}

export interface DbSchemaArgs extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef;
  /** Dot-path into the schema to read. */
  path: Value;
  as?: string;
}

const DB_SCHEMA_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, path: 1, as: 1 } satisfies Record<keyof DbSchemaArgs, 1>);

/** `db.schema <table>` — read a table's schema (`mvp:dbo_get_schema`). */
export function dbSchema(args: DbSchemaArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.schema"`, args, DB_SCHEMA_KEYS);
  assertArg("s.db.schema", "table", args.table, { nullable: true });
  assertValueArg("s.db.schema", "path", args.path);
  return annotate(dboStatement(
    "mvp:dbo_get_schema",
    args.table,
    args.as,
    [entry("path", args.path)],
    {},
    args.tableAlias,
  ), args);
}

/**
 * Result shape of a raw-SQL query (default `"list"`). The engine reads a closed
 * set — `"list"` binds every row, `"single"` the first — and a value outside it
 * is refused at the call rather than stored.
 */
export const DB_RESPONSE_TYPES = ["list", "single"] as const;
export type DbResponseType = (typeof DB_RESPONSE_TYPES)[number];

/** The `parser` members the engine reads. See {@link DbSqlParser}. */
const DB_SQL_PARSERS = ["prepared", "template_engine"] as const;

/** Refuse an out-of-set `responseType`/`parser` that `any` let through. */
function assertSqlEnums(statement: string, args: { responseType?: unknown; parser?: unknown }): void {
  assertOneOf(statement, "responseType", args.responseType, DB_RESPONSE_TYPES);
  assertOneOf(statement, "parser", args.parser, DB_SQL_PARSERS);
}

/**
 * How the SQL body is interpolated before it runs.
 *
 * `"prepared"` (the engine default) substitutes the positional `args` as bound
 * parameters. `"template_engine"` renders the body as a template first, which is
 * what lets a query interpolate structure — a column list, a table name — that a
 * bound parameter cannot carry. It changes how the statement executes, so it is
 * authored rather than inferred, and the key is written only when set: the
 * engine defaults it and omits it at the default.
 */
export type DbSqlParser = "prepared" | "template_engine";

export interface DbDirectQueryArgs extends StatementOptions {
  /** The raw SQL to run (stored verbatim as `context.code`). */
  sql: string;
  /** Result shape: `"list"` (default) or `"single"`. */
  responseType?: DbResponseType;
  /** Positional bind arguments — each a tagged value (filters preserved). */
  args?: Value[];
  /** How the SQL body is interpolated. See {@link DbSqlParser}. */
  parser?: DbSqlParser;
  /** Capture the result into this stack variable. */
  as?: string;
}

const DB_DIRECT_QUERY_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, sql: 1, responseType: 1, args: 1, parser: 1, as: 1 } satisfies Record<keyof DbDirectQueryArgs, 1>);

/**
 * `db.direct_query` (`mvp:dbo_direct_query`) — execute raw SQL against the
 * workspace database. Unlike the `!map:dbo` family it references no table, so
 * `context` carries the SQL (`code`), the `response_type`, and the positional
 * `arg[]` bind values instead of a `dbo.id`. It keeps the same rich envelope.
 */
export function dbDirectQuery(args: DbDirectQueryArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.direct_query"`, args, DB_DIRECT_QUERY_KEYS);
  // PASSED ALONG, not dereferenced, so nothing else would notice its absence:
  // `context.code` would simply be `undefined`, the statement would deploy, and
  // the engine would run an empty query at HTTP 200. `scripts/special-required.ts`
  // is the audit that finds this class of hole.
  assertArg("s.db.direct_query", "sql", args.sql);
  assertListArg("s.db.direct_query", "args", args.args, SQL_ARG_ITEM);
  assertSqlEnums("s.db.direct_query", args);
  return annotate({
    name: "mvp:dbo_direct_query",
    context: {
      code: args.sql,
      response_type: args.responseType ?? "list",
      ...(args.parser === undefined ? {} : { parser: args.parser }),
      arg: (args.args ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
    },
    as: args.as ?? "",
    input: [],
    ...envelope(),
  }, args);
}

// ---------------------------------------------------------------------------
// Structural specials below (no persisted fixture yet — shapes are modeled on
// the verified db family and the engine schema blocks, reachable now and to be
// byte-verified once a golden is vendored). Each keeps the rich db envelope and
// the `context.dbo.id` table reference where the engine schema implies one.
//
// bulk add/patch/update/delete and one external-SQL engine (postgres) are
//   golden-verified against live engine captures (see the conformance corpus):
//   context.dbo.id + LEAN input[items], the captured input order, and `as` storage
//   are confirmed for the bulk ops; bulk.delete's context.search matches the
//   dbo_view search reader. db.query (mvp:dbo_view) is golden-verified in
//   db-query-shape.test.ts (context.search {expression[]}, return.list.{sort,paging},
//   output envelope).
//   @TODO(byte-verify): external SQL captured for postgres only; mssql/mysql/oracle/
//   snowflake share the format and stay modeled-by-analogy (1 of 5 captured).
// ---------------------------------------------------------------------------

export interface DbBulkAddArgs extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef;
  /** The rows to insert (an array value). */
  items: Value;
  /**
   * Honor an explicit `id` on each row (`allow_id_field`).
   *
   * ⚠ **Unset/`false` means the engine STRIPS `id` from every item** and assigns
   * the next sequence value instead — silently, with no error and no warning.
   * The rows then sit at ids nothing else expects, which surfaces much later as
   * a foreign key pointing at the wrong row.
   *
   * This is the opposite of a `table` `seed`, where supplying `id` pins it. If
   * you are inserting rows whose ids other rows reference, set this to `true`.
   * Set it to `false` explicitly to state that engine-assigned ids are intended.
   */
  allowIdField?: boolean;
  as?: string;
}

/**
 * Reject a `bulk.add` whose literal rows carry an `id` the engine would throw
 * away.
 *
 * Only fires where the rows are actually READABLE — an unfiltered `const:array`
 * literal. A `ref`/`inp` items value is a runtime variable whose contents cannot
 * be known here, and a filtered literal has been reshaped by its chain, so both
 * are left alone rather than guessed at. That makes this a partial net by
 * construction; the `allowIdField` doc and the manifest entry carry the rest.
 *
 * It does not fire on PULLED code either: the editor stores `allow_id_field`
 * explicitly (see the `db_bulk_add` golden, which recorded it present and
 * `false`), so codegen emits an explicit `allowIdField` and takes the early
 * return. Only hand-authored SDK code that never mentions the gate reaches the
 * throw — which is the code that was silently losing ids.
 */
function assertBulkAddIds(args: DbBulkAddArgs): void {
  if (args.allowIdField !== undefined && args.allowIdField !== null) return;
  const items = args.items;
  if (items.tag !== "const:array" || items.filters.length > 0) return;
  let rows: unknown;
  try {
    rows = JSON.parse(items.value);
  } catch {
    return;
  }
  if (!Array.isArray(rows)) return;
  const withId = rows.findIndex(
    (r) => typeof r === "object" && r !== null && !Array.isArray(r) && "id" in r,
  );
  if (withId === -1) return;
  throw new Error(
    `Statement "s.db.bulk.add": item ${withId} carries an \`id\`, but \`allowIdField\` is not set — the engine ` +
      `DROPS \`id\` from every row unless it is on, assigning the next sequence value instead, ` +
      `with no error. Rows land at ids nothing else expects and foreign keys written against ` +
      `them point at the wrong rows. Pass \`allowIdField: true\` to pin the ids you supplied, ` +
      `or \`allowIdField: false\` to state that engine-assigned ids are intended. (Unlike a table ` +
      `\`seed\`, where supplying \`id\` pins it.)`,
  );
}

/**
 * Lean bulk-op envelope, modeled on the engine's bulk-op format: `context.dbo.id` + LEAN
 * input entries (`{name,value,tag,filters}`), and
 * — unlike the rich db family — NO rich envelope (decode never reads
 * output/addon/etc). The leaner serialization generation, same as add_or_edit.
 */
function bulkStatement(
  name: string,
  table: ObjectRef | null,
  as: string | undefined,
  input: LeanInput[],
  tableAlias?: string,
): Statement {
  return { name, context: { dbo: dboBinding(table, tableAlias, name) }, as: as ?? "", input };
}

/**
 * `db.bulk.add <table>` — insert many rows (`mvp:dbo_bulkadd`).
 *
 * ⚠ An `id` on a row is DISCARDED unless {@link DbBulkAddArgs.allowIdField} is
 * `true` — see that field. Literal rows carrying one are rejected here rather
 * than silently renumbered by the engine.
 */
export function dbBulkAdd(args: DbBulkAddArgs): Statement {
  args = argsOrEmpty(args);
  assertBulkWriteKeys("s.db.bulk.add", args, ["allowIdField"]);
  assertArg("s.db.bulk.add", "table", args.table, { nullable: true });
  assertValueArg("s.db.bulk.add", "items", args.items);
  assertBulkAddIds(args);
  // `allow_id_field?=false` — omitted when unset (engine schema + editor).
  return annotate(bulkStatement("mvp:dbo_bulkadd", args.table, args.as, [
    ...(optionalFlag("s.db.bulk.add", "allowIdField", args.allowIdField) === undefined
      ? []
      : [leanInput("allow_id_field", c.bool(args.allowIdField!))]),
    leanInput("items", args.items),
  ], args.tableAlias), args);
}

export interface DbBulkDeleteArgs<As extends string = string> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef;
  /**
   * Filter selecting which rows to delete — the same `where` surface as
   * `s.db.query`: `expr(...)`/`cmp(...)` comparisons, `and(...)`/`or(...)` groups,
   * an array of those (ANDed), or a raw `Value`. Encoded into `context.search`
   * via {@link encodeSearch}. **A `where` that constrains nothing deletes every
   * row in the table**, which is why it requires {@link DbBulkDeleteArgs.allRows}.
   */
  where?: DbWhere;
  /**
   * Delete EVERY row: the explicit opt-in a `where`-less bulk delete requires.
   *
   * A filter-less delete is a truncate, and the shape that reaches it — forgetting
   * the predicate — looks identical to the shape that meant it. Saying so costs one
   * word and cannot be typed by accident. Passing both this and a `where` is a
   * contradiction and throws.
   *
   * Emits an EMPTY-GROUP `context.search`, which is what the engine accepts as
   * "every row" — omitting the key entirely is refused with
   * `Missing param: search`. Use `s.db.truncate({ reset: true })` when
   * the id sequence should restart too; this one returns the deleted count.
   */
  allRows?: true;
  /** Capture the deleted-row count into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/**
 * Does this encoded `context.search` actually narrow the rows it matches?
 *
 * "Has a search" is not the same as "has a filter". `where: or()` encodes an
 * empty `{expression: []}` and `where: and()` encodes one empty GROUP; both are
 * byte-equivalent to no search at all and match every row. The realistic path
 * there is a clause list built dynamically that comes out empty — exactly the
 * shape a full-table delete must not reach by accident.
 *
 * Exported for the codegen inverse, which has to reach the same verdict about a
 * STORED search so the source it generates re-encodes to the same bytes.
 */
export function searchConstrainsRows(search: unknown): boolean {
  if (search === undefined || search === null) return false;
  const expression = (search as { expression?: unknown }).expression;
  // Not an `{expression: […]}` tree at all — a raw `Value` escape hatch, whose
  // contents cannot be read here. Assume it constrains rather than accuse it.
  if (!Array.isArray(expression)) return true;
  // Each entry after the first with `or: true` starts a new OR-term; the entries
  // of one term AND together. A term that constrains nothing matches every row,
  // so `x OR and()` is no filter at all: the search constrains only when EVERY
  // term does. This is the engine's own reading of an unconstrained where.
  let termConstrains = false;
  for (const [i, entry] of expression.entries()) {
    const e = entry as { type?: unknown; or?: unknown; group?: unknown };
    if (i > 0 && e?.or === true) {
      if (!termConstrains) return false;
      termConstrains = false;
    }
    // A group constrains only if something inside it does: `and()` with no
    // members encodes as one empty group and matches every row.
    termConstrains ||= e?.type === "group" ? searchConstrainsRows(e.group) : true;
  }
  return termConstrains;
}

/** Whether an `ignoreEmpty` comparison is never, sometimes or always removed at run time. */
type Drop = "never" | "maybe" | "always";

/**
 * Can this search match every row once the engine has removed the `ignoreEmpty`
 * comparisons whose operand is empty?
 *
 * The engine applies a level's entries in order, each joined by its own `or`
 * flag (AND binds tighter), and SKIPS an `ignoreEmpty` comparison with an empty
 * operand — its joiner goes with it. A group whose entries were all skipped is
 * not skipped: it applies as `true`. So a level matches every row when nothing
 * in it applies, or when one of its OR-terms ends up holding only such groups.
 * Every way of emptying the operands is considered; a literal operand is as
 * empty as it is written.
 */
function searchCanMatchEveryRow(search: unknown): boolean {
  const expression = (search as { expression?: unknown } | null | undefined)?.expression;
  if (!Array.isArray(expression)) return false;
  const items = expression.map((entry) => {
    const e = entry as { type?: unknown; or?: unknown; group?: unknown } | null;
    return e?.type === "group"
      ? { or: e.or === true, group: true, canBeTrue: searchCanMatchEveryRow(e.group), drop: "never" as Drop }
      : { or: e?.or === true, group: false, canBeTrue: false, drop: dropOf(entry) };
  });
  // Nothing applies: every entry is a comparison that can be removed.
  if (items.every((i) => !i.group && i.drop !== "never")) return true;
  for (const [start, item] of items.entries()) {
    if (!item.canBeTrue) continue;
    // The term starts here: an OR joins it, or everything before it is removed.
    if (!item.or && !items.slice(0, start).every((i) => !i.group && i.drop !== "never")) continue;
    let allTrue = true;
    for (const next of items.slice(start + 1)) {
      // An entry that applies with an OR ends the term.
      if (next.or && next.drop !== "always") break;
      if (next.canBeTrue || (!next.group && next.drop !== "never")) continue;
      allTrue = false;
      break;
    }
    if (allTrue) return true;
  }
  return false;
}

/** How an encoded comparison fares under `ignoreEmpty`: the engine removes it when either side is empty. */
function dropOf(entry: unknown): Drop {
  const statement = (entry as { statement?: { left?: unknown; right?: unknown } } | null)?.statement;
  const sides = [statement?.left, statement?.right] as Array<{ ignore_empty?: unknown; tag?: unknown; operand?: unknown; filters?: unknown } | null | undefined>;
  if (!sides.some((side) => side?.ignore_empty === true)) return "never";
  const each = sides.map(sideEmptiness);
  if (each.includes("always")) return "always";
  return each.includes("maybe") ? "maybe" : "never";
}

/** Whether one operand can be empty at run time: a column never is, a literal as written, anything else may be. */
function sideEmptiness(side: { tag?: unknown; operand?: unknown; filters?: unknown } | null | undefined): Drop {
  if (side === null || side === undefined) return "never";
  // A filter can fail on the value, and a failing filter removes the comparison too.
  if (Array.isArray(side.filters) && side.filters.length > 0) return "maybe";
  if (side.tag === "col") return "never";
  // `c.text()` encodes as a bare `const`; the typed literals as `const:<type>`.
  if (typeof side.tag !== "string" || !(side.tag === "const" || side.tag.startsWith("const:")) || typeof side.operand !== "string") return "maybe";
  const literal = side.operand.trim();
  switch (side.tag) {
    case "const:null":
      return "always";
    case "const:bool":
      return literal === "false" ? "always" : "never";
    case "const:int":
    case "const:decimal":
      return Number(literal) === 0 ? "always" : "never";
    case "const":
    case "const:text":
      return side.operand === "" || side.operand === "0" ? "always" : "never";
    case "const:array":
    case "const:obj":
      return literal === "[]" || literal === "{}" ? "always" : "never";
    default:
      return "maybe";
  }
}

/**
 * A `bulk.delete` must say which rows it deletes — a filter or `allRows`.
 *
 * `where` is optional on the wire, and a search that constrains nothing means "match
 * every row": the statement that reads as a filtered delete behaves as a
 * `truncate`. Nothing downstream can tell the two apart — the bundle is
 * well-formed, the deploy succeeds, and the request returns HTTP 200 with a
 * count. The mistake that produces it is dropping one argument, so the only
 * place the intent still exists is the call site.
 *
 * This is Xano SDK's own contract rather than a claim about the engine, which
 * accepts any search that constrains nothing as "every row". `allRows: true` and
 * `{ where: and(), allRows: true }` emit the same bytes; `codegen` passes
 * `allRows` on every pulled delete whose stored search constrains nothing, so a
 * round trip is unaffected.
 *
 * The same holds for a search that constrains rows only through `ignoreEmpty`
 * comparisons: the engine removes each one whose operand is empty, so an empty
 * list at run time leaves the delete unscoped. That one has no opt-in.
 */
function assertBulkDeleteScope(search: unknown, allRows: true | undefined): void {
  const constrains = searchConstrainsRows(search);
  if (constrains && allRows) {
    throw new Error(
      "Statement \"s.db.bulk.delete\": `where` and `allRows: true` contradict each other — `allRows` means " +
        "every row in the table. Drop one: keep `where` for a filtered delete, keep `allRows` " +
        "for a full wipe.",
    );
  }
  if (allRows) return;
  if (constrains) {
    if (!searchCanMatchEveryRow(search)) return;
    throw new Error(
      "Statement \"s.db.bulk.delete\": this deletes EVERY row in the table whenever an `ignoreEmpty` operand " +
        "is empty — `ignoreEmpty` REMOVES its comparison rather than matching zero rows, and with it gone " +
        "nothing is left to scope the delete. The fix is to drop `ignoreEmpty`: an empty list then matches no " +
        "row. To also skip the delete when the list is empty, wrap the fixed statement — wrapping it with " +
        "`ignoreEmpty` still set is refused the same way: `s.conditional({ when: expr(withFilters(inp(\"ids\"), " +
        "fl.count()), \">\", c.int(0)), then: [/* this bulk.delete, without ignoreEmpty */] })`.",
    );
  }
  throw new Error(
    "Statement \"s.db.bulk.delete\": this deletes EVERY row in the table — a filter that constrains nothing " +
      "matches all rows, so this is a truncate with a row count. (An omitted `where`, an empty " +
      "`where: []`, and an empty `and()`/`or()` group all encode to the same thing, which is " +
      "how a dynamically built clause list reaches it.) Pass the filter you meant " +
      "(`where: expr(col(\"status\"), \"=\", c.text(\"expired\"))`), or say the wipe is " +
      "deliberate with `allRows: true`.",
  );
}

const DB_BULK_DELETE_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, where: 1, allRows: 1, as: 1 } satisfies Record<keyof DbBulkDeleteArgs, 1>);

/**
 * `db.bulk.delete <table>` — delete many rows by a search (`mvp:dbo_bulkdelete`).
 * Unlike the other bulk ops, the filter rides `context.search`,
 * NOT an input entry. The `where` is encoded through the shared {@link encodeSearch}
 * — the identical operand-based `{expression:[…]}` shape `s.db.query` emits — so the
 * modern DSL (`expr`/`cmp`/`and`/`or`) is fully supported here too.
 *
 * Golden-verified against a live capture: `context.search` (shared with the
 * `dbo_view` search reader) is byte-exact. A `where` that constrains nothing —
 * an empty `and()`/`or()` group — deletes all rows and returns the count; the
 * key itself is mandatory, so `allRows` supplies the empty group.
 *
 * Binds the **deleted-row count** (the engine's `__self: int` output), so it's
 * branded with `as` + `number` for `InferResponse` — table-independent.
 */
export function dbBulkDelete<const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbBulkDeleteArgs<As> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<number, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.bulk.delete"`, args, DB_BULK_DELETE_KEYS);
  assertArg("s.db.bulk.delete", "table", args.table, { nullable: true });
  const context: Record<string, unknown> = { dbo: dboBinding(args.table, args.tableAlias, "mvp:dbo_bulkdelete") };
  const search = encodeSearch(args.where, undefined, `Statement "s.db.bulk.delete"`);
  // The stored bytes are preserved either way — an empty group is authorable
  // and round-trips — but the SCOPE is judged on what the filter constrains.
  assertBulkDeleteScope(search, args.allRows);
  // `context.search` is REQUIRED by the engine, so `allRows` cannot mean "emit
  // no search". Measured on a deployed ephemeral, 2026-08-22:
  //
  //   context without `search`           → 400 `Missing param: search`, 0 rows deleted
  //   context.search = one EMPTY group   → 200, every row deleted, count returned
  //
  // So a where-less `allRows` emits what the second line measured, spelled
  // through `encodeSearch(and())` rather than a literal so the `{ where: and(),
  // allRows: true }` form and this one cannot drift apart. `s.db.truncate` is
  // still the primitive that also RESETS the id sequence; this one reports a
  // count and leaves the sequence alone.
  context.search = search ?? encodeSearch(and());
  // Double-cast is compiler-forced, not sloppiness: this literal's `context`
  // (`Record<string, unknown>` local) and `input: never[]` don't overlap
  // `DbResult` closely enough for a direct `as` (TS2352). The brand is phantom,
  // so the runtime literal is a plain `Statement` regardless.
  return annotate({ name: "mvp:dbo_bulkdelete", context, as: args.as ?? "", input: [] } as unknown as DbResult<
    As,
    ApplyFilters<number, Fs>
  >, args);
}

export interface DbBulkWriteArgs<T extends ObjectRef = ObjectRef, As extends string = string> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /** The rows to write (an array value), each carrying its key. */
  items: Value;
  /** Capture the result into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.bulk.patch <table>` — partial-update many rows (`mvp:dbo_bulkpatch`).
 * Binds the **patched-row LIST** (the engine's `__self[]` row output), so it's
 * branded with `as` + the row-list shape for `InferResponse`. */
export function dbBulkPatch<
  T extends ObjectRef,
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
    args: DbBulkWriteArgs<T, As> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<FullRowShapeOf<T>[], Fs>> {
  args = argsOrEmpty(args);
  assertBulkWriteKeys("s.db.bulk.patch", args);
  assertArg("s.db.bulk.patch", "table", args.table, { nullable: true });
  assertValueArg("s.db.bulk.patch", "items", args.items);
  return annotate(bulkStatement(
    "mvp:dbo_bulkpatch",
    args.table,
    args.as,
    [leanInput("items", args.items)],
    args.tableAlias,
  ) as DbResult<As, ApplyFilters<FullRowShapeOf<T>[], Fs>>, args);
}

/**
 * `db.bulk.update <table>` — REPLACE many rows (`mvp:dbo_bulkupdate`).
 *
 * ⚠ **Every column an item omits is written to its zero value** (`""` / `0` /
 * `null` / `[]` / `{}`), not left alone, with an HTTP 200 and no error. This is
 * a whole-row replace: `{ id: 7, status: "done" }` sets the status and blanks
 * every other column of row 7. Confirmed in the engine — update and patch run
 * the same code, and update writes each absent column's default.
 *
 * **Use {@link dbBulkPatch} (`s.db.bulk.patch`) to write only the keys an item
 * carries.** That is what "update these titles" means; this statement is for
 * replacing rows wholesale. `export()` warns when a STATIC `items` array omits
 * columns of the bound table, and `--strict` / `export({ strict: true })` fails
 * the build on it — but an `items` built from a `ref`/`inp` cannot be inspected,
 * so nothing catches that one for you.
 *
 * Left **unbranded** (plain {@link Statement}): the engine declares no output
 * schema for `dbo_bulkupdate`/`dbo_bulkadd`, so
 * `InferResponse` faithfully resolves a returned bulk-add/update var to `unknown`
 * — matching where the engine's own OpenAPI walk falls back to `json`. Only
 * `bulk.patch` (row list) and `bulk.delete` (count) carry a static output schema.
 */
export function dbBulkUpdate(args: DbBulkWriteArgs): Statement {
  args = argsOrEmpty(args);
  assertBulkWriteKeys("s.db.bulk.update", args);
  assertArg("s.db.bulk.update", "table", args.table, { nullable: true });
  assertValueArg("s.db.bulk.update", "items", args.items);
  return annotate(bulkStatement(
    "mvp:dbo_bulkupdate",
    args.table,
    args.as,
    [leanInput("items", args.items)],
    args.tableAlias,
  ), args);
}

/** What `db.increment` binds: the updated rows (`"list"`, default) or how many changed (`"count"`). */
export type DbIncrementReturnType = "list" | "count";

/** The columns of a typed table whose read type is a single number, less the primary key — what `db.increment` accepts. */
type NumericColsOf<T> = [InferRow<T>] extends [never]
  ? string
  : Exclude<
      Extract<
        { [K in keyof InferRow<T>]-?: NonNullable<InferRow<T>[K]> extends number ? K : never }[keyof InferRow<T>],
        string
      >,
      "id"
    >;

type IncrementResult<Row, A, RT extends DbIncrementReturnType> = RT extends "count"
  ? number
  : WithAddons<Row, A>[];

export interface DbIncrementArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
  RT extends DbIncrementReturnType = DbIncrementReturnType,
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /**
   * Which rows to increment — the same `where` surface as `s.db.query`. Required,
   * and it must constrain something: the engine changes NO rows for an empty
   * filter (it never increments a whole table), so an empty one is refused here,
   * as is one OR-ed with an empty `and()`. A `==?` clause whose input arrives
   * empty drops out at run time; if that leaves nothing, the engine binds `[]`/`0`.
   * A guard in the filter is race-safe — `expr(col("stock"), ">=", c.int(1))`
   * decrements only rows that still have stock, re-checked under a row lock.
   */
  where: DbWhere;
  /** The numeric column to add to: a top-level `int` or `decimal`, not a list. A
   * `Value` names it dynamically (the engine validates it at run time). */
  fieldName: NumericColsOf<T> | Value;
  /** The amount to add; negative decrements. A fractional amount needs a
   * `decimal` column. A null stored value counts as 0. */
  value: number | Value;
  /** `"list"` (default) binds the updated rows; `"count"` binds how many changed. */
  returnType?: RT;
  /** Restrict the columns of the returned rows. List mode only. */
  output?: Cols;
  /** Attach addons to the returned rows (see {@link AddonSpec}). List mode only. */
  addon?: A;
  /** Capture the result into this stack variable. */
  as?: As;
}

/** Engine errors, raised here at build time instead: a column `db.increment` cannot add to. */
function assertIncrementColumn(table: ObjectRef | null, fieldName: string, value: number | Value): void {
  if (fieldName === "id")
    throw new Error("Statement \"s.db.increment\": \"id\" is the primary key, which the engine refuses to increment. Add to a counter column instead.");
  if (table === null || typeof table === "string" || !("schema" in table)) return;
  const column = tableColumns(table as TableDef).find((col) => col.name === fieldName);
  const where = `db.increment on "${table.name}"`;
  if (!column) throw new Error(`${where}: the table has no column "${fieldName}".`);
  if (isListColumn(column))
    throw new Error(`${where}: "${fieldName}" is a list column; db.increment adds to a single int or decimal.`);
  if (column.type !== "int" && column.type !== "decimal")
    throw new Error(`${where}: "${fieldName}" is ${withArticle(column.type)} column; db.increment adds to an int or decimal column.`);
  if (column.type === "int" && typeof value === "number" && !Number.isInteger(value))
    throw new Error(`${where}: ${value} is fractional, and "${fieldName}" is an int column. Use a whole number.`);
}

/** A plain number as the engine's tagged constant: whole → `const:int`, else `const:decimal`. */
function incrementAmount(value: number | Value): Value {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`Statement "s.db.increment": \`value\` must be a finite number, got ${value}.`);
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
    throw new Error(`Statement "s.db.increment": \`value\` ${lossyIntegerProblem(value)}`);
  return coerceScalar(value);
}

const DB_INCREMENT_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, where: 1, fieldName: 1, value: 1, returnType: 1, output: 1, addon: 1, as: 1 } satisfies Record<keyof DbIncrementArgs, 1>);

/**
 * `db.increment <table>` — add a number to one numeric column on every row the
 * `where` matches, atomically (`mvp:dbo_increment`).
 *
 * Use this instead of `db.get` → math → `db.edit` for counters, balances, stock
 * and tallies: that pattern loses updates under concurrency, and so do
 * `db.bulk.patch`/`db.bulk.update`. This runs as one locked UPDATE.
 *
 * Binds the updated rows (`returnType: "list"`, default — full rows, or the
 * `output` columns plus addons) or the changed-row count (`returnType: "count"`).
 * An empty match binds `[]` / `0`. The engine rejects a value that overflows the
 * column and changes nothing.
 */
export function dbIncrement<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const RT extends DbIncrementReturnType = "list",
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbIncrementArgs<T, As, Cols, A, RT> & { asFilters?: Fs },
): DbResult<As, ApplyFilters<IncrementResult<RowShapeOf<T, Cols>, A, RT>, Fs>> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.increment"`, args, DB_INCREMENT_KEYS);
  assertArg("s.db.increment", "table", args.table, { nullable: true });
  assertArg("s.db.increment", "fieldName", args.fieldName);
  if (typeof args.fieldName !== "string" && !isTaggedArg(args.fieldName)) {
    throw new Error(
      `Statement "s.db.increment": argument "fieldName" must be the column name as a string or a tagged value — got ${describeEntry(args.fieldName)}.`,
    );
  }
  // Resolved up front: the column check below reads the table's schema, and a
  // number there reached an `in` test and reported a raw TypeError.
  if (args.table !== null) resolveRef("dbo", args.table, `Statement "s.db.increment": argument "table"`);
  assertEnvelopeLists("s.db.increment", args);
  assertArg("s.db.increment", "value", args.value);
  const returnType: DbIncrementReturnType = args.returnType ?? "list";
  if (returnType !== "list" && returnType !== "count") {
    throw new Error(
      `Statement "s.db.increment": \`returnType\` is ${JSON.stringify(returnType)}; it must be "list" or "count".`,
    );
  }
  if (returnType === "count" && (args.output?.length || args.addon?.length)) {
    throw new Error(
      `Statement "s.db.increment": returnType "count" binds a number, so it cannot take ${
        args.output?.length ? "an `output` whitelist" : "addons"
      }. Use returnType "list", or remove it.`,
    );
  }
  const search = encodeSearch(args.where, undefined, `Statement "s.db.increment"`);
  if (!searchConstrainsRows(search)) {
    throw new Error(
      "Statement \"s.db.increment\": the `where` constrains nothing, and the engine changes NO rows for an " +
        "empty filter — it never increments a whole table. Pass the rows you mean, e.g. " +
        "`where: expr(col(\"id\"), \"=\", inp(\"id\"))`.",
    );
  }
  const amount = incrementAmount(args.value);
  if (typeof args.fieldName === "string") assertIncrementColumn(args.table, args.fieldName, args.value);
  if (args.table !== null) assertNoAddonShadow(args.table, args.addon);
  const statement: Statement = {
    name: "mvp:dbo_increment",
    context: {
      dbo: dboBinding(args.table, args.tableAlias, "mvp:dbo_increment"),
      search,
      return: { type: returnType },
    },
    as: args.as ?? "",
    // Lean entries: the engine's own serialization carries no ignore/expand/children here.
    input: [
      leanInput("field_name", typeof args.fieldName === "string" ? c.text(args.fieldName) : args.fieldName),
      leanInput("value", amount),
    ],
    ...envelope({ output: args.output, addon: args.addon }),
  };
  return annotate(
    statement as DbResult<As, ApplyFilters<IncrementResult<RowShapeOf<T, Cols>, A, RT>, Fs>>,
    args,
  );
}

/**
 * Paging controls for `db.query`. Static controls (`page`/`per_page`/`offset` as
 * plain numbers) land in `context.return.list.paging` (with `enabled:true`) and
 * mirror the engine schema's `return.list.paging` block: `page=1`, `per_page=25`,
 * `offset=0`, `totals=false`, `metadata=true`.
 *
 * **Input-bound (dynamic) paging:** pass a {@link Value} (e.g.
 * `inp("page")`) for `page`/`per_page`/`offset` instead of a number and it is
 * emitted into `context.simpleExternal.<field>` as a tagged `{value,tag,filters}`
 * (byte shape from the `simpleExternal` golden — the inner key is `value`, not
 * `operand`), while the static block stays as the engine's baseline/fallback and
 * the gate (`enabled:true`). `search`/`sort` accept a {@link Value} for a
 * dynamic custom-query / sort override; the engine reads those unconditionally.
 *
 * The `enabled:true` gate is keyed on whether a **page/per_page/offset** field is
 * present (static or `Value`) — a `paging` object carrying *only* `search`/`sort`
 * leaves `enabled:false`, so a dynamic-search-only override does not silently
 * activate default pagination and truncate the result to 25 rows.
 *
 * Note `metadata:true` (the default) wraps the result in a paging envelope
 * (`{ items, curPage, nextPage, … }`) rather than returning a bare row list; pass
 * `metadata:false` to keep the bare array. The envelope only applies when a
 * page/per_page/offset field is present.
 */
export interface DbPaging {
  page?: number | Value;
  per_page?: number | Value;
  offset?: number | Value;
  totals?: boolean;
  metadata?: boolean;
  /**
   * The engine's paging gate (`context.return.<type>.paging.enabled`).
   *
   * **Leave this unset.** It defaults to being DERIVED — on whenever a
   * `page`/`per_page`/`offset` field or a classic `external` blob is present —
   * which is what stops a `search`/`sort`-only `paging` from silently truncating a
   * result to 25 rows. Setting it overrides that derivation.
   *
   * It exists because a stored query can carry the two apart: real workspaces
   * persist a non-default `per_page` with the gate OFF, and a derived-only encoder
   * cannot reproduce that — which cost ~158 `db.query` statements their
   * readability. So this is here to REPRESENT a stored state faithfully, like
   * `table: null`; authoring `enabled: false` beside a `per_page` asks the engine
   * to ignore that `per_page`.
   *
   * Note it also moves where addons graft: a metadata paging envelope puts rows
   * under `items[]`, so the gate and the addon offset stay consistent.
   */
  enabled?: boolean;
  /** Dynamic custom-query override (`context.simpleExternal.search`) — a {@link Value}, ANDed onto the static `where`. */
  search?: Value;
  /** Dynamic sort override (`context.simpleExternal.sort`) — a {@link Value}; replaces the static sort at runtime. */
  sort?: Value;
}

/** A `paging` value that is a tagged {@link Value} (input-bound) vs a plain number. */
function isPagingValue(x: unknown): x is Value {
  return typeof x === "object" && x !== null && "tag" in x && "value" in x && "filters" in x;
}

/** Whether a `paging` arg carries a page/per_page/offset field (static or `Value`). */
function hasPageField(paging?: DbPaging): boolean {
  return (
    !!paging &&
    (paging.page !== undefined || paging.per_page !== undefined || paging.offset !== undefined)
  );
}

/**
 * The engine's paging gate: an explicit {@link DbPaging.enabled} when authored,
 * otherwise derived from a page field or a classic `external` blob.
 *
 * Both the return block's `enabled` and the addon graft offset read this, so the
 * two cannot disagree about whether rows are wrapped in a paging envelope.
 */
function pagingEnabled(paging: DbPaging | undefined, forceEnabled: boolean): boolean {
  return paging?.enabled ?? (hasPageField(paging) || forceEnabled);
}

/**
 * The `context.simpleExternal` block for input-bound paging: one tagged
 * `{value,tag,filters}` entry per `page`/`per_page`/`offset`/`search`/`sort`
 * field authored as a {@link Value}. Numeric fields ride the static block
 * instead, so they are omitted here. Returns `undefined` when nothing is dynamic.
 */
function encodeSimpleExternal(paging?: DbPaging): Record<string, unknown> | undefined {
  if (!paging) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of ["page", "per_page", "offset", "search", "sort"] as const) {
    const v = paging[k];
    if (isPagingValue(v)) out[k] = { value: v.value, tag: v.tag, filters: v.filters };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Which parts of a classic {@link DbExternal} blob the engine is permitted to
 * honor. Each defaults to the engine's own default (search/sort/page `true`,
 * `per_page` `false`) — the shape from the `external` golden.
 */
export interface DbExternalPermissions {
  search?: boolean;
  sort?: boolean;
  page?: boolean;
  per_page?: boolean;
}

/**
 * The classic single-blob external override (`context.external`). Its resolved
 * `value` is a whole faceted-filter object (`{search, sort, page, per_page}`),
 * typically fed from one request input; `permissions` gates which of those
 * sub-keys the engine honors.
 *
 * Combines with input-bound `paging` as a **fallback chain**: the engine uses
 * this blob when it resolves to something non-empty, and falls back to the
 * per-field `paging` binds when it does not. Supplying both is a working
 * configuration — an optional whole-config override in front of per-field
 * defaults — not a conflict.
 */
export interface DbExternal {
  /** The whole external config as one tagged {@link Value} (e.g. `inp("filters")`). */
  value: Value;
  /** Per-part gates; each defaults to the engine default. */
  permissions?: DbExternalPermissions;
}

/**
 * Encode `context.external`: the tagged value flattened (`{value,tag,filters}`)
 * with a `permissions` object filled to the engine defaults (byte shape from the
 * `external` golden — `{search:true, sort:true, page:true, per_page:false}`).
 */
function encodeExternal(ext: DbExternal): Record<string, unknown> {
  const p = ext.permissions ?? {};
  return {
    value: ext.value.value,
    tag: ext.value.tag,
    filters: ext.value.filters,
    permissions: {
      search: p.search ?? true,
      sort: p.sort ?? true,
      page: p.page ?? true,
      per_page: p.per_page ?? false,
    },
  };
}

/**
 * Reject an `eval` whose `as` alias shadows a column already on the queried table
 * — the graft would silently override the base column (same hazard as
 * {@link assertNoAddonShadow}). A bare-name table (no schema) is skipped.
 */
/**
 * Encode `context.bind[]` — one `{ dbo:{as,id}, join, search? }` per join. `as`
 * defaults to the table name; two binds resolving to the same alias throw (SQL
 * alias collision). `search` (the join condition) is omitted when there's no
 * `where`. Byte shape from the `bind` / `bind-nosearch` goldens.
 */
function encodeBind(binds?: readonly DbBind[]): unknown[] | undefined {
  if (!binds?.length) return undefined;
  const seen = new Set<string>();
  return binds.map((b) => {
    if (b.expand !== undefined) return encodeExpandBind(b, seen);
    // An UNBOUND join has no table name to default its alias from, and the
    // stored bytes show the alias outliving the table (`{as:"userJoin", id:""}`)
    // — it is the user's own label, not a function of the target. So `as` is
    // required there rather than being invented.
    if (b.table === null && b.as === undefined) {
      throw new Error(
        "db.query bind: a join with `table: null` must name its `as` alias — an unbound join " +
          "has no table name to derive one from. (`table: null` represents a join whose table " +
          "was deleted; fix the pulled workspace rather than authoring it.)",
      );
    }
    const as = b.as ?? (typeof b.table === "string" ? b.table : (b.table as { name: string }).name);
    if (seen.has(as)) {
      throw new Error(
        `db.query bind: duplicate join alias "${as}" — two joins to the same table need ` +
          `distinct \`as\` values so their dotted-path columns don't collide.`,
      );
    }
    seen.add(as);
    const entry: Record<string, unknown> = {
      // `null` writes the engine's own empty binding, exactly as `dboBinding`
      // does for the query's own table — `resolveRef` rejects a target with
      // neither a name nor a guid.
      dbo: { as, id: b.table === null ? "" : resolveRef("dbo", b.table) },
      join: b.join ?? "inner",
    };
    const search = encodeSearch(b.where, undefined, `Statement "s.db.query": bind "${String(b.as ?? "")}"`);
    if (search !== undefined) entry.search = search;
    return entry;
  });
}

/**
 * Encode a {@link DbExpandBind}: the stored `dbo.id` is the `<alias>.<column>`
 * path itself, which is how the engine tells an expansion from a table join.
 */
function encodeExpandBind(b: DbExpandBind, seen: Set<string>): Record<string, unknown> {
  const where = `db.query bind { expand: ${JSON.stringify(b.expand)} }`;
  if ((b as { table?: unknown }).table !== undefined) {
    throw new Error(`${where}: \`expand\` and \`table\` are exclusive — a bind either joins a table or expands a list column.`);
  }
  if (typeof b.expand !== "string" || !/^[^.]+\.[^.]/.test(b.expand)) {
    throw new Error(
      `${where}: \`expand\` is \`<alias>.<column>\` — the query's \`tableAlias\` (or a joined table's \`as\`), ` +
        `then a list column of it, e.g. "blog.categories".`,
    );
  }
  if (typeof b.as !== "string" || b.as === "") {
    throw new Error(`${where}: an expansion needs an \`as\` alias to address its elements by — the engine refuses one without.`);
  }
  if (seen.has(b.as)) {
    throw new Error(`db.query bind: duplicate join alias "${b.as}" — every join and expansion needs its own \`as\`.`);
  }
  seen.add(b.as);
  const entry: Record<string, unknown> = { dbo: { as: b.as, id: b.expand }, join: b.join ?? "inner" };
  const search = encodeSearch(b.where, undefined, `Statement "s.db.query": bind "${b.as}"`);
  if (search !== undefined) entry.search = search;
  return entry;
}

/**
 * Collect every `{tag:"col"}` operand path out of an ENCODED search tree
 * (`{expression:[…]}`), including nested groups. Walking the encoded form rather
 * than the authored nodes catches the raw-`Value` escape hatch too, which
 * bypasses `expr()`/`cmp()` entirely.
 */
function collectColOperands(search: unknown, out: string[]): void {
  if (search === null || typeof search !== "object") return;
  if (Array.isArray(search)) {
    for (const item of search) collectColOperands(item, out);
    return;
  }
  const node = search as Record<string, unknown>;
  if (node.tag === "col" && typeof node.operand === "string") out.push(node.operand);
  for (const value of Object.values(node)) collectColOperands(value, out);
}

/**
 * Reject a dotted column path whose alias prefix the ENGINE cannot resolve.
 *
 * A `db.query` addresses columns three ways, and only two of them are dotted:
 * a joined table's column takes its `bind` alias (`"team_row.id"`), an object
 * column's sub-key takes the column name (`"meta.country"`), and the query's OWN
 * columns are BARE (`"team"`). Qualifying a base-table column with the table's
 * name — `"q_doc.team"`, the obvious-looking form — resolves only when the
 * query also declares an alias for that table (`tableAlias`, the engine's
 * `context.dbo.as`). Without it the operand is not recognised as a column at all:
 * the engine falls back to treating it as a text literal and the request dies
 * with `ParseError: Invalid value for param:…` naming the OTHER operand, or with
 * `Unsupported parameter reference`. Both are opaque, both are runtime-only, and
 * everything needed to catch them is known here at export.
 *
 * Only runs against a typed `table()` handle: the exception for an object
 * column's sub-key needs the column list, and without it a legitimate
 * `"meta.country"` is indistinguishable from a bad alias.
 */
function assertResolvableColumnPaths(
  table: ObjectRef | null,
  tableAlias: string | undefined,
  bindAliases: readonly string[],
  paths: readonly { path: string; surface: string }[],
): void {
  if (table === null || typeof table === "string" || !("schema" in table)) return;
  const def = table as TableDef;
  const columns = new Set(tableColumns(def).map((col) => col.name));
  const known = new Set<string>(bindAliases);
  if (tableAlias !== undefined) known.add(tableAlias);

  for (const { path, surface } of paths) {
    const dot = path.indexOf(".");
    if (dot <= 0) continue;
    const prefix = path.slice(0, dot);
    if (known.has(prefix) || columns.has(prefix)) continue;
    // The common trap: the author qualified with the table's own name.
    // It reads as the obvious spelling and is the one the docs implied, so it
    // gets its own message naming both working forms.
    if (prefix === def.name) {
      throw new Error(
        `db.query ${surface}: "${path}" — a column of "${def.name}" qualified by the table's ` +
          `own name only resolves when the query declares an alias for that table. Either drop ` +
          `the qualifier (\`${path.slice(dot + 1)}\`) or add \`tableAlias: "${def.name}"\` to the ` +
          `db.query. (A JOINED column is different: it keeps its bind alias, e.g. ` +
          `\`col("${bindAliases[0] ?? "<join alias>"}.id")\`.)`,
      );
    }
    throw new Error(
      `db.query ${surface}: "${path}" — "${prefix}" is not a resolvable alias. A dotted path ` +
        `must start with a join's \`as\` alias${bindAliases.length ? ` (${bindAliases.map((a) => `"${a}"`).join(", ")})` : " (this query has no joins)"}, ` +
        `the query's own \`tableAlias\`, or an object column of "${def.name}". Bare column ` +
        `names address "${def.name}" directly.`,
    );
  }
}

function assertNoEvalShadow(table: ObjectRef, evals?: readonly DbEval[]): void {
  if (!evals?.length) return;
  if (typeof table === "string" || !("schema" in table)) return;
  const cols = new Set(tableColumns(table as TableDef).map((col) => col.name));
  for (const e of evals) {
    if (cols.has(e.as)) {
      throw new Error(
        `db.query eval: alias "${e.as}" shadows an existing "${table.name}" column — the ` +
          `computed value would overwrite it. Rename the eval alias (e.g. "${e.as}_calc").`,
      );
    }
  }
}

/**
 * Build `context.return` for a query, discriminated by `returnType`:
 * - `count`/`exists` → a bare `{ type }` (no sub-block — the scalar rides the
 *   statement `as`);
 * - `single` → `{ type:"single", single:{ sort } }` (first match, no paging);
 * - `stream` → `{ type:"stream", stream:{ sort, distinct, paging? } }` (paging is
 *   `{ page, per_page, enabled }` only — no offset/metadata/totals);
 * - `list` (default) → `{ type:"list", list:{ distinct, sort, paging } }` with the
 *   engine's `page=1`/`offset=0`/`per_page=25`/`metadata=true`/`totals=false`
 *   defaults; the metadata envelope applies only here.
 *
 * `distinct` is hardcoded `"auto"` for now (author control is a later unit).
 */
/**
 * Encode `context.return.aggregate` — `{ sort, paging?, eval, group }`. `group`
 * and `eval` reuse the {@link encodeEval} `{ as, name, filters }` shape, with their
 * `name` alias-qualified against `primaryAlias` (see {@link qualifyAggregateEvals}).
 * Aggregate paging is `{ page, per_page, metadata, enabled }` — no `offset`/`totals`.
 */
function encodeAggregate(agg: DbAggregate | undefined, primaryAlias: string): unknown {
  const block: Record<string, unknown> = {
    sort: encodeSort(agg?.sort, "s.db.query", "aggregate.sort"),
    eval: encodeEval(qualifyAggregateEvals(agg?.eval, primaryAlias, "eval")) ?? [],
    group: encodeEval(qualifyAggregateEvals(agg?.group, primaryAlias, "group")) ?? [],
  };
  if (agg?.paging) {
    block.paging = {
      page: agg.paging.page ?? 1,
      per_page: agg.paging.per_page ?? 25,
      metadata: agg.paging.metadata ?? true,
      enabled: agg.paging.enabled ?? true,
    };
  }
  return { type: "aggregate", aggregate: block };
}

/** Every value `returnType` may resolve to, for the guard's message and check. */
const DB_RETURN_TYPES: readonly DbReturnType[] = [
  "list",
  "single",
  "count",
  "exists",
  "stream",
  "aggregate",
];

/**
 * Resolve `returnType` to the plain string every comparison below keys on.
 *
 * Two silent-wrongness holes closed here, both of which would otherwise end at
 * the same place — the `list` branch at the bottom of {@link encodeReturn},
 * reached by falling off the end of a chain of `===` tests.
 *
 * 1. A TAGGED value. `DbReturnType` is a bare string union, so `c.text("stream")`
 *    does not type-check — but a JavaScript or `as any` caller reaches here with
 *    an object, every `===` against a string is false, and the query silently
 *    becomes a `list`. Unwrapping a constant tag makes the spelling behave the
 *    way the README's statement-enum equivalence says it should, rather than
 *    quietly producing a different query.
 *
 * 2. An UNRECOGNIZED string. `"streams"` had the same fate for the same reason.
 *    A typo in a closed enum is never a request for the default.
 *
 * Case 2 throws rather than passing the value through, which trades one risk for
 * another and is worth stating. The codegen decoder copies a stored `return.type`
 * verbatim, so if a future engine adds a return type, a pulled workspace carrying
 * it would fail to re-export until this list grows. That is accepted here: no
 * captured workspace in the corpus stores a type outside this set, a typo is the
 * far likelier cause, and the failure is one loud message naming the accepted
 * values rather than a query that silently returns a different shape. If a real
 * unknown type ever shows up, widen the set — do not soften this to a warning
 * that reinstates the silent fallback.
 */
function normalizeReturnType(raw: DbReturnType | undefined): DbReturnType {
  if (raw === undefined) return "list";
  // A `c.text("stream")` is `{value:"stream", tag:"const", filters:[]}`. Only an
  // unfiltered constant is unwrappable: a filter chain can reshape the value at
  // runtime, so its result is not knowable at encode time.
  const unwrapped: unknown =
    isTaggedValue(raw) && raw.filters.length === 0 && raw.tag.startsWith("const")
      ? raw.value
      : raw;
  if (typeof unwrapped === "string" && (DB_RETURN_TYPES as readonly string[]).includes(unwrapped)) {
    return unwrapped as DbReturnType;
  }
  const shown = isTaggedValue(raw) ? `${raw.tag}:${JSON.stringify(raw.value)}` : JSON.stringify(raw);
  throw new Error(
    `Statement "s.db.query": \`returnType\` is ${shown}, which is not one of ` +
      `${DB_RETURN_TYPES.map((t) => JSON.stringify(t)).join(", ")}. Falling through to "list" ` +
      `would run the query and return a different shape than the one asked for, with no ` +
      `error anywhere. \`returnType\` is read at encode time to pick the ` +
      `\`context.return\` block, so it cannot be a dynamic value — a filtered or non-constant ` +
      `tagged value cannot be resolved here.`,
  );
}

function encodeReturn(
  returnType: DbReturnType,
  sort?: SortDirective[],
  paging?: DbPaging,
  forceEnabled = false,
  distinct: DbDistinct = "auto",
  aggregate?: DbAggregate,
  primaryAlias = "",
): unknown {
  const sortEls = encodeSort(sort);
  if (returnType === "aggregate") return encodeAggregate(aggregate, primaryAlias);
  if (returnType === "count" || returnType === "exists") return { type: returnType };
  if (returnType === "single") return { type: "single", single: { sort: sortEls } };
  // `enabled:true` gates the engine's paging (+ the simpleExternal page/per_page/
  // offset overrides). Keyed on a page/per_page/offset field being present — a
  // `search`/`sort`-only `paging` must NOT flip it on (else default pagination
  // truncates the result to 25 rows). A classic `external` blob (forceEnabled)
  // also needs the gate on for its page/per_page to take effect.
  const enabled = pagingEnabled(paging, forceEnabled);
  const staticInt = (v: number | Value | undefined, def: number): number =>
    typeof v === "number" ? v : def;
  if (returnType === "stream") {
    // Stream paging is `{ page, per_page, enabled }` only — no offset/metadata/totals.
    const stream: Record<string, unknown> = { sort: sortEls, distinct };
    if (enabled) {
      stream.paging = {
        page: staticInt(paging?.page, 1),
        per_page: staticInt(paging?.per_page, 25),
        enabled: true,
      };
    }
    return { type: "stream", stream };
  }
  const pagingObj = {
    enabled,
    page: staticInt(paging?.page, 1),
    offset: staticInt(paging?.offset, 0),
    per_page: staticInt(paging?.per_page, 25),
    metadata: paging?.metadata ?? true,
    totals: paging?.totals ?? false,
  };
  // The whole `list` sub-block is optional in `mvp_return`, and Xano's editor
  // writes a bare `{type:"list"}` for a query that configures none of it. Emitting
  // the block filled with engine defaults is behaviourally identical but is not
  // the shape a pulled workspace carries — so it is written only when the author
  // configured something inside it.
  // An explicit `paging` argument counts as configured even when every field
  // sits at its default: the block is the engine's gate for the `simpleExternal`
  // overrides and for the "search/sort-only paging must not truncate"
  // behaviour, so an author who passed `paging` keeps the full block.
  const configured = enabled || paging !== undefined || sortEls.length > 0 || distinct !== "auto";
  if (!configured) return { type: "list" };
  return { type: "list", list: { distinct, sort: sortEls, paging: pagingObj } };
}

export interface DbQueryArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly OutputPath<ColsOf<T> | EvalAliases<E> | AddonAliases<A>>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
  P extends DbPaging | undefined = DbPaging | undefined,
  RT extends DbReturnType = DbReturnType,
  E extends readonly DbEval[] = readonly DbEval[],
  AG extends DbAggregate = DbAggregate,
> extends StatementOptions {
  /**
   * SQL alias for the bound table (`context.dbo.as`), used to qualify columns.
   * Absent unless set — Xano writes it on some statements and not others, so it
   * is authored rather than derived (see {@link dboBinding}).
   */
  tableAlias?: string;

  table: DbTableRef<T>;
  /**
   * The engine's `context.return.type`. `"list"` (default) returns a row array
   * (or paging envelope); `"single"` a first-match `row | null`; `"count"` a
   * `number`; `"exists"` a `boolean`; `"stream"` a pageable `row[]` with no
   * metadata envelope. `InferResponse` reflects each shape.
   */
  returnType?: RT;
  /** Primary filter — `expr(...)`, an array of `expr(...)` (ANDed), or a raw `Value`. */
  where?: DbWhere;
  /** Additional filter ANDed with `where` (same forms as `where`). */
  additionalWhere?: DbWhere;
  /**
   * Joins (`context.bind[]`) — `[{ table, as?, join?, where? }]`. Joined columns
   * are addressable by dotted path in `where`/`sort`/`eval`; the row shape is
   * unchanged (output columns still come from `output`/`eval`).
   */
  bind?: DbBind[];
  /** Sort directives (`[{ sortBy, dir }]`) — applied by the engine. */
  sort?: DbSortDirective<ColsOf<T> | EvalAliases<E>>[];
  /** Acquire row locks. */
  lock?: boolean;
  /**
   * Paging controls (`page`/`per_page`/`offset`/`totals`/`metadata`) — applied by
   * the engine. **Supplying `paging` changes the response shape:** with metadata
   * on (the default) the result is wrapped in a paging envelope
   * (`{ items, curPage, nextPage, prevPage, offset, perPage, itemsReceived }`,
   * plus `itemsTotal`/`pageTotal` when `totals:true`) instead of a bare row list,
   * and `InferResponse` reflects that. Pass `metadata:false` to keep
   * the bare array.
   */
  paging?: P;
  /**
   * Classic single-blob external override (`context.external`) — one tagged
   * {@link Value} whose resolved value is a whole `{search,sort,page,per_page}`
   * config, with per-part `permissions` gates. Mutually exclusive with an
   * input-bound `paging` field (a `Value` page/per_page/offset/search/sort): the
   * engine honors `simpleExternal` only when `external` is empty, so authoring
   * both throws. Setting `external` forces `paging.enabled:true` so its
   * page/per_page take effect even with no `paging` arg.
   */
  external?: DbExternal;
  /**
   * Distinct-row handling for a `list`/`stream` query (`"auto"` default | `"yes"`
   * | `"no"`) → `context.return.<type>.distinct`. Ignored for single/count/exists.
   * On a joined query `"auto"` dedupes only when every sort key names this
   * table's alias, so a bare own-column `sortBy` is emitted qualified
   * (`title` → `<table>.title`, declaring the alias; `qualify: false` on the
   * entry keeps it bare) — sort by a joined column and `"auto"` keeps one row
   * per join match.
   */
  distinct?: DbDistinct;
  /**
   * Computed output columns (`context.eval[]`) — each `{ name, as, filters? }`.
   * The `as` alias grafts onto every returned row as an `unknown`-typed key
   * (`InferResponse`), since a filter pipeline's output isn't statically knowable.
   * An alias shadowing an existing column throws at build time.
   */
  eval?: E;
  /**
   * Aggregate/group-by config, used with `returnType:"aggregate"` →
   * `context.return.aggregate.{group,eval,sort,paging}`. `InferResponse` types the
   * aggregate row from the `group` and `eval` aliases (a plain group typed by its column).
   */
  aggregate?: AG;
  /** Restrict returned columns. Captured literally so `InferResponse` narrows
   * the traced row list to exactly these columns. */
  output?: Cols;
  /** Attach addons to enrich each returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` as an `unknown`-typed key — narrow it at the call site. Author
   * `as` relative to a row (`"_user"`); when the query returns a metadata paging
   * envelope, the `items[]` offset is prefixed automatically. */
  addon?: A;
  /** Capture the result list into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/**
 * `db.query <table>` — the query-all search builder (`mvp:dbo_view`). Emits the
 * context the engine actually reads:
 * the filter under `context.search` (`{expression:[…]}`, the same operand-based
 * shape as conditionals/trigger search), sort + paging under
 * `context.return.list`, and output-column restriction via the statement `output`
 * envelope. `where`/`sort`/`paging`/`output` are all applied by the engine.
 *
 * A comparison `where` (plus `additionalWhere`) encodes into one ANDed
 * `expression[]`; a raw `Value` is passed through as `context.search`.
 */
/** Every `s.db.query` argument, held to {@link DbQueryArgs} at compile time. */
const DB_QUERY_KEYS = Object.keys({
  disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, tableAlias: 1, table: 1, returnType: 1, where: 1,
  additionalWhere: 1, bind: 1, sort: 1, lock: 1, paging: 1, external: 1, distinct: 1, eval: 1, aggregate: 1,
  output: 1, addon: 1, as: 1,
} satisfies Record<keyof DbQueryArgs, 1>);
const DB_BIND_KEYS = Object.keys(
  { table: 1, expand: 1, as: 1, join: 1, where: 1 } satisfies Record<keyof DbTableBind | keyof DbExpandBind, 1>,
);

export function dbQuery<
  T extends ObjectRef,
  const As extends string = string,
  const Cols extends readonly OutputPath<ColsOf<T> | EvalAliases<E> | AddonAliases<A>>[] = readonly [],
  const A extends readonly AddonSpec[] = readonly [],
  const P extends DbPaging | undefined = undefined,
  const RT extends DbReturnType = "list",
  const E extends readonly DbEval[] = readonly [],
  const AG extends DbAggregate = DbAggregate,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  args: DbQueryArgs<T, As, Cols, A, P, RT, E, AG> & { asFilters?: Fs } & QueryNestedKeys<P, E, AG> &
    PagedOutputCheck<Cols, P, RT, ColsOf<T> | EvalAliases<E> | AddonAliases<A>>,
): DbResult<As, ApplyFilters<QueryResult<QueryRow<T, Cols, P, RT>, A, P, RT, E, AG, Cols>, Fs>> {
  args = argsOrEmpty(args);
  // The stored shape's spelling (`context.return.type`), typed through `any`:
  // not an argument, so it was dropped and the query ran as a "list".
  if ((args as { return?: unknown }).return !== undefined) {
    throw new Error(
      `Statement "s.db.query": there is no \`return\` argument — the return type is \`returnType\` ` +
        `(${DB_RETURN_TYPES.map((t) => JSON.stringify(t)).join(", ")}), with \`paging\`/\`sort\`/\`aggregate\` beside it.`,
    );
  }
  // A misspelt top-level key through `any` was dropped — and a dropped
  // `where` (`filter:`) returns EVERY row.
  assertKnownKeys(`Statement "s.db.query"`, args, DB_QUERY_KEYS);
  assertArg("s.db.query", "table", args.table, { nullable: true });
  assertQueryArgShapes(args as unknown as Record<string, unknown>);
  // An unbound (`null`) table has no columns to shadow and no name to qualify
  // with, exactly as in an addon's `null` branch.
  if (args.table !== null) {
    assertNoAddonShadow(args.table, args.addon);
    assertNoEvalShadow(args.table, args.eval);
  }
  (args.bind ?? []).forEach((b, i) => assertKnownKeys(`Statement "s.db.query": argument "bind[${i}]"`, b, DB_BIND_KEYS));
  const returnType = normalizeReturnType(args.returnType);
  const tableName =
    args.table === null ? "" : typeof args.table === "string" ? args.table : args.table.name;
  // The primary table alias (the default `dbo.as`) — used to qualify aggregate
  // group/eval column names, which the engine requires as `<alias>.<column>`.
  const primaryAlias = args.tableAlias ?? tableName;
  // An aggregate's `group`/`eval` names are qualified BY THIS SDK — the engine
  // rejects a bare column there (`Unsupported param format`), so a bare authored
  // name is prefixed on emit. The prefix has to be an alias the engine can
  // resolve, and a table's NAME is not one unless the statement also declares it
  // (`dbo.as`); without it the qualified name dies with `Unsupported object
  // reference - <table>.<column>`. The author wrote a bare name and never
  // asked for the qualifier, so the alias is emitted for them.
  //
  // Gated on the SDK actually ADDING a prefix, which is what keeps a pulled
  // workspace byte-exact: stored aggregate names are already dotted, so codegen's
  // re-emit qualifies nothing, adds no alias, and round-trips unchanged.
  const aggregateAddsQualifier =
    returnType === "aggregate" &&
    tableName !== "" &&
    [...(args.aggregate?.group ?? []), ...(args.aggregate?.eval ?? [])].some(
      (e) => !e.name.includes("."),
    );
  // A plain `eval` name needs the SAME treatment, for the same engine reason:
  // `eval: [{ name: "content", as: "c2" }]` exported clean and then answered
  // `Unsupported param format - content` on every request, filters or not
  // (live-verified on a deployed ephemeral). Only the aggregate half
  // was qualified, so the plain half was a compile-clean broken query whenever
  // the author wrote the obvious thing. Same gate: qualify only what the author
  // left bare, so a pulled workspace's already-dotted names round-trip untouched.
  const evalAddsQualifier = tableName !== "" && (args.eval ?? []).some((e) => !e.name.includes("."));
  // A JOINED list/stream query's own-column sort keys get the same treatment,
  // for a different engine reason: `distinct: "auto"` dedupes a join only when
  // every sort key's first segment is the query's own alias, so a bare `title`
  // reads as a sort on another table and the query returns one row per join
  // match. XanoScript's usual form (`sort = {note.title: "asc"}`) is qualified,
  // so the SDK emits that. Every undotted key except an eval alias (which sorts
  // bare) is the query's own column — a joined column is always dotted — so the
  // test needs no column list, and a string-named table and codegen's proof
  // (which binds `{ name, guid }`) qualify exactly as a `table()` handle does.
  // The same gate as above keeps a pulled, already-qualified query byte-exact;
  // a stored BARE key decodes with `qualify: false`, which opts that entry out.
  const joinedRowQuery =
    (returnType === "list" || returnType === "stream") &&
    tableName !== "" &&
    (args.bind?.length ?? 0) > 0;
  const evalAliases = new Set<string>((args.eval ?? []).map((e) => e.as));
  const qualifiesSort = (entry: DbSortDirective): boolean =>
    entry.qualify !== false &&
    typeof entry.sortBy === "string" &&
    entry.sortBy !== "" &&
    !entry.sortBy.includes(".") &&
    !evalAliases.has(entry.sortBy);
  const sortAddsQualifier = joinedRowQuery && (args.sort ?? []).some(qualifiesSort);
  const emittedAlias =
    args.tableAlias ??
    (aggregateAddsQualifier || evalAddsQualifier || sortAddsQualifier ? tableName : undefined);
  const sort = sortAddsQualifier
    ? args.sort!.map((entry) =>
        qualifiesSort(entry) ? { ...entry, sortBy: `${primaryAlias}.${entry.sortBy}` } : entry,
      )
    : args.sort;
  // Qualify only where there IS an alias to qualify with. An unbound (`table:
  // null`) statement has none — it exists to REPRESENT a deleted-table query so
  // it round-trips — and prefixing with `""` would build `".content"` and throw.
  // A decoded query whose stored eval name is already bare is left alone by the
  // same rule when it carries no table; one that does carry a table is rewritten
  // to the resolvable form, and `prove` demotes it to `raw()` rather than
  // changing the bytes.
  const evals =
    primaryAlias === "" ? args.eval : qualifyAggregateEvals(args.eval, primaryAlias, "query eval");
  const context: Record<string, unknown> = { dbo: dboBinding(args.table, emittedAlias, "mvp:dbo_view") };
  const search = encodeSearch(args.where, args.additionalWhere, `Statement "s.db.query"`);
  if (search !== undefined) context.search = search;
  const binds = encodeBind(args.bind);
  if (binds) context.bind = binds;
  // Every surface that takes a column path, checked against the aliases this
  // statement actually declares. Runs after `encodeBind` so the join aliases are
  // the resolved ones (`as` defaults to the table name).
  {
    const bindAliases = (binds ?? []).map(
      (b) => (b as { dbo: { as: string } }).dbo.as,
    );
    const paths: { path: string; surface: string }[] = [];
    const push = (surface: string, values: string[]): void => {
      for (const path of values) paths.push({ path, surface });
    };
    const searchPaths: string[] = [];
    collectColOperands(search, searchPaths);
    push("where", searchPaths);
    for (const b of binds ?? []) {
      const bindPaths: string[] = [];
      collectColOperands((b as { search?: unknown }).search, bindPaths);
      push(`bind "${(b as { dbo: { as: string } }).dbo.as}" where`, bindPaths);
    }
    push("sort", (sort ?? []).map((entry) => entry.sortBy));
    push("eval", (evals ?? []).map((e) => e.name));
    // The AGGREGATE block is deliberately not checked. Its group/eval names are
    // qualified by this SDK rather than by the author (`qualifyAggregateEvals` —
    // the engine rejects a bare name there), and the engine PERSISTS that
    // table-name-qualified form with no `dbo.as` alongside it: see the
    // engine-captured `db_query_aggregate` conformance fixture. Whatever the
    // aggregate path resolves those against, it is not the rule this guard
    // encodes, and a guard that contradicts captured engine bytes would block
    // pulling a real workspace.
    // `emittedAlias`, not `args.tableAlias`: an aggregate that auto-declares the
    // table name as its alias really can resolve `<table>.<column>` everywhere.
    assertResolvableColumnPaths(args.table, emittedAlias, bindAliases, paths);
  }
  const encodedEvals = encodeEval(evals);
  if (encodedEvals) context.eval = encodedEvals;
  // Row lock rides `context.lock` as a tagged value (`{value, tag, filters}`),
  // not a bare bool — the shape the engine's lock-config converter reads.
  const lock = optionalFlag("s.db.query", "lock", args.lock);
  if (lock !== undefined) context.lock = lock;
  // Input-bound paging: `Value`-typed page/per_page/offset/search/sort
  // ride `context.simpleExternal` on top of the static block (which is the gate).
  const simpleExternal = encodeSimpleExternal(args.paging);
  if (args.external !== undefined && args.external !== null) {
    // `external` and `simpleExternal` are a runtime FALLBACK CHAIN, not a static
    // either/or. The engine branches on `!empty($external)` — the *resolved*
    // value, after the tagged value is evaluated — and reads `simpleExternal`
    // whenever that comes back empty. So a blob fed from an optional request
    // input, with per-field paging behind it, is a working configuration and one
    // the editor lets you build.
    //
    // So the pair is not an error: the engine does not "honor `external` and
    // ignore simpleExternal" unconditionally, and refusing it would make real
    // queries authored on both sides impossible to pull. `simpleExternal` is
    // written in this branch too.
    //
    // `external`'s page/per_page are gated by static `paging.enabled` just like
    // simpleExternal — force it on so a self-contained blob isn't silently no-op'd.
    context.return = encodeReturn(returnType, sort, args.paging, true, args.distinct, args.aggregate, primaryAlias);
    context.external = encodeExternal(args.external);
    if (simpleExternal) context.simpleExternal = simpleExternal;
  } else {
    context.return = encodeReturn(returnType, sort, args.paging, false, args.distinct, args.aggregate, primaryAlias);
    if (simpleExternal) context.simpleExternal = simpleExternal;
  }
  // A `list` query with paging enabled + metadata on returns a paging envelope,
  // so its rows live under `items[]` — top-level addons must graft there. Paging
  // is enabled by a page/per_page/offset field or a classic `external` blob; the
  // frontend's return-type editor applies the identical `items[]` prefix.
  const usesPagingEnvelope =
    returnType === "list" &&
    pagingEnabled(args.paging, args.external !== undefined && args.external !== null) &&
    (args.paging?.metadata ?? true);
  return annotate({
    name: "mvp:dbo_view",
    context,
    as: args.as ?? "",
    input: [],
    ...envelope({
      output: args.output,
      addon: args.addon,
      addonOffset: usesPagingEnvelope ? "items[]" : undefined,
    }),
  } as unknown as DbResult<As, ApplyFilters<QueryResult<QueryRow<T, Cols, P, RT>, A, P, RT, E, AG, Cols>, Fs>>, args);
}

/**
 * There is no `as`: the transaction returns nothing, so a binding on it is
 * always `null` (measured on a live instance). The
 * body shares the enclosing stack, so read what its statements bind. A pulled
 * workspace that stores an `as` keeps it through the decoder's envelope spread.
 */
export interface DbTransactionArgs extends StatementAnnotations {
  /** The statements to run atomically. */
  body: Statement[];
}

const DB_TRANSACTION_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, body: 1 } satisfies Record<keyof DbTransactionArgs, 1>);

/**
 * `db.transaction { … }` — run a sub-stack in a database transaction
 * (`mvp:db_transaction`). Carries the `run` sub-stack. Byte-verified
 * (parser-minimal) against the engine's persisted shape.
 */
export function dbTransaction<const B extends readonly Statement[]>(
  args: Omit<DbTransactionArgs, "body"> & { body: B },
): Statement & BodyBrand<B> {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.db.transaction"`, args, DB_TRANSACTION_KEYS);
  assertStatements("s.db.transaction", "body", args.body as unknown as Statement[]);
  const stmt: Statement = {
    name: "mvp:db_transaction",
    context: { run: args.body.map(encodeStatement) },
    input: [],
  };
  return annotate(stmt, args) as Statement & BodyBrand<B>;
}

/** Supported external-SQL engines for `db.external.<engine>.direct_query`. */
export type ExternalSqlEngine = "mssql" | "mysql" | "oracle" | "postgres" | "snowflake";

const EXTERNAL_SQL_NAME: Record<ExternalSqlEngine, string> = {
  mssql: "mvp:dbo_external_mssql_query",
  mysql: "mvp:dbo_external_mysql_query",
  oracle: "mvp:dbo_external_oracle_query",
  postgres: "mvp:dbo_external_postgres_query",
  snowflake: "mvp:dbo_external_snowflake_query",
};

export interface DbExternalQueryArgs extends StatementOptions {
  /** Which external database engine to target. */
  engine: ExternalSqlEngine;
  sql: string;
  /**
   * How to reach the external database. Prefer `env("NAME")` over a literal.
   *
   * A `Value` is stored as the tagged `context.connection_string_flex`, which is
   * what new work should write. A bare **string** is stored in the older
   * `context.connection_string` instead — the engine reads it as the name of a
   * workspace environment variable unless it already looks like a URL, and
   * falls back to it whenever the tagged value is empty. The two are separate
   * stored fields, so a workspace holding the older one round-trips as the older
   * one rather than being quietly rewritten.
   */
  connectionString: Value | string;
  responseType?: DbResponseType;
  args?: Value[];
  /** How the SQL body is interpolated. See {@link DbSqlParser}. */
  parser?: DbSqlParser;
  as?: string;
}

/**
 * `db.external.<engine>.direct_query' — raw SQL against an external database.
 * Stored shape from the engine's direct-query format (the shared base; these engines extend
 * it with `connection_string:true`): `context.{code, response_type,
 * connection_string_flex, arg[]}`. The connection string lands under
 * `connection_string_flex` (a tagged assignment value), NOT `connection_string`.
 *
 * Golden-verified against a live postgres capture: the engine persists
 * `context.{code,response_type,connection_string_flex,arg}` and does NOT store
 * `parser` at its default, so the SDK's omission is correct. The rich envelope
 * matches. Only postgres is capture-verified; the other 4 engines share the
 * format and stay modeled by analogy.
 */
// @TODO(byte-verify): only postgres captured; the other 4 external engines share
//   the format and stay modeled-by-analogy.
const DB_EXTERNAL_QUERY_KEYS = Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1, engine: 1, sql: 1, connectionString: 1, responseType: 1, args: 1, parser: 1, as: 1 } satisfies Record<keyof DbExternalQueryArgs, 1>);

export function dbExternalQuery(args: DbExternalQueryArgs): Statement {
  args = argsOrEmpty(args);
  const statement = `s.db.external.${String(args.engine)}.direct_query`;
  assertKnownKeys(`Statement "${statement}"`, args, DB_EXTERNAL_QUERY_KEYS);
  assertArg(statement, "connectionString", args.connectionString);
  // Same silent passthrough as `db.direct_query` above — `sql` reaches
  // `context.code` without ever being read through.
  assertArg(statement, "sql", args.sql);
  assertListArg(statement, "args", args.args, SQL_ARG_ITEM);
  assertSqlEnums(statement, args);
  const connection = args.connectionString;
  // Whichever field the author named it in, and only that one. Writing both
  // would hand the engine two answers to one question, and writing the newer
  // where the older was stored rewrites a workspace's bytes on deploy.
  const connectionContext =
    typeof connection === "string"
      ? { connection_string: connection }
      : {
          connection_string_flex: {
            value: connection.value,
            tag: connection.tag,
            filters: connection.filters,
          },
        };
  return annotate({
    name: EXTERNAL_SQL_NAME[args.engine],
    context: {
      code: args.sql,
      response_type: args.responseType ?? "list",
      ...(args.parser === undefined ? {} : { parser: args.parser }),
      ...connectionContext,
      arg: (args.args ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
    },
    as: args.as ?? "",
    input: [],
    ...envelope(),
  }, args);
}

registerStatement("mvp:dbo_add", dbAdd);
registerStatement("mvp:dbo_editby", dbEdit);
registerStatement("mvp:dbo_addoreditby", dbAddOrEdit);
registerStatement("mvp:dbo_bulkadd", dbBulkAdd);
registerStatement("mvp:dbo_bulkdelete", dbBulkDelete);
registerStatement("mvp:dbo_bulkpatch", dbBulkPatch);
registerStatement("mvp:dbo_bulkupdate", dbBulkUpdate);
registerStatement("mvp:dbo_increment", dbIncrement);
registerStatement("mvp:dbo_view", dbQuery);
registerStatement("mvp:db_transaction", dbTransaction);
registerStatement("mvp:dbo_external_mssql_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "mssql" }), "s.db.external.mssql.direct_query");
registerStatement("mvp:dbo_external_mysql_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "mysql" }), "s.db.external.mysql.direct_query");
registerStatement("mvp:dbo_external_oracle_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "oracle" }), "s.db.external.oracle.direct_query");
registerStatement("mvp:dbo_external_postgres_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "postgres" }), "s.db.external.postgres.direct_query");
registerStatement("mvp:dbo_external_snowflake_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "snowflake" }), "s.db.external.snowflake.direct_query");
registerStatement("mvp:dbo_getby", dbGet);
registerStatement("mvp:dbo_delby", dbDel);
registerStatement("mvp:dbo_hasby", dbHas);
registerStatement("mvp:dbo_patch", dbPatch);
registerStatement("mvp:dbo_truncate", dbTruncate);
registerStatement("mvp:dbo_get_schema", dbSchema);
registerStatement("mvp:dbo_direct_query", dbDirectQuery);
