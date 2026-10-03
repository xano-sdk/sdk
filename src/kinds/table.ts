/**
 * Table (database) kind → payload key `dbo`. Columns reuse the shared
 * field encoder with the column context; indexes, views, and
 * autocomplete have their own small shapes. Validated against the Xano engine's
 * persisted table shape (the full rich field-type corpus).
 */
import type { UrlLike } from "../util/web-globals.js";
import type { FieldXdo, ExprNode } from "../types/xdo.js";
import { encodeField, COLUMN_CONTEXT, authoredFieldType, isListColumn } from "../fields/field.js";
import type { FieldOptions } from "../fields/field.js";
import type { FieldDescriptor, FieldMap } from "../fields/catalog.js";
import type { RowFromFieldMap, Prettify, BrandOpts, BrandType, ValueOf, ProtoKeySafe, XanoFileRef } from "../fields/value-types.js";
import type { HostedFile } from "../fields/hosted-file.js";
import { encodeComparison } from "../statements/conditional.js";
import type { Condition } from "../statements/conditional.js";
import { RAW_WHERE, isRawWhere, type RawWhere } from "./raw-where.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import { emitDiagnostic } from "../workspace/diagnostics.js";
import { encodeTags } from "./common.js";
import { brandDef } from "./def-brand.js";

/** A column definition: a field with a name + type. */
export interface ColumnDef extends FieldOptions {
  name: string;
  type: string;
}

/**
 * The scalar FAMILY a declared column type belongs to — the grouping every
 * consumer of a column's stored type needs before it can decide what a JS value
 * for that column may be.
 *
 * One table because it was two: the seed coercer and the row-cell
 * coercer each grouped the same type strings into the same families for their
 * own purposes, with no shared source, and had already drifted. Each consumer
 * still owns its POLICY — a seed row coerces loosely (a `Date` or a parseable
 * string for `epochms`), a row cell validates strictly (a whole number) — but
 * they no longer disagree about which types are in a family.
 *
 * A type absent here has no scalar family: `obj`, `json`, a file resource, a
 * geography, a vector, a blob. Consumers treat that as "no bare-literal form"
 * or "ship the JSON as authored", which is theirs to decide, not this table's.
 *
 * `date` is deliberately absent: a row cell takes it as text, and a seed row
 * ships it as authored. Neither is wrong, and unifying them would change what a
 * workspace is allowed to seed, which is not a consolidation.
 */
export type ScalarFamily = "bool" | "int" | "decimal" | "epochms" | "text" | "enum";

export const SCALAR_FAMILY: Readonly<Record<string, ScalarFamily>> = {
  bool: "bool",
  int: "int",
  epochms: "epochms",
  decimal: "decimal",
  text: "text",
  uuid: "text",
  email: "text",
  password: "text",
  enum: "enum",
};

/**
 * A catalog descriptor with its column name: `{ name: "123", ...f.text() }`.
 * The list form that keeps a column order an object cannot — an object puts
 * integer-like keys (`"123"`) first whatever order they were written in.
 */
export type NamedField = FieldDescriptor & { name: string };

/**
 * A table schema is authored either as a list — explicit `ColumnDef`s (raw type
 * strings) or {@link NamedField}s — or, preferred, as a named map of catalog
 * descriptors (`{ id: f.int(), email: f.email() }`).
 */
export type SchemaDef = (ColumnDef | NamedField)[] | FieldMap;

/**
 * Index kind (per the engine's index schema): `primary`/`btree` (+`btree|unique`) on
 * columns, `hash` (equality-only, on one column), `gin` on the internal JSON,
 * `search` (full-text), `gist` (spatial), `vector`. Open-ended (`string & {}`)
 * since the stored layer accepts variants (e.g. `gin|unique`) the authoring DSL
 * doesn't enumerate.
 *
 * `"unique"` is accepted as an ergonomic shorthand for `"btree|unique"` (the
 * literal the engine requires); it is normalized on export. See
 * {@link normalizeIndexType}.
 *
 * `"hash"` was reachable only through the `string & {}` escape, so it got no
 * autocomplete and no checking. Live-verified: a deployed table carrying one
 * exports back as `type: "hash"`. It indexes a single column for EQUALITY only —
 * no range, no ordering, no `sort` — which is the whole reason to pick it over
 * `btree`: a smaller index on a wide column matched with `=` and nothing else.
 */
export type IndexType =
  | "primary"
  | "btree"
  | "btree|unique"
  | "unique"
  | "hash"
  | "gin"
  | "search"
  | "gist"
  | "vector"
  | (string & {});

/**
 * Map author-facing index-type shorthands to the literal the Xano engine
 * accepts. Today just `"unique"` → `"btree|unique"`: `"unique"` is the obvious
 * thing to write and type-checks (the union ends in `string & {}`), but the
 * engine rejects it at import with an opaque `Invalid index type.` 500. Applied
 * everywhere a type is compared or serialized so dedup and export agree.
 */
export function normalizeIndexType(type: IndexType): string {
  return type === "unique" ? "btree|unique" : type;
}

/**
 * Per-field index operator: `asc`/`desc` (btree), `jsonb_ops`/`jsonb_path_ops`
 * (gin on a json or object column), `array_ops` (gin on a list column),
 * `gist_geometry_ops_2d` (gist), or a pgvector distance op (vector indexes).
 */
export type IndexOp =
  | "asc"
  | "desc"
  | "jsonb_path_op"
  | "jsonb_ops"
  | "jsonb_path_ops"
  | "array_ops"
  | "gist_geometry_ops_2d"
  | "vector_ip_ops"
  | "vector_cosine_ops"
  | "vector_l1_ops"
  | "vector_l2_ops"
  // A SEARCH index's per-column weight, stored as a letter. See
  // {@link SearchPriority} — prefer `priority: 1` to writing `op: "A"`.
  | "A"
  | "B"
  | "C"
  | "D"
  | (string & {});

/**
 * How strongly a column counts toward a full-text match, 1 (highest) to 4.
 *
 * A `search` index over several columns ranks a hit by which column it was
 * found in — a title match should outrank a body match — and the engine stores
 * that weight as the letters `A`–`D` in the field's `op`. Both spellings are
 * accepted here and encode identically; `priority` is the one the platform's own
 * surfaces use, and the one that does not require knowing the mapping.
 *
 * Live-verified: a deployed search index written with priorities 1 and 3 exports
 * back with its fields carrying `op: "A"` and `op: "C"`.
 *
 * Omitted, a search field weighs `A`/1, which is the engine's default and means
 * every column counts the same — i.e. no ranking at all, which is rarely what a
 * multi-column search index is for.
 */
export type SearchPriority = 1 | 2 | 3 | 4;

/** `priority` 1-4 → the stored `op` letter. */
const PRIORITY_OPS = ["A", "B", "C", "D"] as const;

/** Full-text-search index language (per the engine's search-index schema). */
export type IndexLang =
  | "simple"
  | "arabic"
  | "danish"
  | "dutch"
  | "english"
  | "finnish"
  | "french"
  | "german"
  | "hungarian"
  | "indonesian"
  | "irish"
  | "italian"
  | "lithuanian"
  | "nepali"
  | "norwegian"
  | "portuguese"
  | "romanian"
  | "russian"
  | "spanish"
  | "swedish"
  | "tamil"
  | "turkish"
  | (string & {});

/** A database index definition. */
export interface IndexDef {
  type: IndexType;
  /**
   * The indexed columns, in order.
   *
   * `op` is the stored per-field operator (`asc`/`desc` for btree, the pgvector
   * op for a vector index, the `A`-`D` weight for a search index). On a `search`
   * index prefer `priority` — it is the same value in the spelling the platform
   * uses, and it is refused alongside `op` rather than one silently winning.
   */
  fields: Array<{ name: string; op?: IndexOp; priority?: SearchPriority }>;
  name?: string;
  /** A `search` index's language; omitted, `"english"`. */
  lang?: IndexLang;
}

/** A table view: a saved, filtered/sorted projection of the table. */
export interface ViewDef {
  name: string;
  /** Stable view id (uuid). Required — the engine persists it verbatim. */
  id: string;
  alias?: string;
  /** Columns to hide in the view → stored `hiddenCols`. */
  hide?: string[];
  /** Free-text search query → stored `q`. */
  q?: string;
  /**
   * Filter expression (reuses the conditional comparison shape). A pulled view
   * whose stored filter no `Condition` can express carries it through
   * `rawWhere()` from `@xano/sdk/codegen` instead.
   */
  where?: Condition | RawWhere;
  /** Sort order, applied in array order. */
  sort?: Array<{ name: string; order: "asc" | "desc" }>;
}

/**
 * The column-name union for a table authored with a {@link FieldMap} schema:
 * the declared column keys plus the auto-injected system columns. Drives
 * schema-aware statement typing (db `fieldName`/`output`/`sortBy`/`row` keys).
 */
export type SchemaCols<S extends FieldMap> = Extract<keyof S, string> | "id" | "created_at";

/**
 * The auto-injected system columns as they appear on a **row**, parameterized by
 * the table's {@link TableDef.idType}: the primary key `id` (a `number` for the
 * default `int`, a `string` for `uuid`) and the `epochms` `created_at` (always a
 * number). A `FieldMap`-schema table adds these to {@link RowOf} unless it
 * declares its own.
 */
type SystemRow<IdT extends "int" | "uuid"> = {
  id: IdT extends "uuid" ? string : number;
  created_at: number;
};

/**
 * The **row type** of a `FieldMap`-schema table — the shape a read returns: each
 * declared column (value types recovered from the field brands, `nullable`/
 * `array` applied) plus the auto-injected system columns `id`/`created_at`,
 * unless the schema declares its own. `IdT` threads the table's
 * {@link TableDef.idType} through so a `uuid` primary key infers `id: string`
 * (not `number`); `Sys` threads {@link TableDef.system} through so a
 * `system:false` table drops the injected columns (matching its narrower runtime
 * row). The read-side mirror of the request-only
 * {@link import("../inputs/infer.js").InferInput}. Recovered from a table handle
 * via {@link InferRow}.
 *
 * `Sys` is compared non-distributively (`[Sys] extends [false]`) so only a
 * literal `false` drops the columns — an unresolved `boolean` keeps them, the
 * safe default. Note {@link SchemaCols} (the column-name phantom) is unaffected
 * and still always carries `id`/`created_at`; the two intentionally diverge for
 * `system:false` (a name may still be referenced even when the read row omits it).
 *
 * This is the table's full declared row, not any one endpoint's payload — a query
 * returns whatever its `response`/`output` selects. `created_at` carries
 * `access:"private"`, but private does not filter a read: a default `db.query`/
 * `db.get` response returns `created_at` like any other column, so this type
 * matches what such an endpoint sends.
 */
export type RowOf<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
> = Prettify<
  ([Sys] extends [false] ? Record<never, never> : Omit<SystemRow<IdT>, keyof S>) &
    RowFromFieldMap<S, "column">
>;

/**
 * Recover a table's row type from a {@link table} handle:
 * `InferRow<typeof postTable>`. Closes the loop the SDK opens with `InferInput`
 * on the request side — rename or retype a column and every consumer that types
 * a row against `InferRow` lights up. A table authored with a raw `ColumnDef[]`
 * schema carries no field brands, so its row is `unknown` (nothing to infer).
 */
export type InferRow<T> = T extends TableDef<string, infer Row> ? Row : never;

/**
 * The columns of a `FieldMap` schema stored `access:"internal"` — an explicit
 * `access: "internal"`, or an `f.password()` that does not override its
 * built-in one. A read response never carries them, so the db read types omit
 * them; {@link InferRow} (and a seed row) keeps them, since a write sets them.
 */
export type InternalCols<S> = {
  [K in keyof S]: BrandOpts<S[K]> extends { access: infer A }
    ? A extends "internal"
      ? K
      : never
    : BrandType<S[K]> extends "password"
      ? K
      : never;
}[keyof S] &
  string;

/** A table handle's {@link InternalCols}; `never` for an unbranded table. */
export type InternalColsOf<T> = T extends TableDef<string, unknown, infer I> ? (string extends I ? never : I) : never;

/**
 * A single seed row: a plain JSON record shipped in the deploy package and
 * inserted on deploy. `Row` is the table's inferred read shape ({@link RowOf}),
 * with the auto-injected system columns made optional — `id` and `created_at`
 * carry engine defaults (auto-increment / `now`), so a seed row may omit them;
 * supplying `id` pins it (the engine preserves it and resets the PK sequence).
 * A raw-`ColumnDef[]` (unbranded) table falls back to an open record.
 */
export type SeedRow<Row = unknown> = [Row] extends [never]
  ? Record<string, unknown>
  : unknown extends Row
    ? Record<string, unknown>
    : SeedFiles<
        Partial<Pick<Row & object, Extract<"id" | "created_at", keyof Row>>> & Omit<Row & object, "id" | "created_at">
      >;

/** Exactly a stored file — not any object that happens to fit its all-optional shape. */
type IsFileRef<V> = [V] extends [XanoFileRef] ? ([XanoFileRef] extends [V] ? true : false) : false;

/**
 * A file column's seed value may also be `hostedFile("./x.png", import.meta.url)`:
 * the file ships with the release and the row points at the destination's copy.
 */
type SeedFileValue<V> =
  IsFileRef<NonNullable<V>> extends true
    ? V | HostedFile
    : NonNullable<V> extends ReadonlyArray<infer E>
      ? IsFileRef<E> extends true
        ? V | ReadonlyArray<E | HostedFile>
        : V
      : V;

/** {@link SeedFileValue} over every column of a seed row. */
type SeedFiles<T> = { [K in keyof T]: SeedFileValue<T[K]> };

/**
 * The AUTHORING shape of one seed row for a {@link FieldMap} schema — a write
 * payload, not a read row: a column without `required: true` is an OPTIONAL key
 * (the engine applies its default for an absent column, and `coerceSeedRows`
 * leaves it absent), while a `required` one must be supplied. Only the injected
 * system columns are added, and those are optional too.
 *
 * Distinct from {@link RowOf}, the READ shape, where every declared column is
 * present. Using the read shape here demanded every column on every seed row —
 * stricter than both the runtime validator and the engine.
 */
export type SeedRowOf<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
> = Prettify<
  ([Sys] extends [false] ? Record<never, never> : Partial<Omit<SystemRow<IdT>, keyof S>>) &
    NullableOptional<SeedFields<S>>
>;

/**
 * Keys a seed row must spell: `required: true` and no `default` — an omitted
 * column with a default takes it (`f.tableRef(t, { required: true, default: 0 })`),
 * which the runtime check agrees with.
 */
type SeedRequiredKeys<M> = {
  [K in keyof M]: BrandOpts<M[K]> extends { required: true }
    ? BrandOpts<M[K]> extends { default: string | number | boolean }
      ? never
      : K
    : never;
}[keyof M];

/** {@link FromFieldMap} on the column surface, with a defaulted column optional. */
type SeedFields<M> = { [K in SeedRequiredKeys<M>]: SeedFileValue<ValueOf<M[K], "column">> } & {
  [K in Exclude<keyof M, SeedRequiredKeys<M>>]?: SeedFileValue<ProtoKeySafe<K, ValueOf<M[K], "column">>>;
};

/**
 * A nullable column is an optional seed key even when `required`: an omitted one
 * stores null, as `s.db.add` accepts (E2E pass 24: `owner: null` had to be spelled).
 */
type NullableOptional<T> = { [K in keyof T as null extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as null extends T[K] ? K : never]?: T[K];
};

/**
 * How a table's seed rows are supplied. Either the rows directly, or — the
 * frontend-safe form — a **deferred source**: a thunk (optionally async, e.g.
 * `() => import("./seed.json")`) resolved only in the Node deploy pipeline. A
 * deferred source keeps large or sensitive seed data out of any frontend bundle
 * that value-imports the table def, and is erased entirely under `import type`.
 * Prefer the thunk form for anything beyond a handful of inline rows — it costs
 * no typing (row and column inference survive every form).
 *
 * A JSON `import()` resolves to a module namespace at runtime, not the array
 * TypeScript types the specifier as; the deploy path unwraps `.default`, so
 * `() => import("./seed.json")` works as written.
 */
export type SeedSource<Row = unknown> =
  | ReadonlyArray<SeedRow<Row>>
  | SeedFileSource
  | (() => ReadonlyArray<LooseSeedRow<SeedRow<Row>>> | Promise<ReadonlyArray<LooseSeedRow<SeedRow<Row>>>>);

/**
 * Widen a literal type to its base. `"a" | "b"` → `string`, `1 | 2` → `number`;
 * everything else (including `null`, `Date` and nested arrays) is preserved.
 */
type WidenSeedValue<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends ReadonlyArray<infer E>
        ? ReadonlyArray<WidenSeedValue<E>>
        : T;

/**
 * A seed row as a DEFERRED source can actually be typed.
 *
 * A `.json` module's strings infer as `string`, never as the literal union an
 * `f.enum` column brands — so `seed: () => import("./rows.json")` matched no
 * `table()` overload the moment any column was an enum, and the diagnostic was
 * a fourteen-level `TS2769` whose real cause sat on the last line. Almost every
 * realistic table has a closed set somewhere, so the recommended form was
 * broken for most real uses.
 *
 * Deferred rows are therefore typed with literals widened to their base type.
 * Nothing is lost: a file's contents are invisible to the type system anyway,
 * and membership is enforced at export by `coerceSeedRows`, where the value and
 * the column's declared options are both in hand — an error naming the table,
 * the row index, the column and the allowed values, which is a better
 * diagnostic than the overload wall ever was.
 *
 * The INLINE form is untouched and stays strict: an invalid literal is still a
 * compile error (reported at the `table(` call, since the overload is what
 * fails to match).
 *
 * Homomorphic by construction, so optional and readonly modifiers survive.
 */
export type LooseSeedRow<Row> = { [K in keyof Row]: WidenSeedValue<Row[K]> };

/** Brand for {@link seedFile}'s marker, so the deploy path can recognise it structurally. */
export const SEED_FILE: unique symbol = Symbol.for("xanosdk.seed.file") as never;

/** A seed source that names a JSON file by PATH — see {@link seedFile}. */
export interface SeedFileSource {
  readonly [SEED_FILE]: { readonly path: string; readonly base: string };
}

/**
 * Seed rows from a JSON file, named by path — the form that cannot reach a
 * frontend bundle.
 *
 * ```ts
 * seed: seedFile("./seed/user.json", import.meta.url)
 * ```
 *
 * Prefer this over `seed: () => import("./seed.json")` for anything you would
 * mind publishing. **The thunk does not keep seed values out of a frontend
 * build**, despite reading as though it should: the `import()` sits in YOUR
 * module, not in `@xano/sdk`, so a bundler sees an ordinary dynamic import
 * and emits the JSON as a served chunk. Nothing the SDK does to its own code can
 * prevent that. A frontend that value-imports any def whose module graph reaches
 * the table then ships the seed to the browser.
 *
 * A path is a plain string, so there is nothing for a bundler to follow. The
 * file is read with `node:fs` in the deploy pipeline only.
 *
 * `base` is required, and is `import.meta.url` at the call site: `path` resolves
 * relative to the FILE THAT DECLARES THE TABLE, which is where an author is
 * looking when they write it — not the CLI's working directory, and not the
 * workspace entry. Passing it explicitly is what makes that true for a table
 * defined in a nested module.
 *
 * ⚠ Rows are validated at export (column names and coercion, per table schema),
 * not at author time — a JSON file's contents are not visible to the type
 * system. Keep secrets out of seed data regardless of form: a seed is throwaway
 * fixture data for disposable environments.
 */
export function seedFile(path: string, base: string | UrlLike): SeedFileSource {
  return { [SEED_FILE]: { path, base: typeof base === "string" ? base : base.href } };
}

/** Whether a {@link SeedSource} is a {@link seedFile} marker. */
export function isSeedFileSource(source: SeedSource): source is SeedFileSource {
  return typeof source === "object" && source !== null && SEED_FILE in source;
}

/**
 * @typeParam Cols - phantom column-name union, captured by {@link table} from a
 *   `FieldMap` schema so db statements can type their column-name fields against
 *   it. Defaults to `string` (a table authored with a raw `ColumnDef[]`, or a
 *   bare-name reference, stays loosely typed). Never set at runtime.
 * @typeParam Row - phantom row-type carrier, captured by {@link table} from a
 *   `FieldMap` schema so `InferRow<typeof table>` can recover the read shape.
 *   Defaults to `unknown` (a raw-schema/bare-name table carries no brands).
 *   Never set at runtime.
 */
export interface TableDef<Cols extends string = string, Row = unknown, Internal extends string = string> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "table";
  /** @internal phantom carrier for {@link Cols}; never assigned at runtime. */
  readonly __cols?: Cols;
  /** @internal phantom carrier for {@link Row}; never assigned at runtime. */
  readonly __row?: Row;
  /** @internal phantom carrier for the `access:"internal"` column names; never assigned at runtime. */
  readonly __internal?: Internal;
  name: string;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"table">;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  auth?: boolean;
  install?: boolean;
  schema: SchemaDef;
  /**
   * Auto-prepend the engine's standard system columns — `id` (int, primary key)
   * and `created_at` (epochms, `default:"now"`, `access:"private"`) — when the
   * authored schema doesn't already declare them. Default `true`; set `false`
   * for a table that owns its primary key shape (e.g. an external/imported one) —
   * it must still declare an `id` column and a `primary` index on it.
   * Columns the author *does* declare are respected and never duplicated.
   */
  system?: boolean;
  /**
   * Type of the auto-injected `id` primary key: `int` (auto-increment, the
   * default) or `uuid`. Ignored when `system:false` or when the author declares
   * their own `id` column. Only affects the system-column shape — the
   * `primary(id)` index is unchanged.
   */
  idType?: "int" | "uuid";
  /**
   * Storage mode. `true` stores every authored field as JSON under the internal
   * `xdo` column (and the engine adds a `gin(xdo)` index); `false` (the default)
   * gives each field its own real Postgres column and no `gin` index. Both look
   * identical to read — `xdo` is hidden. Mirrors the workspace-level `use_xdo`
   * setting (also `false` by default); set per-table to override. Only affects
   * physical storage + the `gin` index, never the authored schema.
   */
  useXdo?: boolean;
  /**
   * Database indexes. The engine's standard set — `primary(id)`,
   * `btree(created_at desc)`, plus `gin(xdo)` when {@link useXdo} is `true` —
   * is auto-prepended (alongside the system columns it indexes) unless
   * `system:false` or you declare an equivalent one (matched by type + covered
   * fields). Declare extras (unique, composite, …) here; they're kept verbatim
   * and the standard set rides along de-duped.
   */
  index?: IndexDef[];
  autocomplete?: string[];
  external?: { source: string; id: string };
  views?: ViewDef[];
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /**
   * Seed rows shipped in the deploy package and inserted on deploy (full-replace
   * import → re-deploy re-seeds cleanly, no duplication). Off the table's
   * persisted schema — it rides as a separate `content/` archive entry, resolved
   * and validated **only in the Node deploy path**, never in the browser-safe
   * bundle. See {@link SeedSource}; prefer a deferred thunk for large data.
   *
   * Typed loosely here (not against `Row`) so a `TableDef<_, ConcreteRow>` stays
   * assignable to `TableDef<string, unknown>` — the {@link table} overload types
   * the authoring input against the real row shape.
   */
  seed?: SeedSource;
  /**
   * Columns whose SEED values are deliberately public — a demo login the
   * frontend prints, say. `deploy --static` refuses a build that carries a seed
   * value from an `internal`, `sensitive` or password column; a column named
   * here is exempt from that scan, on this table only.
   *
   * The column itself is unchanged: an `internal` password stays out of API
   * output. Only its seed values are declared public. Each name must be a
   * non-public column of a table that has a `seed`, or the export fails.
   *
   * @example
   * table({ name: "user", schema: { email: f.email(), password: f.password() },
   *   seed: seedFile("./seed/user.json", import.meta.url), publicSeed: ["password"] })
   */
  publicSeed?: readonly string[];
}

export interface IndexXdo {
  name: string;
  lang: string;
  type: string;
  fields: Array<{ name: string; op: string }>;
  market_item: { id: number; version: number; guid: string };
}

export interface ViewXdo {
  alias: string;
  hiddenCols: string[];
  id: string;
  name: string;
  q: string;
  expression: ExprNode[];
  sort: Array<{ name: string; order: string }>;
}

export interface TableXdo {
  name: string;
  description: string;
  docs: string;
  auth: boolean;
  install: boolean;
  schema: FieldXdo[];
  index: IndexXdo[];
  autocomplete: Array<{ name: string }>;
  external: { source: string; id: string };
  views: ViewXdo[];
  tag: unknown[];
  sql_name: string;
  use_xdo: boolean;
  market_item: { id: number; version: number; guid: string };
}

/** Normalize either schema authoring form into a flat `ColumnDef[]`. */
function toColumns(schema: SchemaDef): ColumnDef[] {
  if (Array.isArray(schema)) {
    return schema.map((c) => {
      if (!("options" in c) || c.options === null || typeof c.options !== "object") return c as ColumnDef;
      const { name, type, options } = c as NamedField;
      return { name, type, ...options };
    });
  }
  return Object.entries(schema).map(([name, d]) => ({ name, type: d.type, ...d.options }));
}

/**
 * The engine's standard system columns, in canonical order. Confirmed identical
 * at the head of every persisted `schema:table*` fixture: `id` is the primary
 * key (`required`, `int` by default or `uuid` via {@link TableDef.idType}),
 * `created_at` an `epochms` (stored name for `timestamp`) with `default:"now"`
 * and `access:"private"`.
 */
function systemColumns(idType: TableDef["idType"] = "int"): ColumnDef[] {
  return [
    // A uuid primary key persists NO `default` key — the value is
    // engine-generated. An `int` key and an ordinary (non-key) uuid column both
    // carry `default: ""`, so this is specific to the uuid key; a declared key
    // can state `default: ""` instead (see `primaryKeyColumn`). See
    // {@link FieldOptions.noDefault}.
    // `nullable` is pinned on both, not left to the per-type default: a uuid
    // column is nullable by default (see COLUMN_NULLABLE_BY_DEFAULT), but a PRIMARY KEY
    // never is, and every captured `id`/`created_at` stores `nullable: false`.
    {
      name: "id",
      type: idType,
      required: true,
      nullable: false,
      ...(idType === "uuid" ? { noDefault: true } : {}),
    },
    { name: "created_at", type: "epochms", default: "now", access: "private", nullable: false },
  ];
}

/**
 * The table's columns as a flat `ColumnDef[]`, regardless of authoring form,
 * with the system columns auto-prepended unless `system:false` or the author
 * already declared them. Shared by {@link encodeTable} and db row expansion so
 * both see the same column list.
 */
export function tableColumns(def: Pick<TableDef, "schema" | "system" | "idType"> & { name?: string }): ColumnDef[] {
  const cols = toColumns(def.schema);
  if (def.system === false) return cols.map((col) => primaryKeyColumn(def.name, col));
  const present = new Set(cols.map((col) => col.name));
  const missing = systemColumns(def.idType).filter((sc) => !present.has(sc.name));
  return [...missing, ...cols.map((col) => primaryKeyColumn(def.name, col))];
}

/**
 * A declared `id` is the primary key, so it carries the key's system properties
 * whatever the declaration says: measured live, an `f.int()` id (not required)
 * fails every deploy with SQL 42601 naming no table, and `required: true` lands.
 * A key of any type but `int` or `uuid` fails too (42804), so it is refused.
 */
function primaryKeyColumn(table: string | undefined, col: ColumnDef): ColumnDef {
  if (col.name !== "id") return col;
  if (col.type !== "int" && col.type !== "uuid") {
    throw new Error(
      `${table === undefined ? "" : `table "${table}", `}column "id" (${authoredFieldType(col.type)}): \`id\` is the table's primary key, which is an int or a uuid — ` +
        `any other type fails the deploy. Declare \`id: f.int()\` or \`id: f.uuid()\`, or leave it out ` +
        `(\`idType: "uuid"\` picks a uuid key).`,
    );
  }
  const key = systemColumns(col.type)[0]!;
  // A uuid key stated with an explicit `default` keeps it. Both stored spellings
  // of the key are real: some workspaces store no `default` and others store
  // `default: ""` (every uuid key in the corpus sweep). The engine discards a
  // required column's default either way, so `noDefault` is only the key's
  // spelling when the author does not state one.
  if (col.type === "uuid" && col.default !== undefined) {
    const { noDefault: _omitted, ...stated } = key;
    return { ...col, ...stated };
  }
  return { ...col, ...key };
}

/**
 * The engine's standard indexes, auto-created alongside a table's system
 * columns, in canonical order. Confirmed against live `mvp_dbo`: the `id`
 * primary key, then (only when `use_xdo`) a `gin` index on the internal `xdo`
 * JSON column (`jsonb_path_op`), then a descending `btree` on `created_at`. The
 * `gin(xdo)` index exists iff the table stores fields as JSON — see
 * {@link TableDef.useXdo}.
 */
function systemIndexes(useXdo = false): IndexDef[] {
  return [
    { type: "primary", fields: [{ name: "id" }] },
    ...(useXdo ? [{ type: "gin" as const, fields: [{ name: "xdo", op: "jsonb_path_op" }] }] : []),
    { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
  ];
}

/** Dedup signature for an index: its type plus the ordered field names it covers. */
function indexSignature(def: IndexDef): string {
  return `${normalizeIndexType(def.type)}|${def.fields.map((field) => field.name).join(",")}`;
}

/**
 * The table's indexes, with the standard system indexes auto-prepended unless
 * `system:false` or the author already declared an equivalent one (matched by
 * type + covered field names). Mirrors {@link tableColumns}: the standard set
 * rides along with the system columns it indexes, and an author who declares
 * their own (e.g. a unique index, or a reordered set) is respected and never
 * doubled.
 */
export function tableIndexes(def: Pick<TableDef, "index" | "system" | "useXdo">): IndexDef[] {
  const declared = def.index ?? [];
  if (def.system === false) return declared;
  const present = new Set(declared.map(indexSignature));
  const missing = systemIndexes(def.useXdo).filter((idx) => !present.has(indexSignature(idx)));
  return [...missing, ...declared];
}

/**
 * The system-column names {@link tableColumns} auto-prepends. Exported so codegen
 * can ask whether an already-complete schema makes that injection a no-op, rather
 * than restating the two names it would have to keep in sync by hand.
 */
export const SYSTEM_COLUMN_NAMES: readonly string[] = systemColumns().map((col) => col.name);

/**
 * `index` with the entries {@link tableIndexes} would re-inject removed — or
 * `null` when removing them would not round-trip.
 *
 * The inverse of the auto-prepend, for codegen: a decoded table already carries a
 * COMPLETE index list, so it has to either suppress the injection (`system:false`,
 * verbose) or drop what the injection puts back (quiet). Choosing the quiet form
 * is only safe if it re-encodes identically, which this asks {@link tableIndexes}
 * itself rather than assuming — a table whose stored set is partial, or carries a
 * differently-named `primary(id)`, gets `null` and keeps the verbose form.
 *
 * Every SUBSET of the standard set is tried, largest first, not just all-of-it.
 * The engine has shipped more than one canonical order: `systemIndexes` writes
 * `primary, gin, created_at`, and 223 tables in the survey instance store
 * `primary, created_at, gin`. Dropping all three of those puts them back in the
 * wrong order, but dropping the two that lead and leaving the `gin` DECLARED
 * reproduces the stored list exactly — so the ordering vintage costs one stated
 * index rather than the whole verbose form. The proof is unchanged: whichever
 * subset is chosen, `tableIndexes` has to rebuild the stored bytes from it.
 */
export function elideSystemIndexes(
  index: readonly IndexDef[],
  useXdo: boolean,
): IndexDef[] | null {
  const system = systemIndexes(useXdo);
  // Compared as ENCODED indexes so the check covers every key the authoring shape
  // leaves optional (`name`, `lang`, a field's `op`) and the canonical ordering
  // the injection imposes, not just the type/fields signature the dedup uses.
  const encoded = (list: readonly IndexDef[]): string => JSON.stringify(list.map(encodeIndex));
  const target = encoded(index);

  for (const subset of subsetsLargestFirst(system.length)) {
    const pending = new Map<string, number>();
    for (const position of subset) {
      const signature = indexSignature(system[position]!);
      pending.set(signature, (pending.get(signature) ?? 0) + 1);
    }
    const kept = index.filter((entry) => {
      const remaining = pending.get(indexSignature(entry)) ?? 0;
      if (remaining === 0) return true;
      pending.set(indexSignature(entry), remaining - 1);
      return false;
    });
    if (kept.length === index.length) continue;
    if (encoded(tableIndexes({ index: kept, useXdo })) === target) return kept;
  }
  return null;
}

/**
 * Every non-empty subset of `0..n-1`, most members first — so the quietest
 * candidate that survives the proof is the one returned. Ordered by size then by
 * position, which keeps the choice deterministic across runs.
 */
function subsetsLargestFirst(n: number): number[][] {
  const all: number[][] = [];
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const members: number[] = [];
    for (let bit = 0; bit < n; bit += 1) if (mask & (1 << bit)) members.push(bit);
    all.push(members);
  }
  return all.sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

export function encodeIndex(def: IndexDef): IndexXdo {
  return {
    name: def.name ?? "",
    // A search index with no language fails the deploy (measured: SQL 42602);
    // the engine's own default is english.
    lang: def.lang || (normalizeIndexType(def.type) === "search" ? "english" : ""),
    type: normalizeIndexType(def.type),
    fields: def.fields.map((field) => ({ name: field.name, op: searchOp(def, field) })),
    market_item: { id: 0, version: 0, guid: "" },
  };
}

/**
 * The stored `op` for one index field, folding a search index's `priority` into
 * the letter the engine keeps.
 *
 * Supplying both is refused rather than resolved: they are two spellings of one
 * value, so a disagreement between them has no correct reading, and picking one
 * silently would rank a search index by a weight the author did not write.
 */
function searchOp(def: IndexDef, field: { name: string; op?: IndexOp; priority?: SearchPriority }): string {
  if (field.priority === undefined) return field.op ?? "";
  if (field.op !== undefined) {
    throw new Error(
      `table index field "${field.name}": \`op\` and \`priority\` are two spellings of the same ` +
        `stored value (priority 1-4 is op "A"-"D"). Supplying both has no correct reading — ` +
        `drop one.`,
    );
  }
  if (normalizeIndexType(def.type) !== "search") {
    throw new Error(
      `table index field "${field.name}": \`priority\` is a SEARCH index's per-column weight, ` +
        `and this index is "${def.type}". On any other index the operator slot means something ` +
        `else entirely (sort direction, a pgvector distance op), so a priority written here ` +
        `would be stored as a letter the index does not understand. Use \`op\`.`,
    );
  }
  return PRIORITY_OPS[field.priority - 1]!;
}

export function encodeView(def: ViewDef): ViewXdo {
  return {
    alias: def.alias ?? "",
    hiddenCols: def.hide ?? [],
    id: def.id,
    name: def.name,
    q: def.q ?? "",
    expression: isRawWhere(def.where)
      ? (structuredClone(def.where[RAW_WHERE]) as ExprNode[])
      : def.where
        ? encodeComparison(def.where).expression
        : [],
    sort: (def.sort ?? []).map((s) => ({ name: s.name, order: s.order })),
  };
}

export function encodeColumn(def: ColumnDef): FieldXdo {
  const { name, type, ...options } = def;
  return encodeField(name, type, options, COLUMN_CONTEXT);
}

/**
 * Reject a 4-byte (astral-plane) column `default` at author time.
 * The engine's default pipeline round-trips the value through a surrogate-pair
 * JSON escape (PHP `json_encode("🌱")` → `"🌱"`) and a downstream
 * decode emits the surrogate halves as invalid CESU-8 bytes, so a default with
 * a character above the BMP (codepoint > U+FFFF — emoji, CJK-extension glyphs)
 * type-checks and `export`s cleanly but 500s at `deploy` with a raw Postgres
 * `22021` (`invalid byte sequence for encoding "UTF8"`) at table-creation time —
 * a "compiles/exports but blows up later" failure. The database
 * is UTF8, so BMP characters (accents, `€`, most CJK) store fine and are *not*
 * rejected; only surrogate-pair characters break. Verified against the engine's
 * Postgres image. Column defaults only: *input* defaults bind at runtime, not as
 * DDL, so they accept any character and never reach this path.
 */
function assertBmpColumnDefault(tableName: string, col: ColumnDef): void {
  if (col.default === undefined) return;
  for (const ch of String(col.default)) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const u = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new Error(
        `table "${tableName}", column "${col.name}": \`default\` contains a 4-byte ` +
          `character (${JSON.stringify(ch)}, ${u}). The engine mangles such characters ` +
          `into an invalid UTF-8 sequence in the column default, failing at deploy with ` +
          `Postgres 22021 (invalid byte sequence for encoding "UTF8"). Use a default within ` +
          `the Basic Multilingual Plane (accents, most CJK, and € are fine), or move the ` +
          `value onto an endpoint input (\`input.text({ default })\`), applied at runtime ` +
          `bind.`,
      );
    }
  }
}

/**
 * Refuse an apostrophe in a text, email or enum column `default` on a table
 * that keeps its fields as columns (`useXdo: false`, its own or inherited),
 * measured live: the database takes the default as written, so a lone `'`
 * fails the deploy that creates the table — or adds the column under
 * `--keep-data` — with an SQL syntax error naming neither, and a doubled `''`
 * deploys but the database's default reads back as a single `'`. A JSON-storage
 * table and a list column store the value exactly.
 */
function assertColumnDefaultQuote(tableName: string, col: ColumnDef, useXdo: boolean): void {
  const family = Object.hasOwn(SCALAR_FAMILY, col.type) ? SCALAR_FAMILY[col.type] : undefined;
  if (useXdo || isListColumn(col) || (family !== "text" && family !== "enum")) return;
  if (typeof col.default !== "string" || !col.default.includes("'")) return;
  throw new Error(
    `table "${tableName}", column "${col.name}" (${authoredFieldType(col.type)}): \`default\` ${JSON.stringify(col.default)} ` +
      `contains an apostrophe, which a table that keeps its fields as columns cannot take in a default — the deploy ` +
      `fails with an SQL syntax error. Use a typographic apostrophe (\u2019), set the value at insert instead of as ` +
      `the default, or give the table \`useXdo: true\`.`,
  );
}

/**
 * Reject an index over a column the table does not have.
 *
 * Nothing downstream catches this: the bundle encodes fine, and the failure
 * surfaces at deploy as a Postgres/engine error naming neither the Xano SDK table
 * nor the columns it does have — so a typo (`"titl"` for `"title"`, or an index
 * written before the column it covers) costs a whole deploy cycle to read.
 *
 * Checked against {@link tableColumns}, not the authored `schema`: `id` and
 * `created_at` are real, indexable columns when the system set is injected, and
 * are genuinely absent under `system:false`. `xdo` joins them unconditionally —
 * it is the engine's internal JSON column, never in a schema and never a typo.
 * Only DECLARED indexes are checked; the system set {@link tableIndexes}
 * injects is this SDK's own and covers columns it knows exist. The wording
 * mirrors the seed-row unknown-column error so the two read as one system.
 */
function assertIndexColumns(def: TableDef): void {
  const known = tableColumns(def).map((col) => col.name);
  const set = new Set([...known, "xdo"]);
  for (const index of def.index ?? []) {
    for (const field of index.fields) {
      if (set.has(field.name)) continue;
      // A DOTTED name addresses a key INSIDE a column rather than a column:
      // `xdo.email` is a unique btree over the `email` key of the `xdo` JSON
      // column, which the engine stores and an export returns untouched. The
      // leading segment is the column and is checked like any other; the
      // remainder is a path within it and is not something this SDK can verify —
      // a JSON column has no declared inner schema to check against, and
      // guessing would reject a valid index.
      const column = field.name.slice(0, field.name.indexOf("."));
      if (column !== "" && set.has(column)) continue;
      const signature = `${normalizeIndexType(index.type)}(${index.fields.map((f) => f.name).join(", ")})`;
      throw new Error(
        `table "${def.name}", index "${signature}": unknown column "${field.name}" (not in table schema). ` +
          `Known columns: ${known.join(", ")}. An index over a column that does not exist exports cleanly ` +
          `and fails at deploy with an engine error that names neither.`,
      );
    }
  }
}

/**
 * Refuse an index the engine rejects at deploy, naming the table and index
 * (the engine's own error names neither), each measured live on both storage
 * modes: any index on a file column (image, attachment, …), a `hash` index over
 * other than one column or over a vector or geo column, a `vector` index over
 * other than one `vector` column or with no `op`, a `gist` index on a non-geo
 * column, a `gin` index on other than a json, object or list column — and on a
 * JSON-storage (`useXdo`) table on a list column too — a `gin` op its column
 * does not take, a `search` index on other than a text, email, password or enum
 * column, and a per-field `op` outside what the type takes. On a JSON-storage
 * table a btree, unique or hash index also fails on a vector column, and turns
 * inserts into an SQL error on a list of anything but text or json. Dotted
 * (`xdo.<key>`) fields address JSON keys and are not type-checked.
 */
function assertIndexFieldTypes(def: TableDef): void {
  const columns = new Map(tableColumns(def).map((col) => [col.name, col]));
  for (const index of def.index ?? []) {
    const type = normalizeIndexType(index.type);
    const at = `table "${def.name}", index "${type}(${index.fields.map((f) => f.name).join(", ")})"`;
    if ((type === "hash" || type === "vector") && index.fields.length !== 1) {
      throw new Error(`${at}: a ${type} index covers exactly one column — the deploy fails on ${index.fields.length}. Declare one index per column.`);
    }
    const ops = INDEX_OPS[type];
    const xdo = def.useXdo === true;
    const plainIndex = type === "btree" || type === "btree|unique" || type === "hash";
    for (const field of index.fields) {
      const col = columns.get(field.name);
      const column = col?.type;
      const list = col !== undefined && isListColumn(col);
      const shown = column === undefined ? "" : `${authoredFieldType(column)}${list ? " list" : ""}`;
      if (column?.startsWith("blob") === true) {
        throw new Error(`${at}: "${field.name}" is ${shown}, and a file column cannot be indexed — the deploy fails with "Complex schema is not supported.". Index a column that holds the value you match on.`);
      }
      if (xdo && plainIndex && column === "vector") {
        throw new Error(`${at}: "${field.name}" is ${shown}, and on a \`useXdo: true\` table a ${type === "btree|unique" ? "unique" : type} index cannot cover a vector column — the deploy fails with an SQL syntax error. Use a vector index.`);
      }
      if (xdo && plainIndex && list && column !== undefined && !XDO_LIST_INDEXABLE.has(column)) {
        throw new Error(`${at}: "${field.name}" is ${shown}, and on a \`useXdo: true\` table a ${type === "btree|unique" ? "unique" : type} index over a list of anything but text or json deploys, then fails inserts with an SQL error. Drop the index, or keep the table's fields as columns (\`useXdo: false\`).`);
      }
      if (type === "vector" && column !== undefined && column !== "vector") {
        throw new Error(`${at}: "${field.name}" is ${shown}, and a vector index needs an \`f.vector(size)\` column — the deploy fails with "Malformed vector index".`);
      }
      if (type === "vector" && (field.op === undefined || field.op === "")) {
        throw new Error(`${at}: a vector index needs the distance \`op\` its queries use on "${field.name}" (${(INDEX_OPS.vector ?? []).map((o) => JSON.stringify(o)).join(", ")}) — the deploy fails with "Malformed vector index" without one.`);
      }
      if (type === "gist" && column !== undefined && !column.startsWith("geo_")) {
        throw new Error(`${at}: "${field.name}" is ${shown}, and a gist (spatial) index needs a geo column (\`f.geo.point()\`, …) — the deploy fails on any other.`);
      }
      if (column === undefined || field.name === "xdo") {
        // `xdo` (the engine's JSON column) and dotted paths are not type-checked.
      } else if (type === "gin" && ((column !== "json" && column !== "obj" && !list) || (xdo && list))) {
        throw new Error(
          xdo && list
            ? `${at}: "${field.name}" is ${shown}, and on a \`useXdo: true\` table a gin index needs a json or object column — the deploy fails on a list. Keep the table's fields as columns (\`useXdo: false\`) to gin-index a list.`
            : `${at}: "${field.name}" is ${shown}, and a gin index needs a json, object or list column — the deploy fails on any other. Use a \`search\` index for text, or \`btree\`.`,
        );
      } else if (type === "gin" && field.op !== undefined && GIN_OPS[field.op] !== undefined && !GIN_OPS[field.op]!(list)) {
        throw new Error(`${at}: op ${JSON.stringify(field.op)} on "${field.name}" (${shown}) is for ${list ? "a json or object" : "a list"} column — the deploy fails. Use ${list ? '"array_ops"' : '"jsonb_ops" or "jsonb_path_ops"'}, or no op.`);
      } else if (type === "search" && (list ? !(xdo && SEARCHABLE.has(column)) : !SEARCHABLE.has(column))) {
        throw new Error(`${at}: "${field.name}" is ${shown}, and a search index needs a text, email, password or enum column — the deploy fails on any other.`);
      } else if (type === "hash" && (column === "vector" || column.startsWith("geo_"))) {
        throw new Error(`${at}: "${field.name}" is ${shown}, and a hash index cannot cover a ${column === "vector" ? "vector" : "geo"} column — the deploy fails. Use a ${column === "vector" ? "vector" : "gist"} index.`);
      }
      if (ops !== undefined && field.op !== undefined && field.op !== "" && !ops.includes(field.op)) {
        throw new Error(`${at}: op ${JSON.stringify(field.op)} on "${field.name}" is not one a ${type} index takes (${ops.map((o) => JSON.stringify(o)).join(", ")}).`);
      }
    }
  }
}

/** A `YYYY-MM-DD` that names a real day. */
function calendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null || m[1] === "0000") return false;
  const day = new Date(0);
  day.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return day.getUTCMonth() === Number(m[2]) - 1 && day.getUTCDate() === Number(m[3]);
}

/** The column types a `search` index takes (measured live). */
const SEARCHABLE: ReadonlySet<string> = new Set(["text", "email", "password", "enum"]);

/**
 * The list types a btree, unique or hash index takes on a JSON-storage table
 * (measured live: a text-like or json list deploys and inserts any list; an
 * int, decimal, bool, timestamp or uuid list deploys, then fails every insert,
 * and a date list every insert of other than exactly one date).
 */
const XDO_LIST_INDEXABLE: ReadonlySet<string> = new Set([...SEARCHABLE, "json"]);

/**
 * The per-field `op` values an index type takes. A gin index's
 * `jsonb_path_op` is the engine's own spelling on its `xdo` index and reads as
 * no op.
 */
const INDEX_OPS: Readonly<Record<string, readonly string[]>> = {
  btree: ["asc", "desc"],
  "btree|unique": ["asc", "desc"],
  gin: ["jsonb_path_op", "jsonb_ops", "jsonb_path_ops", "array_ops"],
  vector: ["vector_cosine_ops", "vector_ip_ops", "vector_l1_ops", "vector_l2_ops"],
};

/** Which column a gin op builds on, by whether it is a list (measured: each fails on the other). */
const GIN_OPS: Readonly<Record<string, (list: boolean) => boolean>> = {
  jsonb_ops: (list) => !list,
  jsonb_path_ops: (list) => !list,
  array_ops: (list) => list,
};

/**
 * Refuse a column `default` the column's type cannot hold. The engine hands a
 * literal default to the database as written (it reads only `"now"` itself, on
 * a timestamp or date), so `f.int({ default: "abc" })` exports cleanly and
 * fails the table at deploy with a raw SQL error. An empty or null default is
 * the type's zero and always fits.
 *
 * On a JSON-storage table the same default deploys and is stored — it fails
 * only the inserts that leave the column unset — so there it is a WARNING
 * (`table.column-default-unfit`) a def accepts with `diagnostics.allow`, and a
 * pulled table that carries one still builds.
 */
function assertColumnDefaultFits(tableName: string, col: ColumnDef, useXdo: boolean): void {
  const value: unknown = col.default;
  // A non-scalar default is reported, with its stored text, by `field.default-not-text`.
  if (value === undefined || value === null || value === "" || typeof value === "object" || isListColumn(col)) return;
  const text = String(value);
  const shown = typeof value === "number" ? text : JSON.stringify(value);
  const family = col.type === "date" ? "date" : Object.hasOwn(SCALAR_FAMILY, col.type) ? SCALAR_FAMILY[col.type] : undefined;
  let want: string | undefined;
  switch (family) {
    case "int":
      if (!/^-?\d+$/.test(text) || BigInt(text) > 2n ** 63n - 1n || BigInt(text) < -(2n ** 63n)) want = "a whole number (64-bit)";
      break;
    case "decimal":
      // Strict: `Number()` also reads `0x10`/`0b1`, which the database refuses.
      if (typeof value === "boolean" || !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text)) want = "a number";
      else if (!decimalDefaultInRange(text, useXdo)) {
        throw new Error(
          `table "${tableName}", column "${col.name}" (decimal): \`default\` ${shown} is out of range — ` +
            (useXdo
              ? "a JSON-storage table holds a decimal as a JSON number, and this one is past what a number can hold"
              : "a normalized table holds a decimal in 14 digits, 5 of them after the point, so it must stay below 1000000000 once rounded to 5 places") +
            ` — the table deploys, then every insert that leaves the column unset fails with an SQL error. Use a smaller default.`,
        );
      }
      break;
    case "bool":
      if (!/^(true|false|t|f|yes|no|on|off|1|0)$/i.test(text)) want = "true or false";
      break;
    case "epochms":
      if (text !== "now" && !/^-?\d+$/.test(text)) {
        const ms = /\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : NaN;
        want =
          `"now" (the insert time) or epoch milliseconds` + (Number.isFinite(ms) ? ` — ${JSON.stringify(text)} is \`default: ${ms}\`` : "");
      }
      break;
    case "date":
      if (text !== "now" && !calendarDate(text)) want = `"now" (the insert date) or a real calendar date ("2026-01-31")`;
      break;
  }
  if (want === undefined) return;
  const consequence = !useXdo
    ? "the database takes the default as written, so the table fails to deploy"
    : family === "date"
      ? "a JSON-storage table deploys, then every insert that leaves the column unset is refused or stores a rolled-over day"
      : "a JSON-storage table deploys, then every insert that leaves the column unset is refused";
  const message =
    `table "${tableName}", column "${col.name}" (${authoredFieldType(col.type)}): \`default\` ${shown} does not fit — ` +
    `${consequence}. Use ${want}.`;
  if (!useXdo) throw new Error(message);
  emitDiagnostic({ severity: "warning", code: "table.column-default-unfit", message });
}

/**
 * Whether a decimal default (already a well-formed number) fits where the
 * table stores it, measured live. A normalized table's column holds 14 digits
 * with 5 after the point, and the value is rounded to 5 places before the size
 * is checked: 999999999.999994 fits, 999999999.999995 does not. A JSON-storage
 * table holds a JSON number, so anything a double reads as finite fits (1e308
 * does, 1e400 does not).
 */
function decimalDefaultInRange(text: string, useXdo: boolean): boolean {
  if (useXdo) return Number.isFinite(Number(text));
  const m = /^\s*[+-]?(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?\s*$/.exec(text)!;
  const digits = (m[1]! + m[2]!).replace(/^0+/, "");
  if (digits === "") return true;
  // |value| = digits × 10^exp; it fits when |value| < 999999999.999995, i.e. digits × 10^(exp+6) < 999999999999995.
  const shift = Number(m[3] ?? "0") - m[2]!.length + 6;
  const limit = 999999999999995n;
  if (shift >= 0) return digits.length + shift <= 15 && BigInt(digits) * 10n ** BigInt(shift) < limit;
  if (-shift > digits.length) return true;
  return BigInt(digits) < limit * 10n ** BigInt(-shift);
}

/**
 * A `system:false` table still needs what every table has: an `id` column and
 * a `primary` index on it. Measured live: without the column the deploy fails
 * with SQL 42703, and without the index with 42P01 — neither naming the table.
 */
function assertOwnPrimaryKey(def: TableDef): void {
  if (def.system !== false) return;
  const hasId = tableColumns(def).some((col) => col.name === "id");
  const hasPrimary = (def.index ?? []).some((index) => index.type === "primary" && index.fields.length === 1 && index.fields[0]!.name === "id");
  if (hasId && hasPrimary) return;
  const missing = [hasId ? undefined : "an `id` column (`id: f.int()` or `id: f.uuid()`)", hasPrimary ? undefined : '`{ type: "primary", fields: [{ name: "id" }] }` in `index`']
    .filter((m) => m !== undefined)
    .join(" and ");
  throw new Error(
    `table "${def.name}": a \`system: false\` table still needs an \`id\` primary key — the deploy fails without it. ` +
      `Declare ${missing}, or drop \`system: false\` to have both added (with \`created_at\`).`,
  );
}

export function encodeTable(def: TableDef): TableXdo {
  if (!def.name) throw new Error("table: `name` is required.");
  assertIndexShape(def);
  for (const col of tableColumns(def)) {
    assertBmpColumnDefault(def.name, col);
    assertColumnDefaultFits(def.name, col, def.useXdo === true);
    assertColumnDefaultQuote(def.name, col, def.useXdo === true);
  }
  assertIndexColumns(def);
  assertIndexFieldTypes(def);
  assertOwnPrimaryKey(def);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    auth: def.auth ?? false,
    install: def.install ?? false,
    schema: tableColumns(def).map(encodeColumn),
    index: tableIndexes(def).map(encodeIndex),
    autocomplete: (def.autocomplete ?? []).map((name) => ({ name })),
    external: def.external ?? { source: "", id: "" },
    views: (def.views ?? []).map(encodeView),
    tag: encodeTags(def.tags),
    // A table has no `as` — it returns nothing (it's a datastore, not a stack
    // statement); confirmed 0/16 live `mvp_dbo` rows carry one. (Older golden
    // export fixtures store `as:<name>`, a stale generation — see normalize.ts.)
    // `sql_name` is the engine's physical table name; persisted as "" (the
    // engine derives the real name) — confirmed against live `mvp_dbo`.
    sql_name: "",
    use_xdo: def.useXdo ?? false,
    market_item: { id: 0, version: 0, guid: "" },
  };
}

export const tableKind: ObjectKind<TableDef, TableXdo> = {
  name: "table",
  payloadKey: "dbo",
  encode: encodeTable,
};
registerKind(tableKind);

/**
 * Author a database table. When the schema is a {@link FieldMap}
 * (`{ name: f.text(), … }`), the returned handle captures its column names in
 * the {@link TableDef} `Cols` type param, so db statements that take the table
 * can type their column-name fields (`fieldName`, `output`, `sortBy`, `row`
 * keys) against the real columns. A raw `ColumnDef[]` schema stays loose.
 */
export function table<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
>(
  def: Omit<TableDef, "schema" | "idType" | "system" | "seed" | "publicSeed"> & {
    schema: S;
    idType?: IdT;
    system?: Sys;
    /** Seed rows typed against this table's row shape (system columns optional). */
    seed?: SeedSource<SeedRowOf<S, IdT, Sys>>;
    /** Columns of THIS table whose seed values are deliberately public — see {@link TableDef.publicSeed}. */
    publicSeed?: readonly (keyof S & string)[];
  },
): TableDef<SchemaCols<S>, RowOf<S, IdT, Sys>, InternalCols<S>>;
/**
 * Raw-schema escape hatch: a table authored with a `ColumnDef[]` schema (no field
 * brands, so nothing to infer) stays loosely typed.
 *
 * This overload is deliberately narrowed to `ColumnDef[]` rather than accepting
 * any `TableDef`. A `FieldMap` schema would match a `TableDef`-wide signature
 * too, and TypeScript's overload resolution silently falls through to a later
 * candidate whenever the generic one does not resolve on the first pass — which
 * a function-form `seed` triggers. The result was a table whose `Cols` and `Row`
 * both collapsed with no error reported at the `table()` call. With
 * this overload unable to match a `FieldMap`, the generic signature is the only
 * candidate and resolves, or reports a real error.
 */
export function table(def: Omit<TableDef, "schema"> & { schema: (ColumnDef | NamedField)[] }): TableDef;
export function table(def: TableDef): TableDef {
  if (def !== null && typeof def === "object") {
    assertIndexShape(def);
    assertColumnNames(def);
  }
  return brandDef(def, "table");
}

/**
 * The column names that deploy, seed, take a row and filter, as measured on an
 * ephemeral: ASCII letters, digits and `_ - : @ !`, not starting or ending with
 * `-` and not starting with `@`, and at most 63 bytes. A space, a dot, `$` or a
 * non-ASCII letter fails the deploy; a `?` anywhere, an all-digit name or one
 * made only of `_` and `-` deploys but fails every insert (seed rows included);
 * a leading `@` fails every filter on the column; a name past 63 bytes deploys
 * but reads back empty (the database keeps the first 63 bytes of a column
 * name), and two that share those 63 fail the deploy as duplicates.
 */
const COLUMN_NAME = /^(?![-@])(?![0-9]+$)(?![_-]+$)[A-Za-z0-9_:@!-]+(?<!-)$/;
const COLUMN_NAME_BYTES = 63;

/** The diagnostic a table accepts to keep a live column name the rule refuses. */
export const COLUMN_NAME_UNUSABLE = "table.column-name-unusable";

/** What goes wrong with a column name, or undefined for one that deploys and works. */
export function unusableColumnName(name: string): string | undefined {
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > COLUMN_NAME_BYTES && COLUMN_NAME.test(name)) {
    return `is ${bytes} bytes and the database keeps only the first ${COLUMN_NAME_BYTES}, so it deploys but every read returns it empty`;
  }
  if (COLUMN_NAME.test(name)) return undefined;
  if (/[^\x21-\x7e]|[.$]/.test(name) || name === "") return "cannot be deployed";
  if (/^[A-Za-z0-9_:@!?-]+$/.test(name) && (name.includes("?") || /^[0-9]+$/.test(name) || /^[_-]+$/.test(name))) {
    return "deploys, but every insert into the table fails (seed rows included)";
  }
  if (/^@[A-Za-z0-9_:@!-]*$/.test(name) && !name.endsWith("-")) return "deploys, but every filter on it fails";
  return "is outside the column-name rule";
}

/** The columns of a table whose names {@link unusableColumnName} refuses, with why. */
export function unusableColumns(schema: unknown): { name: string; why: string }[] {
  const names = Array.isArray(schema)
    ? schema.map((c: unknown) => (c !== null && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
    : schema !== null && typeof schema === "object"
      ? Object.keys(schema)
      : [];
  const out: { name: string; why: string }[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const why = unusableColumnName(name);
    if (why !== undefined) out.push({ name, why });
  }
  return out;
}

/**
 * Refuse a column name that cannot be deployed or used, naming the table, the
 * column and the rule. A table that accepts {@link COLUMN_NAME_UNUSABLE} keeps
 * one — a pulled table carries the live name, and renaming it moves data — but
 * never two names the database would truncate to the same column.
 */
function assertColumnNames(def: Pick<TableDef, "name" | "schema" | "diagnostics">): void {
  const schema: unknown = def.schema;
  const names = Array.isArray(schema)
    ? schema.map((c: unknown) => (c !== null && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
    : schema !== null && typeof schema === "object"
      ? Object.keys(schema)
      : [];
  const seen = new Map<string, string>();
  const at = new Map<string, number>();
  for (const [i, name] of names.entries()) {
    if (typeof name !== "string") continue;
    if (at.has(name)) {
      throw new Error(
        `table "${String(def.name)}": schema[${at.get(name)}] and schema[${i}] are both named ${JSON.stringify(name)} — ` +
          `the database keeps one column per name, so the table deploys with one of them. Rename or drop one.`,
      );
    }
    at.set(name, i);
    const head = new TextDecoder().decode(new TextEncoder().encode(name).slice(0, COLUMN_NAME_BYTES));
    const other = seen.get(head);
    if (other !== undefined) {
      throw new Error(
        `table "${String(def.name)}": the column names ${JSON.stringify(other)} and ${JSON.stringify(name)} share their first ` +
          `${COLUMN_NAME_BYTES} bytes, which is all of a column name the database keeps — the deploy fails on a duplicate column. ` +
          `Shorten one of them.`,
      );
    }
    seen.set(head, name);
  }
  if ((def.diagnostics?.allow as readonly string[] | undefined)?.includes(COLUMN_NAME_UNUSABLE)) return;
  const bad = unusableColumns(schema)[0];
  if (bad === undefined) return;
  const { name, why } = bad;
  let fixed = name.trim().replace(/[^A-Za-z0-9_:@!-]+/g, "_").replace(/^[-@_]+|[-_]+$/g, "");
  if (/^[0-9]+$/.test(fixed)) fixed = `col_${fixed}`;
  if (new TextEncoder().encode(fixed).length > COLUMN_NAME_BYTES) fixed = fixed.slice(0, COLUMN_NAME_BYTES).replace(/[-_]+$/, "");
  throw new Error(
    `table "${String(def.name)}": the column name ${JSON.stringify(name)} ${why} — a column name ` +
      `is ASCII letters, digits, \`_\`, \`-\`, \`:\`, \`@\` and \`!\`, does not start or end with \`-\` or start with \`@\`, ` +
      `is not all digits or all \`_\`/\`-\`, and is at most ${COLUMN_NAME_BYTES} bytes.` +
      (fixed !== "" && fixed !== name && unusableColumnName(fixed) === undefined ? ` Rename it, e.g. ${JSON.stringify(fixed)}.` : " Rename it."),
  );
}

/**
 * Refuse an `index` entry that is not `{ type, fields: [{ name }, …] }` with a
 * message naming the entry, rather than a TypeError from deep in the encoder.
 */
/** The index types the engine builds (a `|`-suffix such as `btree|unique` qualifies one). */
const INDEX_TYPES: ReadonlySet<string> = new Set(["primary", "btree", "hash", "gin", "gist", "search", "vector"]);

function assertIndexShape(def: Pick<TableDef, "name" | "index">): void {
  if (def.index === undefined) return;
  const where = `table "${String(def.name)}"`;
  if (!Array.isArray(def.index)) {
    throw new Error(`${where}: \`index\` must be a list of { type, fields } entries — got ${typeof def.index}.`);
  }
  def.index.forEach((index, i) => {
    const at = `${where}, index[${i}]`;
    if (index === null || typeof index !== "object") throw new Error(`${at} must be a { type, fields } entry — got ${String(index)}.`);
    if (typeof index.type !== "string") throw new Error(`${at}: \`type\` must be the index type ("btree", "unique", "search", …).`);
    const base = normalizeIndexType(index.type).split("|")[0]!;
    if (!INDEX_TYPES.has(base)) {
      const hint = base === "spatial" ? " A spatial index is `gist`." : base === "fulltext" || base === "text" ? " A full-text index is `search`." : "";
      throw new Error(
        `${at}: ${JSON.stringify(index.type)} is not an index type the engine builds — the deploy fails with "Invalid index type.", ` +
          `naming no table. Use one of ${[...INDEX_TYPES].filter((t) => t !== "primary").map((t) => `"${t}"`).join(", ")}, "unique".${hint}`,
      );
    }
    if (!Array.isArray(index.fields) || index.fields.length === 0) {
      throw new Error(`${at}: \`fields\` must be a non-empty list of the indexed columns, e.g. \`fields: [{ name: "email" }]\`.`);
    }
    index.fields.forEach((field, j) => {
      if (field === null || typeof field !== "object" || typeof (field as { name?: unknown }).name !== "string") {
        throw new Error(
          `${at}: fields[${j}] must be { name: "<column>" } — got ${JSON.stringify(field) ?? String(field)}.` +
            (typeof field === "string" ? ` Write \`{ name: ${JSON.stringify(field)} }\`.` : ""),
        );
      }
    });
  });
}
