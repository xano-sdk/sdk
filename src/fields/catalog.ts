/**
 * Rich field-type catalog (`f.*`). A typed, validated authoring surface over the
 * shared field encoder. Each constructor returns a {@link FieldDescriptor}
 * (`{ type, options }`) carrying the **stored** type string — the engine's
 * author-facing names differ from what it persists, so this layer applies the
 * authoritative mapping (the engine's stored-type map):
 *
 *   object → obj · timestamp → epochms · image → blob_img ·
 *   video → blob_video · audio → blob_audio · attachment → blob
 *
 * Every other type (text/int/decimal/bool/uuid/date/email/password/json/enum/
 * vector/geo_*) is stored under its own name. Columns and inputs both consume
 * descriptors; the per-context differences (`customize`, `market_item`,
 * `description`) are still applied by {@link encodeField}.
 */
import type { FieldOptions, NestedField, MethodArg, ReadonlyMethods } from "./field.js";
import type {
  TypeBrand,
  XanoFileRef,
  XanoGeoValue,
  ObjectOf,
} from "./value-types.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type {
  TextMethod,
  IntMethod,
  DecimalMethod,
  EmailMethod,
  PasswordMethod,
  VectorMethod,
  TableRefMethod,
} from "./generated/field-methods.generated.js";

/** A typed field, ready to attach to a column/input name. */
export interface FieldDescriptor {
  /** The **stored** type string (post-mapping), e.g. `blob_img`, `epochms`. */
  type: string;
  options: FieldOptions;
}

/** A named map of fields — used for table schemas and object children. */
export type FieldMap = Record<string, FieldDescriptor>;

/** Options accepted by every catalog constructor (no `values`/`children`/`vector` — those are positional). */
export type FieldOpts = Omit<FieldOptions, "values" | "children" | "vector">;

/**
 * {@link FieldOpts} with `methods` narrowed to the field type's valid method set
 * `N` (see {@link MethodArg}). Types with no engine-declared methods use
 * `MethodOpts<never>`, leaving only the `{ name, arg }` escape hatch.
 */
export type MethodOpts<N extends string> = Omit<FieldOpts, "methods"> & {
  methods?: MethodArg<N>[];
};

/** {@link MethodOpts} made safe to capture under a `const` type parameter (see {@link ReadonlyMethods}). */
export type ConstMethodOpts<N extends string> = ReadonlyMethods<MethodOpts<N>, N>;

/**
 * An enum's `default` must be one of its `values` (or `""`, no default): the
 * engine stores any text, and a default outside the list is a value no request
 * can send back.
 */
export type EnumDefault<V extends ReadonlyArray<string | number>, O = unknown> = NoInfer<
  O extends { default: infer D }
    ? [D] extends [V[number] | `${V[number]}` | ""]
      ? unknown
      : // A record, so the error names the values instead of reducing to `never`.
        { default: { "default must be one of": `${V[number]}` } }
    : unknown
>;

/**
 * The stored types that persist a `default` value. The engine drops `default`
 * on every other type at import (per the engine's schema processing), so
 * authoring one would silently lose data — guard it instead.
 */
const DEFAULTABLE_TYPES = new Set([
  "text",
  "int",
  "decimal",
  "enum",
  "bool",
  "email",
  "json",
  "date",
  "epochms",
]);

/** Field visibility — the engine's `access` enum. */
const ACCESS_VALUES = new Set(["public", "private", "internal"]);

/** Valid `format` values for text fields (per the engine's text-field schema). */
const FORMAT_VALUES = new Set(["", "plaintext", "yaml", "html", "xml", "markdown"]);

/**
 * `f.enum`'s values are a positional list of strings or numbers. An options
 * object in that slot (`f.enum({ values })`) or a bare string (`f.enum("abc")`,
 * which would spread into one value per letter) is refused with the right call.
 */
function assertEnumValues(values: unknown): void {
  if (Array.isArray(values) && values.every((v) => typeof v === "string" || typeof v === "number")) return;
  throw new Error(`f.enum takes its values as a list of strings or numbers, FIRST: f.enum(["a", "b"], { default: "a" }) — got ${JSON.stringify(values)}.`);
}

function descriptor(type: string, options: FieldOptions): FieldDescriptor {
  if (options.format && type !== "text") {
    throw new Error(`f: \`format\` is only valid on text fields, not "${type}".`);
  }
  if (options.format !== undefined && !FORMAT_VALUES.has(options.format)) {
    throw new Error(
      `f: invalid text \`format\` "${options.format}"; ` +
        `valid: plaintext/yaml/html/xml/markdown.`,
    );
  }
  if (options.access !== undefined && !ACCESS_VALUES.has(options.access)) {
    throw new Error(
      `f: invalid \`access\` "${options.access}"; valid: public/private/internal.`,
    );
  }
  if (
    options.default !== undefined &&
    options.default !== "" &&
    !DEFAULTABLE_TYPES.has(type)
  ) {
    throw new Error(
      `f: \`default\` is not supported on "${type}" fields (the engine drops it); ` +
        `valid on text/int/decimal/enum/bool/email/json/date/timestamp.`,
    );
  }
  // The two say opposite things about the same key, and silently honouring one
  // would emit bytes the author did not ask for.
  if (options.noDefault === true && options.default !== undefined) {
    throw new Error(
      `f: \`noDefault\` and \`default\` are mutually exclusive on "${type}" fields — ` +
        `\`noDefault\` omits the key entirely, so there is no value to set.`,
    );
  }
  return { type, options };
}

/**
 * A plain scalar/geo/file constructor: `f.int(opts?)`. `V` is the field's value
 * type (carried as a phantom brand for `InferInput`); the method-set type param
 * `N` narrows `options.methods` to the names valid for the field type. Options
 * are captured via a `const` type parameter `O` so literal flags survive on the
 * brand; the runtime object is still exactly `{ type, options }`.
 */
function make<V, N extends string, T extends string>(type: T, defaults?: Partial<FieldOptions>) {
  return <const O extends ConstMethodOpts<N> = Record<string, never>>(
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<V, O, T> =>
    descriptor(type, { ...defaults, ...options } as FieldOptions) as FieldDescriptor & TypeBrand<V, O, T>;
}

/**
 * The referenced table's primary-key type, or `undefined` when the reference
 * carries no schema to read it from (a bare name, or a `{name, guid}` ref).
 *
 * Three spellings reach here and all three are answered from the target itself
 * rather than assumed: an authored `table()` def states `idType`; a def that
 * omits it may still declare its own `id` column, in either the field-map or the
 * `ColumnDef[]` schema form; an already-encoded table payload only has the
 * column. Only a target that actually carries a `schema` is inspected, so
 * nothing is inferred from a reference that never had one.
 */
function targetKeyType(table: ObjectRef): "int" | "uuid" | undefined {
  if (typeof table === "string") return undefined;
  const def = table as { idType?: unknown; schema?: unknown };
  if (def.idType === "int" || def.idType === "uuid") return def.idType;
  if (def.schema === undefined || def.schema === null) return undefined;
  const idType = Array.isArray(def.schema)
    ? (def.schema as Array<{ name?: unknown; type?: unknown }>).find((col) => col?.name === "id")
        ?.type
    : (def.schema as Record<string, { type?: unknown } | undefined>).id?.type;
  if (idType === "uuid") return "uuid";
  // A schema-bearing target with no declared `id` gets the engine's default key.
  return idType === undefined || idType === "int" ? "int" : undefined;
}


/** Convert a named field map into the encoder's `NestedField[]` form. */
export function toNestedFields(map: FieldMap): NestedField[] {
  return Object.entries(map).map(([name, d]) => ({ name, type: d.type, ...d.options }));
}

/**
 * The stored scalar type of a `tableRef` FK, derived from its `type` option: a
 * `uuid`-keyed reference stores a `string`, everything else (the default `int`)
 * stores a `number`. Keeps `InferRow` honest — a FK column is the referenced
 * table's PK value, never the loose `string | number`.
 */
type TableRefValue<T, O> = TableRefType<T, O> extends "uuid" ? string : number;

/**
 * The stored type of a `tableRef` FK: the `type` option when given, else the
 * handle's own `idType` (a uuid-keyed `table()` makes a uuid column), else `int`.
 */
type TableRefType<T, O> = O extends { type: infer K extends "int" | "uuid" }
  ? K
  : T extends { readonly __row?: infer R }
    ? R extends { id: infer I }
      ? [I] extends [string]
        ? "uuid"
        : "int"
      : "int"
    : "int";

/** The rich field-type catalog. */
export const f = {
  // --- scalars ---
  text: make<string, TextMethod, "text">("text"),
  int: make<number, IntMethod, "int">("int"),
  decimal: make<number, DecimalMethod, "decimal">("decimal"),
  bool: make<boolean, never, "bool">("bool"),
  uuid: make<string, never, "uuid">("uuid"),
  date: make<string, never, "date">("date"),
  email: make<string, EmailMethod, "email">("email"),
  /** Password field; defaults to `access:"internal"` (the engine's stored default). */
  password: make<string, PasswordMethod, "password">("password", { access: "internal" }),
  /**
   * JSON column. Accepts an optional nested `children` schema — the structure the
   * editor shows when a `json` field is expanded, and what a pulled workspace
   * carries.
   *
   * `children` is spelled as an ARRAY of named, typed fields rather than the
   * `FieldMap` {@link FieldCatalog.object} takes positionally. The two are not
   * interchangeable: an object column's children are the column's own schema,
   * while a json column's are a description of the shape stored inside it, which
   * the engine persists in the order given. That order is part of the stored
   * bytes, and a map does not preserve it.
   *
   * Without this there is no way to author a structured JSON column at all.
   */
  json<const O extends ConstMethodOpts<never> & { children?: readonly NestedField[] } = Record<string, never>>(
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<unknown, O, "json"> {
    return descriptor("json", { ...options } as FieldOptions) as FieldDescriptor & TypeBrand<unknown, O, "json">;
  },
  /** Epoch-millisecond timestamp (authored as `timestamp`). */
  timestamp: make<number, never, "epochms">("epochms"),

  // --- file resources (authoring name → blob_* stored name) ---
  /** Image file resource (stored `blob_img`). */
  image: make<XanoFileRef, never, "blob_img">("blob_img"),
  /** Video file resource (stored `blob_video`). */
  video: make<XanoFileRef, never, "blob_video">("blob_video"),
  /** Audio file resource (stored `blob_audio`). */
  audio: make<XanoFileRef, never, "blob_audio">("blob_audio"),
  /** Generic file attachment (stored `blob`). */
  attachment: make<XanoFileRef, never, "blob">("blob"),

  // --- geo ---
  geo: {
    /** Value `{ type: "point", data: { lng, lat } }`. */
    point: make<XanoGeoValue<"point">, never, "geo_point">("geo_point"),
    /** Value `{ type: "points", data: [{ lng, lat }, …] }`. */
    multipoint: make<XanoGeoValue<"points">, never, "geo_multipoint">("geo_multipoint"),
    /** Value `{ type: "path", data: [{ lng, lat }, …] }`. */
    linestring: make<XanoGeoValue<"path">, never, "geo_linestring">("geo_linestring"),
    /** Value `{ type: "paths", data: [[{ lng, lat }, …], …] }`. */
    multilinestring: make<XanoGeoValue<"paths">, never, "geo_multilinestring">("geo_multilinestring"),
    /** Value `{ type: "poly", data: [{ lng, lat }, …] }` — the ring is closed for you. */
    polygon: make<XanoGeoValue<"poly">, never, "geo_polygon">("geo_polygon"),
    /** Value `{ type: "polys", data: [[{ lng, lat }, …], …] }`. */
    multipolygon: make<XanoGeoValue<"polys">, never, "geo_multipolygon">("geo_multipolygon"),
  },

  // --- composite (positional payload + options) ---
  /**
   * Enum field. `values` may be empty — that is an enum column added in the
   * editor and not yet given its options, which the engine stores and which
   * appears in the survey corpus. Refusing it made the SDK stricter than the
   * engine and cost a real table its readable form.
   *
   * An empty `values` brands the column `never` — an enum permitting nothing can
   * hold nothing. Note what that becomes downstream: `InferRow` surfaces the
   * column as `undefined`, not `never`, so a read-time narrow written against
   * `never` (`if (row.e === "x")`) is dead differently than it looks.
   */
  enum<const V extends ReadonlyArray<string | number>, const O extends ConstMethodOpts<never> = Record<string, never>>(
    values: V,
    options: O & EnumDefault<V, O> = {} as O & EnumDefault<V, O>,
  ): FieldDescriptor & TypeBrand<V[number], O, "enum"> {
    assertEnumValues(values);
    return descriptor("enum", { ...options, values: [...values] } as FieldOptions) as FieldDescriptor &
      TypeBrand<V[number], O, "enum">;
  },

  /** Vector field; `size` (>= 1) is the embedding dimensionality. */
  vector<const O extends ConstMethodOpts<VectorMethod> = Record<string, never>>(
    size: number,
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<number[], O, "vector"> {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`f.vector: size must be an integer >= 1, got ${size}.`);
    }
    return descriptor("vector", { ...options, vector: { size } } as FieldOptions) as FieldDescriptor &
      TypeBrand<number[], O, "vector">;
  },

  /** Nested object field (stored `obj`); `children` is a named field map. */
  object<const C extends FieldMap, const O extends ConstMethodOpts<never> = Record<string, never>>(
    children: C,
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<ObjectOf<C>, O, "obj"> {
    return descriptor("obj", { ...options, children: toNestedFields(children) } as FieldOptions) as FieldDescriptor &
      TypeBrand<ObjectOf<C>, O, "obj">;
  },

  /**
   * Table-reference (foreign-key) field — the column holds the referenced
   * table's primary key. The engine persists the link as a trailing `@` method
   * carrying the target table's id (`{name:"@", arg:["dbo=<guid>"]}`); on import
   * it parses that back into the column's `tableref_id`. The reference resolves to the
   * table's deterministic guid via the shared cross-object resolver, so it
   * agrees with the target table's payload `guid` with no shared registry.
   *
   * The column takes the target handle's key type (`idType`), else `int`; pass
   * `{ type: "uuid" }` for a uuid-keyed table named by bare string. A reference
   * column may only be `int` or `uuid` — the two valid primary-key types.
   *
   * @param table The referenced table (a `table()` def handle or its bare name).
   *   For a **self-reference** (e.g. `tweets.reply_to → tweets`), the table's
   *   `const` binding isn't assigned yet inside its own initializer — using the
   *   handle throws a "used before declaration" error. Pass the **bare name**
   *   instead: `f.tableRef("tweets", { type: "int" })`. Identity guids derive
   *   from `(type, name)`, so the name form resolves to the same guid.
   *
   * Byte-verified whole-object against a persisted table readback: the `@`
   * method carries
   * `disabled:false`, sits last in `methods`, and its `dbo=` arg is the target
   * table's payload guid.
   *
   * The engine asserts the referenced table's primary-key type matches
   * (int↔int, uuid↔uuid). When the target is passed as a **def handle** its
   * `idType` is in hand, so a mismatch throws here instead of surfacing as an
   * import failure. The bare-name form (self-references) carries no schema —
   * there is nothing to check against, and it is not guessed at.
   */
  tableRef<
    const T extends ObjectRef,
    const O extends ConstMethodOpts<TableRefMethod> & { type?: "int" | "uuid" } = Record<string, never>,
  >(table: T, options: O = {} as O): FieldDescriptor & TypeBrand<TableRefValue<T, O>, O, TableRefType<T, O>> {
    const { type: given, methods = [], ...rest } = options as ConstMethodOpts<TableRefMethod> & {
      type?: "int" | "uuid";
    };
    // The engine requires the column to match the target's key type and rejects
    // the import otherwise. A handle states its key, so an omitted `type` takes
    // it; a bare name (the self-reference spelling) carries none to check.
    const idType = targetKeyType(table);
    const type = given ?? idType ?? "int";
    if (idType !== undefined && idType !== type) {
      const name = typeof table === "string" ? `"${table}"` : table.name || "<unnamed>";
      throw new Error(
        `f.tableRef(${name}, { type: "${type}" }): that table's primary key is "${idType}". The engine ` +
          `requires a reference column to match the target's key type, so this fails at import. ` +
          `Drop \`type\` to take the key type from the handle.`,
      );
    }
    const guid = resolveRef("dbo", table);
    return descriptor(type, {
      ...rest,
      methods: [...(methods ?? []), { name: "@", arg: [`dbo=${guid}`] }],
    }) as FieldDescriptor & TypeBrand<TableRefValue<T, O>, O, TableRefType<T, O>>;
  },
} as const;
