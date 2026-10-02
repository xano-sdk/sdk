/**
 * Value decoder — stored `{value, tag, filters}` → Xano SDK source expression.
 *
 * Every candidate expression is **proved before it is emitted**: the decoder
 * builds the readable form by calling the real `c.*` / `ref` / `withFilters`
 * constructors, then compares what they produced against the stored value. Only
 * an exact match is emitted; anything else falls back to `rawValue(...)`, which
 * is verbatim by construction. So a wrong guess degrades readability, never
 * fidelity — and the same check absorbs the encoder's own guards (the
 * regex-pattern throw, the `c.obj` nested-value rejection) without restating them.
 *
 * Expression values (`const:expr` / `const:expr2`) are decoded as SOURCE, not as
 * structure: `obj()` is tried first because it is the checked form, and anything
 * else comes back through `c.expression` / `c.expressionLegacy`, which carry the
 * expression string verbatim. Exact either way — the difference is only whether
 * the emitted call type-checks its contents. A structured decoder for the
 * expression grammar remains out of scope.
 */
import type { FilterXdo, TaggedValue } from "../types/xdo.js";
import { TAGS } from "../types/xdo.js";
import {
  auth,
  c,
  caught,
  col,
  env,
  inp,
  isToolsetPath,
  out,
  ref,
  resp,
  setting,
  toolset,
  withFilters,
} from "../values/value.js";
import type { BlankTag, NullTag, Value } from "../values/value.js";
import { FILTER_NAMES, FILTER_REQUIRED_ARGS, fl } from "../values/generated/filters.generated.js";
import { obj as objValue } from "../values/obj.js";
import { parseObjExpr } from "./obj-expr.js";
import { CODEGEN_MODULE, SDK_MODULE, type DecodeContext } from "./context.js";
import { call, lit, obj, type Expr } from "./print.js";
import { normalize } from "../validate/normalize.js";

/** A proposed decoding: the source to emit, what it re-encodes to, and its imports. */
interface Candidate {
  readonly expr: Expr;
  readonly value: Value;
  /** Symbols the expression needs from `@xano/sdk`. */
  readonly symbols: readonly string[];
}

/** Structural equality over stored JSON. Key order is irrelevant; presence is not. */
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

/** Run a constructor, treating any encoder guard it trips as "not decodable". */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Value/filter equality under the round-trip contract's own comparator.
 *
 * The proof this decoder rests on is "the constructor reproduces what was
 * stored" — and what counts as reproduced is `normalize`, the same oracle
 * `xanosdk preflight` and codegen verification use. Comparing raw instead made
 * the decoder stricter than the contract, and two generational artifacts it
 * already absorbs were enough to send an otherwise-decodable value to
 * `rawValue()`:
 *
 * - a numeric `value` (`{value: 12, tag:"const:int"}`) where the SDK writes the
 *   string form — the single most common shape in the wild;
 * - a filter stored without `disabled`, which `filter()` always writes. That one
 *   is doubly costly: it also fails the whole-chain check below, so ONE
 *   old-vintage filter dragged its entire value down with it.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/** The pattern-piped regex filters — the ones whose piped value IS the pattern. */
const REGEX_PATTERN_FILTERS = new Set([
  "regex_test",
  "regex_match",
  "regex_match_all",
  "regex_matches",
  "regex_replace",
  "regex_get_all_matches",
  "regex_get_first_match",
]);

/**
 * A `const:obj` stored with no content at all: `""` (most of them) or `null`.
 * Both are the pre-`{}` empty form — see the decode branch for what happens to
 * them and why it is reported.
 */
export function isBlankObject(value: unknown): boolean {
  return value === "" || value === null;
}

/** Split a `/body/flags` literal. Null when the value is not in that form. */
function splitSlashRegex(value: string): { body: string; flags: string } | null {
  const m = /^\/(.*)\/([a-zA-Z]*)$/s.exec(value);
  return m ? { body: m[1]!, flags: m[2]! } : null;
}

/** The text a `textConst` `const:encoded` value carries, or `undefined` for any other spelling. */
function encodedTextOf(value: string): string | undefined {
  const m = /^\(("(?:[^"\\]|\\.)*")\)$/s.exec(value);
  if (m === null) return undefined;
  try {
    const text: unknown = JSON.parse(m[1]!);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for a tag whose blank form `c.blank` spells.
 *
 * Tested against the constructor's own accepted set rather than a list repeated
 * here, so the decoder cannot offer a spelling the authoring surface rejects.
 */
function isBlankTag(tag: string): tag is BlankTag {
  return tag.startsWith("const") && tag !== "const" && tag !== "const:obj";
}

/**
 * Decode the un-filtered base of a value.
 *
 * `regexPiped` says the first filter in the chain treats this value as a regex
 * pattern — which is the only context where `c.regex` is the right surface and,
 * not coincidentally, the context where a bare `c.text` pattern is a live bug.
 */
function decodeBase(v: TaggedValue, regexPiped: boolean): Candidate | null {
  const bare = { value: v.value, tag: v.tag, filters: [] };
  const propose = (expr: Expr, built: Value | null, ...symbols: string[]): Candidate | null =>
    built && sameValue(built, bare) ? { expr, value: built, symbols } : null;

  // The editor's unconfigured value box, taken before the per-tag arms because
  // several of them would otherwise coerce it into something it is not:
  // `Number("")` is 0, so a blank `const:int` would propose `c.int(0)` and only
  // the byte comparison inside `propose` would catch it. Naming the state up
  // front is clearer than relying on that, and it is what `c.blank` spells.
  //
  // `const` and `const:obj` are absent from `BlankTag` because their blanks
  // already round-trip exactly (`c.text("")`, `c.obj(null)`), so they fall
  // through to the arms below unchanged.
  const blankTag = v.value === "" && isBlankTag(v.tag) ? v.tag : null;
  if (blankTag) {
    return propose(call("c.blank", lit(blankTag)), attempt(() => c.blank(blankTag)), "c");
  }

  switch (v.tag) {
    case "const": {
      if (regexPiped) {
        const parts = splitSlashRegex(v.value);
        if (parts) {
          const args = parts.flags ? [lit(parts.body), lit(parts.flags)] : [lit(parts.body)];
          const built = attempt(() => c.regex(parts.body, parts.flags));
          const candidate = propose(call("c.regex", ...args), built, "c");
          if (candidate) return candidate;
        }
        // A bare pattern here is exactly what `withFilters` refuses to encode, so
        // there is no readable form — the caller falls back and reports.
        return null;
      }
      return propose(call("c.text", lit(v.value)), attempt(() => c.text(v.value)), "c");
    }
    case "const:encoded": {
      // Only the spelling `c.text` itself writes is proposed; any other quoted
      // literal fails the byte comparison and falls back.
      const text = encodedTextOf(v.value);
      if (text === undefined || regexPiped) return null;
      return propose(call("c.text", lit(text)), attempt(() => c.text(text)), "c");
    }
    case "const:int": {
      const n = Number(v.value);
      if (Number.isSafeInteger(n)) {
        const asNumber = propose(call("c.int", lit(n)), attempt(() => c.int(n)), "c");
        if (asNumber) return asNumber;
      }
      // Outside the safe range (or a spelling `String(n)` does not reproduce):
      // the engine stores integers as strings and has no such limit, so the
      // string form carries the stored digits verbatim. `18446744073709551615`
      // — one real value in the corpus — is `…616` as a number literal, which
      // is why the number form is proved first and this is not a fallback that
      // rounds.
      return propose(call("c.int", lit(v.value)), attempt(() => c.int(v.value)), "c");
    }
    case "const:decimal": {
      const n = Number(v.value);
      if (!Number.isFinite(n)) return null;
      const asNumber = propose(call("c.decimal", lit(n)), c.decimal(n), "c");
      if (asNumber) return asNumber;
      // The number form did not reproduce the stored bytes, which for a decimal
      // means a spelling no numeric literal carries — `"10.00"` stringifies as
      // `"10"`. The engine stores decimals as strings, so passing the stored
      // string through is exact. Tried second so the readable form stays the
      // default and this is reserved for what it cannot express.
      return propose(call("c.decimal", lit(v.value)), c.decimal(v.value), "c");
    }
    case "const:bool": {
      const b = v.value === "true";
      return propose(call("c.bool", lit(b)), c.bool(b), "c");
    }
    case "const:null":
      return propose(call("c.null"), c.null(), "c");
    // The engine's native current-time constant. `c.now()` is the only authoring
    // form, and it only reproduces `value:"now"` — every occurrence in a real
    // workspace is exactly that, and any other value falls through to `rawValue`
    // rather than being decoded as a "now" it is not.
    case "const:epochms":
      return propose(call("c.now"), c.now(), "c");
    case "const:array":
    case "const:obj": {
      // A BLANK object constant — `value:""` or `value:null` — is the shape the
      // editor stopped writing long ago; a new object variable starts at `{}`
      // today. It is NOT the same value: the engine JSON-decodes the stored
      // string, so a blank yields null where `{}` yields an empty object.
      //
      // So it comes back as `c.obj(null)`, which reproduces the stored bytes
      // exactly. `c.obj()` would be readable, but it would re-point every such
      // statement at `{}` on the next deploy. An exact spelling costs nothing and
      // needs no warning, and it is what the sibling blank tags already do (a blank
      // `const:int` is carried verbatim for the same reason).
      if (v.tag === "const:obj" && isBlankObject(v.value)) {
        return propose(call("c.obj", lit(null)), attempt(() => c.obj(null)), "c");
      }
      // The OBJECT-TYPED null — `value:"null"` rather than the blank `""`. It is
      // what a `db.*` statement's `@meta` slot carries, so it turns up in the
      // most ordinary queries a user reads. `c.obj(null)` writes the blank and
      // would change the stored bytes; `c.null("const:obj")` is the exact
      // spelling. Taken before the JSON parse below, which would otherwise route
      // it to `c.obj(null)` and fail its own proof.
      if (v.tag === "const:obj" && v.value === "null") {
        const objNull: NullTag = "const:obj";
        return propose(call("c.null", lit(objNull)), attempt(() => c.null(objNull)), "c");
      }
      const parsed = attempt(() => JSON.parse(v.value) as unknown);
      if (parsed === null && v.value !== "null") return null;
      const isArray = Array.isArray(parsed);
      if (isArray !== (v.tag === "const:array")) return null;
      const built = attempt(() =>
        isArray ? c.array(parsed as never) : c.obj(parsed as never),
      );
      return propose(call(isArray ? "c.array" : "c.obj", lit(parsed)), built, "c");
    }
    case "var":
      return propose(call("ref", lit(v.value)), attempt(() => ref(v.value)), "ref");
    case "input":
      return propose(call("inp", lit(v.value)), inp(v.value), "inp");
    case "auth":
      return propose(call("auth", lit(v.value)), auth(v.value), "auth");
    case "col":
      return propose(call("col", lit(v.value)), col(v.value), "col");
    case "trycatch":
      return propose(call("caught", lit(v.value)), caught(v.value as never), "caught");
    case "output":
      return propose(call("out", lit(v.value)), out(v.value), "out");
    case "response": {
      // `resp()` stores the bare literal `"response"`; a drilled path appends
      // `.seg` or the bracket escape. `propose` is the proof — a path this
      // splits wrongly (a segment holding a literal `.`) re-renders differently
      // and falls back to `rawValue` rather than emitting a plausible mis-read.
      const path = parseRespPath(v.value);
      if (path === null) return null;
      return propose(
        path === "" ? call("resp") : call("resp", lit(path)),
        attempt(() => resp(path)),
        "resp",
      );
    }
    case "setting": {
      // Built-in request/system vars carry a `$` prefix and are settings; a plain
      // name is a workspace env var, whose idiomatic surface is `env(...)`. Both
      // encode identically, so this is a readability split, not a semantic one.
      const isEnvVar = !v.value.startsWith("$");
      return isEnvVar
        ? propose(call("env", lit(v.value)), attempt(() => env(v.value)), "env")
        : propose(call("setting", lit(v.value)), attempt(() => setting(v.value)), "setting");
    }
    // The older expression form. `obj()` always emits `const:expr2`, so no
    // object-building path can reproduce this tag — but `c.expressionLegacy` carries
    // the source verbatim, which is both exact and readable.
    case "const:expr":
      return propose(call("c.expressionLegacy", lit(v.value)), attempt(() => c.expressionLegacy(v.value)), "c");
    case "const:expr2": {
      // A dynamic object, stored as its rendered XanoScript expression string.
      // `obj()` is the authoring constructor, so the inverse is a parse — scoped
      // to exactly the grammar `obj()` emits (see `obj-expr.ts`).
      //
      // `propose` is the proof: it re-runs the real `obj()` over the parsed
      // record and requires the re-rendered string to equal the stored one, so a
      // parser that mis-reads an expression yields `null` and falls back to
      // `rawValue` rather than emitting a plausible-but-different value.
      const parsed = parseObjExpr(v.value);
      if (parsed) {
        const built = attempt(() => objValue(parsed.built));
        const candidate = propose(parsed.expr, built, ...parsed.symbols);
        if (candidate) return candidate;
      }
      // Not the object grammar (or the parse did not prove out): the expression
      // is some other expression-engine source — `~` concatenation, arithmetic,
      // a conditional. `c.expression` carries it verbatim, which beats
      // `rawValue` on readability and is exactly as faithful. `obj()` stays
      // preferred above because it is the CHECKED form; this is the passthrough.
      return propose(call("c.expression", lit(v.value)), attempt(() => c.expression(v.value)), "c");
    }
    // A toolset-scoped binding. Guarded on the accepted path set rather than
    // decoded for any value: the authoring type is a closed union, and emitting
    // a call it rejects would leave the pulled tree failing its own type-check.
    // An unrecognised name keeps its `rawValue` — exact, and honest about being
    // a name the SDK does not model.
    case "toolset":
      return isToolsetPath(v.value)
        ? propose(call("toolset", lit(v.value)), toolset(v.value), "toolset")
        : null;
    default:
      // `response` — an engine-side tag with no authoring constructor.
      return null;
  }
}

/** `fl.<name>` when the name is a plain identifier, `fl["…"]` otherwise. */
function filterCallee(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `fl.${name}` : `fl[${JSON.stringify(name)}]`;
}

/**
 * The verbatim form of one filter: the stored object, passed straight to
 * `withFilters` (which accepts a `FilterXdo` as well as an `fl.*` result).
 *
 * The escape hatch for a filter the catalog cannot rebuild exactly — most often
 * one the engine stored WITHOUT `disabled`, since `filter()` always writes it.
 * Degrading the single filter keeps the rest of the value readable
 * (`withFilters(ref("answers"), {…})`) instead of collapsing the whole thing to
 * `rawValue`, which is what happened before.
 */
function literalFilter(stored: FilterXdo): Candidate {
  return {
    expr: lit(stored),
    value: { value: "", tag: "const", filters: [] },
    symbols: [],
  };
}

/** Decode one stored filter to its `fl.*` call, or to a verbatim literal. */
function decodeFilter(stored: FilterXdo): Candidate | null {
  const known = (FILTER_NAMES as readonly string[]).includes(stored.name);
  // `filter()` hard-codes `disabled: false`, so a filter stored without that key
  // — or with it true — has no `fl.*` form and rides through verbatim instead.
  if (!known || (stored.disabled ?? false) !== false || !Array.isArray(stored.arg)) {
    return literalFilter(stored);
  }
  // A stored call with fewer arguments than the engine requires is a call the
  // typed factory refuses to spell: the omitted slot is a LEADING
  // one, so writing it positionally would put the next argument in the wrong
  // place. The stored bytes are still the stored bytes, so it rides through
  // verbatim rather than being reshaped into a call that would not compile.
  if (stored.arg.length < ((Object.hasOwn(FILTER_REQUIRED_ARGS, stored.name) ? FILTER_REQUIRED_ARGS[stored.name] : undefined) ?? 0)) {
    return literalFilter(stored);
  }

  // A stored argument that is not a value at all — `null` is what an earlier
  // SDK wrote for a trigger input accessor (`t.action`) passed as a filter
  // argument. No call spells it, so the whole value declines to `rawValue`
  // (named by `describeFallback`) instead of reading a property off null.
  if (stored.arg.some((arg) => arg === null || typeof arg !== "object")) return null;

  const args: Expr[] = [];
  const symbols = new Set<string>(["fl"]);
  const built: Value[] = [];
  for (const arg of stored.arg) {
    const candidate = decodeValueCandidate(arg);
    if (!candidate) return literalFilter(stored);
    args.push(candidate.expr);
    built.push(candidate.value);
    for (const symbol of candidate.symbols) symbols.add(symbol);
  }

  const factory = (fl as Record<string, (...a: Value[]) => FilterXdo>)[stored.name];
  const encoded = factory ? attempt(() => factory(...built)) : null;
  if (!encoded || !sameValue(encoded, stored)) return literalFilter(stored);
  return {
    expr: call(filterCallee(stored.name), ...args),
    // A filter is not a value; the caller only reads `expr`/`symbols` here.
    value: { value: "", tag: "const", filters: [] },
    symbols: [...symbols],
  };
}

/**
 * Decode a stored filter array to the source expressions that rebuild it.
 *
 * Shared by the two places a filter chain is stored: inside a value
 * (`{value, tag, filters}`, handled by `decodeValue`) and on a statement's
 * result binding (`output.filters`, handled by the statement decoder). Both want
 * the same thing — `fl.*` calls where the catalog can name the filter, a
 * verbatim literal where it cannot — so both read it from here.
 *
 * Never fails: an unnameable filter degrades to a literal that still re-encodes
 * to the stored bytes, so a chain is always recoverable even when part of it is
 * unrecognized.
 */
export function decodeFilterChain(filters: readonly FilterXdo[]): {
  exprs: Expr[];
  symbols: string[];
} {
  const exprs: Expr[] = [];
  const symbols = new Set<string>();
  for (const stored of filters) {
    const decoded = decodeFilter(stored);
    // `decodeFilter` only returns null on a shape `literalFilter` also refuses;
    // fall back to the literal rather than dropping a stored filter.
    if (!decoded) {
      exprs.push(lit(stored));
      continue;
    }
    exprs.push(decoded.expr);
    for (const symbol of decoded.symbols) symbols.add(symbol);
  }
  return { exprs, symbols: [...symbols] };
}

/**
 * Rebuild the plain-JSON record behind a `{}`-plus-`set` object constant — the
 * form `c.obj({…})` writes and the editor stores. Null when the
 * chain is anything else (a `set` whose value is a live reference, a filter that
 * is not `set`, a disabled one), which leaves the generic `withFilters` path to
 * handle it.
 */
function decodeObjSetChain(filters: readonly FilterXdo[]): Record<string, unknown> | null {
  // Prototype-free while building: a stored `set` path of `__proto__` would
  // otherwise assign the prototype instead of an own key, and this decoder runs
  // over workspaces it did not author. Spread back to a plain object at the end.
  const out = Object.create(null) as Record<string, unknown>;
  for (const f of filters) {
    if (f.name !== "set" || f.disabled || f.arg.length !== 2) return null;
    const [path, member] = f.arg as [TaggedValue, TaggedValue];
    if (path.tag !== "const" || (path.filters?.length ?? 0) > 0) return null;
    const decoded = decodeObjMember(member);
    if (!decoded) return null;
    const key = parseSetPath(path.value);
    // `__proto__` has no readable form here at all: in EMITTED source both
    // `{ __proto__: … }` and `{ "__proto__": … }` set the prototype rather than
    // a key, so the printed record would re-encode to an object missing it. The
    // byte check downstream cannot see that — it compares what this function
    // built, not what the printed source would rebuild — so refuse the candidate
    // and let the generic `fl.set(c.text("__proto__"), …)` chain carry it.
    if (key === "__proto__") return null;
    out[key] = decoded.value;
  }
  return { ...out };
}

/**
 * A stored `set` path segment back to the literal key it stands for — the
 * inverse of the encoder's `setPath`. A bare segment IS the key; `["a.b"]` is
 * the bracket form, whose interior unescapes `\"` and `\\` in one pass so the
 * two escapes cannot be applied in the wrong order.
 */
function parseSetPath(stored: string): string {
  const bracketed = /^\["(.*)"\]$/s.exec(stored);
  return bracketed ? bracketed[1]!.replace(/\\(["\\])/g, "$1") : stored;
}

/**
 * The drill path off a stored `response` value — the inverse of the `resp()`
 * encoder. `"response"` → `""`, `"response.id"` → `"id"`,
 * `'response["a-b"]'` → `"a-b"`. Null when the value is not that grammar.
 */
function parseRespPath(stored: string): string | null {
  if (stored === "response") return "";
  if (!stored.startsWith("response")) return null;
  let rest = stored.slice("response".length);
  const segments: string[] = [];
  while (rest.length > 0) {
    const bare = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (bare) {
      segments.push(bare[1]!);
      rest = rest.slice(bare[0].length);
      continue;
    }
    const bracketed = /^\["((?:[^"\\]|\\.)*)"\]/s.exec(rest);
    if (bracketed) {
      segments.push(bracketed[1]!.replace(/\\(["\\])/g, "$1"));
      rest = rest.slice(bracketed[0].length);
      continue;
    }
    return null;
  }
  return segments.join(".");
}

/** One `set` member back to its JSON value, boxed so `null` is not "no match". */
function decodeObjMember(m: TaggedValue): { value: unknown } | null {
  const filters = Array.isArray(m.filters) ? m.filters : [];
  if (m.tag === "const:obj" && m.value === "{}") {
    const nested = decodeObjSetChain(filters);
    return nested ? { value: nested } : null;
  }
  if (filters.length > 0) return null;
  switch (m.tag) {
    case "const":
      return { value: m.value };
    case "const:null":
      return { value: null };
    case "const:bool":
      return { value: m.value === "true" };
    case "const:int":
    case "const:decimal":
      return { value: Number(m.value) };
    case "const:array":
      return attempt(() => ({ value: JSON.parse(m.value) as unknown }));
    default:
      return null;
  }
}

/** Build the readable form of a value, or null when none is provably exact. */
function decodeValueCandidate(v: TaggedValue, regexSlot = false): Candidate | null {
  if (v === null || typeof v !== "object") return null;
  const filters = Array.isArray(v.filters) ? v.filters : [];
  // A populated object constant, before the generic base-plus-filters path —
  // which would otherwise spell it as a `withFilters(c.obj(), fl.set(…), …)`
  // chain that says nothing about the object it builds. Guarded by the same
  // byte check as every other candidate, so a chain that only looks like one
  // falls through instead of being re-pointed at a different object.
  if (v.tag === "const:obj" && v.value === "{}" && filters.length > 0) {
    const record = decodeObjSetChain(filters);
    const built = record ? attempt(() => c.obj(record as never)) : null;
    if (built && record && sameValue(built, v)) {
      return { expr: call("c.obj", lit(record)), value: built, symbols: ["c"] };
    }
  }
  // ANY pattern-piped regex filter in the chain makes the base a regex PATTERN,
  // not just one in first position — the same reading `withFilters` enforces.
  // Scanning only the first filter spelled a stored
  // `trim → regex_test` base as `c.text("/^hi/i")` rather than `c.regex("^hi","i")`,
  // which is the same bytes but hides what the value is.
  // `regexSlot` is the same reading arriving from the other direction: the
  // STATEMENT FIELD is declared a pattern (`s.expect.to_match`'s `value`), so the
  // base is a pattern even with no filter in the chain to say so.
  const base = decodeBase(
    v,
    regexSlot || filters.some((filter) => REGEX_PATTERN_FILTERS.has(filter.name)),
  );
  if (!base) return null;
  if (filters.length === 0) return base;

  const symbols = new Set<string>([...base.symbols, "withFilters"]);
  const filterExprs: Expr[] = [];
  const builtFilters: FilterXdo[] = [];
  for (const stored of filters) {
    const decoded = decodeFilter(stored);
    if (!decoded) return null;
    filterExprs.push(decoded.expr);
    builtFilters.push(stored);
    for (const symbol of decoded.symbols) symbols.add(symbol);
  }

  // `withFilters` can refuse the chain outright (the regex-pattern guard); when it
  // does, there is no source form that both compiles and re-encodes to this value.
  const built = attempt(() => withFilters(base.value, ...builtFilters));
  if (!built || !sameValue(built, v)) return null;
  return {
    expr: call("withFilters", base.expr, ...filterExprs),
    value: built,
    symbols: [...symbols],
  };
}

/** The verbatim `rawValue({…})` form, exact for any stored value. */
function fallbackExpr(v: TaggedValue): Expr {
  const entries: Array<[string, Expr]> = [
    ["value", lit(v.value)],
    ["tag", lit(v.tag)],
  ];
  if (Array.isArray(v.filters) && v.filters.length > 0) entries.push(["filters", lit(v.filters)]);
  return call("rawValue", obj(entries));
}

/**
 * Decode a stored value to a source expression, recording the imports it needs
 * and reporting anything that had to fall back to a verbatim literal.
 */
export function decodeValue(
  ctx: DecodeContext,
  v: TaggedValue,
  opts: { regexPattern?: boolean } = {},
): Expr {
  const candidate = decodeValueCandidate(v, opts.regexPattern === true);
  if (candidate) {
    for (const symbol of candidate.symbols) ctx.use(SDK_MODULE, symbol);
    return candidate.expr;
  }
  ctx.use(CODEGEN_MODULE, "rawValue");
  ctx.problem("value-fallback", describeFallback(v));
  return fallbackExpr(v);
}

/**
 * Why a stored value had no readable form — the cause, not just the tag.
 *
 * "tag const:int has no idiomatic form" reads as though the SDK cannot express
 * integer constants, which it plainly can. Naming the real cause is what lets
 * the category be clustered instead of merely counted — the same move that
 * turned the `rawField()` and `raw()` piles into named decisions.
 *
 * A blank constant is `c.blank(tag)` and a `"10.00"` decimal is
 * `c.decimal("10.00")`, so neither reaches a fallback at all. What remains for
 * a blank value is a blank REFERENCE — an `input`/`var`/`response` naming
 * nothing — which is an unbound binding rather than an empty value box, and
 * must not borrow that wording.
 */
function describeFallback(v: TaggedValue): string {
  const hole = nonValueFilterArg(v);
  if (hole !== undefined) {
    return (
      `filter \`${hole.filter}\` stores argument ${hole.index + 1} as ${hole.stored} rather than a value — ` +
      `the shape an earlier SDK wrote for a trigger input accessor (\`t.action\`) passed as a filter ` +
      `argument, which lost the value it named. Carried verbatim so the bytes do not change; put back the ` +
      `value that was meant (e.g. \`inp("action")\`)`
    );
  }
  if (!(TAGS as readonly string[]).includes(v.tag)) {
    return `unknown tag ${v.tag} has no idiomatic form; emitted verbatim`;
  }
  if (v.value === "") {
    return (
      `a blank ${v.tag} — a reference that names nothing, so there is no target to resolve and no ` +
      `\`${v.tag}\` constructor call that would mean this. Carried verbatim so it keeps meaning ` +
      `exactly what it stores; bind it upstream to give it one`
    );
  }
  return `tag ${v.tag} stores ${JSON.stringify(v.value)}, which no \`c.*\` constructor reproduces exactly; emitted verbatim`;
}

/** The first filter argument under `v` that is not a value (e.g. `null`), anywhere in its chain. */
function nonValueFilterArg(v: TaggedValue): { filter: string; index: number; stored: string } | undefined {
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const node = stack.pop() as { filters?: unknown } | null;
    if (node === null || typeof node !== "object" || !Array.isArray(node.filters)) continue;
    for (const f of node.filters as Array<{ name?: unknown; arg?: unknown }>) {
      if (f === null || typeof f !== "object" || !Array.isArray(f.arg)) continue;
      const index = f.arg.findIndex((a) => a === null || typeof a !== "object");
      if (index !== -1) return { filter: String(f.name), index, stored: describeStored(f.arg[index]) };
      stack.push(...(f.arg as unknown[]));
    }
  }
  return undefined;
}

/** A field read back from one of its two stored generations. */
export interface ValueOrBare {
  /** What the factory is called with — a `Value`, or the bare scalar itself. */
  readonly runtime: unknown;
  /** The same thing as source. */
  readonly expr: Expr;
}

/** Name what a two-generation slot held, for a decline the reader can act on. */
export function describeStored(v: unknown): string {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object with no `tag`";
  return `a ${typeof v}`;
}

/**
 * Read a field the engine stores in two generations: a `{value, tag, filters}`
 * envelope, or the bare scalar that predates it.
 *
 * Both are live. `mvp:dbo_external_*_query` resolves a bare
 * `context.connection_string` against the workspace environment whenever the
 * flex value is empty, and `mvp:workspace_run_endpoint` declares its `token` as
 * plain text — so a decoder that accepts only the envelope reads a workspace
 * it cannot reproduce, and 33 external-SQL statements plus every plain-token
 * `api.call` go out as `raw()` without it.
 *
 * Promotion is a READ-side affordance only. The bare scalar comes back as a bare
 * scalar, and the factories that take one write it back into the older field —
 * the round trip is judged against the bytes the workspace holds, not against
 * the spelling this SDK would pick for new code. `null` when the slot holds
 * neither; the caller declines and names what {@link describeStored} found.
 */
export function readValueOrBare(ctx: DecodeContext, stored: unknown): ValueOrBare | null {
  if (typeof stored === "string" || typeof stored === "number" || typeof stored === "boolean") {
    return { runtime: stored, expr: lit(stored) };
  }
  if (stored === null || typeof stored !== "object") return null;
  const block = stored as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  const value: TaggedValue = {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
  return { runtime: value, expr: decodeValue(ctx, value) };
}
