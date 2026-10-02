/**
 * Value-type algebra for the typed descriptor layer.
 *
 * Input and column constructors (`input.*`, `f.*`) return a runtime descriptor
 * of exactly `{ type, options }`. This module adds a **phantom brand** to those
 * return types that carries, at the TYPE LEVEL only, the field's value type `V`
 * and the literal options object `O` the caller passed. The brand props are
 * optional and never assigned at runtime, so the emitted object is unchanged and
 * every branded descriptor stays structurally assignable to the un-branded
 * `FieldDescriptor` / `InputDescriptor` — existing consumers are unaffected.
 *
 * `InferInput` (see `../inputs/infer.ts`) reads these brands to turn a query's
 * declared `input` map into the request-payload TS type. The same algebra powers
 * nested-object inference, since object `children` are built from `f.*`.
 */
import type { COLUMN_NULLABLE_TYPES, INPUT_NULLABLE_TYPES } from "./field.js";

/**
 * Opaque runtime value of a file input/column. The request payload carries a
 * resource reference (path/metadata), not the raw bytes — model it structurally
 * rather than as `unknown` so a consumer at least sees an object shape.
 */
export interface XanoFileRef {
  /** Vault path, e.g. `/vault/<…>/<name>`. Join it to your base URL — see {@link import("./file-url.js").fileUrl}. */
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  /** Storage visibility as stored on the column (`"public"` / `"private"`). */
  access?: string;
  /** Type-specific metadata — e.g. `{ width, height }` on an image. */
  meta?: unknown;
  /**
   * ⚠ The engine's own absolute URL, which on a tenant-scoped environment omits
   * the `/tenant/<name>` segment and 404s. Do NOT read it directly: pass the
   * file to `fileUrl(file, baseUrl)`, which joins the correct `path` to the base
   * URL your client already has.
   */
  url?: string;
}

/**
 * Opaque runtime value of a raw file **upload** (`input.file()`).
 *
 * Distinct from {@link XanoFileRef}, and the distinction matters: this is the
 * bytes as they arrive on the request (multipart, base64, or a fetched URI). It
 * is not yet stored anywhere and cannot be written to a file column. Pass it to
 * a `s.storage.create_*` statement (`create_image`, `create_attachment`, …) to
 * store it and get back the {@link XanoFileRef} a column holds.
 */
export interface XanoFileUpload {
  readonly __fileUpload?: never;
}

/**
 * Marker value of a database-link input (`input.dbLink()`).
 *
 * Opaque on purpose: a dblink input does not bind a value of its own. The engine
 * EXPANDS it into one input per column of the linked table, so a table with
 * three columns turns one dblink entry into three request inputs. Read those by
 * their own column names — `inp("email")`, not `inp("user__")`.
 */
export interface XanoDbLink {
  readonly __dbLink?: never;
}

/** One `{ lng, lat }` position, as the engine both accepts and returns. */
export interface XanoGeoPosition {
  lng: number;
  lat: number;
}

/**
 * The `data` nesting for each geo `type` name. The names are the engine's own
 * and the ONLY spellings it takes — `"multipoint"`, `"linestring"`,
 * `"multipoly"` and the other guessable names are refused with a 400.
 *
 * | column                  | `type`   | `data`                 |
 * |-------------------------|----------|------------------------|
 * | `f.geo.point`           | `point`  | one position           |
 * | `f.geo.multipoint`      | `points` | positions              |
 * | `f.geo.linestring`      | `path`   | positions              |
 * | `f.geo.multilinestring` | `paths`  | arrays of positions    |
 * | `f.geo.polygon`         | `poly`   | positions (ring closed for you) |
 * | `f.geo.multipolygon`    | `polys`  | arrays of positions    |
 */
export interface XanoGeoData {
  point: XanoGeoPosition;
  points: XanoGeoPosition[];
  path: XanoGeoPosition[];
  paths: XanoGeoPosition[][];
  poly: XanoGeoPosition[];
  polys: XanoGeoPosition[][];
}

/** A geo `type` name: `point`, `points`, `path`, `paths`, `poly`, `polys`. */
export type XanoGeoType = keyof XanoGeoData;

/**
 * The value of an `f.geo.*` column: `{ type, data }`, NOT GeoJSON (no
 * `coordinates`, no `"Point"`/`"MultiPoint"` keywords).
 *
 * The same shape goes in and comes back: `{ type: "point", data: { lng: 1,
 * lat: 2 } }` reads back identical, and a `poly` ring reads back closed. Each
 * column's row type narrows `T` to its own name, so `f.geo.multipoint` reads as
 * `XanoGeoValue<"points">`. With no argument this is the union of all six.
 *
 * Raw WKT text (`c.text("POINT(1 2)")`) is also accepted wherever a value is
 * taken — it is just not the typed path, because a read never returns one.
 */
export type XanoGeoValue<T extends XanoGeoType = XanoGeoType> = {
  [K in T]: { type: K; data: XanoGeoData[K] };
}[T];

/**
 * Which surface a field is read on. Inputs and columns share one stored shape but
 * not one set of `nullable` defaults, so the value type of the SAME descriptor
 * can differ: `f.date()` is `string` as a column and `string | null` inside an
 * input object.
 */
export type ValueSurface = "input" | "column";

/** Stored types nullable by default on surface `Sf` — the encoder's own lists. */
type NullableByDefault<Sf extends ValueSurface> = Sf extends "column"
  ? (typeof COLUMN_NULLABLE_TYPES)[number]
  : (typeof INPUT_NULLABLE_TYPES)[number];

/**
 * Phantom brand intersected onto a descriptor's return type. `V` is the field's
 * base value type; `O` is the literal options object captured via a `const` type
 * parameter at the call site; `T` is the stored type (`"date"`, `"blob_img"`, …),
 * which decides the `nullable` default. All props are optional and never present
 * at runtime.
 */
export interface TypeBrand<V, O, T extends string = string> {
  readonly __value?: V;
  readonly __opts?: O;
  readonly __type?: T;
}

/**
 * The value of an object field, kept unresolved until a surface reads it: its
 * children's `nullable` defaults depend on whether the object is an input or a
 * column. Type-level only.
 */
export interface ObjectOf<C> {
  readonly __objectOf: C;
}

/** Resolve an {@link ObjectOf} value against surface `Sf`; any other value is unchanged. */
type ResolveValue<V, Sf extends ValueSurface> = V extends ObjectOf<infer C> ? FromFieldMap<C, Sf> : V;

/** A branded descriptor's value exactly as branded — objects still unresolved. */
export type RawBrandValue<D> = D extends TypeBrand<infer V, unknown> ? V : unknown;

/** The base value type carried by a branded descriptor `D` (before array/nullable), read on surface `Sf`. */
export type BrandValue<D, Sf extends ValueSurface = "input"> = ResolveValue<RawBrandValue<D>, Sf>;

/** The literal options object captured on a branded descriptor `D`. */
export type BrandOpts<D> = D extends TypeBrand<unknown, infer O> ? O : object;

/** The stored type carried by a branded descriptor `D`; `string` when unbranded. */
export type BrandType<D> = D extends TypeBrand<unknown, unknown, infer T> ? T : string;

type ApplyArray<T, O> = O extends { array: true } ? T[] : T;

/**
 * `| null` when the field can hold null: an explicit `nullable: true`, a
 * `nullable` flag that is not a literal `false`, or no flag on a type the
 * surface makes nullable by default.
 */
type ApplyNullable<T, O, St extends string, Sf extends ValueSurface> = O extends { nullable: false }
  ? T
  : O extends { nullable: boolean }
    ? T | null
    : [St] extends [NullableByDefault<Sf>]
      ? T | null
      : T;

/**
 * The full value type of a single branded descriptor `D` read on surface `Sf`:
 * its base value with `array` and `nullable` applied, `nullable` defaulting per
 * stored type exactly as the encoder does. (Optionality of the *key* is a
 * map-level concern handled by {@link FromFieldMap}.)
 */
export type ValueOf<D, Sf extends ValueSurface> = ApplyNullable<
  ApplyArray<BrandValue<D, Sf>, BrandOpts<D>>,
  BrandOpts<D>,
  BrandType<D>,
  Sf
>;

/** Keys whose descriptor options declare `required: true`. */
type RequiredKeys<M> = {
  [K in keyof M]: BrandOpts<M[K]> extends { required: true } ? K : never;
}[keyof M];

/** Keys without `required: true` — optional in the produced payload type. */
type OptionalKeys<M> = Exclude<keyof M, RequiredKeys<M>>;

/**
 * Turn a named map of branded descriptors into an object type: required inputs
 * become required keys, everything else becomes an optional (`?`) key. Used for
 * a query's top-level `input` map (surface `"input"`), a seed row (`"column"`),
 * and nested `object` children (the enclosing field's surface).
 */
export type FromFieldMap<M, Sf extends ValueSurface = "input"> = Prettify<
  { [K in RequiredKeys<M>]: ValueOf<M[K], Sf> } & { [K in OptionalKeys<M>]?: ProtoKeySafe<K, ValueOf<M[K], Sf>> }
>;

/**
 * The value type of an OPTIONAL key named after an `Object.prototype` member
 * (`constructor`, `toString`, `valueOf`, …). TypeScript checks an object
 * literal's inherited member against such a key even when the literal omits it,
 * so `{ name: "x" }` failed against `{ constructor?: number }` with "Function is
 * not assignable". Widening only those keys to also admit the inherited member
 * lets a literal omit the column; every other key is untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types -- the inherited members ARE Object's
export type ProtoKeySafe<K, V> = K extends keyof Object ? V | Object[K] : V;

/**
 * Turn a named map of branded descriptors into a **row** type — the read shape
 * of a table. Unlike {@link FromFieldMap} (a request payload, where `required`
 * gates key optionality), every declared column is present on a returned row, so
 * all keys are required here; `nullable`/`array` still apply via {@link ValueOf}.
 * Powers `InferRow<typeof table>` (see `../kinds/table.ts`) on surface
 * `"column"`, and an agent's structured output on `"input"`.
 */
export type RowFromFieldMap<M, Sf extends ValueSurface = "column"> = Prettify<{
  [K in keyof M]: ValueOf<M[K], Sf>;
}>;

/** Flatten an intersection into a single object literal for readable hovers. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * A const-inferred record `T` checked against the keys of `Shape`: every key
 * `Shape` does not declare is retyped to a record naming the `Allowed` keys, so
 * a misspelling (`perPage`, `filter`, `temprature`) is a compile error on that
 * key. A generic parameter is inferred FROM the literal, so without this it
 * widens to include the typo and TypeScript's excess-property check never runs.
 * An object, not a string, so intersecting a literal (`5 & …`) is not `never`.
 */
export type NoExtraKeys<T, Shape, Allowed extends string> = NoInfer<{
  [K in Exclude<keyof T, keyof Shape>]: { "unknown key; expected one of": Allowed };
}>;
