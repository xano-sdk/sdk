/**
 * The kind a factory made a def as — so a `register*` call can refuse a def of
 * another kind by name.
 *
 * Through `any` (plain JavaScript, a value that crossed an `any`),
 * `registerFunctions([queryDef])` exported the query as a function,
 * `registerQueries([functionDef])` said "`verb` is required", and
 * `registerTriggers([functionDef])` crashed with a TypeError. Every def is a
 * plain object, and several kinds share most of their shape, so the shape
 * alone cannot say which factory made one. The factory can.
 *
 * Non-enumerable, and keyed through the global symbol registry: it never
 * reaches `Object.keys`, JSON, a spread or `toEqual`, and it survives the SDK
 * being loaded twice (the CLI under Node, the entry under tsx). A def with no
 * brand — spread into a new object, written as a literal that `satisfies` the
 * def type, as a decoded tree may be — is checked by shape as before; only a
 * brand that names ANOTHER kind is refused.
 *
 * Two factories stay unbranded on purpose, because they ship in browser
 * bundles (a typed frontend imports a query and its group): `apiGroup()` is the
 * identity, which a bundler inlines away together with its module — a brand
 * would keep that module (~3 kB) — and `query()` is recognised by its `verb`.
 * A group is recognised by the keys only it carries, and every def type's
 * type-only `__kind` refuses the wrong register call at compile time.
 */
const DEF_KIND: unique symbol = Symbol.for("xanosdk.def.kind") as never;

/** Stamp `def` as made by the factory of registry kind `kind`; returns `def`. */
export function brandDef<T>(def: T, kind: string): T {
  if (typeof def !== "object" || def === null) return def;
  try {
    Object.defineProperty(def, DEF_KIND, { value: kind, enumerable: false, configurable: true });
  } catch {
    // A frozen def keeps no brand; it is checked by shape, as an unbranded one is.
  }
  return def;
}

/** The registry kind the factory that made `def` stamped, if any. */
export function defKindOf(def: unknown): string | undefined {
  if (typeof def !== "object" || def === null) return undefined;
  const kind = (def as { [DEF_KIND]?: unknown })[DEF_KIND];
  return typeof kind === "string" ? kind : undefined;
}
