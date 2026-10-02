/**
 * The shared tagged-value primitive. Every place a function references
 * data — input bindings, statement context, response — uses this `{value, tag,
 * filters}` shape. Built and tested once here, reused everywhere.
 */
import type { FilterXdo, TaggedValue, Tag } from "../types/xdo.js";
import type { QueryFilter } from "./generated/query-filters.generated.js";
import { TAGS } from "../types/xdo.js";
// The lambda-body guard, applied in `filter()` below. The cycle back to this
// module is deliberate and safe: `lambda.ts` reaches `c` only at call time.
import { assertLambdaFilterArgs } from "./lambda.js";
import { assertExpressionFilterArgs } from "./expression-arg.js";
import { assertEnumFilterArgs } from "./enum-arg.js";
// Imports only a leaf module, so this cannot cycle back here either.
import { describeEntry, protoKeyed } from "../statements/args.js";
import { withArticle } from "../util/article.js";
// Leaf module (no imports of its own), so this cannot cycle back here.

/** A Xano SDK authored value is just the stored tagged-value shape. */
export type Value = TaggedValue;

/**
 * A {@link Value} that also carries, **at the type level only**, the name of the
 * stack variable it references (`ref("user")` → `RefValue<"user">`). The `__ref`
 * carrier is phantom — never present at runtime — and required (not optional) so
 * `InferResponse`'s trace matches only real refs, never a plain `Value`.
 * Because it is a subtype of `Value`, every existing `ref(...)` use — filter
 * args, `db.query` `where`, response fields — keeps type-checking unchanged.
 */
export type RefValue<Name extends string = string> = Value & { readonly __ref: Name };

/**
 * An `auth(path)` read, carrying its path at the type level only (phantom
 * `__auth`) so `InferResponse` types it from a query's auth table row.
 */
export type AuthValue<Path extends string = string> = Value & { readonly __auth: Path };

/**
 * A {@link Value} whose tag has no object-literal form, so `obj()` refuses it
 * as a member — at the type level through this phantom `__notObjMember` carrier
 * (never present at runtime), and at runtime by the tag. Bind it with
 * `s.set_var` first and `ref()` the variable.
 */
export type NotObjMember<Tag extends string> = Value & { readonly __notObjMember: Tag };

/**
 * A `caught(path)` read, carrying its path at the type level only (phantom
 * `__caught`) so `InferResponse` types it: `code`, `message` and `name` are
 * strings, `result` is whatever payload was attached.
 */
export type CaughtValue<Path extends string = string> = NotObjMember<"trycatch"> & { readonly __caught: Path };

/** What `caught(path)` reads, at the type level. */
export type CaughtShape<Path extends string> = Path extends "code" | "message" | "name"
  ? string
  : Path extends ""
    ? { code: string; message: string; name: string; result: unknown }
    : unknown;

/**
 * A {@link Value} that carries, at the type level only, the input it reads
 * (`inp("email")` → `InpValue<"email">`), so `InferResponse` types it from the
 * def's declared `input` instead of `unknown`. Phantom, like `__ref`.
 */
export type InpValue<Name extends string = string> = Value & { readonly __inp: Name };

/**
 * A {@link Value} that has had a filter chain attached (`withFilters(...)`).
 * The `__filtered` carrier is phantom (type-only). A filter can reshape the
 * value arbitrarily at runtime — turn an object into a scalar, add or drop keys
 * — with no static signal, so `InferResponse` treats a filtered response value
 * as `unknown` (the honest floor, matching how the Xano engine degrades a
 * filtered result to `json`). Overriding via `responseShape` remains available.
 */
export type FilteredValue<
  Base = unknown,
  Chain extends readonly unknown[] = readonly unknown[],
> = Value & {
  readonly __filtered: true;
  /** Phantom: the value the chain was applied to, so its type can be folded. */
  readonly __base?: Base;
  /** Phantom: the flattened filter chain, in application order. */
  readonly __chain?: Chain;
};

/**
 * A {@link Value} built by {@link c.regex} — a PCRE pattern the engine can
 * actually run, delimiter-wrapped (`/…/flags`).
 *
 * The `__regex` carrier is phantom (type-only). It exists so a helper that takes
 * a pattern can SAY so in its signature (`function match(p: RegexValue)`) and so
 * an editor's hover distinguishes a pattern from the text beside it.
 *
 * It is deliberately NOT used to restrict `s.expect.to_match` or the `fl.regex_*`
 * pattern slot. A nominal restriction there
 * would have to reject `Value`, and `inp()`, `env()`, `auth()` and `sys.*` all
 * return exactly `Value` — the same type `c.text` does — so it would reject every
 * DYNAMIC pattern along with the broken constant ones. The enforcement is instead
 * a build-time refusal that inspects the value it was actually given
 * ({@link assertRegexPattern}), which fires on the bare constant and stays silent
 * on a reference it cannot see through.
 */
export type RegexValue = Value & { readonly __regex: true };

/** Flatten one level of `withFilters`'s spread-or-array argument list. */
export type FlattenFilters<Fs extends readonly unknown[]> = Fs extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends readonly unknown[]
    ? [...Head, ...FlattenFilters<Tail>]
    : [Head, ...FlattenFilters<Tail>]
  : [];

/**
 * A {@link Value} produced by {@link col} (or a filter chain built from one). The
 * `__col` carrier is phantom (type-only). It exists so a `col()` reference can be
 * *statically rejected* where it would silently fail at runtime: inside a
 * `db.edit`/`db.add` `row`, `{tag:"col"}` does not resolve to the row's stored
 * value — it evaluates to `null`, so a following `fl.add(1)` computes `null + 1`
 * and the engine aborts ("Numbers are required for mathematical operations").
 * `col()` is only meaningful in a `db.query` `where`/view expression.
 */
export type ColValue = Value & { readonly __col: true };

/**
 * The error branch surfaced when a tagged {@link Value} is nested inside a
 * `c.obj`/`c.array` literal. The long message is the *property key*
 * so TypeScript prints it verbatim in the "property … is missing" diagnostic; a
 * `Value` has no such key, so intersecting it here makes the offending position
 * fail to type-check. The runtime guard ({@link assertPlainJson}) carries the
 * same guidance for JS/`any`-typed callers the type can't reach.
 */
type TaggedValueNotAllowed = {
  "❌ c.obj/c.array take plain JSON only — a tagged value (inp/ref/auth/col/c.*) can't be nested. For a computed object response use a record of values: `response: { key: value }` (not c.obj).": never;
};

/**
 * Recursively reject any nested {@link Value} in a plain-JSON literal `T`. A
 * member assignable to `Value` maps to {@link TaggedValueNotAllowed}; plain JSON
 * (primitives, arrays, objects) passes through unchanged. Used intersected with
 * a naked `T` (`o: T & RejectValues<T>`) so `T` stays inferrable while the
 * rejection rides along. Structural `extends Value` detection — not a `JsonLiteral`
 * constraint — so it survives a future `TaggedValue` interface→alias refactor.
 */
type RejectValues<T> = T extends Value
  ? TaggedValueNotAllowed
  : T extends NotJson
    ? NotPlainJson
  : T extends readonly (infer E)[]
    ? readonly RejectValues<E>[]
    : T extends object
      ? { [K in keyof T]: RejectValues<T[K]> }
      : T;

/**
 * JS values `JSON.stringify` cannot carry faithfully: a function or symbol
 * vanishes (or reads `null` in a list), a bigint throws, a `Date` becomes a
 * string and a `Map`/`Set` becomes `{}`. Each is refused at the type level
 * here and at runtime by {@link assertPlainJson}.
 */
type NotJson =
  | ((...args: never[]) => unknown)
  | bigint
  | symbol
  | Date
  | RegExp
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | Promise<unknown>;

/** `c.obj([…])` — a list handed to the record constructor. Printed verbatim, like {@link TaggedValueNotAllowed}. */
type ListNotAllowed = {
  "❌ c.obj takes a { key: value } record — a list is c.array([ … ]).": never;
};

/** `c.obj`'s top-level rejection of a list; a record (or anything else) passes. */
type RejectList<T> = T extends readonly unknown[] ? ListNotAllowed : unknown;

/** The error branch for a {@link NotJson} member — printed verbatim, like {@link TaggedValueNotAllowed}. */
type NotPlainJson = {
  "❌ c.obj/c.array take plain JSON only — no functions, Dates, Maps/Sets, class instances, bigint or symbol values. Convert first: a Date to date.toISOString(), a Map to Object.fromEntries(map).": never;
};

/** Runtime-guard message. Context-neutral: `c.obj`/`c.array` are
 * general constant constructors, used well beyond responses. */
const REJECT_TAGGED_VALUE =
  "c.obj/c.array embed a plain JSON constant and cannot contain a tagged value " +
  "(inp/ref/auth/col/env/c.int/c.text/c.bool/…) — those serialize as internal " +
  "representation the engine can't decode. For a computed object response, use a " +
  "record of values — `response: { key: value }` — not `c.obj({ key: value })`. For a " +
  "request body (`s.api.request({ params })`) a tagged value is fine at the TOP LEVEL " +
  "of a plain object; nested, wrap the whole body in `obj({...})`, which encodes any " +
  "depth.";

/**
 * Shape check matching {@link Value}: a `{value, tag, filters}` object whose
 * `tag` is an actual {@link Tag}. Requiring a valid tag (not merely any string)
 * keeps the runtime guard in lockstep with the compile-time `extends Value`
 * check, so a plain-JSON literal that happens to use `tag`/`value`/`filters` as
 * keys with an unrecognized tag is not falsely rejected. Mirrors the `isValue`
 * predicate in `responses/response.ts`.
 *
 * Exported so `coerceObj` (the HTTP-request family's object field) can detect a
 * record-of-values with the *same* check `c.obj` rejects on — keeping the
 * "encode as object-of-values" runtime branch in lockstep with the `c.obj`
 * strict-constant guard.
 */
export function isTaggedValue(x: unknown): x is Value {
  return (
    // A trigger field accessor (`t.new`) is a *callable* Value — a function
    // carrying the `{value,tag,filters}` props — so `typeof` is "function", not
    // "object". Accept both, or a bare `t.new` slips past this check, falls
    // through coerceObj's record path, and trips the c.obj nested-value guard.
    (typeof x === "object" || typeof x === "function") &&
    x !== null &&
    "value" in x &&
    "filters" in x &&
    Array.isArray((x as { filters?: unknown }).filters) &&
    (TAGS as readonly string[]).includes((x as { tag?: unknown }).tag as string) &&
    // `{ a, __proto__: ref("v") }` inherits all three — a record, not `ref("v")`.
    !protoKeyed(x)
  );
}

/**
 * Throw if a tagged {@link Value} is nested anywhere in a `c.obj`/`c.array`
 * argument. The compile-time {@link RejectValues} type is the first
 * line of defense; this guard catches JS callers and `any`-typed values that
 * erase the type, failing loudly at construction instead of 500ing at runtime.
 *
 * Iterative, like the export-side walkers: the literal being crossed
 * is the author's, so its depth is theirs to choose, and a recursive form would
 * answer a deep one with a `RangeError` instead of the message above. Children
 * are pushed in reverse so the FIRST offending member in source order is the one
 * reported.
 */
function assertPlainJson(root: unknown, helper: "c.obj" | "c.array"): void {
  // `null` is an EXIT frame: the object it closes leaves the current path. Only
  // an object on the path from the root is a cycle — the same object reached
  // twice through two siblings is a shared value JSON stores twice, and fine.
  const stack: Array<[unknown, string] | [null, string, object]> = [[root, ""]];
  const onPath = new Map<object, string>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.length === 3) {
      onPath.delete(frame[2]);
      continue;
    }
    const [x, path] = frame;
    if (typeof x === "object" && x !== null) {
      const back = onPath.get(x);
      if (back !== undefined) {
        // Without this the walk never ended: a cyclic literal grew the stack
        // until the heap ran out.
        throw new Error(
          `${helper}: value at "${path}" refers back to itself (to ${back === "" ? "the argument" : `the value at "${back}"`}) — ` +
            `a cycle, which JSON cannot store. Pass a copy without the back-reference.`,
        );
      }
    }
    if (isTaggedValue(x)) {
      throw new Error(path === "" ? REJECT_TAGGED_VALUE : `${helper}: value at "${path}" is a tagged value. ${REJECT_TAGGED_VALUE}`);
    }
    const bad = notJson(x);
    if (bad !== undefined) {
      throw new Error(
        `${helper}: ${path === "" ? "the argument" : `value at "${path}"`} is ${bad} — ${helper}() stores plain JSON only ` +
          `(strings, finite numbers, booleans, null, lists and plain records). ` +
          `Convert it first: a Date to date.toISOString(), a Map to Object.fromEntries(map), a bigint to Number() or String().`,
      );
    }
    if (typeof x === "object" && x !== null) {
      onPath.set(x, path);
      stack.push([null, path, x]);
    }
    if (Array.isArray(x)) {
      for (let i = x.length - 1; i >= 0; i--) stack.push([x[i], `${path}[${i}]`]);
    } else if (typeof x === "object" && x !== null) {
      const entries = Object.entries(x);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        stack.push([v, joinPath(path, k)]);
      }
    }
  }
}

/**
 * @internal A list stored under the OBJECT tag — the bytes a list-valued record
 * argument (`coerceObj`) has always written. Not reachable as `c.obj([…])`,
 * which takes a record: an author's list is `c.array([…])`.
 */
export function objTaggedList(a: readonly unknown[]): Value {
  assertPlainJson(a, "c.obj");
  return val(JSON.stringify(a), "const:obj");
}

/** `a.b`, `a["b c"]`, `[0].id` — the member path an author reads back to their literal. */
function joinPath(path: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return path === "" ? key : `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

/**
 * What a non-JSON member is, or `undefined` for plain JSON. `undefined` itself
 * passes: an optional record key left `undefined` is dropped, the usual JS
 * reading of an absent key.
 */
function notJson(x: unknown): string | undefined {
  switch (typeof x) {
    case "function":
      return "a function";
    case "symbol":
      return "a symbol";
    case "bigint":
      return `a bigint (${String(x)}n)`;
    case "number":
      return Number.isFinite(x) ? undefined : `${String(x)}, which JSON cannot store`;
    case "object": {
      if (x === null || Array.isArray(x)) return undefined;
      const proto = Object.getPrototypeOf(x) as object | null;
      if (proto === null || proto === Object.prototype) return undefined;
      return protoKeyed(x) ? describeEntry(x) : describeInstance(x);
    }
    default:
      return undefined;
  }
}

/** `a Date`, `a Map`, `a Money instance` — a non-plain object named by its constructor. */
function describeInstance(x: object): string {
  const name = (x as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof name !== "string" || name === "") return "a class instance";
  const builtin = ["Date", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Promise", "Error"];
  if (builtin.includes(name)) return `a ${name}`;
  return `${withArticle(name)} instance`;
}

/** A decimal's string spelling: optional sign, digits with an optional point, optional exponent. */
const DECIMAL_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function val(value: string, tag: Tag, filters: FilterXdo[] = []): Value {
  return { value, tag, filters };
}

/**
 * A text constant in the stored form the engine reads back exactly.
 *
 * The engine evaluates a `const` value by re-reading it as a quoted literal, and
 * that reader misplaces the closing quote after two or more trailing
 * backslashes: `a\\` (a, two backslashes) answers `a\\\\"` (doubled, plus a
 * stray quote), and inside an object response the result is invalid JSON
 * (measured live). Such a value is stored as `const:encoded` instead — the
 * engine's own tag for a value written as its quoted literal — with the last
 * backslash spelled `\u005c`, so no backslash sits before the closing quote.
 * Every other text keeps the plain `const` form.
 */
function textConst(s: string): Value {
  // `c.text(null)` — the stored null form a pull spells — tests as "null" and stays `const`.
  return /\\\\$/.test(s) ? val(`(${JSON.stringify(s).slice(0, -3)}\\u005c")`, "const:encoded") : val(s, "const");
}

/**
 * A tagged value as the plain `{value, tag, filters}` object the bundle stores.
 *
 * A trigger field accessor (`t.new`, `t.action`, `t.toolset`, …) is a *callable*
 * Value — a function carrying the three props — so it can be both `t.new` and
 * `t.new("owner")`. Embedded as-is, it is a FUNCTION inside the stored tree, and
 * JSON writes a function in an array as `null` (and drops it from an object):
 * `fl.concat(t.action)` shipped `"arg":[null]`, typechecked, exported clean, and
 * broke the next pull. Every place a Value is nested into another — a filter
 * argument, an operand, a record member — takes it through here. A plain Value
 * is returned as-is (same object, byte-identical); anything that is not a
 * callable passes through for the caller's own shape check.
 */
export function toPlainValue<T>(v: T): T {
  if (typeof v !== "function") return v;
  const { value, tag, filters } = v as unknown as Value;
  if (typeof tag !== "string" || !Array.isArray(filters)) return v;
  return { value, tag, filters } as unknown as T;
}

/** A JSON object (not an array, not null) — the shape that takes `set` filters. */
function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Is this key spellable as a BARE `set` path segment — an identifier the
 * engine's path reader takes as a literal key and nothing else?
 *
 * Anything outside `[A-Za-z_][A-Za-z0-9_]*` gets the bracket form, because the
 * reader splits on `.` and `[`: `"a.b"` bare would nest (`{a:{b:…}}`) where the
 * literal key must stay flat. Digits are excluded because a numeric segment is
 * an INDEX to that reader, not because the bracket form changes that — see the
 * numeric-key note on {@link c.obj}.
 */
const BARE_SET_PATH = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `set` path segment for one object key — bare when it can be, otherwise the
 * engine's own bracket-and-quote escape, `["key"]`, which makes a key holding
 * any character spellable. Backslash is escaped BEFORE the quote so a key
 * ending in one cannot escape the closing quote and unterminate the segment.
 * {@link parseSetPath} in the codegen decoder is the exact inverse.
 */
function setPath(key: string): string {
  if (BARE_SET_PATH.test(key)) return key;
  return `["${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * Encode one member of a `c.obj` record as the `set` filter's value argument.
 * Nested records recurse (nested `{}`-plus-`set`, exactly what the editor
 * writes); arrays stay a JSON `const:array` — that form survives the engine's
 * tag reader intact, braces and all, because they sit inside the brackets.
 *
 * Members a JSON encoder would not carry are matched to what a JSON-string form
 * stores, so the two differ in FORM only: a non-finite
 * number becomes null exactly as `JSON.stringify` writes it (an engine that
 * read `"NaN"` as a decimal would get a number it cannot parse). An `undefined`
 * member is dropped one level up, in {@link objSetFilters}.
 */
function objMember(m: unknown): Value {
  if (isPlainRecord(m)) return val("{}", "const:obj", objSetFilters(m));
  if (Array.isArray(m)) return val(JSON.stringify(m), "const:array");
  if (m === null) return val("null", "const:null");
  if (typeof m === "boolean") return val(m ? "true" : "false", "const:bool");
  if (typeof m === "number") {
    if (!Number.isFinite(m)) return val("null", "const:null");
    // A magnitude past the safe-integer range only stringifies in exponent form
    // ("1e+21"), which is not an integer literal — carry it as a decimal, the
    // tag whose stored form is a string in the first place.
    return Number.isInteger(m) && Number.isSafeInteger(m)
      ? val(String(m), "const:int")
      : val(String(m), "const:decimal");
  }
  return textConst(String(m));
}

/**
 * A populated object constant as one `set` filter per key over an empty `{}`
 * base — the ONLY populated form the engine can read back.
 *
 * A statement's stored `{value, tag, filters}` is flattened to a single piped
 * string (`{}|set(!const "a",!const:int 1)`) before it is evaluated, and the
 * reader that splits that string back apart ends the value at the first
 * unquoted `}` or `,` outside brackets. So a populated JSON string —
 * `{"a":1}` — arrives truncated to `{"a":1`, fails to JSON-decode, and the
 * request dies with the engine's generic `ERROR_FATAL "Unable to decode."`,
 * which names neither the statement nor the value. `{}` alone is special-cased
 * by that reader, and each key's data rides inside a `set(...)` argument where
 * quoting protects it — which is why this form works and why the editor has
 * only ever written this one.
 */
function objSetFilters(o: Record<string, unknown>): FilterXdo[] {
  return (
    Object.entries(o)
      // An `undefined` member is not a null — `JSON.stringify` DROPS such a key,
      // and a key present as null is a different value at runtime (an `exists`
      // check flips). Dropping it keeps this a change of form only.
      .filter(([, m]) => m !== undefined)
      .map(([key, m]) => filter("set", val(setPath(key), "const"), objMember(m)))
  );
}

/** PCRE modifiers that also exist (and mean the same thing) as JS RegExp flags.
 * A `RegExp`'s `g`/`y`/`d` are JS-only — passing them to PHP `preg_*` raises
 * "Unknown modifier", so they are dropped when deriving flags from a RegExp. */
const PCRE_JS_FLAGS = "imsxu";

/** Escape any interior forward slash so a `/…/`-delimited literal stays valid
 * (`\d/\d` → `\d\/\d`). Backslash escapes are skipped so `\/` is never doubled. */
function escapeRegexSlashes(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      out += ch + (body[i + 1] ?? "");
      i++;
      continue;
    }
    out += ch === "/" ? "\\/" : ch;
  }
  return out;
}

/**
 * Emulate PHP's delimiter scan to decide whether a const string is a *valid*
 * PCRE literal (`/…/flags`, `~…~i`, `(…)`, …) — the check behind the {@link
 * withFilters} guard. The delimiter is the first char (must be non-alphanumeric,
 * non-backslash, non-whitespace); the pattern ends at the next *unescaped*
 * closing delimiter, after which only flag letters may follow. A bare JS-style
 * body (`^[^@\s]+$`, `[a-z]+`, `\d{2}`) fails this — exactly the input PHP rejects,
 * so the guard fires on the same strings the engine would silently no-match on.
 */
function isValidPcreLiteral(s: string): boolean {
  if (s.length < 2) return false;
  const d = s[0]!;
  if (/[a-zA-Z0-9\\\s]/.test(d)) return false;
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[d] ?? d;
  let i = 1;
  for (; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === close) break;
  }
  if (i >= s.length) return false;
  return /^[a-zA-Z]*$/.test(s.slice(i + 1));
}

/**
 * Refuse a BARE regex pattern where the engine needs a delimiter-wrapped one.
 *
 * The shared half of the {@link withFilters} guard and of
 * `s.expect.to_match`: both slots hand their value to PHP `preg_*`
 * as the PATTERN, and PHP reads the first character as the delimiter. A
 * `c.text("^Xano SDK.*Engine$")` therefore becomes the pattern `^Xano SDK.*Engine$`
 * delimited by `^` — or, in the to_match case a live engine reported, the quoted
 * `/"^Xano SDK.*Engine$"/` — and matches NOTHING for every input. An assertion
 * built on it fails against text that plainly matches; a precondition built on
 * it silently rejects every value.
 *
 * Fires only on a value this function can actually READ: an unfiltered `const`
 * literal. A `ref`/`inp`/`env` pattern, or one that has already been through a
 * filter chain, is left alone — the pattern is not visible here and refusing it
 * would be a guess. Returns the located message, or `null` when the value is
 * fine, so each caller can word its own throw.
 */
export function barePatternRefusal(value: Value): string | null {
  if (value.filters.length > 0 || value.tag !== "const") return null;
  if (isValidPcreLiteral(value.value)) return null;
  return (
    `${JSON.stringify(value.value)} is a BARE regex pattern. PHP \`preg_*\` reads the first ` +
    `character as the delimiter, so the engine matches nothing for every input — the assertion ` +
    `or precondition built on it fails (or passes) against text that plainly should not. Build ` +
    `it with c.regex(${JSON.stringify(value.value)}) instead of c.text(...), which wraps and ` +
    `escapes it into a valid PCRE literal`
  );
}

/**
 * The pattern-piped regex filters, each mapped to the ARGUMENT SLOT that holds
 * its subject — the text the pattern runs against.
 *
 * Two guards read this. The piped value is the PATTERN, so a bare (undelimited)
 * const there is the {@link withFilters} footgun; the named slot is the
 * SUBJECT, so a delimiter-wrapped pattern *there* is the operand pair written
 * backwards. Excludes `regex_quote`, whose piped value is raw text to be
 * escaped rather than a pattern.
 *
 * The index is the filter's own signature, not a convention: `regex_replace`
 * takes `(replacement, subject)`, so its subject is the SECOND argument, and a
 * guard that assumed slot 0 for the family would read its replacement text as
 * the subject. The three names with no catalog entry are reachable only through
 * the `filter("…")` escape hatch and follow `regex_test`'s single-argument shape.
 */
const REGEX_SUBJECT_SLOT: Readonly<Record<string, number>> = {
  regex_test: 0,
  regex_match: 0,
  regex_match_all: 0,
  regex_matches: 0,
  regex_replace: 1,
  regex_get_all_matches: 0,
  regex_get_first_match: 0,
};

const REGEX_PATTERN_FILTERS = new Set(Object.keys(REGEX_SUBJECT_SLOT));

/** Regex metacharacters — the evidence that a delimiter-wrapped const really is
 * a PATTERN and not text that merely has slashes around it. See
 * {@link reversedOperandRefusal} for why the {@link isValidPcreLiteral} scan
 * alone is not enough to accuse a subject. */
const REGEX_METACHARACTERS = /[\\^$.|?*+()[\]{}]/;

/**
 * The pattern text of a value that can be READ as one here — an unfiltered
 * `const` holding a valid PCRE literal, else `null`. The same boundary
 * {@link barePatternRefusal} draws: a
 * `ref`/`inp`/`env`, or anything already through a filter chain, is not
 * inspectable and is left alone.
 */
function readablePattern(value: TaggedValue | undefined): string | null {
  if (!value || value.tag !== "const") return null;
  if (Array.isArray(value.filters) && value.filters.length > 0) return null;
  return isValidPcreLiteral(value.value) ? value.value : null;
}

/**
 * Refuse a regex operand pair written BACKWARDS: the subject piped, the pattern
 * passed as the argument.
 *
 * The regex family is the one family that pipes its PATTERN — every other filter
 * pipes the subject (`withFilters(c.text(" hi "), fl.trim())`). So the reverse
 * order reads correctly as an English sentence, type-checks, and exports clean,
 * and then answers `false` for every input with HTTP 200. Which direction that
 * breaks in decides whether anyone notices: `if (!matches) reject` refuses every
 * legal value and is visible, while `if (matches) reject` permits every value it
 * exists to refuse and is not.
 *
 * The shape is legible in the bytes, because `c.regex` supplies the delimiters:
 * the argument slot holds `/^x1_[0-9]+$/` while the piped value does not look
 * like a pattern at all. Both halves are required before accusing:
 *
 * - The SUBJECT slot must hold a readable PCRE literal *carrying at least one
 *   regex metacharacter*. The delimiter scan alone would also match ordinary
 *   text like `c.text("/usr/")` — a legitimate subject — so the metacharacter is
 *   what separates a pattern from a path. A metacharacter-free pattern
 *   (`c.regex("abc")`) reversed is therefore missed; these guards fire on
 *   evidence, and a false refusal of correct code costs more than a miss.
 * - The PATTERN slot must NOT itself be a readable pattern. When it is, the
 *   order is already right and the argument is just subject text that looks like
 *   a regex — nothing to report.
 *
 * Returns the located message, or `null`; each caller words its own throw.
 */
export function reversedOperandRefusal(
  pattern: TaggedValue | undefined,
  subject: TaggedValue | undefined,
): string | null {
  const misplaced = readablePattern(subject);
  if (misplaced === null || !REGEX_METACHARACTERS.test(misplaced)) return null;
  if (readablePattern(pattern) !== null) return null;
  return (
    `the OPERANDS are reversed. ${JSON.stringify(misplaced)} is a delimiter-wrapped ` +
    `regex pattern sitting in the SUBJECT slot, which means the pattern and the text it ` +
    `tests were written the other way round. The regex family is pattern-piped — the piped ` +
    `value is the PATTERN and the argument is the text matched against it, the reverse of ` +
    `every other filter — so this runs the subject as a pattern and answers false for every ` +
    `input, with HTTP 200 and no error. Swap them: pipe the c.regex(...) pattern and pass ` +
    `the subject as the argument`
  );
}

/**
 * The same refusal, located in a whole value's filter CHAIN: the value is the
 * pattern, each pattern-piped filter's subject slot is a candidate subject.
 *
 * One reading for both callers. {@link withFilters} composes its result and asks
 * here, so the guard cannot drift from what is actually emitted; the export-time
 * diagnostic asks the same question of a value it did not build — a `rawValue`,
 * a decoded workspace, a hand-assembled envelope — which is the only way the
 * shape can still reach a bundle now that the build-time path refuses it.
 *
 * A filter that is not FIRST leaves the pattern un-inspectable (an earlier
 * filter may be building it), which is the same carve-out {@link
 * barePatternRefusal} makes for a filtered base.
 */
export function reversedRegexOperands(
  v: TaggedValue,
): { filter: string; slot: number; subject: string; message: string } | null {
  const chain = Array.isArray(v.filters) ? v.filters : [];
  for (const [i, applied] of chain.entries()) {
    const slot = (Object.hasOwn(REGEX_SUBJECT_SLOT, applied.name) ? REGEX_SUBJECT_SLOT[applied.name] : undefined);
    if (slot === undefined) continue;
    const pattern = { value: v.value, tag: v.tag, filters: chain.slice(0, i) };
    const message = reversedOperandRefusal(pattern, applied.arg?.[slot]);
    if (message !== null) {
      return { filter: applied.name, slot, subject: applied.arg?.[slot]?.value ?? "", message };
    }
  }
  return null;
}

/**
 * Tags {@link c.blank} can spell — the constant tags with no exact blank form of
 * their own.
 *
 * Derived by exclusion from {@link TAGS} rather than listed, so a constant tag
 * added to the catalog is blank-spellable without a second edit here. The two
 * carve-outs are the tags that already round-trip a blank exactly: `const` via
 * `c.text("")`, and `const:obj` via `c.obj(null)`.
 *
 * Reference tags are excluded by construction: a blank `var`/`input`/`col` is an
 * unbound reference, not an empty value, and the two want different fixes.
 */
export type BlankTag = Exclude<Extract<Tag, `const${string}`>, "const" | "const:obj">;

/**
 * Tags {@link c.null} can spell — the two the engine stores a `"null"` value
 * under. `const:null` is the plain one; `const:obj` is the object-typed null a
 * `db.*` statement's `@meta` slot carries.
 *
 * Listed rather than derived: a `"null"` value under any OTHER constant tag is
 * unobserved, and inventing spellings for it would offer an authoring form for
 * bytes no engine writes.
 */
export type NullTag = "const:null" | "const:obj";

/**
 * The stored spelling of an integer constant, guarding the `number` form.
 *
 * Xano stores integers as strings, so the string and `bigint` forms pass
 * through verbatim — that is what lets a value past `Number.MAX_SAFE_INTEGER`
 * round-trip at all. A `number` is only accepted where `String(n)` is
 * demonstrably the integer that was typed: `18446744073709551615` is already
 * `…616` by the time it is an argument, and stringifying it would write a
 * different number under the caller's nose.
 */
function intLiteral(n: number | bigint | string): string {
  if (typeof n === "bigint") return String(n);
  if (typeof n !== "number" && typeof n !== "string") {
    // Through `any`: `{}` printed as "[object Object]" and was offered to
    // `c.decimal`, which takes it no better.
    throw new Error(`c.int() takes an integer, got ${describeEntry(n)}.`);
  }
  if (typeof n === "string") {
    if (!/^[+-]?\d+$/.test(n)) {
      throw new Error(
        `c.int() takes an integer literal as a string (digits, optional sign), got ` +
          `${JSON.stringify(n)}. For a fractional number use c.decimal(), and for the ` +
          `editor's empty value box use c.blank("const:int").`,
      );
    }
    return n;
  }
  if (!Number.isInteger(n)) {
    throw new Error(
      `c.int() takes an integer, got ${n}. Use c.decimal(${n}) for a fractional number.`,
    );
  }
  if (!Number.isSafeInteger(n)) throw new Error(`c.int() was given ${lossyIntegerProblem(n)}`);
  return String(n);
}

const INT64_MAX = 9223372036854775807n;

/**
 * Why an integer past `Number.MAX_SAFE_INTEGER` cannot be taken as given: the
 * number literal was rounded before any code saw it, so the digits the author
 * wrote are gone — only they can supply them, as a string or a bigint literal.
 */
export function lossyIntegerProblem(n: number): string {
  const rounded = BigInt(n);
  const range = rounded > INT64_MAX || rounded < -INT64_MAX - 1n ? ", outside the 64-bit integer range" : "";
  return (
    `${n}, past Number.MAX_SAFE_INTEGER: a JavaScript number cannot hold it exactly, so the literal was ` +
    `rounded before reaching here (it now reads ${rounded}${range}). Write the exact digits you meant as a ` +
    `string or a bigint literal — c.int("<digits>") or c.int(<digits>n).`
  );
}

/**
 * A constant {@link Value} that also remembers the JavaScript type it resolves
 * to at runtime.
 *
 * Phantom and optional, so a `ConstValue<T>` IS a `Value` everywhere one is
 * expected and a plain `Value` is still assignable back — nothing about the
 * encoding changes, and no existing call site moves. What it buys is one thing:
 * `s.set_var("n", c.int(1))` can brand its binding, so a `ref("n")` in the
 * response resolves to `number` instead of bottoming out at `unknown`.
 *
 * Deliberately NOT carried by every constructor. `c.blank()` is the editor's
 * unconfigured value box and `c.expression()` is unparsed source — neither has a
 * type anything here could honestly claim, so both stay bare and keep the
 * `unknown` floor.
 */
export type ConstValue<T> = Value & { readonly __const?: T };

/** Constant constructors. Values always serialize as strings (per fixture). */
export const c = {
  /**
   * Plain string constant → `tag:"const"`.
   *
   * `null` is accepted alongside a string because the engine stores both: 47
   * values in the sweep are a bare `const` holding `null` rather than `""`,
   * mostly ignored statement-input entries the engine never reads. They are
   * distinct bytes — `normalize` keeps them apart, unlike the `const:obj` blanks
   * it does canonicalize — so a pull has to be able to spell the null form, and
   * `c.text(null)` did not type-check.
   *
   * Write `c.text("")` for an empty string. The null form is here so a pulled
   * workspace round-trips, not to be authored.
   */
  text<const S extends string | null>(s: S): ConstValue<S> {
    // Through `any`, a number or a record was stored as-is — a non-string in a
    // slot every reader treats as text.
    if (typeof s !== "string" && s !== null) {
      throw new Error(
        `c.text() takes a string, got ${describeEntry(s)}. ` +
          (typeof s === "number" ? `A number is c.int()/c.decimal(); as text it is c.text("${String(s)}").` : "A record is c.obj({ … }), a list c.array([ … ]).")
      );
    }
    return textConst(s as string);
  },
  /**
   * Integer constant → `tag:"const:int"`, value stringified (e.g. `"123"`).
   *
   * Pass a **string** or `bigint` for an integer outside JavaScript's safe
   * range: `c.int("9223372036854775807")` is exact, where the number literal
   * for it silently rounds. The engine's integers are signed 64-bit and it
   * clamps a value past that range with no error, so the export warns on one
   * (`value.int-out-of-range`); the string form still stores the digits as
   * written, which a pulled workspace relies on.
   *
   * A `number` that is not an integer, or is past `Number.MAX_SAFE_INTEGER`,
   * **throws**: by the time such a literal reaches here its precision is already
   * gone, so encoding it would write a value the caller did not type. The throw
   * names the string form.
   */
  int(n: number | bigint | string): ConstValue<number> {
    return val(intLiteral(n), "const:int");
  },
  /**
   * Decimal constant → `tag:"const:decimal"`.
   *
   * Pass a **string** to preserve a stored spelling a number literal cannot
   * reproduce — `c.decimal("10.00")` keeps its trailing zeros, where
   * `c.decimal(10)` writes `"10"`. The engine stores decimals as strings either
   * way, so this is exactness rather than a workaround; prefer the number form
   * whenever it reproduces the value you want.
   */
  decimal(n: number | string): ConstValue<number> {
    if ((typeof n !== "number" && typeof n !== "string") || (typeof n === "number" && !Number.isFinite(n))) {
      throw new Error(`c.decimal() takes a finite number (or its string spelling), got ${describeEntry(n)}.`);
    }
    // The string form is for an exact stored spelling (`"10.00"`), not for any
    // string: `"abc"`, `""` and `"NaN"` were stored as decimals no reader can
    // take. The editor's empty box is `c.blank("const:decimal")`.
    if (typeof n === "string" && !DECIMAL_LITERAL.test(n)) {
      throw new Error(
        `c.decimal() takes a number, or a decimal literal as a string (digits, optional sign, ` +
          `point and exponent), got ${JSON.stringify(n)}. For the editor's empty value box use ` +
          `c.blank("const:decimal").`,
      );
    }
    return val(String(n), "const:decimal");
  },
  /**
   * The editor's **unconfigured value box** — a value cell added and never
   * filled in, stored as `{value: "", tag}`.
   *
   * This is not a zero, an empty string, or an empty collection. The engine
   * reads `""` and `"0"` differently, so `c.blank("const:int")` and `c.int(0)`
   * are different stored values and the SDK will not canonicalize one into the
   * other. It exists because 13 real values in the survey corpus are in this
   * state and had no authoring form, so a pull emitted them as annotated
   * literals with a warning attached — describing a workspace that was fine.
   *
   * Constant tags only. A blank `var` or `input` is an unbound REFERENCE, which
   * is a different defect with a different fix, and is deliberately not
   * spellable here. `const` and `const:obj` are excluded too: they already have
   * exact blank forms in `c.text("")` and `c.obj(null)`, and a second spelling
   * for the same bytes is how two constructors start disagreeing.
   */
  blank(tag: BlankTag): Value {
    // Through `any`, `c.blank("const:nope")` stored a tag no engine reads.
    if (typeof tag !== "string" || !tag.startsWith("const:") || (tag as string) === "const:obj" || !(TAGS as readonly string[]).includes(tag)) {
      throw new Error(
        `c.blank() takes a constant tag with a blank form — "const:int", "const:decimal", "const:bool", … — got ${describeEntry(tag)}. ` +
          `A blank text is c.text(""), a blank object c.obj(null).`,
      );
    }
    return val("", tag);
  },
  /** Boolean constant → `"true"`/`"false"` with `tag:"const:bool"`. */
  bool<const B extends boolean>(b: B): ConstValue<B> {
    // Truthiness stored `c.bool("false")` as TRUE. The two spellings a string
    // can mean are read as what they say; anything else is refused.
    if (typeof b === "string" && (b === "true" || b === "false")) return val(b, "const:bool");
    if (typeof b !== "boolean") {
      throw new Error(`c.bool() takes true or false, got ${describeEntry(b)}.`);
    }
    return val(b ? "true" : "false", "const:bool");
  },
  /**
   * Null constant → value `"null"` (per engine fixture).
   *
   * Bare `c.null()` is the plain `const:null`. Pass a tag for the **object-typed
   * null** the engine writes into a `db.*` statement's `@meta` slot —
   * `c.null("const:obj")` → `{tag:"const:obj", value:"null"}`, 16 of them across
   * eight ordinary queries in the survey corpus, which had no spelling and came
   * back as `rawValue`.
   *
   * ⚠ Not the same bytes as `c.obj(null)`, which is the BLANK object
   * (`value: ""`). Both evaluate to null — the engine JSON-decodes the stored
   * string and `""` and `"null"` both decode to it — but they are two stored
   * spellings, and the SDK writes back the one it was given rather than
   * re-pointing a pulled workspace at the other.
   */
  null(tag: NullTag = "const:null"): ConstValue<null> {
    // Through `any`, `c.null(5)` stored `5` as the tag.
    if (tag !== "const:null" && tag !== "const:obj") {
      throw new Error(`c.null() takes no argument, or the tag "const:obj" for an object-typed null — got ${describeEntry(tag)}.`);
    }
    return val("null", tag);
  },
  /**
   * Build a **regex pattern value** for the pattern-piped regex filters
   * (`fl.regex_test`/`regex_match`/`regex_replace`/…). Xano runs PHP `preg_*`, so
   * the pattern MUST be delimiter-wrapped — a bare `c.text("^…$")` is an invalid
   * PCRE and the filter then matches *nothing* for every input, so a precondition
   * built on it silently rejects all values. This wraps the raw
   * pattern in `/…/`, escapes any interior `/`, and appends `flags`, so the result
   * is always valid; `withFilters` rejects a bare `c.text` pattern and points here.
   *
   * Pass a JS `RegExp` (source + flags used directly, minus JS-only `g`/`y`/`d`):
   * `c.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/i)`, or a raw body + optional PCRE flags:
   * `c.regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "i")`. The pattern is the piped
   * value; the filter's `subject` arg is the text tested against it.
   */
  regex(pattern: string | RegExp, flags?: string): RegexValue {
    if (typeof pattern !== "string" && !(pattern instanceof RegExp)) {
      throw new Error(`c.regex() takes a pattern string or a RegExp — got ${describeEntry(pattern)}.`);
    }
    // `null` is the absent flags argument; anything else must be a string.
    if (flags === null) flags = undefined;
    if (flags !== undefined && typeof flags !== "string") {
      throw new Error(`c.regex: flags must be letters (e.g. "i", "im"), got ${describeEntry(flags)}.`);
    }
    const body = typeof pattern === "string" ? pattern : pattern.source;
    const raw =
      flags ??
      (typeof pattern === "string"
        ? ""
        : [...pattern.flags].filter((ch) => PCRE_JS_FLAGS.includes(ch)).join(""));
    if (!/^[a-zA-Z]*$/.test(raw)) {
      throw new Error(`c.regex: flags must be letters (e.g. "i", "im"), got ${JSON.stringify(raw)}`);
    }
    return val(`/${escapeRegexSlashes(body)}/${raw}`, "const") as RegexValue;
  },
  /**
   * Current time as an **epoch-milliseconds** value — the engine's native
   * `const:epochms` constant. Xano has no `$now` *setting*, so this lives on
   * `c.*` (a current-time literal) rather than {@link sys} (which emits
   * `setting("$…")` and would reference a dead `$now` var).
   *
   * Emits `{tag:"const:epochms", value:"now"}` — an UNFILTERED value, valid
   * inline as a `where`/`cmp` operand. The equivalent `text("now") |to_epoch_ms`
   * chain evaluates to the same epoch-ms number on a live engine, and both
   * persist verbatim, but the native tag is what the editor writes and needs no
   * filter to get there. Chain math onto it as usual:
   * `withFilters(c.now(), fl.epochms_add_ms(c.int(-maxAgeMs)))`.
   *
   * Inside an `obj()` the tag is flattened into an expression string, where the
   * identifier `now` alone is the STRING "now" — so `obj()` writes the
   * `now|to_epochms` coercion that restores this tag's meaning. A `c.now()` used
   * as a FILTER ARGUMENT there is refused: the coercion cannot be written in
   * that position. Hoist it with `s.set_var` and `ref()` it.
   */
  now(): ConstValue<number> {
    return val("now", "const:epochms");
  },
  /**
   * Object constant → JSON-string value with `tag:"const:obj"`. Takes **plain
   * JSON literals only**: nesting a tagged value (`inp`/`ref`/`auth`/`c.*`) is a
   * compile error and throws at runtime — it would serialize as internal
   * representation the engine can't decode. For a computed/multi-key object
   * response use a record of values (`response: { key: value }`), not `c.obj`.
   *
   * Called with no argument it is the **empty object**, `{}` — the same default
   * the editor gives a new object variable, and the only empty form current
   * editors write.
   *
   * Called with an explicit `null` it is the **blank** form (stored `value: ""`),
   * which the engine evaluates to `null` rather than `{}` — it JSON-decodes the
   * stored string, and decoding `""` yields null. That is a real difference in
   * what the statement sees, so the two are separate spellings rather than one
   * "empty object": `c.obj()` is `{}`, `c.obj(null)` is null.
   *
   * ⚠ **Prefer `c.obj()`.** The blank form is legacy — no current editor path
   * writes it — and it exists here so a pulled workspace round-trips to the
   * same bytes instead of being quietly re-pointed at `{}`.
   *
   * A **populated** object is stored the way the editor stores one: an empty
   * `{}` base carrying one `set` filter per key. It is NOT a
   * populated JSON string — that form fails the request at runtime, see
   * {@link objSetFilters}.
   *
   * ⚠ **Zero-based numeric keys come back as a LIST**, not an object:
   * `c.obj({ "0": "a" })` evaluates to `["a"]`. That is the engine's data model
   * — a numeric key IS an index there, and the same object decoded from JSON
   * anywhere else behaves identically — not something this encoding introduces.
   * A non-zero-based numeric key (`{ "2": … }`) survives as a key. Live-verified.
   * `export()` warns `value.obj-zero-based-numeric-keys` on the def that carries one.
   */
  obj<const T>(o?: (T & RejectValues<T> & RejectList<T>) | null): ConstValue<T> {
    // Explicit `null` is the blank form, and is NOT the same as no argument:
    // `c.obj()` writes `{}`. Checked before the `??` below, which would
    // otherwise fold the two together.
    if (o === null) return val("", "const:obj");
    const j = (o ?? {}) as unknown;
    // A record only. Through `any`, a function stored no value at all and a
    // bare scalar was stored as an object constant holding a number; a list
    // was stored as an OBJECT constant holding one, where `c.array` is the list.
    if (typeof j !== "object" || Array.isArray(j)) {
      throw new Error(
        `c.obj() takes a { key: value } record of plain JSON — got ${describeEntry(j)}. ` +
          `A number is c.int()/c.decimal(), text c.text(), a list c.array([ … ]).`,
      );
    }
    assertPlainJson(j, "c.obj");
    // Only a RECORD takes the `{}`-plus-`set` form. Anything else keeps the
    // JSON string: brackets and quotes shield those from the tag reader that
    // truncates a bare `}` — see {@link objSetFilters}.
    if (!isPlainRecord(j)) return val(JSON.stringify(j), "const:obj");
    return val("{}", "const:obj", objSetFilters(j));
  },
  /**
   * Array constant → JSON-string value with `tag:"const:array"`. Takes **plain
   * JSON literals only** — like {@link obj}, a nested tagged value is a compile
   * error and throws at runtime.
   */
  array<const T extends readonly unknown[]>(a: T & RejectValues<T>): ConstValue<T> {
    // Through `any`, `42`, `null`, `{}` and `"x"` were each stored as a
    // `const:array` holding something that is not a list.
    if (!Array.isArray(a)) {
      throw new Error(
        `c.array() takes a list of plain JSON — got ${describeEntry(a)}. ` +
          `A record is c.obj({ … }), an empty list c.array([]).`,
      );
    }
    assertPlainJson(a, "c.array");
    return val(JSON.stringify(a), "const:array");
  },
  /**
   * A **Xano Expression Engine** expression, passed through verbatim →
   * `tag:"const:expr2"`. The string IS the expression, exactly as it would be
   * typed into the expression editor:
   *
   *   c.expression('"Hello, " ~ $input.name')
   *   c.expression("$var.price * $var.qty")
   *   c.expression("{ id: $var.user.id, tier: $var.plan }")
   *
   * ⚠️ **THE STRING IS NOT VALIDATED.** Xano SDK does not parse it, does not
   * type-check it, and cannot tell a working expression from a typo — the whole
   * string is handed to the engine as-is. Nothing here participates in
   * `InferResponse`, so a var referenced inside it is invisible to the type
   * system, and a rename that updates every typed `ref()` will NOT update this.
   * A malformed expression surfaces at RUNTIME, and one that is merely wrong
   * (`$var.tota1`) surfaces as a wrong answer, not an error. Play at your own
   * risk until validation exists.
   *
   * Prefer the typed surfaces whenever they cover the case: `ref`/`inp`/`col`
   * for references, `withFilters(..., fl.*)` for transforms, {@link obj} for a
   * dynamic object (it BUILDS a checked expression for you). Reach for this only
   * for expression-engine syntax the typed surfaces cannot express — string
   * concatenation with `~`, inline arithmetic, conditionals.
   *
   * NOT the `expr()` condition builder. `expr(col("id"), "=", inp("id"))` builds
   * a comparison for a `where`; this builds a VALUE from raw expression source.
   */
  expression(source: string): Value {
    assertExpressionSource(source, "c.expression");
    return val(source, "const:expr2");
  },
  /**
   * The **older** expression form → `tag:"const:expr"`, kept because real
   * workspaces still hold values stored that way and codegen has to bring them
   * back as something readable. New code wants {@link expression}, which is what
   * the expression editor writes today.
   *
   * ⚠️ Unvalidated passthrough, exactly like {@link expression} — see the
   * warning there. This one additionally uses the older syntax generation, so an
   * expression copied out of the current editor may not mean the same thing
   * here.
   */
  expressionLegacy(source: string): Value {
    assertExpressionSource(source, "c.expressionLegacy");
    return val(source, "const:expr");
  },
};

/**
 * Guard the two raw-expression constructors.
 *
 * The type signature already says `string`, but the failure this catches is the
 * one the type system cannot: `c.expression` sits one keystroke from `expr()`,
 * the condition builder, and a caller reaching for the wrong one passes a
 * `Value` or a comparison. Silently stringifying that would ship `[object
 * Object]` into an expression the engine evaluates at runtime, so it throws
 * here, pointing at the surface that was actually wanted.
 */
function assertExpressionSource(source: string, fn: string): void {
  if (typeof source !== "string") {
    const tagged = isTaggedValue(source);
    throw new Error(
      `${fn}() takes the expression SOURCE as a string, got ${tagged ? "a Value" : describeEntry(source)}. ` +
        (tagged
          ? `To reference a value inside an expression, write its path into the string ` +
            `(e.g. ${fn}("$var.total * 2")). For a comparison in a where/condition use ` +
            `expr(left, op, right) or cmp(...), not ${fn}().`
          : `Pass expression-engine source, e.g. ${fn}('"Hi, " ~ $input.name').`),
    );
  }
  if (source === "") {
    throw new Error(
      `${fn}() was given an empty string, which the engine cannot evaluate. ` +
        `Pass expression source, or use c.text("") for an empty string constant.`,
    );
  }
}

/** Options for {@link ref}. */
export interface RefOptions {
  /**
   * Null-safe nested access (opt-in). A dotted `ref("owner.user_id")` normally
   * compiles to the raw var path `$owner.user_id`, which the engine resolves in
   * a single lookup — so when the base var `owner` is null (e.g. a `db.get` that
   * matched no row), it raises a runtime `ERROR_FATAL` "Unable to locate var"
   * (HTTP 500) instead of yielding null.
   *
   * With `safe: true` the path compiles through the `get` filter
   * (`$owner|get:"user_id"`), which walks the remaining path and resolves to
   * null when the base is null — so an ownership/existence guard evaluates to
   * `false` cleanly rather than throwing. Has no effect on a plain, dot-free name
   * (a bare var already resolves to null without error).
   */
  safe?: boolean;
}

/**
 * Reference a **stack variable** — the `as:` output of an earlier statement:
 * `{tag:"var", value}`. e.g. `dbGet({ ..., as: "user" })` then `ref("user")`.
 *
 * Pass `{ safe: true }` to make a *nested* path null-safe: `ref("owner.user_id",
 * { safe: true })` resolves to null instead of 500ing when the base `owner` is
 * null — the intent-revealing opt-in for drilling into a `db.get`
 * result that may not exist.
 *
 * Picking a reference helper (these are easy to mix up):
 * - {@link ref} — a stack variable (`as:` output). **Not** a foreign key — that's
 *   the field constructor `f.tableRef`.
 * - {@link inp} — an endpoint/function `input`.
 * - {@link col} — a table column (in a `db.query` `where`/view comparison).
 * - {@link auth} — the authenticated caller (`auth("id")`).
 * - `c.*` — a literal constant (`c.int(1)`, `c.text("x")`).
 */
export function ref<const Name extends string>(name: Name, opts?: RefOptions): RefValue<Name> {
  assertRefName("ref", name, "the variable name");
  assertNamed("ref", name, "the variable to read, e.g. ref(\"total\")");
  const dot = name.indexOf(".");
  if (opts?.safe && dot !== -1) {
    // Compile `owner.user_id` → `$owner|get:"user_id"`: reference the base var
    // (which exists and may be null) and let the `get` filter walk the rest of
    // the path, resolving to null instead of raising when the base is null.
    const base = name.slice(0, dot);
    const path = name.slice(dot + 1);
    return withFilters(val(base, "var"), filter("get", c.text(path), c.null())) as unknown as RefValue<Name>;
  }
  // `__ref` is a phantom (type-only) carrier — the runtime object is exactly the
  // plain `{value, tag, filters}` Value; the cast attaches the name to the type.
  return val(name, "var") as RefValue<Name>;
}

/**
 * The second parameter every non-`ref` reference creator declares, so that
 * passing `{ safe: true }` to one is a COMPILE error whose expected type is the
 * explanation.
 *
 * `safe` was silently dropped before this: the creators took one parameter, so
 * JavaScript discarded the extra argument and TypeScript never saw it. An
 * author who wrote `inp("owner.id", { safe: true })` believed they had a
 * null-safe drill and still got a 500 on a null base.
 */
export type SafeIsRefOnly = "`safe` is only valid on ref()";

/**
 * Refuse the dropped-option call at runtime, for the JavaScript and `as any`
 * callers {@link SafeIsRefOnly} cannot reach.
 *
 * Refusing rather than IMPLEMENTING `safe` here is deliberate. `ref`'s safe
 * drill wraps a `get` filter around a `var` base, and whether that same wrapping
 * resolves correctly against an `input`/`auth`/`output` base is unverified
 * against the engine. Refusing states something true; implementing would ship a
 * second unverified claim onto the surface.
 */
function assertNoRefOptions(creator: string, opts: unknown): void {
  if (opts === undefined) return;
  const safe = typeof opts === "object" && opts !== null && "safe" in opts;
  throw new Error(
    `${creator}() takes only a name — ${safe ? "`safe`" : "a second argument"} is a ref() option ` +
      `and would be silently dropped here. Null-safe drilling into a ` +
      `dotted path is implemented on ref() alone: \`ref("owner.id", { safe: true })\` compiles to ` +
      `\`$owner|get:"id"\`, which yields null instead of 500ing when the base is null. To drill ` +
      `safely from ${creator}(), bind it to a variable first (\`s.set_var\`) and ref() that.`,
  );
}

/**
 * Refuse a reference name that is not a string. Through `any` or untyped
 * JavaScript, `ref(null)` reached `name.indexOf` and reported a raw TypeError,
 * and `inp(7)` stored a reference to nothing. `what` is how the helper names its
 * argument ("the variable name", "the input name", …).
 */
function assertRefName(creator: string, name: unknown, what: string): void {
  if (typeof name === "string") return;
  throw new Error(`${creator}() takes ${what} as a string — got ${describeEntry(name)}.`);
}

/**
 * An empty name reads nothing: `ref("")` and `env("")` were stored and resolved
 * to null at runtime. (`inp("")` is NOT refused — the bare input reference is
 * the whole input object, `$input`, a real reading.)
 */
function assertNamed(creator: string, name: string, what: string): void {
  if (name === "") throw new Error(`${creator}() was given an empty name — pass ${what}.`);
}

/**
 * A path argument with a `""` default (`auth()`, `resp()`, `caught()`): `null`
 * is the absent path, anything else must be a string.
 */
function refPath(creator: string, path: unknown): string {
  if (path === undefined || path === null) return "";
  assertRefName(creator, path, "a dotted path");
  return path as string;
}

/**
 * Reference a function/endpoint **input**: `{tag:"input", value}`. See {@link ref} for the full picker.
 * `inp("")` is the whole input object (`$input`).
 */
export function inp<const Name extends string>(name: Name, opts?: SafeIsRefOnly): InpValue<Name> {
  assertRefName("inp", name, "the input name");
  assertNoRefOptions("inp", opts);
  return val(name, "input") as InpValue<Name>;
}

/**
 * Reference a table **column**: `{tag:"col", value}` (used in `db.query` `where` +
 * table views). See {@link ref} for the full picker. The return is branded
 * {@link ColValue} so it is a *compile error* to pass `col()` into a `db.edit`/
 * `db.add` `row` — where it would resolve to `null` at runtime. Outside a
 * `db.*` statement's where/sort/eval (a condition, a `set_var`, a response) the
 * engine reads it as the column's NAME, so export refuses it there.
 */
export function col(name: string, opts?: SafeIsRefOnly): ColValue {
  assertRefName("col", name, "the column name");
  assertNoRefOptions("col", opts);
  return val(name, "col") as ColValue;
}

/**
 * Reference the authenticated identity (`{tag:"auth", value}`). Pass a path to
 * drill into the auth record — `auth("id")` is the authenticated row id
 * (Xano's `$auth.id`); bare `auth()` is the whole record. Use it to bind the
 * caller into a row write on an authenticated endpoint (one whose `auth` names
 * an auth table), e.g.
 * `s.db.add({ table: post, row: { author_id: auth("id") } })`.
 */
export function auth<const P extends string = "">(path: P = "" as P, opts?: SafeIsRefOnly): AuthValue<P> {
  assertNoRefOptions("auth", opts);
  return val(refPath("auth", path), "auth") as AuthValue<P>;
}

/**
 * Drill a dotted path onto a base reference, one segment at a time, using the
 * engine's own bracket escape for any segment that is not a bare identifier
 * (`a.b` → `base.a.b`, `a-b` → `base["a-b"]`). Shares {@link setPath} with the
 * `set`-filter encoder, so the two spellings cannot drift.
 */
function drill(base: string, path: string): string {
  if (path === "") return base;
  return path
    .split(".")
    .reduce((out, seg) => (BARE_SET_PATH.test(seg) ? `${out}.${seg}` : out + setPath(seg)), base);
}

/**
 * Reference the RESPONSE of the object under test (`{tag:"response", value}`) —
 * the subject nearly every unit-test assertion is written against.
 *
 * Bare `resp()` is the whole response (stored as the literal `"response"`, which
 * is what the editor writes); a path drills into it, `resp("id")` →
 * `"response.id"`. A segment that is not a bare identifier takes the engine's
 * bracket escape, so `resp("user-data")` → `response["user-data"]`.
 *
 * Meaningful only inside a `tests` entry's `expect` list. It is NOT a stack
 * variable: a running stack has no response yet, which is why `ref` cannot
 * spell this and why the engine gives it its own tag.
 */
export function resp(path = "", opts?: SafeIsRefOnly): NotObjMember<"response"> {
  assertNoRefOptions("resp", opts);
  return val(drill("response", refPath("resp", path)), "response") as NotObjMember<"response">;
}

/**
 * The four fields the engine binds in a `s.try_catch` catch arm. Read straight
 * off the engine's own catch-variable map, which sets exactly these.
 */
export type CaughtField = "code" | "message" | "name" | "result";

/**
 * Read the caught error inside a {@link s.try_catch} **catch** arm
 * (`{tag:"trycatch", value}` — XanoScript's `$trycatch.*`).
 *
 * Only valid inside the catch arm; the engine binds these for that scope alone
 * and they read empty anywhere else. The four fields are all the engine sets:
 * - `name` — the error name/type (for a thrown error statement, its message)
 * - `message` — the human-readable message (`"Throw Error Statement"` for a throw)
 * - `code` — the mapped HTTP-ish error code
 * - `result` — the error payload, when one was attached
 *
 * e.g. `s.try_catch({ try: [...], catch: [s.debug_log(caught("message"))] })`.
 * Bare `caught()` is the whole error record.
 */
export function caught<const P extends CaughtField | "" = "">(path?: P, opts?: SafeIsRefOnly): CaughtValue<P> {
  assertNoRefOptions("caught", opts);
  return val(refPath("caught", path ?? ""), "trycatch") as CaughtValue<P>;
}

/**
 * The toolset-scoped bindings, as the engine sets them.
 *
 * Both statements that populate the namespace write exactly two members —
 * `token` (the calling URL's token, null when the call carried none) and
 * `params` (the URL's parameters, an empty object when there were none). A
 * dotted `params.<key>` reads one parameter: the lookup walks the stored map,
 * so a path into `params` resolves the same way `ref("a.b")` does.
 *
 * Closed at the root deliberately — a name outside it resolves to empty rather
 * than raising, so a typo would read as a silent null at runtime.
 */
export type ToolsetPath = "token" | "params" | `params.${string}`;

/** Whether `value` is a path {@link toolset} accepts. Used by the decoder, which
 * must not emit a call the authoring type would reject — a pulled workspace has
 * to type-check. */
export function isToolsetPath(value: string): value is ToolsetPath {
  return value === "token" || value === "params" || value.startsWith("params.");
}

/**
 * Read a **toolset-scoped binding** inside an agent/MCP tool
 * (`{tag:"toolset", value}`) — the token and URL parameters the toolset was
 * called with, alongside {@link ref}/{@link inp}/{@link env}/{@link auth}.
 *
 * - `toolset("token")` — the token on the calling URL, null when absent.
 * - `toolset("params")` — the URL parameters as an object.
 * - `toolset("params.tenant")` — one parameter out of that object.
 *
 * Only bound while a tool runs under its toolset; anywhere else it reads empty.
 */
export function toolset(path: ToolsetPath, opts?: SafeIsRefOnly): NotObjMember<"toolset"> {
  assertRefName("toolset", path, "a path (\"token\", \"params\" or \"params.<name>\")");
  assertNoRefOptions("toolset", opts);
  return val(path, "toolset") as NotObjMember<"toolset">;
}

/**
 * Read a **workspace environment variable** — the ones set via `workspaceConfig({ env })`
 * or the workspace dashboard, e.g. `env("STRIPE_KEY")` → `$env.STRIPE_KEY`.
 *
 * Under the hood a workspace env var is a `{tag:"setting", value:"NAME"}` (the plain,
 * non-`$` name) — `$env.NAME` in XanoScript is sugar for that setting. This is the SAME
 * tag the built-in request/system vars use; those just carry a `$`-prefixed name
 * (`$env.$remote_ip`). So `env("remote_ip")` reads a *user* var literally named
 * `remote_ip` (usually unset → null), NOT the caller IP — use {@link sys} (`sys.remoteIp()`)
 * or {@link setting} with the exact `$`-prefixed name for the built-ins.
 *
 * (`$env.NAME` is a setting, not the raw `tag:"env"` form — which does not resolve
 * workspace vars — so this reads them as settings, matching the platform.)
 */
export function env(name: string, opts?: SafeIsRefOnly): Value {
  assertRefName("env", name, "the environment variable name");
  assertNamed("env", name, "the environment variable to read, e.g. env(\"STRIPE_KEY\")");
  assertNoRefOptions("env", opts);
  return val(name, "setting");
}

/**
 * Reference a workspace setting by raw name (`{tag:"setting", value}`). The built-in
 * request/system variables are settings with a **`$`-prefixed** name — `setting("$remote_ip")`,
 * `setting("$datasource")`, etc. Prefer the typed {@link sys} accessors, which spell the
 * names for you and avoid the `$`-prefix footgun; drop to `setting()` only for a name `sys`
 * doesn't cover.
 */
export function setting(name: string, opts?: SafeIsRefOnly): Value {
  assertRefName("setting", name, "the setting name");
  assertNamed("setting", name, "the setting to read, e.g. setting(\"$remote_ip\")");
  assertNoRefOptions("setting", opts);
  return val(name, "setting");
}

/**
 * Built-in **system / request-context variables**. In XanoScript these are written
 * `$env.$remote_ip`, `$env.$datasource`, … — note the second `$`: they are *settings*
 * (`{tag:"setting", value:"$remote_ip"}`), distinct from the user-defined env vars that
 * {@link env} reaches. Reaching for `env("remote_ip")` silently reads the wrong thing;
 * these accessors emit the correct `setting("$…")` form so you never type the `$` prefix.
 *
 * The one that matters most: a **public** endpoint has no caller identity, so `auth("id")`
 * does not resolve there — the
 * request FAILS with a 403 rather than degrading to one shared bucket, so key a rate limit
 * off {@link sys.remoteIp} instead —
 * `withFilters(c.text("rl:apply:"), fl.concat(sys.remoteIp()))`.
 *
 * Mirrors the full workspace "environment" panel; every accessor returns a {@link Value}.
 */
export const sys = {
  /** Client IP address (`$remote_ip`, text). Best public-endpoint rate-limit key. */
  remoteIp: (): Value => val("$remote_ip", "setting"),
  /** HTTP method of the request — `GET`, `POST`, … (`$request_method`, text). */
  requestMethod: (): Value => val("$request_method", "setting"),
  /** Full request URI/path (`$request_uri`, text). */
  requestUri: (): Value => val("$request_uri", "setting"),
  /** Raw query-string portion of the URL (`$request_querystring`, text). */
  requestQueryString: (): Value => val("$request_querystring", "setting"),
  /** Request headers as an object/map (`$http_headers`, object). */
  /**
   * The request's headers, keyed Title-Cased whatever the client sent — a
   * client's `x-sync-secret` is read as `X-Sync-Secret`, so read that spelling.
   * `s.api.call` sends header names the same way.
   */
  httpHeaders: (): Value => val("$http_headers", "setting"),
  /** The caller's `Authorization` bearer token, if present (`$request_auth_token`, text). */
  requestAuthToken: (): Value => val("$request_auth_token", "setting"),
  /** API base URL for the request (`$api_baseurl`, text). */
  apiBaseUrl: (): Value => val("$api_baseurl", "setting"),
  /** Active data source name — e.g. `live` or a branch source (`$datasource`, text). */
  datasource: (): Value => val("$datasource", "setting"),
  /** Active branch name (`$branch`, text). */
  branch: (): Value => val("$branch", "setting"),
  /** Tenant identifier for multi-tenant instances (`$tenant`, text). */
  tenant: (): Value => val("$tenant", "setting"),
  /** Current release number (`$release`, int). */
  release: (): Value => val("$release", "setting"),
  /** Platform identifier (`$platform`, int). */
  platform: (): Value => val("$platform", "setting"),
  /** `true` when the request is running under the debugger (`$debugger`, bool). */
  isDebugger: (): Value => val("$debugger", "setting"),
};

/**
 * Reference a column of the **parent statement's output row** (`{tag:"output",
 * value}`) — the `$output.<col>` reference an addon input binds to. Only
 * meaningful inside an addon spec's `input` map (see `s.db.query`'s `addon`
 * arg), where the engine resolves it against each row the parent query returns,
 * e.g. `addon: [{ addon: transactions, as: "items._txns",
 * input: { user_id: out("id") } }]`.
 */
export function out(name: string, opts?: SafeIsRefOnly): NotObjMember<"output"> {
  assertRefName("out", name, "the output name");
  assertNoRefOptions("out", opts);
  return val(name, "output") as NotObjMember<"output">;
}

/**
 * Build a `mvp_filter` chain entry: `{name, disabled:false, arg}`.
 *
 * Generic in the name so a literal call carries it at the type level
 * (`filter("upper")` is a `FilterXdo<"upper">`), which is what lets a chain's
 * result type be folded. A `string` name — the escape-hatch spelling, and what a
 * decoded workspace passes — widens to `FilterXdo<string>` and folds to
 * `unknown`, exactly as before.
 */
export function filter<const N extends string>(
  name: N,
  ...args: (Value | undefined)[]
): FilterXdo<N> {
  // A HOLE — an omitted argument with a supplied one after it. Dropping it
  // (below) would slide every later argument one slot forward, so the code
  // lands in the initial-value slot and the engine refuses the call, or worse,
  // silently reads the wrong thing. Omission is only ever meaningful from the
  // END.
  const last = args.reduce((acc, a, i) => (a !== undefined ? i : acc), -1);
  const hole = args.slice(0, last).findIndex((a) => a === undefined);
  if (hole !== -1) {
    throw new Error(
      `Filter \`${name}\`: argument ${hole + 1} is omitted but argument ${last + 1} is supplied. ` +
        `Filter arguments are positional, so an omitted one in the middle would shift every argument after it ` +
        `into the wrong slot. Pass a value for argument ${hole + 1}, or use the named form ` +
        `— \`fl.${name}({ … })\` — which cannot mis-slot.`,
    );
  }
  // A lambda filter's body is checked HERE — the one choke point every spelling
  // passes through, `lam.*` or not. It only fires where the body is
  // an inspectable constant.
  assertLambdaFilterArgs(name, args);
  // And an EXPRESSION filter's argument at the same point. The two
  // are separate contracts on purpose: `fl.transform` takes expression source,
  // not a JavaScript body, so checking it against the lambda contract would
  // reject correct code — and checking it against nothing let a `$this` that
  // silently resolves to null ship as a wrong answer with HTTP 200.
  assertExpressionFilterArgs(name, args);
  // And an enumerated argument whose wrong spellings the engine accepts in
  // silence. The emitted signature narrows these to a literal
  // union, which the `c.text(...)` spelling — the one codegen emits, and the one
  // every example in the wild uses — walks straight past.
  assertEnumFilterArgs(name, args);
  // Drop omitted trailing args. Typed filter factories (fl.*) declare their
  // named params positionally, so calling one with fewer args (e.g. `fl.trim()`)
  // passes `undefined` here — without this it would serialize as a stray `null`.
  // A callable accessor (`t.action`) is flattened to its plain shape here, the
  // one choke point every filter argument passes: stored as a function it would
  // serialize as `null`.
  return { name, disabled: false, arg: args.filter((a): a is Value => a !== undefined).map(toPlainValue) };
}

/**
 * One chain member {@link withFilters} takes: an `fl.*` filter, or a `qf.*`
 * step for an operand a db query compiles to SQL — `where: expr(col("at"), ">",
 * withFilters(c.now(), qf.epochms_sub_day(7)))`. A `qf` step carries no
 * `disabled`, and a zero-argument one no `arg`; it is appended as it came, the
 * bytes a query's `eval` stores for the same step.
 */
export type ChainFilter = FilterXdo | QueryFilter;

/**
 * Attach a filter chain to a value, returning a new value. Pass filters spread
 * (the canonical form, `withFilters(v, fl.trim(), fl.lower())`); the array form
 * (`withFilters(v, [fl.trim(), fl.lower()])`) is also accepted — both are flattened.
 * A db-query operand also takes `qf.*` steps (see {@link ChainFilter}).
 */
export function withFilters<V extends Value, const Fs extends readonly (ChainFilter | ChainFilter[])[]>(
  value: V,
  ...filters: Fs
): FilteredValue<V, FlattenFilters<Fs>> &
  (V extends ColValue ? { readonly __col: true } : unknown) {
  // Flatten to ANY depth, then check what came out. The signature
  // already refuses `[[fl.trim()]]`, so reaching here with one means the call
  // came through JavaScript or an `as any` — and a single-level `.flat()` left
  // the inner array in place as a member, which encodes as a filter entry whose
  // `name` is undefined. The bundle carries it, the engine reads nothing, and
  // nothing said so.
  //
  // Flattening deeply rather than refusing the nesting is deliberate: an extra
  // array wrapper has exactly one sensible reading, and the filters inside it
  // are the ones the author meant. What has NO sensible reading is a member
  // that is not a filter at all, so that is what the guard below refuses.
  // The subject first: `withFilters(null, fl.trim())` reached `value.filters`
  // and reported a raw TypeError naming nothing the author wrote.
  if (!isTaggedValue(value)) {
    throw new Error(
      `withFilters: the first argument must be a tagged value (\`c.*\`, \`ref()\`, \`inp()\`, …) — got ` +
        `${describeEntry(value)}. It is the value the chain is applied to; the filters follow it.`,
    );
  }
  const added = filters.flat(Infinity) as FilterXdo[];
  const malformed = added.findIndex(
    (f) => f === null || typeof f !== "object" || typeof (f as FilterXdo).name !== "string",
  );
  if (malformed !== -1) {
    const got = added[malformed];
    throw new Error(
      `withFilters: argument ${malformed} of the filter chain is not a filter — got ` +
        `${JSON.stringify(got) ?? String(got)}. Each entry must come from an \`fl.*\` factory ` +
        `(or \`filter(name, ...)\`), which returns \`{name, arg, disabled}\`. A tagged value is ` +
        `not a filter: to pipe one value through another, pass it as a filter ARGUMENT ` +
        `(\`fl.concat(other)\`), not as a chain member.`,
    );
  }
  // The OPERAND-ORDER guard runs first. A reversed pair usually
  // pipes a plain subject — `c.text("x1_115_session")` — which the bare-pattern
  // guard below reads as a broken pattern and answers with "build it with
  // c.regex(...)". Following that advice turns one reversed pair into two
  // patterns and no subject, so the more specific diagnosis has to be reached
  // first. Same source of truth as the bare-pattern guard: both read
  // `REGEX_SUBJECT_SLOT`, so neither can drift into a different reading of
  // which operand is which.
  const reversed = reversedRegexOperands({
    value: value.value,
    tag: value.tag,
    filters: [...value.filters, ...added],
  });
  if (reversed) {
    throw new Error(
      `Regex filter \`${reversed.filter}\`: ${reversed.message} — ` +
        `\`withFilters(c.regex(…), fl.${reversed.filter}(${reversed.slot === 0 ? "" : "…, "}subject))\`. ` +
        `Naming the argument says which slot is which: ` +
        `\`fl.${reversed.filter}({ subject: … })\`.`,
    );
  }
  // Guard the pattern-piped regex footgun: when a regex filter is
  // applied to a bare `const` value, that value IS the pattern — and an
  // undelimited PCRE silently matches nothing for every input (a precondition on
  // it rejects all values, valid ones included). Only fire when the base is an
  // unfiltered const literal we can actually inspect; a ref/inp pattern or a
  // mid-chain value is left alone. Point straight at `c.regex`.
  //
  // ANY position in the added chain, not just the first. Reading only
  // `added[0]` would let a normalizer in front of the regex filter —
  // `withFilters(c.text("^hi"), fl.trim(), fl.regex_test(inp("url")))`, the
  // shape an author reaches for when the pattern looks like it needs cleaning —
  // walk straight past it and deploy a precondition that rejects every value
  // with an HTTP 200. Nothing upstream fixes a bare pattern: the
  // normalizing filters pass the delimiters they do not have through unchanged,
  // and `regex_quote` escapes the body without adding any.
  //
  // A chain that genuinely BUILDS its pattern (concatenating delimiters on)
  // still has a spelling: apply the prefix in its own `withFilters` call, which
  // leaves the piped value filtered and therefore uninspectable, and the guard
  // stays off it — the same carve-out a `ref`/`inp` pattern already gets.
  // One source of truth with `s.expect.to_match`'s guard — both slots pipe a
  // PATTERN into PHP `preg_*`, so both refuse on the same reading.
  const pipedIsBarePattern = barePatternRefusal(value) !== null;
  const offending = pipedIsBarePattern
    ? added.find((filter) => REGEX_PATTERN_FILTERS.has(filter.name))
    : undefined;
  if (offending) {
    // A later-position filter gets the extra sentence: the chain MIGHT be
    // building the pattern rather than normalizing one, and that reading has a
    // spelling the guard does not see.
    const escapeHatch =
      added[0] === offending
        ? ""
        : ` If this chain BUILDS the pattern rather than normalizing it, apply the ` +
          `prefix in its own \`withFilters(...)\` call — the guard only inspects an ` +
          `unfiltered const, so a filtered base passes through untouched.`;
    throw new Error(
      `Regex filter \`${offending.name}\` is pattern-piped: the value it filters is the ` +
        `regex PATTERN, which PHP \`preg_*\` requires to be delimiter-wrapped. ` +
        `${JSON.stringify(value.value)} is a bare pattern, so the engine matches nothing ` +
        `for every input (a precondition on it silently rejects all values). Build it with ` +
        `c.regex(${JSON.stringify(value.value)}) instead of c.text(...).${escapeHatch}`,
    );
  }
  // `__filtered`, `__base`, and `__chain` are phantom carriers — the runtime
  // object is the plain `{value, tag, filters}` Value. They record what the chain
  // was applied to and which filters it holds, so `InferResponse` can FOLD the
  // chain to a result type instead of degrading it to `unknown`. A `col()`-derived
  // chain keeps the `__col` brand so `withFilters(col("x"), fl.add(...))` is
  // rejected in a `row` just like a bare `col()` — the wrapped form is
  // the actual footgun.
  return { ...value, filters: [...value.filters, ...added] } as unknown as FilteredValue<
    V,
    FlattenFilters<Fs>
  > &
    (V extends ColValue ? { readonly __col: true } : unknown);
}
