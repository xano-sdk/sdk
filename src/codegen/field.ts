/**
 * Field, input, and response decoders — stored `FieldXdo` → `f.*` / `input.*`
 * source, and stored `result[]` → a `response` def.
 *
 * Same discipline as the value decoder: a readable candidate is only emitted
 * after `encodeField` has been run over the recovered options and the result
 * compared against the stored field. When the catalog cannot reproduce a stored
 * shape, the decoder drops to the descriptor literal (`{type, options}`), which
 * is still a legal `FieldDescriptor` and still round-trips.
 *
 * A couple of stored keys are fixed by `encodeField` and have no authoring
 * surface at all (`override`, `is_settings_registry`). A field carrying a
 * non-default value for one of those cannot round-trip through any authored
 * form, so it is reported by name rather than quietly emitted as something
 * close. `merge`, `hidden`, and `customize` are authorable options, not in that
 * set — each is what lets a large `rawField()` cluster come back as readable
 * catalog calls.
 */
import type { FieldXdo, MethodXdo, ResultItemXdo, TaggedValue } from "../types/xdo.js";
import type { FieldContext, FieldCustomization, FieldOptions, MethodSpec, NestedField } from "../fields/field.js";
// The CLI's plan disclosure reads this from here: importing it from `fields/field.ts`
// directly regroups the build's chunks so that `import { fl }` drags the CLI in
// (test/bundle-floor.test.ts).
export { authoredFieldType } from "../fields/field.js";
import { CATALOG_BY_TYPE, COLUMN_CONTEXT, INPUT_CONTEXT, authoredFieldType, defaultNullable, encodeField, parseMethod } from "../fields/field.js";
import { f } from "../fields/catalog.js";
import { FIELD_METHODS } from "../fields/generated/field-methods.generated.js";
import type { FieldDescriptor } from "../fields/catalog.js";
import { input } from "../inputs/input.js";
// The two table-relationship readers live in `src/bundle/schema.ts`, where they
// are also the published `@xano/sdk/bundle` surface. One copy: a decoder that
// read the FK shape differently from the one a third-party schema view reads
// would put the two into silent disagreement about the same bytes. `tableRefOf`
// returning null for a bare `dbo=` is load-bearing HERE — an FK annotation
// pointing at nothing. Treating it as a reference made `f.tableRef` throw on an
// empty target, which took the whole field down to a descriptor literal; null
// routes it through the ordinary catalog path, where the `@` method rides along
// in `methods` verbatim.
import { linkedTableOf, tableRefOf } from "../bundle/schema.js";
import { CODEGEN_MODULE, SDK_MODULE, type DecodeContext } from "./context.js";
import { arr, call, lit, obj, spread, type Expr } from "./print.js";
import { resolveReference, type RefIndex, type ResolveOptions } from "./ref-index.js";
import {
  clearLocalDboRefs,
  hasNoListBounds,
  normalize,
  isDeadResultItem,
  isEmptyCustomize,
} from "../validate/normalize.js";
import { decodeValue } from "./value.js";

/** Which authoring catalog to emit against: table columns (`f`) or inputs (`input`). */
export type FieldSurface = "f" | "input";

/**
 * Types that exist only as inputs, so they must not resolve against `f.*`.
 * `file` is a raw upload — the request's bytes, not a stored resource — which is
 * why no table column has the type and why `f` has no constructor for it.
 */
const INPUT_ONLY_BY_TYPE: Readonly<Record<string, string>> = { file: "file" };

/**
 * Stored keys `encodeField` writes unconditionally, with the value it always
 * writes. No authoring option reaches any of these, so a stored field carrying a
 * different value cannot round-trip through *any* source form — not the catalog
 * call and not the descriptor literal either.
 */
const ENCODER_FIXED: ReadonlyArray<readonly [string, unknown]> = [
  // `merge` and `hidden` are NOT here: they are authorable field options, which
  // is what lets a merged/hidden field come back as a readable catalog call.
  // Together they would be the largest single cause of `rawField()`.
  ["override", []],
  ["is_settings_registry", false],
];

/**
 * Field equality under the round-trip contract's own comparator. `normalize`
 * strips the server-generated keys the SDK never emits — `_xsid`, `market_item` —
 * so a stored `_xsid` is not a fidelity loss, while `customize` (which it does not
 * strip) is.
 */
function sameField(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/**
 * The top-level keys on which a re-encoded field disagrees with the stored one.
 *
 * A `value-fallback` that only says a field "emitted as a descriptor literal"
 * cannot be clustered — and two different causes reach that message, so a row
 * cannot even be attributed to one of them. Naming the keys is what turns the
 * category into something a sweep can group by. Compared under `normalize`, the
 * same comparator {@link sameField} uses, so a key it strips never shows up.
 */
function differingKeys(encoded: unknown, stored: unknown): string[] {
  const a = normalize(encoded) as Record<string, unknown> | null;
  const b = normalize(stored) as Record<string, unknown> | null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !deepEqual(a[key], b[key])).sort();
}

/** How a re-encode differed, as a message fragment naming the keys. */
function describeDiff(encoded: unknown, stored: unknown): string {
  const keys = differingKeys(encoded, stored);
  return keys.length === 0 ? "differs structurally" : `differs at ${keys.join(", ")}`;
}

/** Structural equality over stored JSON. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b as object, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Stored keys with no authoring surface that this field sets to a non-default.
 *
 * The comparison runs under `normalize` — the round-trip contract's own
 * comparator — not raw equality, so a legacy `customize:""` counts as the empty
 * customization it is rather than as an unrepresentable shape. Comparing raw
 * made this function contradict the oracle the decode is proven against: the
 * catalog call it refused reproduces the field exactly under the only
 * comparison anyone actually runs.
 *
 * `customize` is not here either. It is an authorable option
 * ({@link FieldOptions.customize}), which is what lets Xano's own CRUD scaffold
 * — a dblink input with per-column overrides — come back as a readable
 * `input.dbLink` call instead of a `rawField()` envelope.
 */
function unrepresentableKeys(stored: FieldXdo): string[] {
  const record = stored as unknown as Record<string, unknown>;
  // `_xsid` and `market_item` are omitted deliberately: `normalize` strips both,
  // so a stored value there does not break the round trip and reporting it would
  // be noise on every pulled object.
  const fixed: Array<readonly [string, unknown]> = [...ENCODER_FIXED];
  // Each side is normalized as a one-key OBJECT, not as a bare value: the rules
  // that canonicalize the empty `customize` forms (and that drop a member
  // sitting at its engine default) are keyed off the member NAME, so they only
  // fire when the key is there to be seen.
  return fixed
    .filter(
      ([key, value]) =>
        Object.hasOwn(record, key) &&
        !deepEqual(normalize({ [key]: record[key] }), normalize({ [key]: value })),
    )
    .map(([key]) => key);
}

/**
 * `"min:8"` for a method whose args survive the colon round trip, else null.
 *
 * Self-checking rather than rule-based: the candidate string is parsed back with
 * the encoder's own splitter and compared to the stored args, so this cannot
 * drift from `parseMethod` no matter how either side changes.
 */
function colonForm(name: string, args: readonly (string | number)[]): string | null {
  if (name.includes(":")) return null;
  if (args.length === 0) return name;
  if (!args.every((a) => typeof a === "number" || typeof a === "string")) return null;
  const candidate = [name, ...args].join(":");
  const { name: reName, arg: recovered } = parseMethod(candidate);
  if (reName !== name || recovered.length !== args.length) return null;
  return recovered.every((value, i) => value === args[i]) ? candidate : null;
}

/**
 * Every method name any field type's generated union enumerates.
 *
 * The colon shorthand (`"min:8"`) only type-checks against `MethodArg<N>`, whose
 * `N` is the per-type union — so a name no union carries has to take the
 * explicit `{name, arg}` form, which {@link MethodArg} documents as the
 * universal escape hatch for exactly that.
 *
 * Membership is checked across ALL types rather than the field's own, because
 * the same helper reads `customize` blocks, whose per-column overrides target the
 * columns of a DIFFERENT table — types this decoder does not have. Checking the
 * union of every type keeps all 842 customize-bearing fields on the readable
 * shorthand; scoping it per-type would have pushed every one of them to the
 * fifteen-line object form to catch a case that does not occur.
 *
 * It costs nothing in practice: the corpus holds exactly ONE name outside the
 * unions, `@` — the FK annotation, 814 uses — and the 58 of those pointing at
 * nothing ride `methods` verbatim rather than becoming an `f.tableRef`, so they
 * were emitted as `"@:dbo="` and the tree did not compile.
 */
const ENUMERATED_METHODS: ReadonlySet<string> = new Set(
  Object.values(FIELD_METHODS).flatMap((methods) => Object.keys(methods)),
);

/**
 * The method names the constructor a stored field decodes to types its
 * `methods` against — the field type's own union, narrowed again to the
 * `tableRef` union when the field is a table reference, and empty for a
 * `dbLink` input (whose options take no method names).
 *
 * The shorthand only compiles against this set, so a name outside it has to take
 * the explicit `{ name, arg }` form even though some OTHER type enumerates it.
 * The corpus carries such names: a `trim` left on an int, bool, date, uuid,
 * image, epochms and object column after its type was changed in the editor.
 */
export function ownMethodNames(stored: FieldXdo, context: FieldContext): ReadonlySet<string> {
  if (context === INPUT_CONTEXT && linkedTableOf(stored) !== null) return new Set();
  const own = Object.keys(FIELD_METHODS[stored.type] ?? {});
  const ref = tableRefOf(stored) !== null ? FIELD_METHODS.tableRef ?? {} : null;
  return new Set(ref === null ? own : own.filter((name) => Object.hasOwn(ref, name)));
}

/**
 * The stored method names a field carries that its type does not take — every
 * enabled method outside {@link ownMethodNames} except the `@` reference
 * annotation, which is not a method.
 */
export function foreignMethodNames(stored: FieldXdo, context: FieldContext): string[] {
  const own = ownMethodNames(stored, context);
  const names = (stored.methods ?? [])
    .filter((method) => method.name !== "@" && (method.disabled ?? false) === false)
    .map((method) => method.name)
    .filter((name) => !own.has(name));
  return [...new Set(names)];
}

/**
 * Recover authoring `methods` from the stored list, or null when not expressible.
 *
 * `shorthand` is the set of names the colon shorthand may be used for — every
 * enumerated name by default, or a field's {@link ownMethodNames}.
 */
function recoverMethods(
  stored: readonly MethodXdo[],
  shorthand: ReadonlySet<string> = ENUMERATED_METHODS,
): MethodSpec[] | null {
  const out: MethodSpec[] = [];
  for (const method of stored) {
    // `encodeMethods` always writes `disabled: false`; a disabled method has no
    // authoring form. An ABSENT `disabled` is the older engine generation's way
    // of writing the same default (see the lean field envelope in
    // `normalize`) — only an explicit `true` is a real disabled method.
    if ((method.disabled ?? false) !== false) return null;
    const args = method.arg ?? [];
    // Prefer the colon shorthand (`"min:8"`) — it is what an author writes, and
    // the object form turns a three-rule password column into fifteen lines.
    // It is only emitted when re-parsing it yields the stored args exactly, so
    // an arg that cannot survive the trip (an embedded `:`, a string that looks
    // like a number) falls back to the explicit form rather than drifting.
    const short = shorthand.has(method.name) ? colonForm(method.name, args) : null;
    out.push(short ?? (args.length > 0 ? { name: method.name, arg: [...args] } : { name: method.name }));
  }
  return out;
}

/**
 * Recover a stored `customize` map into authoring form: `null` when the map is
 * one of the empty spellings (nothing to author), `undefined` when a node holds
 * something no {@link FieldCustomization} can express.
 *
 * The tri-state is what keeps the two outcomes apart at the call site: an empty
 * map is the ordinary case on every field in a workspace, while an unexpressible
 * node has to take the whole field to a verbatim form rather than silently
 * dropping the member.
 */
function recoverCustomize(
  stored: unknown,
): Readonly<Record<string, FieldCustomization>> | null | undefined {
  if (isEmptyCustomize(stored)) return null;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const out: Record<string, FieldCustomization> = {};
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const node = value as Record<string, unknown>;
    // Every stored node carries exactly these five keys; a sixth is a shape this
    // has never seen and must not be encoded as though the extra were absent.
    const known = new Set(["hidden", "default", "methods", "required", "customize"]);
    if (Object.keys(node).some((key) => !known.has(key))) return undefined;
    const methods = recoverMethods((node.methods ?? []) as MethodXdo[]);
    if (methods === null) return undefined;
    const nested = recoverCustomize(node.customize);
    if (nested === undefined) return undefined;
    const recovered: FieldCustomization = {};
    if (node.hidden === true) recovered.hidden = true;
    if (node.required === true) recovered.required = true;
    if (node.default !== undefined && node.default !== "") {
      recovered.default = node.default as FieldCustomization["default"];
    }
    if (methods.length > 0) recovered.methods = methods;
    if (nested !== null) recovered.customize = nested;
    out[name] = recovered;
  }
  return out;
}

/** Recover the authoring `FieldOptions` a stored field was encoded from. */
export function recoverOptions(
  stored: FieldXdo,
  context: FieldContext,
  elide = true,
): FieldOptions | null {
  // Every read tolerates an absent key. A bundle's fields are complete, but a
  // decoder that throws on a partial shape turns a recoverable oddity into a
  // failed pull; falling through to the proof below (and then to `rawField()`)
  // keeps it exact instead.
  const options: FieldOptions = {};
  const values = Array.isArray(stored.values) ? stored.values : [];
  const list = stored.list ?? { min: "", max: "" };
  const vector = stored.vector ?? { size: 3 };
  const style = stored.style ?? { type: "single" };
  const access = stored.access ?? "public";
  const format = stored.format ?? "";
  const mode = stored.mode ?? "";
  const fallbackDefault = stored.default ?? "";

  // Recovered verbatim rather than interpreted: a stored `hidden: [""]` is a real
  // spelling in the wild, and reproducing it exactly is what makes this safe
  // without deciding what an empty entry MEANS.
  if (stored.merge === true || !elide) options.merge = stored.merge === true;
  const hidden = Array.isArray(stored.hidden) ? (stored.hidden as string[]) : [];
  if (hidden.length > 0 || !elide) options.hidden = [...hidden];
  // Elided against the TYPE's default on this surface, not against `false`.
  // Blob/geo/uuid/vector fields (and date/epochms/file inputs) are nullable
  // unless told otherwise, so for those it is the explicit `nullable: false`
  // that has to survive into the regenerated source.
  const nullable = stored.nullable ?? false;
  if (nullable !== defaultNullable(String(stored.type ?? ""), context) || !elide) options.nullable = nullable;
  if (stored.required || !elide) options.required = stored.required ?? false;
  if (stored.sensitive || !elide) options.sensitive = stored.sensitive ?? false;
  // An ABSENT `default` is not the same stored shape as an empty one, and only a
  // uuid primary key is stored that way. Recovering it as `noDefault` lets the
  // column come back as a readable catalog call; without it, no `f.*` form could
  // reproduce the absence and the field degraded to a `rawField()` passthrough.
  if (!Object.hasOwn(stored, "default")) options.noDefault = true;
  else if (fallbackDefault !== "" || !elide) options.default = fallbackDefault;
  if (mode !== "" || !elide) options.mode = mode;
  if (format !== "" || !elide) options.format = format as FieldOptions["format"];
  if (access !== "public" || !elide) options.access = access as FieldOptions["access"];
  if (values.length > 0) options.values = [...values] as FieldOptions["values"];
  // Elided on the MEANING of the block, not on one spelling of it. A field with
  // no length bounds stores `{min:"", max:""}` almost always and `{min:{},
  // max:{}}` twice in the sweep; comparing against the first spelling alone
  // emitted `list: {max: {}, min: {}}` for the second — bytes no author would
  // write, and ill-typed besides, since `FieldOptions.list` declares strings. The
  // predicate is shared with `normalize`, so the elision and the round-trip
  // comparison cannot disagree about what "unbounded" is.
  if (!hasNoListBounds(list)) options.list = { ...list } as FieldOptions["list"];
  if (!deepEqual(vector, { size: 3 })) options.vector = { ...vector };
  // `array: true` and `style: {type:"list"}` encode identically, but only
  // `array` reaches the inferred type (`InferRow`/`InferInput` read it as `T[]`),
  // so a list decodes to it. Any other style is carried as stored.
  if (style.type === "list") options.array = true;
  else if (!deepEqual(style, { type: "single" })) {
    options.style = { type: style.type as NonNullable<FieldOptions["style"]>["type"] };
  }
  if (context.includeDescription && stored.description !== undefined && stored.description !== "") {
    options.description = stored.description;
  }

  const methods = recoverMethods(stored.methods ?? [], ownMethodNames(stored, context));
  if (methods === null) return null;
  if (methods.length > 0) options.methods = methods;

  const customize = recoverCustomize(stored.customize);
  if (customize === undefined) return null;
  if (customize !== null) options.customize = customize;

  const children: NestedField[] = [];
  for (const child of storedChildren(stored)) {
    const childOptions = recoverOptions(child, context);
    if (childOptions === null) return null;
    children.push({ name: child.name, type: child.type, ...childOptions });
  }
  if (children.length > 0) options.children = children;

  return options;
}

/** A field's nested children. Stored loosely as `unknown[]`; every entry is a field. */
function storedChildren(stored: FieldXdo): FieldXdo[] {
  return (stored.children ?? []) as FieldXdo[];
}

/**
 * Reset every LOCAL table reference inside a `customize` block to the unbound
 * spelling, returning the rewritten field and the targets that were cleared.
 *
 * The rewrite itself lives in `normalize` so the decoder and the round-trip
 * comparison apply exactly one rule; this wraps it with the reporting the change
 * earns. A cleared reference is a real loss — a same-workspace redeploy would
 * have resolved that id — so every target is named rather than quietly dropped,
 * the same way a blanked table reference is.
 */
function unbindLocalCustomizeRefs(stored: FieldXdo): { field: FieldXdo; unbound: string[] } {
  const customize = (stored as { customize?: unknown }).customize;
  if (customize === null || typeof customize !== "object") return { field: stored, unbound: [] };
  const cleared = new Set<string>();
  const rewritten = clearLocalDboRefs(customize, cleared);
  if (cleared.size === 0) return { field: stored, unbound: [] };
  return { field: { ...stored, customize: rewritten } as FieldXdo, unbound: [...cleared].sort() };
}

/** Render recovered options as a source object literal, decoding nested children. */
function optionsExpr(options: FieldOptions, omit: ReadonlyArray<keyof FieldOptions> = []): Expr {
  const entries: Array<[string, Expr]> = [];
  for (const [key, value] of Object.entries(options)) {
    if ((omit as readonly string[]).includes(key)) continue;
    entries.push([key, lit(value)]);
  }
  return obj(entries);
}

/** A field decoded to source, plus whether it uses the readable catalog form. */
export interface DecodedField {
  readonly expr: Expr;
  readonly idiomatic: boolean;
}

/**
 * Decode one stored field to a `f.*` / `input.*` call, or to the descriptor
 * literal when the catalog cannot reproduce it.
 */
export function decodeField(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: FieldXdo,
  surface: FieldSurface,
  resolve: ResolveOptions = {},
  primaryKey = false,
): DecodedField {
  const context = surface === "input" ? INPUT_CONTEXT : COLUMN_CONTEXT;

  // The one thing never carried through as stored: a table reference inside
  // `customize` that names its target by local row id. Done FIRST so every path
  // below — catalog call, descriptor literal, `rawField()` — decodes the same
  // unbound field, and reported once because it is a change to the pulled tree
  // rather than a passthrough.
  const { field: stored_, unbound } = unbindLocalCustomizeRefs(stored);
  if (unbound.length > 0) {
    ctx.problem(
      "unportable-id",
      `field "${stored.name}" references ${unbound.join(", ")} inside \`customize\` by LOCAL row id rather than by guid — ` +
        `an internal id is not portable identity, so it is recovered as unbound (\`dbo=\`). ` +
        `A re-deploy will not re-link it, including back into the workspace it came from`,
    );
  }
  stored = stored_;

  // An input row added in the editor and never filled in: no name, no type.
  // Nothing can bind to it — `inp("")` is not addressable — so it is a defect in
  // the workspace rather than a shape this SDK failed to model, and the
  // fallback's own sentence (`field "" ()`) reads as a bug in the tool. Reported
  // here, before any decode path, so it is said once whichever form is emitted;
  // the field is still carried, because a pull that quietly drops a row stops
  // describing the workspace it came from.
  if (stored.name === "" && (stored.type === "" || stored.type === undefined)) {
    ctx.problem(
      "workspace-defect",
      `an ${surface === "input" ? "input" : "column"} has no name and no type — an editor row that was ` +
        `added and never filled in. Nothing can bind to it (there is no name to bind), and the engine ` +
        `reads no type for it. Remove it upstream, or give it a name and a type. It is carried into the ` +
        `tree as stored so the pull still describes the workspace`,
      "unnamed, untyped",
    );
  }

  const options = recoverOptions(stored, context);
  // A table's uuid key encodes with no `default` unless it states one, so the
  // `default: ""` that recovery elides as the field's own default has to be
  // stated back for the key to re-encode it. Real workspaces store both.
  if (
    primaryKey &&
    options !== null &&
    stored.type === "uuid" &&
    Object.hasOwn(stored, "default") &&
    options.default === undefined
  ) {
    options.default = "";
  }

  // Keys no authoring option can reach — `override`, `is_settings_registry` —
  // would be silently rewritten by any `f.*`/`input.*`/descriptor form.
  // `rawField()` carries the whole envelope instead, so this degrades
  // readability without losing data.
  const missing = unrepresentableKeys(stored);
  if (missing.length > 0) {
    ctx.use(CODEGEN_MODULE, "rawField");
    ctx.problem(
      "value-fallback",
      `field "${stored.name}" stores ${missing.join(", ")} in a shape no authoring surface can produce; emitted verbatim via rawField()`,
    );
    return { idiomatic: false, expr: call("rawField", lit(stored)) };
  }

  /**
   * The descriptor literal reproduces the stored field through `encodeField`'s
   * normal path, so it is preferred over `rawField()` — it still reads as data,
   * but as *authorable* data. `rawField()` is the last resort.
   */
  const descriptorLiteral = (): DecodedField => {
    const descriptor: Expr = obj([
      ["type", lit(stored.type)],
      ["options", options === null ? lit({}) : optionsExpr(options)],
    ]);
    if (options !== null && sameField(encodeField(stored.name, stored.type, options, context), stored)) {
      return { idiomatic: false, expr: descriptor };
    }
    ctx.use(CODEGEN_MODULE, "rawField");
    return { idiomatic: false, expr: call("rawField", lit(stored)) };
  };

  // The descriptor literal is still a legal `FieldDescriptor`, so the schema
  // keeps compiling; it just reads as data rather than as a catalog call.
  const literalBecause = (why: string): DecodedField => {
    if (missing.length === 0) {
      ctx.problem(
        "value-fallback",
        `field "${stored.name}" (${stored.type}) emitted as a descriptor literal: ${why}`,
      );
    }
    return descriptorLiteral();
  };

  if (options === null) {
    return literalBecause("its options could not be recovered from the stored shape");
  }
  const reEncoded = encodeField(stored.name, stored.type, options, context);
  if (!sameField(reEncoded, stored)) {
    return literalBecause(`re-encoding the recovered options ${describeDiff(reEncoded, stored)}`);
  }

  const kind = surface === "input" ? "input" : "column";
  const typeName = stored.type === "obj" ? "object" : authoredFieldType(stored.type);
  const foreign = foreignMethodNames(stored, context);
  if (foreign.length > 0) {
    const names = foreign.map((name) => `\`${name}\``).join(", ");
    const one = foreign.length === 1;
    ctx.problem(
      "workspace-defect",
      `${kind} "${stored.name}" (${typeName}) stores the method${one ? "" : "s"} ${names}, which the \`${typeName}\` ` +
        `type does not take — most likely left over from an earlier type. ` +
        `Decoded in the explicit \`{ name, arg }\` form so the tree compiles and re-deploys the same bytes; ` +
        `remove ${one ? "it" : "them"} upstream`,
      "foreign method",
    );
  }

  // Nested `children` are read only on an object or json field; on any other
  // type they are leftovers from an earlier type, and that type's constructor
  // has no `children` option. The descriptor literal carries them as stored.
  if (stored.type !== "obj" && stored.type !== "json" && storedChildren(stored).length > 0) {
    ctx.problem(
      "workspace-defect",
      `${kind} "${stored.name}" (${typeName}) stores nested children, which only an object or json ${kind} reads — ` +
        `most likely left over from an earlier type. Emitted as a descriptor literal so the tree compiles and ` +
        `re-deploys the same bytes; remove them upstream`,
      "stale children",
    );
    return descriptorLiteral();
  }

  const ns = ctx.use(SDK_MODULE, surface);
  const opts = options;

  /**
   * Emit a catalog call only once the constructor has been run and its output
   * compared against the stored field. Constructors apply their own defaults
   * (`f.password` sets `access:"internal"`), so recovered options that re-encode
   * correctly through `encodeField` can still be wrong through the catalog.
   */
  /**
   * Why the last candidate was rejected, kept so the fallback can say what the
   * catalog could not reproduce instead of only that it failed. A constructor
   * that throws leaves no encoding to diff, so it records that instead.
   */
  let lastRejection = "no catalog form was attempted";
  const proven = (expr: Expr, build: () => FieldDescriptor): DecodedField | null => {
    let built: FieldDescriptor;
    try {
      built = build();
    } catch (err) {
      lastRejection = `the catalog constructor threw (${err instanceof Error ? err.message : String(err)})`;
      return null;
    }
    const encoded = encodeField(stored.name, built.type, built.options, context);
    if (sameField(encoded, stored)) return { idiomatic: true, expr: asInputList(expr) };
    lastRejection = `the catalog call ${describeDiff(encoded, stored)}`;
    return null;
  };

  /**
   * On the input surface a list reads as `input.list(input.int())`, the form the
   * docs teach: `array: true` moves off the element call onto the wrapper. Same
   * options either way — `input.list` spreads the element's and adds `array`.
   */
  const asInputList = (expr: Expr): Expr => {
    if (surface !== "input" || opts.array !== true || expr.kind !== "call") return expr;
    const last = expr.args[expr.args.length - 1];
    if (last?.kind !== "object") return expr;
    const entries = last.entries.filter(([key]) => key !== "array");
    const args = [...expr.args.slice(0, -1), ...(entries.length > 0 ? [obj(entries)] : [])];
    return call(`${ns}.list`, call(expr.callee, ...args));
  };

  /** The catalog the emitted call resolves against at evaluation time. */
  const catalog = (surface === "input" ? input : f) as unknown as Record<string, unknown>;

  if (stored.type === "enum") {
    lastRejection = `its default ${JSON.stringify(opts.default)} is not one of its values, which the \`enum\` constructor refuses`;
  }
  const dbLinkGuid = linkedTableOf(stored);
  if (dbLinkGuid !== null && surface === "input") {
    // `merge` is what makes the engine expand the link, so `input.dbLink` forces
    // it — emitting it back would be redundant, and it is not authorable here.
    const rest = { ...opts };
    delete rest.merge;
    const restExpr = optionsExpr(rest);
    const args: Expr[] = [
      resolveReference(ctx, refs, dbLinkGuid, { ...resolve, unresolved: "object-ref" }),
    ];
    if (restExpr.kind === "object" && restExpr.entries.length > 0) args.push(restExpr);
    const decoded = proven(call(`${ns}.dbLink`, ...args), () =>
      input.dbLink({ name: "", guid: dbLinkGuid }, rest as never),
    );
    if (decoded) return decoded;
  }

  const refGuid = tableRefOf(stored);
  if (refGuid !== null) {
    // The `@` method IS the reference; it is re-added by `f.tableRef`, so the
    // authored options must not repeat it.
    const withoutRef: FieldOptions = { ...opts, methods: opts.methods!.slice(0, -1) };
    if (withoutRef.methods!.length === 0) delete withoutRef.methods;
    // `type` is a tableRef-only option (the FK's scalar type) and defaults to int.
    const entries: Array<[string, Expr]> = stored.type === "uuid" ? [["type", lit("uuid")]] : [];
    for (const [key, value] of Object.entries(withoutRef)) entries.push([key, lit(value)]);
    // `f.tableRef` takes an ObjectRef, where a bare string is read as a NAME —
    // so an unresolvable guid must degrade to `{name, guid}`, not to the string.
    const args: Expr[] = [
      resolveReference(ctx, refs, refGuid, { ...resolve, unresolved: "object-ref" }),
    ];
    const tail = { ...(stored.type === "uuid" ? { type: "uuid" } : {}), ...withoutRef };
    if (entries.length > 0) args.push(obj(entries));
    const decoded = proven(call(`${ns}.tableRef`, ...args), () =>
      f.tableRef({ name: "", guid: refGuid }, tail as never),
    );
    if (decoded) return decoded;
  } else if (
    stored.type === "enum" &&
    // A stored default outside the values does not type-check as `f.enum(…)`
    // (`EnumDefault`); the descriptor literal below still carries it.
    (opts.default === undefined || opts.default === "" || (opts.values ?? []).some((v) => String(v) === String(opts.default)))
  ) {
    const rest = optionsExpr(opts, ["values"]);
    const args: Expr[] = [lit(opts.values ?? [])];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { values, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.enum`, ...args), () =>
      (catalog.enum as (v: never, o: never) => FieldDescriptor)(
        (values ?? []) as never,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else if (stored.type === "vector") {
    const rest = optionsExpr(opts, ["vector"]);
    const args: Expr[] = [lit(opts.vector?.size ?? 3)];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { vector, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.vector`, ...args), () =>
      (catalog.vector as (s: number, o: never) => FieldDescriptor)(
        vector?.size ?? 3,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else if (stored.type === "obj") {
    const rest = optionsExpr(opts, ["children"]);
    const children = storedChildren(stored);
    const args: Expr[] = [
      obj(children.map((child) => [child.name, decodeField(ctx, refs, child, surface, resolve).expr])),
    ];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { children: childOpts, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.object`, ...args), () =>
      (catalog.object as (c: never, o: never) => FieldDescriptor)(
        Object.fromEntries(
          (childOpts ?? []).map(({ name, type, ...rest2 }) => [name, { type, options: rest2 }]),
        ) as never,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else {
    const accessor =
      (Object.hasOwn(CATALOG_BY_TYPE, stored.type) ? CATALOG_BY_TYPE[stored.type] : undefined) ??
      (surface === "input" ? (Object.hasOwn(INPUT_ONLY_BY_TYPE, stored.type) ? INPUT_ONLY_BY_TYPE[stored.type] : undefined) : undefined);
    if (accessor !== undefined) {
      const [head, leaf] = accessor.split(".");
      const factory = (
        leaf === undefined
          ? catalog[head!]
          : (catalog[head!] as Record<string, unknown>)[leaf]
      ) as (o: never) => FieldDescriptor;

      // Try the leanest form first. A constructor may supply its own defaults
      // (`f.password` sets `access:"internal"`), so any recovered option the bare
      // call already produces is redundant — dropping it is what makes
      // `f.password()` read as `f.password()`. Each candidate is still proven, so
      // trimming can never change the emitted bytes.
      const candidates: FieldOptions[] = [opts];
      const bare = (() => {
        try {
          return factory({} as never).options as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (bare) {
        const lean = Object.fromEntries(
          Object.entries(opts).filter(([key, value]) => !deepEqual(value, bare[key])),
        ) as FieldOptions;
        if (Object.keys(lean).length < Object.keys(opts).length) candidates.unshift(lean);

        // The mirror case: a constructor default can also *override* a value the
        // recovered options dropped as an encoder default. `f.password` forces
        // `access:"internal"`, so a stored public password column needs `access`
        // stated back explicitly even though `encodeField` treats it as the default.
        const full = recoverOptions(stored, context, false);
        if (full) {
          const restated = Object.fromEntries(
            Object.keys(bare)
              .filter((key) => Object.hasOwn(full, key))
              .map((key) => [key, (full as Record<string, unknown>)[key]]),
          );
          candidates.push({ ...opts, ...restated } as FieldOptions);
        }
      }

      for (const candidate of candidates) {
        const rest = optionsExpr(candidate);
        const args = rest.kind === "object" && rest.entries.length > 0 ? [rest] : [];
        const decoded = proven(call(`${ns}.${accessor}`, ...args), () => factory(candidate as never));
        if (decoded) return decoded;
      }
    }
  }

  // The catalog form did not reproduce the stored bytes — a constructor default
  // the recovered options did not account for. The descriptor literal bypasses
  // constructors entirely, so it still round-trips.
  ctx.problem(
    "value-fallback",
    `field "${stored.name}" (${stored.type}) emitted as a descriptor literal: ${lastRejection}`,
  );
  return descriptorLiteral();
}

/** Decode a stored field array to a named `FieldMap` object literal. */
export function decodeFieldMap(
  ctx: DecodeContext,
  refs: RefIndex,
  fields: readonly FieldXdo[],
  surface: FieldSurface,
  resolve: ResolveOptions = {},
  table = false,
): Expr {
  return obj(
    fields.map((field) => [
      field.name,
      ctx.at(`${surface === "input" ? "input" : "schema"}.${field.name}`, () =>
        decodeField(ctx, refs, field, surface, resolve, table && isPrimaryKey(field)).expr,
      ),
    ]),
  );
}

/** A table's top-level `id` column, which the table encoder treats as its primary key. */
function isPrimaryKey(field: FieldXdo): boolean {
  return field.name === "id";
}

/** A key a JS object enumerates before every string key, whatever order it was written in. */
const ARRAY_INDEX_KEY = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * A table's stored columns as its `schema`: the named map, or — when a column
 * name is an array index (`"123"`), which an object would move to the front —
 * the list form `[{ name, ...f.<type>() }]`, which keeps the stored order.
 */
export function decodeTableSchema(
  ctx: DecodeContext,
  refs: RefIndex,
  fields: readonly FieldXdo[],
  resolve: ResolveOptions = {},
): Expr {
  if (!fields.some((field) => ARRAY_INDEX_KEY.test(field.name) && Number(field.name) < 2 ** 32 - 1)) {
    return decodeFieldMap(ctx, refs, fields, "f", resolve, true);
  }
  return arr(
    fields.map((field) =>
      spread(
        ctx.at(`schema.${field.name}`, () =>
          decodeField(ctx, refs, field, "f", resolve, isPrimaryKey(field)).expr,
        ),
        [["name", lit(field.name)]],
      ),
    ),
  );
}

/**
 * Decode a stored `result[]` back to a `response` def.
 *
 * A single unnamed item is a bare value; named items form a record. An empty
 * list means the def declared no response at all, so the caller omits the key.
 */
export function decodeResponse(
  ctx: DecodeContext,
  stored: readonly ResultItemXdo[],
): Expr | undefined {
  if (stored.length === 0) return undefined;

  const asValue = (item: ResultItemXdo): TaggedValue => ({
    value: item.value,
    tag: item.tag,
    filters: item.filters ?? [],
  });

  // The engine's response builder DISCARDS some stored entries before they can
  // contribute anything: one that sets `disabled`, and one whose `name` is blank
  // when the list holds more than one entry (a blank name has nothing to key the
  // response object by). Dropping those is what lets the rest keep the readable
  // record form — they are editor exhaust, and carrying them cost whole
  // responses their decode.
  //
  // Order matters and mirrors the engine's: the `disabled` test comes BEFORE the
  // blank-name test, so a lone disabled entry is skipped rather than becoming
  // the bare value — the builder then accumulates nothing and the response is
  // null. That is why the bare-value case is read off the SURVIVORS below
  // instead of off the stored list.
  //
  // `_xsid` is deliberately NOT a trigger. It is an engine-generated editor id
  // on `normalize()`'s strip list, so it is not authored data and can never fail
  // verification — measured across the fixture corpus, 13 result items carry a
  // non-empty one. Treating it as unrepresentable (as this check first did)
  // would push nearly every real query onto the raw path.
  const live = stored.filter((item) => !isDeadResultItem(item, stored.length));
  if (live.length < stored.length) {
    const dropped = stored.length - live.length;
    ctx.problem(
      "expected-omission",
      `${dropped} response item${dropped === 1 ? " is" : "s are"} skipped by the engine — ` +
        `${dropped === 1 ? "it sets" : "they set"} \`disabled\`, or ${dropped === 1 ? "names" : "name"} ` +
        `nothing to key the response by — so ${dropped === 1 ? "it contributes" : "they contribute"} ` +
        `no value and ${dropped === 1 ? "is" : "are"} not carried across`,
    );
  }
  // Every survivor was dead: the engine builds no response at all from this list.
  if (live.length === 0) return undefined;
  if (live.length === 1 && live[0]!.name === "") return decodeValue(ctx, asValue(live[0]!));

  // The survivors form a RECORD, keyed by name. Two sharing a name still cannot
  // be carried — the engine keeps the LAST and the record would silently do the
  // same, so it stays verbatim rather than quietly dropping the shadowed one.
  const names = live.map((item) => item.name);
  if (new Set(names).size !== names.length || names.some((name) => name === "")) {
    ctx.use(CODEGEN_MODULE, "rawResponse");
    ctx.problem(
      "raw-fallback",
      `the response has ${live.length} live items whose names do not key it (blank or repeated), which the record form cannot carry; emitted verbatim via rawResponse()`,
    );
    return call("rawResponse", lit(stored));
  }

  return obj(
    live.map((item) => [item.name, ctx.at(`response.${item.name}`, () => decodeValue(ctx, asValue(item)))]),
  );
}

/** Re-exported so kind decoders share one structural comparison. */
export { deepEqual };
