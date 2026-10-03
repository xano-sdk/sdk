/**
 * Shared field encoder. Function inputs and table columns are nearly
 * the same stored shape; this encoder fills the common defaults and is
 * parameterized by a `FieldContext` for the three spots where they differ:
 * `customize` (`""` vs `{}`), `market_item` id types (string vs numeric), and
 * whether `description` is emitted.
 */
import type { FieldXdo, MethodXdo } from "../types/xdo.js";

/** Field visibility — the engine's `access` enum. */
export type FieldAccess = "public" | "private" | "internal";

/** Valid `format` values for text fields (per the engine's text-field schema). */
export type TextFormat = "" | "plaintext" | "yaml" | "html" | "xml" | "markdown";

/** Field cardinality — `"single"` (scalar) or `"list"` (array column). */
export type FieldStyleType = "single" | "list";

export interface FieldOptions {
  required?: boolean;
  nullable?: boolean;
  /**
   * Default value. Authored as a `string`, `number`, or `boolean` for
   * ergonomics (`default: 0`, `default: false`); the engine stores it as a
   * string, so it's coerced at encode time (`0` → `"0"`, `false` → `"false"`).
   *
   * On a **table column** the default must stay within the Basic Multilingual
   * Plane: a 4-byte character (codepoint > U+FFFF — emoji, CJK-extension glyphs)
   * is mangled into an invalid UTF-8 sequence by the engine's default pipeline
   * and is rejected at export/encode time rather than 500ing at deploy with
   * Postgres `22021`. BMP characters (accents, `€`, most CJK) store
   * fine. A *function/endpoint input* default binds at runtime and has no limit.
   */
  default?: string | number | boolean;
  /**
   * Persist **no `default` key at all** for this field, rather than the empty
   * `default: ""` every other field carries.
   *
   * Set on a table's `uuid` PRIMARY KEY, the one column stored this way — its
   * value is engine-generated, so there is nothing for a default to mean, and
   * absent vs empty are different stored bytes. Applied automatically to a uuid
   * `id` (declared or via `idType: "uuid"`) unless it states `default: ""`,
   * the other spelling real workspaces store for the same key.
   *
   * NOT a property of `uuid` in general: an ordinary (non-key) `uuid` column
   * does carry `default: ""`. Mutually exclusive with {@link default}.
   */
  noDefault?: boolean;
  description?: string;
  /**
   * Methods/filters applied at bind time. Each entry is either a bare name
   * (`"trim"`), a colon-form string with args (`"min:8"` → `{name:"min",
   * arg:["8"]}`), or an explicit `{ name, arg }` object.
   */
  methods?: MethodSpec[];
  /** Enum values (for `type:"enum"` fields), e.g. `["draft","live"]`. */
  values?: Array<string | number>;
  mode?: string;
  /** Text-field display format (text fields only; the engine drops it elsewhere). */
  format?: TextFormat;
  sensitive?: boolean;
  /**
   * Merge the referenced object's fields into this one rather than nesting them.
   *
   * **Leave this unset** unless reproducing a pulled field. It defaults to `false`,
   * which is what every field this SDK authors from scratch wants; it is here so a
   * pulled workspace's field can be recovered as a readable `f.*` call instead of
   * degrading to `rawField()`. Paired with {@link hidden} in the wild — 584 fields
   * across the sweep carry `merge: true` with a `hidden` list beside it.
   */
  merge?: boolean;
  /**
   * Names to hide from this field's expansion (e.g. `["created_at"]`).
   *
   * **Leave this unset** unless reproducing a pulled field; it defaults to `[]`.
   * Each entry is resolved as a name and removed from the expanded shape, so an
   * entry naming nothing hides nothing — a stored `[""]` is a real spelling that
   * appears in the wild and round-trips verbatim here rather than being guessed at.
   */
  hidden?: readonly string[];
  /** Field visibility in API output. Defaults to `"public"`. */
  access?: FieldAccess;
  style?: { type: FieldStyleType };
  /**
   * Length bounds for an array field. Both members are `json`-typed in the
   * engine, not numeric — the editor declares them as `json` and every consumer
   * reads them through a numeric coercion (`+list.max`) — so a bound can arrive
   * as `5` or as `"5"` and neither spelling is wrong.
   *
   * That is also why "unset" has no single spelling: an empty `json` control
   * serializes to `""` on 8,814 fields in the sweep and to `{}` on two. Codegen
   * elides the block whenever every member is blank in either form (see
   * `hasNoListBounds`), so only a bound that is actually SET reaches this type.
   */
  list?: { min?: string | number; max?: string | number };
  vector?: { size: number };
  /**
   * Array/list field — stored as `style:{type:"list"}` (e.g. `int[]`, `object[]`).
   * Ignored when an explicit `style` is given.
   */
  array?: boolean;
  /** Nested fields for `type:"obj"` columns; each is itself a named, typed field. */
  children?: NestedField[];
  /**
   * Per-column overrides applied to this field's EXPANSION, keyed by the
   * expanded column's name. Meaningful on a merged field — an
   * {@link input.dbLink} — where the engine expands a table's columns into
   * request inputs and consults this map for each one.
   *
   * **Leave this unset** unless reproducing a pulled field; it defaults to `{}`.
   * Xano's own CRUD scaffold writes it, so it is the common shape in a pulled
   * workspace, not an edge case.
   */
  customize?: Readonly<Record<string, FieldCustomization>>;
}

/**
 * One expanded column's override inside a merged field's {@link
 * FieldOptions.customize} map.
 *
 * Every member restates what the column already declares, so an omitted member
 * is not "inherit" — it is the stored default (`hidden:false`, `required:false`,
 * `default:""`, no methods). Author the ones you mean to change and accept the
 * rest, which is what the editor writes.
 */
export interface FieldCustomization {
  /** Drop this column from the expansion entirely. */
  hidden?: boolean;
  /** Whether the expanded input is required. */
  required?: boolean;
  /** Default for the expanded input; stored as a string (`0` → `"0"`). */
  default?: string | number | boolean;
  /** Methods/filters appended to the column's own, in the same spellings as {@link FieldOptions.methods}. */
  methods?: readonly MethodSpec[];
  /** Overrides for an object column's OWN children, keyed by child name. */
  customize?: Readonly<Record<string, FieldCustomization>>;
}

/** A nested field inside an object column's `children` — a named, typed `FieldOptions`. */
export interface NestedField extends FieldOptions {
  name: string;
  type: string;
}

// Maintainer notes (kept out of the shipped JSDoc):
//
// `nullable` is not one global default in Xano — its column-creation API sets it
// per type. Every type here is declared `nullable?=true` by the engine's own
// `schema/type/<type>` endpoint, and the same values come back on a real pulled
// table (`test/fixtures/tables/schema-table-all.json`, a live workspace export):
// blobs, geo and uuid all store `nullable: true` without anyone asking.
//
// Matching it matters beyond byte-fidelity. A `vector` column is the case where
// the divergence is fatal rather than cosmetic: the engine turns an empty
// default into SQL `NULL` only when the column is nullable, so a non-null
// `f.vector(N)` reaches PostgreSQL as `vector(8) not null default ''` and the
// table cannot be created at all — `''` is not a vector literal.
//
// `uuid` is the same trap one step later, and it holds for a REQUIRED uuid too
// (a uuid-keyed `f.tableRef` included): `""` is no uuid, so a non-null uuid
// column has no default an insert can take — every insert that omits it fails
// (`23502 NOT NULL VIOLATION` on a fresh column, `22P02 invalid input syntax for
// type uuid: ""` on one flipped from nullable, both measured live), and a
// zero-uuid `default` is refused for uuid fields. Keep it nullable (E2E pass 23
// reverted a pass-22 change that made required uuids non-null). The same live
// probe found no other type with this trap: a non-null timestamp stores 0, a
// date `1970-01-01`, and enum/json/object/bool/decimal/email/geo/file inserts
// all succeed.
//
// `epochms` is deliberately absent. The `timestamp` endpoint declares
// `nullable?=true`, but the only unambiguous stored evidence is the system
// `created_at`, which is `false` everywhere, and authored epochms columns in the
// corpus carry both values. Left at `false` rather than guessed at.

/**
 * Stored types a COLUMN is nullable by default: files, geo, uuid and vector.
 * Pass `nullable: false` to override. The value types read the same list, so a
 * column nullable by default infers `T | null`.
 */
export const COLUMN_NULLABLE_TYPES = [
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
  "uuid",
  "vector",
] as const;
const COLUMN_NULLABLE_BY_DEFAULT: ReadonlySet<string> = new Set(COLUMN_NULLABLE_TYPES);

// An INPUT adds `file`, `date` and `epochms` to the column list, matching the
// builder. Here the difference is runtime, not cosmetic: an optional input's `""`
// default becomes `null` only when the input is nullable. Otherwise an omitted
// `date` never binds, so reading it fails the request with "Unable to locate
// input", and an omitted `file` is rejected as "Value is not properly formed".

/**
 * Stored types an INPUT is nullable by default: the column list plus `file`,
 * `date` and `epochms`, so an omitted optional one binds `null`. Pass
 * `nullable: false` to override.
 */
export const INPUT_NULLABLE_TYPES = [...COLUMN_NULLABLE_TYPES, "file", "date", "epochms"] as const;
const INPUT_NULLABLE_BY_DEFAULT: ReadonlySet<string> = new Set(INPUT_NULLABLE_TYPES);

/** Context distinguishing an input field from a column field. */
export interface FieldContext {
  /**
   * The empty-customization block written into every encoded field. An OBJECT,
   * never a string: `""` is the older engine generation's empty form, which this
   * SDK reads (and `normalize` canonicalizes forward to `{}`) but must never
   * write. Typed to make emitting it impossible rather than merely discouraged.
   */
  customize: Record<string, unknown>;
  marketItem: { id: string | number; version: string | number; guid: string };
  includeDescription: boolean;
  /** Stored types that encode `nullable: true` when the author does not say. */
  nullableTypes: ReadonlySet<string>;
}

/**
 * Function-input and table-column fields share one persisted shape — confirmed
 * byte-for-byte against live `mvp_query.input[*]` and `mvp_dbo.schema[*]`: both
 * use `customize:{}` and numeric `market_item` ids.
 */
export const INPUT_CONTEXT: FieldContext = {
  customize: {},
  marketItem: { id: 0, version: 0, guid: "" },
  includeDescription: true,
  nullableTypes: INPUT_NULLABLE_BY_DEFAULT,
};

/**
 * Table-column field context — identical persisted shape to {@link INPUT_CONTEXT};
 * only the per-type `nullable` defaults differ.
 */
export const COLUMN_CONTEXT: FieldContext = {
  customize: {},
  marketItem: { id: 0, version: 0, guid: "" },
  includeDescription: true,
  nullableTypes: COLUMN_NULLABLE_BY_DEFAULT,
};

/**
 * Whether a stored type is nullable when the author says nothing, on the
 * surface `ctx` encodes for.
 *
 * Exported because codegen has to elide against the SAME value: a geo column an
 * author explicitly turned NOT-nullable is stored `nullable: false`, and eliding
 * that against a blanket `false` would drop it from the regenerated source and
 * re-encode it as `true`.
 */
export function defaultNullable(type: string, ctx: FieldContext): boolean {
  return ctx.nullableTypes.has(type);
}

/**
 * A field method/filter: a bare name (`"trim"`), a colon-form string carrying
 * args (`"min:8"`, `"min:8:foo"` — first segment is the name, the rest are
 * args), or an explicit `{ name, arg }` object. A method whose argument is text
 * (`startsWith`, `pattern`, `ok`, `salt`) takes everything after the first `:`
 * as that one argument (`"startsWith:https://"`); `pattern`'s error text needs
 * `{ name: "pattern", arg: [regex, errorText] }`.
 */
export type MethodSpec = string | { name: string; arg?: Array<string | number> };

/**
 * A type-narrowed {@link MethodSpec} for a field constructor: a bare method name
 * from the field type's valid set `N` (`"trim"`), the colon-form carrying args
 * (`"min:8"`), or the explicit `{ name, arg }` object — which stays a universal
 * escape hatch for any name the per-type union doesn't enumerate. The per-type
 * `N` unions live in `fields/generated/field-methods.generated.ts`.
 */
export type MethodArg<N extends string> =
  | N
  | `${N}:${string}`
  | { name: string; arg?: Array<string | number> };

/**
 * An options type `T` with its `methods` array widened to `readonly`. Field/input
 * constructors capture their options via a `const` type parameter so literal
 * flags (`required`/`nullable`/`array`) survive for `InferInput`; `const` also
 * makes any inline `methods: [...]` a readonly tuple, so a constructor's options
 * constraint must accept readonly arrays. The runtime cast back to `FieldOptions`
 * is safe — the encoder only ever reads (`.map`) the methods.
 */
export type ReadonlyMethods<T, N extends string> = Omit<T, "methods"> & {
  methods?: readonly MethodArg<N>[];
};

/**
 * Normalize a `MethodSpec` into its stored `{ name, disabled, arg }`, parsing
 * the colon form.
 *
 * A numeric-looking segment (one that round-trips through `Number` unchanged)
 * becomes a number, because that is what the engine persists: a UI-authored
 * `min` on a password column stores `arg: [8]`, not `["8"]`. Without the
 * coercion `"min:8"` and the equivalent `{name:"min", arg:[8]}` encode to
 * different bytes, which makes the colon form unusable as the decoded shorthand
 * for any method that takes a number — i.e. most of them.
 *
 * An arg that is genuinely the string `"8"` still has the explicit object form.
 */
export function parseMethod(spec: MethodSpec): MethodXdo {
  if (typeof spec !== "string") return { name: spec.name, disabled: false, arg: spec.arg ?? [] };
  // A method whose one argument is text (the `"text"` entries of `FIELD_METHODS`)
  // splits only at its first `:`, so `"startsWith:https://"` keeps `https://` whole.
  const [name = spec, ...arg] = spec.split(/:(?<!^(?:ok|pattern|salt|startsWith):.+)/);
  return { name, disabled: false, arg: arg.map((part) => (part !== "" && String(Number(part)) === part ? Number(part) : part)) };
}

export function encodeMethods(methods: readonly MethodSpec[] | undefined): MethodXdo[] {
  return (methods ?? []).map(parseMethod);
}

/**
 * Encode a {@link FieldOptions.customize} map into the stored node shape.
 *
 * Every stored node in the survey corpus carries the same five keys — 589 of
 * them, no variants — so each is written unconditionally at its default rather
 * than elided. The nested `customize` is written as `{}` when empty, the current
 * engine spelling; `normalize` canonicalizes the older `""`/`[]` empties forward
 * to it, so a legacy map still compares equal without this ever writing one.
 */
export function encodeCustomize(
  customize: Readonly<Record<string, FieldCustomization>> | undefined,
): Record<string, unknown> {
  // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
  // stored here, where assigning it on a plain `{}` sets a prototype instead.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [name, node] of Object.entries(customize ?? {})) {
    out[name] = {
      hidden: node.hidden ?? false,
      default: node.default !== undefined ? String(node.default) : "",
      methods: encodeMethods(node.methods),
      required: node.required ?? false,
      customize: encodeCustomize(node.customize),
    };
  }
  return out;
}

/**
 * Marker carrying an already-persisted field envelope that {@link encodeField}
 * must return **verbatim**, skipping the rebuild below. Set only by `rawField()`
 * (see `raw-field.ts`), which is reachable from `@xano/sdk/codegen`.
 *
 * It rides on the field's `options`, so it survives the `{name, type,
 * ...options}` spread `toNestedFields` uses — a raw field nested inside an
 * object column short-circuits at its own depth.
 */
export const RAW_FIELD: unique symbol = Symbol.for("xanosdk.field.rawEnvelope") as never;

/**
 * The `default` entry, or nothing when {@link FieldOptions.noDefault} is set.
 *
 * Spread into the field so the key is genuinely ABSENT rather than present-and-
 * empty — only absence matches what the engine writes for a uuid primary key,
 * and the two are different stored bytes.
 */
function defaultEntry(options: FieldOptions): { default?: string } {
  if (options.noDefault === true) return {};
  return { default: options.default !== undefined ? String(options.default) : "" };
}

/**
 * Whether a column holds a LIST, read the way {@link encodeField} writes it: an
 * explicit `style` wins, and `array` decides only when `style` is absent. Every
 * reader that branches on list-vs-scalar goes through here, so the two
 * spellings of one column (`array: true`, `style: { type: "list" }`) cannot be
 * accepted by the encoder and refused by a validator.
 */
export function isListColumn(col: Pick<FieldOptions, "array" | "style">): boolean {
  return (col.style?.type ?? (col.array ? "list" : "single")) === "list";
}

/** Encode a named field (input or column) into its full stored `FieldXdo`. */
export function encodeField(
  name: string,
  type: string,
  options: FieldOptions,
  ctx: FieldContext,
): FieldXdo {
  // `rawField()` short-circuit: the envelope is already persisted, so the
  // rebuild below would drop exactly the keys it exists to preserve.
  const rawEnvelope = (options as Partial<Record<typeof RAW_FIELD, FieldXdo>>)?.[RAW_FIELD];
  if (rawEnvelope !== undefined) return rawEnvelope;

  const field: FieldXdo = {
    name,
    type,
    _xsid: "",
    nullable: options.nullable ?? ctx.nullableTypes.has(type),
    ...defaultEntry(options),
    merge: options.merge ?? false,
    hidden: options.hidden !== undefined ? [...options.hidden] : [],
    override: [],
    customize: options.customize !== undefined ? encodeCustomize(options.customize) : ctx.customize,
    required: options.required ?? false,
    values: options.values ?? [],
    mode: options.mode ?? "",
    format: options.format ?? "",
    sensitive: options.sensitive ?? false,
    list: options.list ?? { min: "", max: "" },
    vector: options.vector ?? { size: 3 },
    access: options.access ?? "public",
    style: options.style ?? { type: options.array ? "list" : "single" },
    children: (options.children ?? []).map((ch) => encodeField(ch.name, ch.type, ch, ctx)),
    methods: encodeMethods(options.methods),
    market_item: ctx.marketItem,
    is_settings_registry: false,
  };
  if (ctx.includeDescription) {
    field.description = options.description ?? "";
  }
  return field;
}
/**
 * Stored type → catalog accessor, for the types whose authoring name differs
 * from what the engine persists (plus the ones that match, for completeness).
 * `enum`, `vector`, `obj`, and table refs take positional payloads and are
 * handled separately.
 */
export const CATALOG_BY_TYPE: Readonly<Record<string, string>> = {
  text: "text",
  int: "int",
  decimal: "decimal",
  bool: "bool",
  uuid: "uuid",
  date: "date",
  email: "email",
  password: "password",
  json: "json",
  epochms: "timestamp",
  blob_img: "image",
  blob_video: "video",
  blob_audio: "audio",
  blob: "attachment",
  geo_point: "geo.point",
  geo_multipoint: "geo.multipoint",
  geo_linestring: "geo.linestring",
  geo_multilinestring: "geo.multilinestring",
  geo_polygon: "geo.polygon",
  geo_multipolygon: "geo.multipolygon",
};

/** A stored column type as it is authored (`epochms` → `timestamp`, `blob_img` → `image`). */
export function authoredFieldType(type: string): string {
  return Object.hasOwn(CATALOG_BY_TYPE, type) ? CATALOG_BY_TYPE[type]! : type;
}
