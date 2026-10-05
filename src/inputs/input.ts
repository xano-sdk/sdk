/**
 * Input authoring + encoding. `input.text()` / `input.int()` return a small
 * descriptor; `encodeInput(name, descriptor)` delegates to the shared field
 * encoder with the input field context.
 */
import type { InputXdo } from "../types/xdo.js";
import { isTaggedValue } from "../values/value.js";
import { encodeField, INPUT_CONTEXT } from "../fields/field.js";
import type { FieldOptions, MethodArg, ReadonlyMethods } from "../fields/field.js";
import { f, toNestedFields } from "../fields/catalog.js";
import type { FieldMap, EnumDefault } from "../fields/catalog.js";
import type { TypeBrand, RawBrandValue, BrandType, ObjectOf, XanoFileUpload, XanoDbLink } from "../fields/value-types.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type {
  TextMethod,
  IntMethod,
  DecimalMethod,
  EmailMethod,
  PasswordMethod,
} from "../fields/generated/field-methods.generated.js";

export type InputOptions = FieldOptions;

/**
 * {@link InputOptions} with `methods` narrowed to the input type's valid method
 * set `N` (mirrors the field catalog's `MethodOpts`). Types with no
 * engine-declared methods leave `N = never` (only the `{ name, arg }` escape hatch).
 */
export type InputOpts<N extends string> = Omit<InputOptions, "methods"> & {
  methods?: MethodArg<N>[];
};

/** {@link InputOpts} made safe to capture under a `const` type parameter (see {@link ReadonlyMethods}). */
export type ConstInputOpts<N extends string> = ReadonlyMethods<InputOpts<N>, N>;

/** Internal descriptor carried until `encodeInput` runs. */
export interface InputDescriptor {
  type: string;
  options: InputOptions;
}

function makeInput<V, N extends string, T extends string>(type: T) {
  return <const O extends ConstInputOpts<N> = Record<string, never>>(
    options: O = {} as O,
  ): InputDescriptor & TypeBrand<V, O, T> =>
    ({ type, options }) as InputDescriptor & TypeBrand<V, O, T>;
}

/**
 * Typed input constructors. Inputs and table columns share one engine schema, so
 * `input.*` is a full mirror of the `f.*` catalog — every engine-legal input type
 * (scalars, files, geo, vector, table refs, objects, lists). The file/geo/vector/
 * tableRef constructors delegate to `f.*`: the descriptor (`{ type, options }`) is
 * context-free — the input-vs-column difference is applied later by `encodeInput`'s
 * `INPUT_CONTEXT` — so the same constructor is correct for both and they can't drift.
 * `enum`/`object` take their payload positionally; the rest take plain options.
 */
export const input = {
  // --- scalars ---
  text: makeInput<string, TextMethod, "text">("text"),
  int: makeInput<number, IntMethod, "int">("int"),
  decimal: makeInput<number, DecimalMethod, "decimal">("decimal"),
  bool: makeInput<boolean, never, "bool">("bool"),
  email: makeInput<string, EmailMethod, "email">("email"),
  /**
   * Password input — hashes its value **when the input binds**, before your stack
   * runs. This breaks the natural signup/login shape and is the single most common
   * way to ship silently-broken auth:
   * - **Login:** `s.security.check_password` receives the *already-hashed* submission
   *   (a fresh random salt each request), compares it against the stored hash, and
   *   never matches — so login always fails with a false "invalid password".
   * - **Signup:** the value is hashed here at bind, so the `f.password` column then sees
   *   an already-hashed `salt.hash` value and stores it as-is (the column's hash-on-write
   *   skips a value already in that shape) — the plaintext never lands in the column.
   *
   * Recipe: use {@link input.text} (e.g. `input.text({ methods: ["min:6"] })`) for the
   * password on **both** signup and login, let the `f.password` *column* hash on write,
   * and pass the plaintext straight to `check_password`. See the auth recipe in the
   * README. Reach for `input.password` only when you specifically want bind-time hashing
   * and are not also comparing it with `check_password`.
   */
  password: makeInput<string, PasswordMethod, "password">("password"),
  /**
   * URL input — a `text` field that names the intent "this holds a URL". There
   * is no native engine `url` type, and this does **not** by itself enforce an
   * http(s) scheme: a `javascript:`/`data:` URL still type-checks and imports.
   * When the value is security-relevant (e.g. a link that gets navigated to),
   * reject bad input at the boundary in the stack with `s.precondition` — see
   * the "validate input at the boundary" recipe in the README. Carries the same
   * `TextMethod` options as {@link input.text}.
   */
  url: makeInput<string, TextMethod, "text">("text"),
  uuid: makeInput<string, never, "uuid">("uuid"),
  date: makeInput<string, never, "date">("date"),
  /**
   * Epoch-millisecond timestamp (stored `epochms`). A number binds as ms as-is —
   * epoch SECONDS land in 1970 with no error — and an ISO-8601 string keeps its
   * offset but drops fractional seconds. Send epoch ms for sub-second precision.
   */
  timestamp: makeInput<number, never, "epochms">("epochms"),
  json: makeInput<unknown, never, "json">("json"),

  /**
   * Raw file **upload** (stored `file`) — the bytes as they arrive on the
   * request (multipart, base64, or a fetched URI). Input-only: there is no
   * `f.file` column, because an upload is not something a table holds.
   *
   * It is NOT a stored file resource and cannot be written to a file column
   * directly. Store it first and write what you get back:
   * `s.storage.create_image({ as: "img", value: inp("avatar") })`, then write
   * `ref("img")` to an `f.image()` column. Use {@link input.image} and friends
   * only when the caller already sends a stored file resource.
   *
   * Read the upload with `inp`, NOT `ref("input.avatar")`: `ref` is the `var`
   * tag, so that spelling makes the engine look for a stack variable named
   * `input` and fail the request with `Missing var entry: input`.
   */
  file: makeInput<XanoFileUpload, never, "file">("file"),

  /**
   * **Database link** — one input that EXPANDS into one input per column of the
   * linked table (stored `<tableGuid>_mvpschema`; XanoScript `dblink`). A table
   * with three columns turns this single entry into three request inputs, so
   * read them by their own column names: `inp("email")`, not `inp("user__")`.
   * The expansion is live — adding a column to the table adds an input here.
   *
   * `hidden` is how you drop columns from that expansion (`["created_at", "id"]`)
   * and is the common case in the wild, not an edge case. `merge: true` is what
   * makes the engine expand rather than nest, so it is forced and cannot be
   * unset — a dblink that does not merge is not a dblink.
   *
   * `customize` overrides individual expanded columns — `{ email: { required:
   * true, methods: ["lower"] } }` — where `hidden` drops them wholesale. Both
   * are read per column by the engine's expansion, and a column named in
   * `customize` with `hidden: true` is dropped exactly as the outer list does it.
   * A node REPLACES the column's own `required` flag and `methods`, and an
   * omitted one is stored as `false` / none: a node that only adds a method
   * makes a required column optional, so restate `required: true`.
   *
   * Input-only: the engine refuses it as a column type, and a column linking a
   * whole table would be a foreign key — use
   * {@link f.tableRef} for that.
   *
   * By convention the editor names the entry after the table with a trailing
   * `__` (`user__`), but the name is just the key in your `input:` map and any
   * name round-trips.
   */
  dbLink<const O extends ConstInputOpts<never> = Record<string, never>>(
    table: ObjectRef,
    options: O = {} as O,
  ): InputDescriptor & TypeBrand<XanoDbLink, O> {
    return {
      type: `${resolveRef("dbo", table)}_mvpschema`,
      options: { ...options, merge: true },
    } as InputDescriptor & TypeBrand<XanoDbLink, O>;
  },

  // --- file resources / geo / vector / table refs (shared with the `f.*` catalog) ---
  /** Image file input (stored `blob_img`). */
  image: f.image,
  /** Video file input (stored `blob_video`). */
  video: f.video,
  /** Audio file input (stored `blob_audio`). */
  audio: f.audio,
  /** Generic file-attachment input (stored `blob`). */
  attachment: f.attachment,
  /** Geo inputs: `input.geo.point()`, `.polygon()`, … (six geometry types). */
  geo: f.geo,
  /** Vector input; `size` (>= 1) is the embedding dimensionality. */
  vector: f.vector,
  /** Table-reference input — see {@link f.tableRef}; pass the table handle or bare name. */
  tableRef: f.tableRef,
  /**
   * Enum input. `values` may be empty, mirroring {@link f.enum} — the two
   * surfaces describe the same engine type, and one accepting what the other
   * rejects is how they start disagreeing about what a workspace can hold.
   */
  enum<const V extends ReadonlyArray<string | number>, const O extends ConstInputOpts<never> = Record<string, never>>(
    values: V,
    options: O & EnumDefault<V, O> = {} as O & EnumDefault<V, O>,
  ): InputDescriptor & TypeBrand<V[number], O, "enum"> {
    return { type: "enum", options: { ...options, values: [...values] } } as InputDescriptor &
      TypeBrand<V[number], O, "enum">;
  },
  /**
   * Object input (stored `obj`) with typed, named children. `children` is a
   * field map built from the same `f.*` catalog used for columns, e.g.
   * `input.object({ name: f.text(), age: f.int() })`.
   */
  object<const C extends FieldMap, const O extends ConstInputOpts<never> = Record<string, never>>(
    children: C,
    options: O = {} as O,
  ): InputDescriptor & TypeBrand<ObjectOf<C>, O, "obj"> {
    return {
      type: "obj",
      options: { ...options, children: toNestedFields(children) },
    } as InputDescriptor & TypeBrand<ObjectOf<C>, O, "obj">;
  },
  /**
   * List (array) input — wraps an element constructor, mirroring `Array<T>`:
   * `input.list(input.text())`, `input.list(input.object({ id: f.int() }))`.
   * The element's own options (e.g. its `methods`) are kept; list-level `options`
   * (`required`, `nullable`, `description`, …) apply to the list field and win
   * on conflict. The element's value type is preserved as the array element.
   *
   * A non-array value is NOT rejected: it binds as a one-item list, and a
   * non-JSON string for an `input.object` element binds its children's defaults.
   * A string starting with `[` is parsed as JSON without an element check. Mark
   * an object child `required` or guard with `s.precondition` when the shape
   * must hold.
   */
  list<const E extends InputDescriptor, const O extends ConstInputOpts<never> = Record<string, never>>(
    element: E,
    options: O = {} as O,
  ): InputDescriptor & TypeBrand<RawBrandValue<E>, O & { array: true }, BrandType<E>> {
    if (!element?.type) {
      throw new Error("input.list: pass an element constructor, e.g. input.list(input.text()).");
    }
    return {
      type: element.type,
      options: { ...element.options, ...options, array: true },
    } as InputDescriptor & TypeBrand<RawBrandValue<E>, O & { array: true }, BrandType<E>>;
  },
};

/** Encode a named input descriptor into the full stored `InputXdo`. */
export function encodeInput(name: string, descriptor: InputDescriptor): InputXdo {
  // Guard the `inp(...)` (value ref, tag "input") vs `input.*` (descriptor)
  // collision: an `input:` map wants descriptor factories (`input.text()`), but
  // `inp("x")` — the value ref used one line over in a `where`/stack slot —
  // shares the word "input" and mis-types easily (a listed llms.txt gotcha). A
  // `Value` has no `type`/`options`, so it would otherwise encode into a broken
  // field silently. TS already rejects this for typed callers; this catches
  // JS/`any`-typed ones with a message that names the fix.
  if (isTaggedValue(descriptor)) {
    throw new Error(
      `input "${name}": got a value ref (inp("${descriptor.value}"), tag "${descriptor.tag}") where an input descriptor is required. ` +
        `An "input:" map wants a descriptor factory like input.text()/input.int()/input.enum([...]) — not the value ref inp(...). ` +
        `Reach for inp("${name}") only to READ this input inside a where/stack/value slot.`,
    );
  }
  return encodeField(name, descriptor.type, descriptor.options, INPUT_CONTEXT) as InputXdo;
}
