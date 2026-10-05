/**
 * Stored input rows → the validator-neutral {@link InputDescription} the route
 * manifest's input sections are rendered from.
 *
 * Read off the PAYLOAD, never a def. The decode paths (`pull`, `generate`,
 * `init --from`) write `routes.gen.ts` from a source bundle with no compile of
 * the workspace behind it, and `routes --emit` writes it from a compile; the two
 * must produce the same bytes, so both go through this one reading of the same
 * stored rows (`planRouteManifest`).
 *
 * The rows are read defensively, as `unknown`. A payload here may be an engine
 * export of any age, and the persisted form is inconsistent in ways an
 * authored def never is (`src/types/xdo.ts` lists them): `list` bounds as
 * `3`, `"3"`, `""` or `{}`, `customize` as `{}` or `""`, method args as `[8]` or
 * `["8"]`. Each is normalized here, once, so no renderer has to know.
 *
 * Where the XanoScript form and the engine disagree about what an input MEANS,
 * the engine's request binding wins, because the description says what a
 * client may send: a `json` input is always nullable, an `enum`/`vector`/`obj`
 * declared directly has no methods applied, and a dbLink expands the way the
 * engine expands it (see {@link expandDbLink}).
 */
import type { FieldXdo } from "../types/xdo.js";
import type { DbLinkInputDescription, InputDescription, InputDescriptionBase, InputListBounds, InputMethod, InputScalarType } from "../plugin.js";
import { COLUMN_NULLABLE_TYPES, INPUT_NULLABLE_TYPES, isListColumn, type FieldOptions } from "../fields/field.js";
import { linkedTableOf, tableRefOf } from "../bundle/schema.js";

type Row = Readonly<Record<string, unknown>>;

/** A table's stored columns, by table guid — what a dbLink expands against. */
export type TableColumns = ReadonlyMap<string, readonly unknown[]>;

const SCALAR_TYPES: ReadonlySet<string> = new Set<InputScalarType>([
  "text",
  "int",
  "decimal",
  "bool",
  "email",
  "password",
  "uuid",
  "date",
  "epochms",
  "json",
  "file",
  "blob",
  "blob_img",
  "blob_video",
  "blob_audio",
  "geo_point",
  "geo_multipoint",
  "geo_linestring",
  "geo_multilinestring",
  "geo_polygon",
  "geo_multipolygon",
]);

/**
 * The per-type nullable defaults of the two surfaces. An input row and a table
 * column (a dbLink's expansion, an object's children inside one) disagree on
 * `date`/`epochms`/`file`, so a row that omits `nullable` is read against the
 * surface it was stored on, exactly as the encoder wrote it.
 */
const INPUT_NULLABLE: ReadonlySet<string> = new Set(INPUT_NULLABLE_TYPES);
const COLUMN_NULLABLE: ReadonlySet<string> = new Set(COLUMN_NULLABLE_TYPES);

function isRow(v: unknown): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? v.filter(isRow) : [];
}

/** The table columns a payload carries, by guid, for {@link describeInputs}. */
export function tableColumns(payload: Readonly<Record<string, unknown>>): TableColumns {
  const out = new Map<string, readonly unknown[]>();
  for (const table of rows(payload.dbo)) {
    if (typeof table.guid === "string" && table.guid !== "" && Array.isArray(table.schema)) {
      out.set(table.guid, table.schema);
    }
  }
  return out;
}

/** Describe a def's stored `input[]`, in declared order. */
export function describeInputs(input: unknown, tables: TableColumns): InputDescription[] {
  return rows(input).map((row) => describeField(row, INPUT_NULLABLE, tables));
}

/**
 * One bound of a list, or `undefined` for none.
 *
 * The engine renders both bounds with `%d` whenever EITHER is set, so an unset
 * side reaches it as `0` — which is why `0` must mean "no bound" there, and
 * here. Everything that is not a positive integer after that coercion (`""`,
 * `{}`, a stray non-numeric string) is the same unbounded side.
 */
function bound(v: unknown): number | undefined {
  const n = typeof v === "number" ? Math.trunc(v) : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `false` for a single value, else the list's enforced bounds. */
function listOf(row: Row): false | InputListBounds {
  if (!isListColumn({ style: isRow(row.style) ? (row.style as FieldOptions["style"]) : undefined })) return false;
  const stored = isRow(row.list) ? row.list : {};
  const min = bound(stored.min);
  const max = bound(stored.max);
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function methodArg(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/**
 * A row's stored methods as the engine applies them: not a disabled one, and
 * not an `@` annotation — `@` carries a table reference, an access level or a
 * description into the engine's type string, and none of those is something a
 * client's value is checked against. A table reference is described by its own
 * `tableRef` entry instead.
 *
 * `honorDisabled` is off only for a dbLink customization node: the engine's
 * expansion appends a node's methods without reading `disabled`, so a
 * customization's disabled method is still applied.
 */
function methodsOf(stored: unknown, honorDisabled = true): InputMethod[] {
  return rows(stored).flatMap((m) => {
    if (typeof m.name !== "string" || m.name === "@") return [];
    if (honorDisabled && m.disabled === true) return [];
    return [{ name: m.name, args: Array.isArray(m.arg) ? m.arg.map(methodArg) : [] }];
  });
}

/** The flags every described input carries. */
function baseOf(row: Row, type: string, nullableByDefault: ReadonlySet<string>): InputDescriptionBase {
  return {
    name: typeof row.name === "string" ? row.name : "",
    required: row.required === true,
    // The engine binds every `json` input nullable, whatever was stored.
    nullable: type === "json" ? true : typeof row.nullable === "boolean" ? row.nullable : nullableByDefault.has(type),
    list: listOf(row),
    // The engine renders an enum, a vector and an object without their
    // methods, so none of them applies one.
    methods: type === "enum" || type === "vector" || type === "obj" ? [] : methodsOf(row.methods),
  };
}

/**
 * Describe one stored field — an input row, or a table column reached through a
 * dbLink. `nullableByDefault` is the surface it was stored on.
 */
function describeField(row: Row, nullableByDefault: ReadonlySet<string>, tables: TableColumns): InputDescription {
  const type = typeof row.type === "string" ? row.type : "";
  const field = row as unknown as FieldXdo;

  const linked = linkedTableOf(field);
  if (linked !== null) return expandDbLink(row, linked, tables);

  const base = baseOf(row, type, nullableByDefault);
  const table = tableRefOf(field);
  if (table !== null) return { ...base, type: "tableRef", keyType: type === "uuid" ? "uuid" : "int", table };
  if (type === "enum") {
    const values = Array.isArray(row.values) ? row.values : [];
    return { ...base, type, values: values.map((v) => (typeof v === "number" ? v : methodArg(v))) };
  }
  if (type === "vector") {
    const size = isRow(row.vector) ? Number(row.vector.size) : Number.NaN;
    return { ...base, type, size: Number.isFinite(size) ? size : 0 };
  }
  if (type === "obj") {
    return { ...base, type, children: rows(row.children).map((child) => describeField(child, nullableByDefault, tables)) };
  }
  if (SCALAR_TYPES.has(type)) return { ...base, type: type as InputScalarType };
  return { ...base, type: "unknown", storedType: type };
}

/** A `customize` map, or `{}` for each of its empty spellings (`{}`, `""`, `[]`). */
function customizeMap(v: unknown): Row {
  return isRow(v) ? v : {};
}

/**
 * Expand a dbLink into the request inputs the engine binds for it.
 *
 * The rules are the engine's expansion, step for step, because the engine is
 * what accepts or rejects the body:
 *
 * - The table's `id` never expands. The engine removes it before anything else,
 *   so a link cannot accept a primary key for the row it creates.
 * - A column the link's `hidden` list names is dropped.
 * - A column with NO customization node is dropped when its `access` is
 *   `private` or `internal` (the editor's default for `created_at`), and
 *   otherwise keeps its own `required` and methods.
 * - A column WITH a node is dropped when the node says `hidden`. Otherwise the
 *   node REPLACES the column's `required` and methods — a stored node always
 *   carries both, at `false`/`[]` when unset, so a node written only to add a
 *   method also makes a required column optional, as the engine does.
 * - A node with a nested `customize` leaves its (object) column's own flags
 *   alone and applies the same rules, one level down, to that column's
 *   children.
 *
 * Read as COLUMNS, with the column surface's nullable defaults: that is where
 * the rows were stored.
 */
function expandDbLink(row: Row, table: string, tables: TableColumns): DbLinkInputDescription {
  const name = typeof row.name === "string" ? row.name : "";
  const schema = tables.get(table);
  if (schema === undefined) return { name, type: "dbLink", table, columns: undefined };
  const hidden = new Set(Array.isArray(row.hidden) ? row.hidden.filter((h): h is string => typeof h === "string") : []);
  const columns = rows(schema).filter((column) => column.name !== "id" && !hidden.has(String(column.name)));
  return { name, type: "dbLink", table, columns: customizeColumns(columns, customizeMap(row.customize), tables) };
}

/** Apply one level of a dbLink's `customize` to `columns` (see {@link expandDbLink}). */
function customizeColumns(columns: readonly Row[], customize: Row, tables: TableColumns): InputDescription[] {
  return columns.flatMap((column): InputDescription[] => {
    const name = String(column.name);
    const node = Object.hasOwn(customize, name) ? customize[name] : undefined;
    if (node === undefined) {
      if (column.access === "private" || column.access === "internal") return [];
      return [describeField(column, COLUMN_NULLABLE, tables)];
    }
    const settings = isRow(node) ? node : {};
    if (settings.hidden === true) return [];
    const described = describeField(column, COLUMN_NULLABLE, tables);
    const nested = customizeMap(settings.customize);
    if (Object.keys(nested).length > 0) {
      if (described.type !== "obj") return [described];
      return [{ ...described, children: customizeColumns(rows(column.children), nested, tables) }];
    }
    if (described.type === "dbLink") return [described];
    // An object's value is not a scalar the engine appends methods to, so a node
    // on one sets its `required` alone. Every other type takes the node's methods
    // — an enum and a vector included, unlike when they are declared directly.
    const methods = described.type === "obj" ? [] : methodsOf(settings.methods, false);
    return [{ ...described, required: settings.required === true, methods }];
  });
}
