/**
 * Which `$args.x` an agent prompt template prints where x may be absent.
 *
 * The template is read as a tag stream (`{% if %}`/`{% elseif %}`/`{% else %}`/
 * `{% endif %}`, `{% for %}…{% else %}…{% endfor %}`, other block tags) and
 * each expression is parsed with the template language's operator precedence.
 * A condition yields what it GUARANTEES: the args present when it is true and
 * the args present when it is false. Every leaf test is decided the same way —
 * evaluate it with the arg absent (null): a test that is false for an absent arg
 * guarantees the arg when true (`$args.x`, `is defined`, `is not empty`,
 * `!= null`, `== "a"`), and one that is true for an absent arg guarantees it
 * when false (`is null`, `is not defined`, `== ""`, `not in ['a']`). The
 * absent value runs through `|default(lit)`, `?? lit` and known filters first,
 * so `$args.x|default('') != ''` guards and `$args.x|default('a')` does not.
 * `not`, `and`, `or`, ternaries and `??` compose those. An expression nested
 * too deep to walk is read as unreadable.
 */

/** Guaranteed-present args when an expression is truthy (`t`) and when falsy (`f`). */
interface Guard {
  t: Set<string>;
  f: Set<string>;
}

type Lit = null | boolean | number | string | Lit[];

type Node =
  | { k: "root" }
  | { k: "ref"; key: string }
  | { k: "lit"; v: Lit }
  | { k: "not"; a: Node }
  | { k: "and" | "or" | "coalesce"; a: Node; b: Node }
  | { k: "cmp"; op: string; a: Node; b: Node }
  | { k: "is"; neg: boolean; test: string; a: Node; args: Node[] }
  | { k: "filter"; name: string; a: Node; args: Node[] }
  | { k: "cond"; c: Node; a: Node; b: Node }
  | { k: "other"; kids: Node[] };

interface Tok {
  type: "str" | "num" | "name" | "op";
  v: string;
  /** Whitespace precedes the token. */
  sp: boolean;
}

const OPS = ["??", "?:", "==", "!=", "<=", ">=", "//", "**", "..", "=>", "<", ">", "+", "-", "*", "/", "%", "~", "=", "?", ":", "|", ".", ",", "(", ")", "[", "]", "{", "}"];

const NUM = /\d+(?:\.\d+)?/y;
const NAME = /[A-Za-z_$][\w$]*/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let sp = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      sp = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        v += src[j];
        j++;
      }
      if (j >= src.length) throw new Error("unterminated string");
      out.push({ type: "str", v, sp });
      i = j + 1;
    } else if (/\d/.test(ch)) {
      NUM.lastIndex = i;
      const m = NUM.exec(src)!;
      out.push({ type: "num", v: m[0], sp });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(ch)) {
      NAME.lastIndex = i;
      const m = NAME.exec(src)!;
      out.push({ type: "name", v: m[0], sp });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op === undefined) throw new Error(`unexpected "${ch}"`);
      out.push({ type: "op", v: op, sp });
      i += op.length;
    }
    sp = false;
  }
  return out;
}

/** Binary operators and their precedence; word operators match name tokens. */
const BINARY: Record<string, number> = {
  or: 10,
  and: 15,
  "==": 20, "!=": 20, "<": 20, ">": 20, "<=": 20, ">=": 20,
  in: 20, "not in": 20, matches: 20, "starts with": 20, "ends with": 20,
  "..": 25,
  "+": 30, "-": 30,
  "~": 40,
  "*": 60, "/": 60, "//": 60, "%": 60,
  is: 100, "is not": 100,
  "**": 200,
  "??": 300,
};
const RIGHT_ASSOC = new Set(["**", "??"]);
const NOT_PRECEDENCE = 50;
/** `is` tests spelled as two words. */
const TWO_WORD_TESTS: Record<string, string> = { same: "as", divisible: "by" };

/** Nesting past this is read as unreadable rather than walked. */
const MAX_DEPTH = 200;

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly toks: Tok[]) {}

  parseAll(): Node {
    const n = this.expr();
    if (this.i < this.toks.length) throw new Error(`unexpected "${this.toks[this.i]!.v}"`);
    return n;
  }

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.type === "op" && t.v === v;
  }
  private isName(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.type === "name" && t.v === v;
  }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new Error(`expected "${v}"`);
    this.i++;
  }

  /** A full expression: binary operators, then `?:`, `? … : …`. */
  expr(): Node {
    this.enter();
    try {
      return this.ternary();
    } finally {
      this.depth--;
    }
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new Error("nested too deep");
  }

  private ternary(): Node {
    const c = this.binary(0);
    if (this.isOp("?:")) {
      this.i++;
      return { k: "cond", c, a: c, b: this.expr() };
    }
    if (this.isOp("?")) {
      this.i++;
      if (this.isOp(":")) {
        this.i++;
        return { k: "cond", c, a: c, b: this.expr() };
      }
      const a = this.expr();
      if (!this.isOp(":")) return { k: "cond", c, a, b: { k: "lit", v: "" } };
      this.i++;
      return { k: "cond", c, a, b: this.expr() };
    }
    return c;
  }

  /** The binary operator at the cursor, as its table key, and its token count. */
  private binaryOp(): [string, number] | undefined {
    const t = this.peek();
    if (t === undefined) return undefined;
    if (t.type === "op") return t.v in BINARY ? [t.v, 1] : undefined;
    if (t.type !== "name") return undefined;
    if (t.v === "not" && this.isName("in", 1)) return ["not in", 2];
    if ((t.v === "starts" || t.v === "ends") && this.isName("with", 1)) return [`${t.v} with`, 2];
    if (t.v === "is" && this.isName("not", 1)) return ["is not", 2];
    return t.v === "or" || t.v === "and" || t.v === "in" || t.v === "matches" || t.v === "is" ? [t.v, 1] : undefined;
  }

  private binary(min: number): Node {
    this.enter();
    try {
      return this.binaryChain(min);
    } finally {
      this.depth--;
    }
  }

  private binaryChain(min: number): Node {
    let left = this.unary();
    for (;;) {
      const op = this.binaryOp();
      if (op === undefined) break;
      const prec = BINARY[op[0]]!;
      if (prec < min) break;
      this.i += op[1];
      if (op[0] === "is" || op[0] === "is not") {
        left = this.test(left, op[0] === "is not");
        continue;
      }
      const right = this.binary(RIGHT_ASSOC.has(op[0]) ? prec : prec + 1);
      left = combine(op[0], left, right);
    }
    return left;
  }

  private test(a: Node, neg: boolean): Node {
    const t = this.peek();
    if (t?.type !== "name") throw new Error("expected a test name");
    this.i++;
    let test = t.v.toLowerCase();
    const second = TWO_WORD_TESTS[test];
    if (second !== undefined && this.isName(second)) {
      this.i++;
      test = `${test} ${second}`;
    }
    const args = this.isOp("(") ? this.callArgs() : [];
    return { k: "is", neg, test, a, args };
  }

  private unary(): Node {
    if (this.isName("not")) {
      this.i++;
      return { k: "not", a: this.binary(NOT_PRECEDENCE) };
    }
    if (this.isOp("-") || this.isOp("+")) {
      this.i++;
      return { k: "other", kids: [this.binary(500)] };
    }
    return this.postfix(this.primary());
  }

  private callArgs(): Node[] {
    this.expect("(");
    const args: Node[] = [];
    while (!this.isOp(")")) {
      // A named argument, `name = value`, or an arrow function's parameters.
      if (this.peek()?.type === "name" && (this.isOp("=", 1) || this.isOp("=>", 1))) this.i += 2;
      else if (this.isOp("(")) {
        let j = 1;
        while (this.peek(j)?.type === "name" || this.isOp(",", j)) j++;
        if (this.isOp(")", j) && this.isOp("=>", j + 1)) this.i += j + 2;
      }
      args.push(this.expr());
      if (!this.isOp(",")) break;
      this.i++;
    }
    this.expect(")");
    return args;
  }

  private primary(): Node {
    const t = this.peek();
    if (t === undefined) throw new Error("unexpected end");
    this.i++;
    if (t.type === "str") return { k: "lit", v: t.v };
    if (t.type === "num") return { k: "lit", v: Number(t.v) };
    if (t.type === "name") {
      const lower = t.v.toLowerCase();
      if (lower === "true" || lower === "false") return { k: "lit", v: lower === "true" };
      if (lower === "null" || lower === "none") return { k: "lit", v: null };
      if (t.v === "$args") return { k: "root" };
      if (this.isOp("(")) return { k: "other", kids: this.callArgs() };
      return { k: "other", kids: [] };
    }
    if (t.v === "(") {
      const n = this.expr();
      this.expect(")");
      return n;
    }
    if (t.v === "[") {
      const items: Node[] = [];
      while (!this.isOp("]")) {
        items.push(this.expr());
        if (!this.isOp(",")) break;
        this.i++;
      }
      this.expect("]");
      return items.every((n) => n.k === "lit")
        ? { k: "lit", v: items.map((n) => (n as { v: Lit }).v) }
        : { k: "other", kids: items };
    }
    if (t.v === "{") {
      const values: Node[] = [];
      while (!this.isOp("}")) {
        if (this.isOp("(")) {
          this.i++;
          values.push(this.expr());
          this.expect(")");
        } else this.i++;
        if (this.isOp(":")) {
          this.i++;
          values.push(this.expr());
        }
        if (!this.isOp(",")) break;
        this.i++;
      }
      this.expect("}");
      return values.length === 0 ? { k: "lit", v: [] } : { k: "other", kids: values };
    }
    throw new Error(`unexpected "${t.v}"`);
  }

  private postfix(start: Node): Node {
    let n = start;
    for (;;) {
      if (this.isOp(".")) {
        this.i++;
        const name = this.peek();
        if (name === undefined || (name.type !== "name" && name.type !== "num")) throw new Error("expected an attribute");
        this.i++;
        const args = this.isOp("(") ? this.callArgs() : [];
        n = n.k === "root" ? { k: "ref", key: name.v } : n.k === "ref" ? n : { k: "other", kids: [n, ...args] };
      } else if (this.isOp("[")) {
        this.i++;
        const sub = this.expr();
        this.expect("]");
        if (n.k === "root") n = sub.k === "lit" && typeof sub.v === "string" ? { k: "ref", key: sub.v } : { k: "other", kids: [sub] };
        else if (n.k !== "ref") n = { k: "other", kids: [n, sub] };
      } else if (this.isOp("|")) {
        this.i++;
        const name = this.peek();
        if (name?.type !== "name") throw new Error("expected a filter name");
        this.i++;
        let args: Node[] = [];
        if (this.isOp("(")) args = this.callArgs();
        else {
          // `|default:"x"` — a colon argument written against the filter name.
          while (this.isOp(":") && !this.peek()!.sp) {
            this.i++;
            args.push(this.postfix(this.primary()));
          }
        }
        n = { k: "filter", name: name.v.toLowerCase(), a: n, args };
      } else return n;
    }
  }
}

function combine(op: string, a: Node, b: Node): Node {
  if (op === "and" || op === "or") return { k: op, a, b };
  if (op === "??") return { k: "coalesce", a, b };
  if (BINARY[op] === 20) return { k: "cmp", op, a, b };
  return { k: "other", kids: [a, b] };
}

/** A node's children. */
function kids(n: Node): Node[] {
  switch (n.k) {
    case "not": return [n.a];
    case "and": case "or": case "coalesce": case "cmp": return [n.a, n.b];
    case "is": case "filter": return [n.a, ...n.args];
    case "cond": return [n.c, n.a, n.b];
    case "other": return n.kids;
    default: return [];
  }
}

/** Whether a tree nests deeper than {@link MAX_DEPTH} — a long `~`/`and` or filter chain nests without recursing the parser. */
function tooDeep(root: Node): boolean {
  const stack: Array<[Node, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (d > MAX_DEPTH) return true;
    for (const k of kids(n)) stack.push([k, d + 1]);
  }
  return false;
}

/** The expression's tree, or undefined where it is unreadable or nests too deep to walk. */
function parse(expr: string): Node | undefined {
  try {
    const n = new Parser(tokenize(expr)).parseAll();
    return tooDeep(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

const NONE: Guard = { t: new Set(), f: new Set() };
const union = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a, ...b]);
const inter = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a].filter((k) => b.has(k)));
const minus = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a].filter((k) => !b.has(k)));

/** Template `empty`: null, false, "" and an empty list. */
function isEmpty(v: Lit): boolean {
  return v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Filters that turn a null or empty list into an empty list, so a loop over the result never runs on an absent arg. */
const LIST_FILTERS = new Set(["sort", "reverse", "slice", "filter", "map", "unique", "batch", "column"]);

/** A filter's result on input `v`, for the filters whose result is known here; undefined otherwise. */
function applyFilter(name: string, v: Lit): Lit | undefined {
  const str = v === null || v === false ? "" : v === true ? "1" : typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  const text = (f: (s: string) => string | undefined): Lit | undefined => (str === undefined ? undefined : f(str));
  switch (name) {
    case "length":
    case "count": return Array.isArray(v) ? v.length : str?.length;
    case "abs": return v === null ? 0 : typeof v === "number" ? Math.abs(v) : undefined;
    case "raw": return v;
    case "first":
    case "last":
      if (v === null) return null;
      if (Array.isArray(v)) return (name === "first" ? v[0] : v[v.length - 1]) ?? null;
      return typeof v === "string" ? (name === "first" ? v.slice(0, 1) : v.slice(-1)) : undefined;
    case "keys": return v === null ? [] : Array.isArray(v) ? v.map((_, i) => i) : undefined;
    case "join": return v === null || (Array.isArray(v) && v.length === 0) ? "" : undefined;
    case "lower": return text((x) => x.toLowerCase());
    case "upper": return text((x) => x.toUpperCase());
    case "trim": return text((x) => x.trim());
    case "capitalize": return text((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase());
    case "title": return text((x) => x.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()));
    case "escape":
    case "e": return text((x) => (/[<>&"']/.test(x) ? undefined : x));
    case "striptags": return text((x) => (/</.test(x) ? undefined : x));
    case "nl2br": return text((x) => (/\n/.test(x) ? undefined : x));
    default:
      return LIST_FILTERS.has(name) && (v === null || (Array.isArray(v) && v.length === 0)) ? [] : undefined;
  }
}

/**
 * The args an expression depends on and the value it takes when they are
 * absent: refs are null, literals themselves, `|default(lit)` and `?? lit`
 * their fallback, and the filters {@link applyFilter} knows applied in order.
 */
function probe(n: Node): { keys: Set<string>; absent: Lit } | undefined {
  switch (n.k) {
    case "ref": return { keys: new Set([n.key]), absent: null };
    case "lit": return { keys: new Set(), absent: n.v };
    case "coalesce": {
      const a = probe(n.a);
      if (a === undefined || a.absent !== null) return a;
      const b = probe(n.b);
      return b === undefined ? undefined : { keys: union(a.keys, b.keys), absent: b.absent };
    }
    case "filter": {
      const a = probe(n.a);
      if (a === undefined) return undefined;
      if (n.name === "default") {
        if (!isEmpty(a.absent)) return a;
        const d = n.args[0] === undefined ? { keys: new Set<string>(), absent: "" } : probe(n.args[0]);
        return d === undefined ? undefined : { keys: union(a.keys, d.keys), absent: d.absent };
      }
      const v = applyFilter(n.name, a.absent);
      return v === undefined ? undefined : { keys: a.keys, absent: v };
    }
    default: return undefined;
  }
}

function truthy(v: Lit): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !(v === null || v === false || v === 0 || v === "" || v === "0");
}

const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;

/** Loose ordering of two template values: negative, zero or positive; undefined where it is not decided here. */
function looseCompare(x: Lit, y: Lit): number | undefined {
  if (x === null && typeof y === "string") x = "";
  if (y === null && typeof x === "string") y = "";
  if (x === null || y === null || typeof x === "boolean" || typeof y === "boolean") return Number(truthy(x)) - Number(truthy(y));
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x)) return -1;
    if (!Array.isArray(y)) return 1;
    if (x.length !== y.length) return x.length - y.length;
    return x.every((e, i) => looseCompare(e, y[i]!) === 0) ? 0 : undefined;
  }
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "number" && NUMERIC.test(y as string)) return x - Number(y);
  if (typeof y === "number" && NUMERIC.test(x as string)) return Number(x) - y;
  if (typeof x === "string" && typeof y === "string" && NUMERIC.test(x) && NUMERIC.test(y)) return Number(x) - Number(y);
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

/** A comparison's result with both operands known; undefined where it is not decided here. */
function evalCmp(op: string, x: Lit, y: Lit): boolean | undefined {
  const c = (): number | undefined => looseCompare(x, y);
  const r = (v: number | undefined, f: (n: number) => boolean): boolean | undefined => (v === undefined ? undefined : f(v));
  switch (op) {
    case "==": return r(c(), (n) => n === 0);
    case "!=": return r(c(), (n) => n !== 0);
    case "<": return r(c(), (n) => n < 0);
    case ">": return r(c(), (n) => n > 0);
    case "<=": return r(c(), (n) => n <= 0);
    case ">=": return r(c(), (n) => n >= 0);
    case "in":
    case "not in": {
      if (!Array.isArray(y)) return undefined;
      const hits = y.map((e) => looseCompare(x, e));
      const found = hits.some((h) => h === 0) ? true : hits.some((h) => h === undefined) ? undefined : false;
      return found === undefined ? undefined : op === "in" ? found : !found;
    }
    case "starts with":
    case "ends with":
      if (typeof y !== "string" || (x !== null && typeof x !== "string")) return undefined;
      return op === "starts with" ? (x ?? "").startsWith(y) : (x ?? "").endsWith(y);
    default:
      return undefined;
  }
}

/** An `is` test's result on an absent arg; undefined where it is not decided here. */
function evalTest(test: string, subject: Node, absent: Lit, args: Node[]): boolean | undefined {
  switch (test) {
    case "defined": return subject.k !== "ref";
    case "null":
    case "none": return absent === null;
    case "empty": return isEmpty(absent);
    case "iterable": return Array.isArray(absent);
    case "even":
    case "odd": {
      const n = typeof absent === "number" ? absent : 0;
      return test === "even" ? n % 2 === 0 : n % 2 !== 0;
    }
    case "same as": {
      const a = args[0];
      return a?.k === "lit" && !Array.isArray(a.v) ? absent === a.v : undefined;
    }
    default: return undefined;
  }
}

/** A leaf decided by its value on an absent arg: false then guarantees the arg when true, true guarantees it when false. */
function decided(keys: Set<string>, onAbsent: boolean | undefined): Guard {
  // With two args absent together, a result says only that one of them is present.
  if (onAbsent === undefined || keys.size !== 1) return NONE;
  return onAbsent ? { t: new Set(), f: keys } : { t: keys, f: new Set() };
}

function guard(n: Node): Guard {
  switch (n.k) {
    case "not": {
      const g = guard(n.a);
      return { t: g.f, f: g.t };
    }
    case "and": {
      const a = guard(n.a);
      const b = guard(n.b);
      return { t: union(a.t, b.t), f: inter(a.f, b.f) };
    }
    case "or": {
      const a = guard(n.a);
      const b = guard(n.b);
      return { t: inter(a.t, b.t), f: union(a.f, b.f) };
    }
    case "cond": {
      const c = guard(n.c);
      const a = guard(n.a);
      const b = guard(n.b);
      return { t: inter(union(c.t, a.t), union(c.f, b.t)), f: inter(union(c.t, a.f), union(c.f, b.f)) };
    }
    case "coalesce": {
      // `a ?? b` is a when a is not null, else b — a literal b decides one side outright,
      // and on an absent arg the expression takes b's value, which decides the other side.
      const a = guard(n.a);
      if (n.b.k === "lit") {
        const own = truthy(n.b.v) ? { t: new Set<string>(), f: a.f } : { t: a.t, f: new Set<string>() };
        const p = probe(n);
        const d = p === undefined ? NONE : decided(p.keys, truthy(p.absent));
        return { t: union(own.t, d.t), f: union(own.f, d.f) };
      }
      const b = guard(n.b);
      return { t: inter(a.t, b.t), f: inter(a.f, b.f) };
    }
    case "cmp": {
      const pa = probe(n.a);
      const pb = probe(n.b);
      if (pa === undefined || pb === undefined) return NONE;
      return decided(union(pa.keys, pb.keys), evalCmp(n.op, pa.absent, pb.absent));
    }
    case "is": {
      const p = probe(n.a);
      if (p === undefined) return NONE;
      const r = evalTest(n.test, n.a, p.absent, n.args);
      return decided(p.keys, r === undefined ? undefined : r !== n.neg);
    }
    default: {
      const p = probe(n);
      return p === undefined ? NONE : decided(p.keys, truthy(p.absent));
    }
  }
}

/** The args a condition guarantees; an unreadable one is taken to guarantee every arg it names when true. */
function conditionGuard(expr: string): Guard {
  const n = parse(expr);
  if (n !== undefined) return guard(n);
  return { t: new Set([...expr.matchAll(/\$args\.([A-Za-z_]\w*)/g)].map((m) => m[1]!)), f: new Set() };
}

/** The args whose value an expression prints, less those its own ternary, `?:`, `??` or `|default` covers. */
function printed(n: Node): Set<string> {
  switch (n.k) {
    case "ref": return new Set([n.key]);
    case "filter":
      return n.args.reduce((s, a) => union(s, printed(a)), n.name === "default" ? new Set<string>() : printed(n.a));
    case "cond": {
      const g = guard(n.c);
      return union(minus(printed(n.a), g.t), minus(printed(n.b), g.f));
    }
    case "coalesce": {
      return union(minus(printed(n.a), probe(n.a)?.keys ?? new Set()), printed(n.b));
    }
    case "other": return n.kids.reduce((s, k) => union(s, printed(k)), new Set<string>());
    default: return new Set();
  }
}

type Piece = { kind: "print"; body: string } | { kind: "tag"; name: string; body: string };

const OPEN = /\{[{%#]/g;

/** The print and tag pieces of a template, in order; comments and `{% verbatim %}` content dropped. */
function scan(template: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < template.length) {
    OPEN.lastIndex = i;
    const open = OPEN.exec(template);
    if (open === null) break;
    const at = open.index;
    const kind = template[at + 1]!;
    if (kind === "#") {
      const close = template.indexOf("#}", at + 2);
      i = close < 0 ? template.length : close + 2;
      continue;
    }
    const closer = kind === "{" ? "}}" : "%}";
    let j = at + 2;
    let quote: string | undefined;
    for (; j < template.length; j++) {
      const ch = template[j]!;
      if (quote !== undefined) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (template.startsWith(closer, j)) break;
    }
    const body = template.slice(at + 2, j).replace(/^[-~]/, "").replace(/[-~]$/, "");
    i = j + 2;
    if (kind === "{") {
      out.push({ kind: "print", body });
      continue;
    }
    const m = /^\s*(\w+)([\s\S]*)$/.exec(body);
    if (m === null) continue;
    const name = m[1]!;
    if (name === "verbatim" || name === "raw") {
      const end = new RegExp(`\\{%[-~]?\\s*end${name}\\s*[-~]?%\\}`).exec(template.slice(i));
      i = end === null ? template.length : i + end.index + end[0].length;
      continue;
    }
    out.push({ kind: "tag", name, body: m[2]! });
  }
  return out;
}

/** Block tags that open a body closed by `end<name>`, with no bearing on args. */
const BLOCK_TAGS = new Set(["block", "apply", "autoescape", "embed", "filter", "macro", "sandbox", "spaceless", "with", "cache", "set"]);

interface Frame {
  tag: string;
  /** Guaranteed in the current branch. */
  cur: Set<string>;
  /** Guaranteed by the falsity of every earlier branch's test (an `if` chain). */
  failed: Set<string>;
  last: Guard;
}

/**
 * The `$args.x` keys a prompt template prints where x may be absent. A print is
 * covered by its own `|default`, `??`, `?:` or ternary, or by an enclosing
 * branch that only runs with x present — `{% if %}`/`{% elseif %}`/`{% else %}`
 * by the guarantees of its tests, a `{% for … in $args.x %}` body by x.
 * Comments and `{% verbatim %}` are never rendered.
 */
export function unguardedArgPlaceholders(template: string): Set<string> {
  const out = new Set<string>();
  const frames: Frame[] = [];
  for (const p of scan(template)) {
    if (p.kind === "print") {
      const n = parse(p.body);
      const keys = n !== undefined ? printed(n) : leadingRef(p.body);
      for (const key of keys) if (!frames.some((f) => f.cur.has(key))) out.add(key);
      continue;
    }
    const top = frames[frames.length - 1];
    if (p.name === "if") {
      const g = conditionGuard(p.body);
      frames.push({ tag: "if", cur: g.t, failed: new Set(), last: g });
    } else if (p.name === "elseif" && top?.tag === "if") {
      top.failed = union(top.failed, top.last.f);
      top.last = conditionGuard(p.body);
      top.cur = union(top.failed, top.last.t);
    } else if (p.name === "else" && (top?.tag === "if" || top?.tag === "for")) {
      top.failed = union(top.failed, top.last.f);
      top.last = NONE;
      top.cur = top.failed;
    } else if (p.name === "for") {
      const m = /^\s*[\w$]+(?:\s*,\s*[\w$]+)?\s+in\s+([\s\S]*)$/.exec(p.body);
      const iter = m === null ? undefined : parse(m[1]!);
      const g = iter === undefined ? NONE : guard(iter);
      frames.push({ tag: "for", cur: g.t, failed: new Set(), last: g });
    } else if (BLOCK_TAGS.has(p.name) && !(p.name === "set" && /=/.test(p.body))) {
      frames.push({ tag: p.name, cur: new Set(), failed: new Set(), last: NONE });
    } else if (p.name.startsWith("end")) {
      const tag = p.name.slice(3);
      const at = frames.map((f) => f.tag).lastIndexOf(tag);
      if (at >= 0) frames.length = at;
    }
  }
  return out;
}

/** An unreadable print: its leading `$args.x`, unless a fallback follows it. */
function leadingRef(body: string): Set<string> {
  const m = /^\s*\$args\.([A-Za-z_]\w*)([\s\S]*)$/.exec(body);
  return m === null || /\|\s*default\b|\?/.test(m[2]!) ? new Set() : new Set([m[1]!]);
}
