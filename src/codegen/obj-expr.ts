/**
 * The inverse of `obj()`, for `const:expr2` / `const:expr` values.
 *
 * A dynamic object is stored as ONE value whose `value` is the object rendered
 * as a XanoScript expression string (`{ question: $input.question }`). There is
 * no structured form to walk, so decoding it means parsing that string — which
 * is why the value decoder once handled only trivially-invertible shapes and
 * left this one emitting an annotated `rawValue({…})` literal. Exact, but it
 * reads as data.
 *
 * This parser is deliberately **narrow**: it accepts exactly the grammar
 * `src/values/obj.ts` emits, and nothing else. That is the whole reason it is
 * safe. A general XanoScript expression language (arithmetic, comparisons, function
 * calls) is a much larger surface where a subtly wrong parse would produce a
 * plausible but different value — so anything outside the grammar returns
 * `null` and the caller falls back exactly as before.
 *
 * Safety does not rest on the parser being right, though. The caller re-runs the
 * real `obj()` over whatever this returns and compares the re-rendered string to
 * the stored one, emitting only on an exact match (the standing proof-carrying
 * rule). A parser bug therefore costs readability, never fidelity.
 */
import {
  auth,
  c,
  col,
  env,
  inp,
  isTaggedValue,
  ref,
  setting,
  sys,
  withFilters,
  type Value,
} from "../values/value.js";
import type { ObjInput, ObjMember } from "../values/obj.js";
import { fl, FILTER_NAMES } from "../values/generated/filters.generated.js";
import { call, lit, obj as objExpr, arr, type Expr } from "./print.js";

/** A parsed member: what to print, and what to feed the real `obj()` to prove it. */
interface Parsed {
  readonly expr: Expr;
  readonly built: ObjMember;
  /** Authoring symbols the emitted expression needs imported. */
  readonly symbols: readonly string[];
}

/** Bare-identifier keys — the only kind XanoScript object literals accept. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A `$`-rooted reference path, e.g. `$input.user.id`. */
const REFERENCE = /^\$(input|var|auth|db)((?:\.[A-Za-z0-9_$]+)*)$/;
/**
 * `$env.<name>` — a workspace env var, or a built-in request var when the name
 * carries its own `$`. ONE segment only, which is all `obj()` emits: a setting's
 * value is a plain name. A dotted drill like `$env.$http_headers.X-Request-Id`
 * is legal upstream and declines here, falling back to `rawValue` exactly as
 * every other out-of-grammar shape does.
 */
const SETTING = /^\$env\.(\$?[A-Za-z0-9_]+)$/;

/**
 * Built-in request vars, keyed by stored name back to their `sys.*` accessor.
 *
 * Derived by calling each accessor rather than restating the names, so it
 * cannot drift as `sys` grows. Without it a pulled `$env.$remote_ip` decodes to
 * `setting("$remote_ip")` — byte-identical, but the spelling the SDK's own docs
 * steer authors away from, because `env("remote_ip")` sits one typo away and
 * silently reads a different thing.
 */
const SYS_BY_NAME = new Map(
  Object.entries(sys).map(([accessor, make]) => [make().value, accessor] as const),
);

/** A hand-rolled cursor — the grammar is small enough not to warrant a lexer. */
class Cursor {
  #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get done(): boolean {
    return this.#at >= this.#text.length;
  }

  skipSpace(): void {
    while (this.#at < this.#text.length && /\s/.test(this.#text[this.#at]!)) this.#at++;
  }

  /** Consume `token` if it is next, after whitespace. */
  eat(token: string): boolean {
    this.skipSpace();
    if (!this.#text.startsWith(token, this.#at)) return false;
    this.#at += token.length;
    return true;
  }

  peek(): string | undefined {
    this.skipSpace();
    return this.#text[this.#at];
  }

  /** Consume while `re` matches, returning the run (possibly empty). */
  take(re: RegExp): string {
    this.skipSpace();
    const start = this.#at;
    while (this.#at < this.#text.length && re.test(this.#text[this.#at]!)) this.#at++;
    return this.#text.slice(start, this.#at);
  }

  /**
   * Consume a JSON double-quoted string, honouring escapes. Returns null when
   * the next token is not a well-formed string.
   */
  takeString(): string | null {
    this.skipSpace();
    if (this.#text[this.#at] !== '"') return null;
    let i = this.#at + 1;
    let out = "";
    while (i < this.#text.length) {
      const ch = this.#text[i]!;
      if (ch === "\\") {
        const next = this.#text[i + 1];
        if (next === undefined) return null;
        // Delegate escape semantics to JSON.parse rather than reimplementing
        // them — `\uXXXX` in particular is easy to get subtly wrong.
        const decoded = tryJsonParse(`"\\${next}"`);
        if (next === "u") {
          const seq = this.#text.slice(i, i + 6);
          const hex = tryJsonParse(`"${seq}"`);
          if (typeof hex !== "string") return null;
          out += hex;
          i += 6;
          continue;
        }
        if (typeof decoded !== "string") return null;
        out += decoded;
        i += 2;
        continue;
      }
      if (ch === '"') {
        this.#at = i + 1;
        return out;
      }
      out += ch;
      i++;
    }
    return null;
  }
}

function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `$input.a.b` → the matching authoring call, or null if not a reference. */
function parseReference(token: string): Parsed | null {
  const m = REFERENCE.exec(token);
  if (!m) return null;
  const root = m[1]!;
  const path = m[2]!.replace(/^\./, "");

  switch (root) {
    case "input":
      return path === "" ? null : { expr: call("inp", lit(path)), built: inp(path), symbols: ["inp"] };
    case "var":
      return path === "" ? null : { expr: call("ref", lit(path)), built: ref(path), symbols: ["ref"] };
    case "db":
      return path === "" ? null : { expr: call("col", lit(path)), built: col(path), symbols: ["col"] };
    case "auth":
      // `$auth` alone is the whole auth record; `$auth.x` is one field. Both are
      // reachable, unlike the others, whose bare form `obj()` never emits.
      return path === ""
        ? { expr: call("auth"), built: auth(), symbols: ["auth"] }
        : { expr: call("auth", lit(path)), built: auth(path), symbols: ["auth"] };
    default:
      return null;
  }
}

/**
 * One member, plus any filter chain riding it.
 *
 * The chain is postfix (`$var.row|get:"a.b"|add:1`), so it is parsed as a loop
 * after the atom rather than folded into it — which is also how it binds: a
 * trailing `|` applies to the whole value to its left, never to one filter
 * argument. Arguments are therefore parsed with {@link parseAtom}, which cannot
 * consume a `|`.
 */
function parseMember(cur: Cursor): Parsed | null {
  // `obj()` groups a member whose chain ends in an argument filter when another
  // member follows it (see `grouped` in `obj.ts`). The grouping carries no
  // meaning of its own, and the proof re-renders it only where the encoder
  // would, so an out-of-place pair still declines.
  if (cur.eat("(")) {
    const inner = parseMember(cur);
    return inner && cur.eat(")") ? inner : null;
  }
  const atom = parseAtom(cur);
  if (!atom) return null;
  if (cur.peek() !== "|") return atom;

  // Everything from here on is a Value — `withFilters` has nothing to attach to
  // a raw scalar, so a filtered literal is lifted to the constant `obj()` would
  // have rendered it from. The PRINTED form has to be lifted in lockstep, or the
  // emitted source calls `withFilters("hi", …)` on a bare string.
  const lifted = liftToValue(atom);
  if (!lifted) return null;
  const expr = lifted.expr;
  let built = lifted.built;
  const symbols = [...lifted.symbols];
  const filterExprs: Expr[] = [];
  // `c.now()` is stored as `now|to_epochms`: the coercion is what makes the
  // identifier evaluate as a time rather than as the string "now" (see
  // `serializeEpochMs` in `obj.ts`), so it is the encoder's own bytes, not a
  // filter the author wrote. Absorbed on the FIRST position only, and only for
  // the bare constant, so `withFilters(c.now(), fl.to_epochms())` — a real
  // authored chain — still declines to the proof rather than decoding as if the
  // author had written nothing.
  let absorbNowCoercion = built.tag === "const:epochms" && built.value === "now";

  while (cur.eat("|")) {
    const name = cur.take(/[A-Za-z0-9_]/);
    // `FILTER_NAMES` is the authoritative membership list. An unknown name has
    // no `fl.*` factory to build or print, so the whole parse declines.
    if (name === "" || !FILTER_NAMES.includes(name)) return null;
    const factory = (fl as Record<string, ((...a: unknown[]) => unknown) | undefined>)[name];
    if (typeof factory !== "function") return null;

    const argExprs: Expr[] = [];
    const argBuilt: unknown[] = [];
    while (cur.eat(":")) {
      const arg = parseAtom(cur);
      if (!arg) return null;
      // `fl.*` takes a scalar or a Value; a record or array argument has no
      // accepted spelling, so decline rather than guess one.
      if (arg.built !== null && typeof arg.built === "object" && !isTaggedValue(arg.built)) {
        return null;
      }
      argExprs.push(arg.expr);
      argBuilt.push(arg.built);
      symbols.push(...arg.symbols);
    }
    let filterValue: unknown;
    try {
      filterValue = factory(...argBuilt);
    } catch {
      return null;
    }
    if (absorbNowCoercion && name === "to_epochms" && argBuilt.length === 0) {
      absorbNowCoercion = false;
      continue;
    }
    absorbNowCoercion = false;
    built = withFilters(built, filterValue as never);
    filterExprs.push(call(`fl.${name}`, ...argExprs));
  }

  // Nothing but the encoder's own coercion — the member is the bare constant.
  if (filterExprs.length === 0) return { expr, built, symbols };

  return {
    expr: call("withFilters", expr, ...filterExprs),
    built,
    symbols: [...symbols, "withFilters", "fl"],
  };
}

/** A parsed member already narrowed to a {@link Value}, expression included. */
interface LiftedValue {
  readonly expr: Expr;
  readonly built: Value;
  readonly symbols: readonly string[];
}

/**
 * Lift a raw scalar member to the constant `obj()` renders it from, so a filter
 * chain has a {@link Value} to attach to — carrying the printed expression with
 * it, since `withFilters` needs a real constructor call on both sides, not a
 * bare literal. Returns null for a record or array, which `withFilters` cannot
 * take.
 */
function liftToValue(parsed: Parsed): LiftedValue | null {
  const m = parsed.built;
  if (isTaggedValue(m)) return { expr: parsed.expr, built: m, symbols: parsed.symbols };
  if (typeof m === "string") return { expr: call("c.text", lit(m)), built: c.text(m), symbols: ["c"] };
  if (typeof m === "number") {
    return Number.isInteger(m)
      ? { expr: call("c.int", lit(m)), built: c.int(m), symbols: ["c"] }
      : { expr: call("c.decimal", lit(m)), built: c.decimal(m), symbols: ["c"] };
  }
  if (typeof m === "boolean") return { expr: call("c.bool", lit(m)), built: c.bool(m), symbols: ["c"] };
  return null;
}

/** One member ATOM — reference, scalar literal, nested record, or array. */
function parseAtom(cur: Cursor): Parsed | null {
  const next = cur.peek();
  if (next === undefined) return null;

  if (next === "{") return parseRecord(cur);

  if (next === "[") {
    if (!cur.eat("[")) return null;
    const exprs: Expr[] = [];
    const built: ObjMember[] = [];
    const symbols: string[] = [];
    if (cur.eat("]")) return { expr: arr([]), built: [], symbols: [] };
    for (;;) {
      const member = parseMember(cur);
      if (!member) return null;
      exprs.push(member.expr);
      built.push(member.built);
      symbols.push(...member.symbols);
      if (cur.eat(",")) continue;
      if (cur.eat("]")) break;
      return null;
    }
    return { expr: arr(exprs), built, symbols };
  }

  if (next === '"') {
    const text = cur.takeString();
    // A raw string member, which is what `obj()` renders a bare string to. Kept
    // as a raw literal rather than `c.text(...)`: both encode identically and
    // `{ greeting: "hi" }` is the more readable of the two.
    return text === null ? null : { expr: lit(text), built: text, symbols: [] };
  }

  // A bare token: `$`-reference, number, true/false, or null.
  const token = cur.take(/[A-Za-z0-9_$.\-+]/);
  if (token === "") return null;

  const reference = parseReference(token);
  if (reference) return reference;

  // The engine's native current-time constant. Narrowed to exactly `now`, which
  // is the only value `c.now()` produces and the only one the value decoder
  // accepts for this tag.
  if (token === "now") return { expr: call("c.now"), built: c.now(), symbols: ["c"] };

  const settingMatch = SETTING.exec(token);
  if (settingMatch) {
    const name = settingMatch[1]!;
    const accessor = SYS_BY_NAME.get(name);
    if (accessor) {
      return { expr: call(`sys.${accessor}`), built: setting(name), symbols: ["sys"] };
    }
    // A `$`-prefixed name `sys` does not cover stays `setting()`; a plain one is
    // a workspace env var, which is what `env()` is for.
    return name.startsWith("$")
      ? { expr: call("setting", lit(name)), built: setting(name), symbols: ["setting"] }
      : { expr: call("env", lit(name)), built: env(name), symbols: ["env"] };
  }

  if (token === "true" || token === "false") {
    const value = token === "true";
    return { expr: lit(value), built: value, symbols: [] };
  }
  // `null` has no raw ObjMember form — `obj()` reaches it only via `c.null()`.
  if (token === "null") return { expr: call("c.null"), built: c.null(), symbols: ["c"] };

  if (/^-?\d+(\.\d+)?$/.test(token)) {
    const n = Number(token);
    // Reject anything that would not render back identically (e.g. `1.50`,
    // `+3`), rather than relying on the caller's proof to catch it.
    return Number.isFinite(n) && String(n) === token
      ? { expr: lit(n), built: n, symbols: [] }
      : null;
  }
  return null;
}

/** `{ key: member, … }` — the only top-level form `obj()` emits. */
function parseRecord(cur: Cursor): Parsed | null {
  if (!cur.eat("{")) return null;
  const entries: Array<readonly [string, Expr]> = [];
  const built: ObjInput = {};
  const symbols: string[] = [];

  if (cur.eat("}")) return { expr: objExpr([]), built, symbols };

  for (;;) {
    const key = cur.take(/[A-Za-z0-9_$]/);
    if (key === "" || !IDENT.test(key)) return null;
    if (!cur.eat(":")) return null;
    const member = parseMember(cur);
    if (!member) return null;
    // A duplicate key would silently drop one member on the way back.
    if (Object.hasOwn(built, key)) return null;
    entries.push([key, member.expr]);
    // Defined, not assigned: `built.__proto__ = …` SETS the prototype, so the
    // member vanished, the proof failed, and a record with that key decoded as
    // an untyped `c.expression(…)`. The printer spells it `["__proto__"]:`.
    Object.defineProperty(built, key, { value: member.built, enumerable: true, writable: true, configurable: true });
    symbols.push(...member.symbols);
    if (cur.eat(",")) continue;
    if (cur.eat("}")) break;
    return null;
  }
  return { expr: objExpr(entries), built, symbols };
}

/** What a successful parse hands back to the value decoder. */
export interface ObjExprCandidate {
  /** The `obj({…})` call to print. */
  readonly expr: Expr;
  /** The record to re-run through the real `obj()` as proof. */
  readonly built: ObjInput;
  /** Authoring symbols the printed expression needs, including `obj` itself. */
  readonly symbols: readonly string[];
}

/**
 * Parse a stored dynamic-object expression string into an `obj({…})` call.
 *
 * Returns null for anything outside the grammar `obj()` emits — the caller then
 * falls back to `rawValue`, exactly as before. Never throws.
 */
export function parseObjExpr(value: string): ObjExprCandidate | null {
  const cur = new Cursor(value);
  if (cur.peek() !== "{") return null;
  const parsed = parseRecord(cur);
  if (!parsed) return null;
  cur.skipSpace();
  // Trailing content means the string was more than one object literal, so the
  // parse does not account for the whole value.
  if (!cur.done) return null;
  return {
    expr: call("obj", parsed.expr),
    built: parsed.built as ObjInput,
    symbols: ["obj", ...parsed.symbols],
  };
}

/** Re-export so the value decoder builds through the same constructor it proves against. */
export type { Value };
