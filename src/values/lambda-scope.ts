/**
 * Scope-aware reference finding over a MASKED function source (strings,
 * comments, regex and template text already blanked by `maskNonCode`).
 *
 * Answers one question: does this code READ identifier `name` as a free
 * variable? A property access (`$var.total`), an object-literal key
 * (`{ total: 1 }`, `{ total() {} }`) and a name declared by a local — `let`,
 * `const`, `var`, a parameter, a `catch` binding, a destructuring pattern, an
 * inner `function`/`class` — in a scope enclosing the occurrence are not free
 * reads. Neither is a class member name (`total = 1`, `total() {}`), a
 * statement label (`total:`, `continue total`), or a name in a TypeScript type
 * position (`: total`, `as total`, a `type total = …` alias). A shorthand
 * property (`{ total }`) is a read.
 *
 * A tokenizer plus bracket matching, not a parser: no runtime dependency on a
 * compiler. Where the shapes below do not recognize a construct the answer
 * leans towards "not a free read", because the caller turns a free read into a
 * build error and refusing correct code is the worse failure.
 */

import { IDENT } from "./lambda-ident.js";

interface Token {
  text: string;
  kind: "id" | "num" | "punc";
  /** A line break sits between this token and the previous one. */
  nl: boolean;
}

const PUNCTUATORS = ["...", "=>", "?.", "??", "&&", "||", "==", "!=", "<=", ">="];

/** An identifier, or a `#private` name (one token, so its name is never a read). */
const ID_AT = new RegExp(`^#?${IDENT}`, "u");

function tokenize(mask: string): Token[] {
  const out: Token[] = [];
  let nl = false;
  let i = 0;
  while (i < mask.length) {
    const ch = mask[i]!;
    if (ch === "\n") {
      nl = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const id = ID_AT.exec(mask.slice(i, i + 256));
    if (id) {
      out.push({ text: id[0], kind: "id", nl });
      i += id[0].length;
    } else if (/[0-9]/.test(ch)) {
      const num = /^[0-9][0-9A-Za-z_.]*/.exec(mask.slice(i, i + 64))![0];
      out.push({ text: num, kind: "num", nl });
      i += num.length;
    } else {
      const multi = PUNCTUATORS.find((p) => mask.startsWith(p, i));
      const text = multi ?? ch;
      out.push({ text, kind: "punc", nl });
      i += text.length;
    }
    nl = false;
  }
  return out;
}

const OPEN: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

/** Index of each bracket's partner; -1 where unbalanced. */
function matchBrackets(toks: Token[]): number[] {
  const match = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== "punc") return;
    if (OPEN[t.text] !== undefined) stack.push(i);
    else if (CLOSE.has(t.text)) {
      const open = stack.pop();
      if (open !== undefined && OPEN[toks[open]!.text] === t.text) {
        match[open] = i;
        match[i] = open;
      }
    }
  });
  return match;
}

/** Keywords that end a statement head, after which `{` opens a block. */
const BLOCK_AFTER_WORD = new Set(["else", "do", "try", "finally", "catch"]);
/** Keywords never taken as a binding or a reference. */
const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export",
  "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new", "null", "of",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "await", "async", "undefined",
]);
/** Words before `(` that make the parenthesis a statement head, not a call or a parameter list. */
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with", "return", "typeof", "await", "yield", "new"]);

interface Scope {
  name: string;
  from: number;
  to: number;
}

class Analysis {
  readonly toks: Token[];
  readonly match: number[];
  /** Brace index → true when it opens an object literal (or object pattern) rather than a block. */
  readonly objectBrace = new Map<number, boolean>();
  /** Token indices that are a binding's own declaration site. */
  readonly declSites = new Set<number>();
  readonly scopes: Scope[] = [];
  /** Brace indices that open a class body. */
  readonly classBodies = new Set<number>();
  /** [from, to] token ranges that are TypeScript type positions, never value reads. */
  readonly typeRanges: Array<[number, number]> = [];
  /** [from, to] ranges of function bodies (parameters included), outermost first. */
  readonly functions: Array<[number, number]> = [];

  /** Index of the leading `function` keyword of the analysed function, or -1. */
  readonly header: number;

  constructor(mask: string, header: boolean) {
    this.toks = tokenize(mask);
    this.header = !header ? -1 : this.t(0) === "function" ? 0 : this.t(0) === "async" && this.t(1) === "function" ? 1 : -1;
    this.match = matchBrackets(this.toks);
    this.functions.push([0, this.toks.length]);
    this.classifyBraces();
    this.collect();
  }

  private t(i: number): string {
    return this.toks[i]?.text ?? "";
  }

  private classifyBraces(): void {
    // The innermost open bracket at each point, so a `:` can be placed.
    const open: number[] = [];
    this.toks.forEach((tok, i) => {
      if (tok.kind !== "punc") return;
      if (CLOSE.has(tok.text)) {
        if (open.length > 0 && this.match[open[open.length - 1]!] === i) open.pop();
        return;
      }
      if (tok.text === "(" || tok.text === "[") open.push(i);
      if (tok.text !== "{") return;
      const prev = this.toks[i - 1];
      let object: boolean;
      if (prev === undefined) object = false;
      else if (prev.text === ":" && prev.kind === "punc") object = !this.statementColon(i - 1, open[open.length - 1]);
      else if (prev.kind === "punc") object = !["=>", ")", "{", "}", ";"].includes(prev.text);
      else if (prev.kind === "id") object = !BLOCK_AFTER_WORD.has(prev.text) && KEYWORDS.has(prev.text);
      else object = false;
      // `const {` / `let {` / `(` … — a destructuring pattern reads like an object.
      this.objectBrace.set(i, object);
      open.push(i);
    });
  }

  /**
   * Whether the `:` at `colon` ends a `case …:` / `default:` clause or a
   * statement label — after which `{` opens a block — rather than an object
   * key, a ternary's second branch or a type annotation. `enclosing` is the
   * innermost open bracket. Only a colon sitting directly in a block (or at
   * the top level) can be one; there the statement is read back to its start.
   */
  private statementColon(colon: number, enclosing: number | undefined): boolean {
    if (enclosing !== undefined && (this.t(enclosing) !== "{" || this.objectBrace.get(enclosing) === true)) return false;
    // A class body holds members, whose `name: Type` is an annotation.
    for (let k = (enclosing ?? 0) - 1; k >= 0 && ![";", "{", "}"].includes(this.t(k)); k--) {
      if (this.t(k) === "class") return false;
    }
    // A statement starts after `;`, a brace, a clause's `:`, `else`/`do`, or a control head's `)`.
    const boundary = (k: number): boolean =>
      k < 0 ||
      k === enclosing ||
      [";", "{", "}", ":"].includes(this.t(k)) ||
      (this.toks[k]!.kind === "id" && BLOCK_AFTER_WORD.has(this.t(k))) ||
      (this.t(k) === ")" && this.match[k]! > 0 && ["if", "for", "while", "with"].includes(this.t(this.match[k]! - 1)));
    // `case` straight before the colon: its operand was a masked string.
    if (this.t(colon - 1) === "case") return true;
    // A label, or `default`: one word that starts the statement.
    if (this.toks[colon - 1]?.kind === "id" && boundary(colon - 2) && this.t(colon - 2) !== "?") {
      return this.t(colon - 1) === "default" || !KEYWORDS.has(this.t(colon - 1));
    }
    // `case <expr>:` — balanced ternaries between `case` and this colon.
    let questions = 0;
    let colons = 0;
    for (let k = colon - 1; k > (enclosing ?? -1); k--) {
      const closer = CLOSE.has(this.t(k)) ? this.match[k]! : -1;
      if (closer >= 0) {
        k = closer;
        continue;
      }
      const text = this.t(k);
      if (text === "case") return questions === colons;
      if (text === ";" || text === "{" || text === "}") return false;
      if (text === "?") questions++;
      if (text === ":") colons++;
    }
    return false;
  }

  /**
   * Skip forward from `i` to the first token in `stops` at bracket depth 0, a
   * closer of an enclosing bracket, or (with `asi`) a line break that ends the
   * statement (never before the first token). `angles` counts `<`/`>` as brackets, for type annotations.
   */
  private skip(i: number, stops: string[], angles = false, asi = true): number {
    let depth = 0;
    let angle = 0;
    const start = i;
    for (; i < this.toks.length; i++) {
      const tok = this.toks[i]!;
      if (depth === 0 && angle === 0 && stops.includes(tok.text)) return i;
      if (tok.kind === "punc") {
        if (OPEN[tok.text] !== undefined) {
          depth++;
          continue;
        }
        if (CLOSE.has(tok.text)) {
          if (depth === 0) return i;
          depth--;
          continue;
        }
        if (angles && tok.text === "<") angle++;
        if (angles && tok.text === ">" && angle > 0) {
          angle--;
          continue;
        }
      }
      if (depth > 0 || angle > 0) continue;
      // A line break before the first token cannot end a statement that has not started.
      if (asi && tok.nl && tok.kind !== "punc" && i !== start) {
        const prev = this.toks[i - 1];
        if (prev && (prev.kind !== "punc" || [")", "]", "}"].includes(prev.text))) return i;
      }
    }
    return i;
  }

  private declare(name: string, site: number, from: number, to: number): void {
    this.declSites.add(site);
    this.scopes.push({ name, from, to });
  }

  /** Bind every name in the pattern at `i`; returns the index after it. */
  private pattern(i: number, from: number, to: number): number {
    const tok = this.toks[i];
    if (tok === undefined) return i;
    if (tok.text === "...") return this.pattern(i + 1, from, to);
    if (tok.kind === "id") {
      if (!KEYWORDS.has(tok.text)) this.declare(tok.text, i, from, to);
      return i + 1;
    }
    if (tok.text === "{" || tok.text === "[") {
      const end = this.match[i]!;
      if (end < 0) return i + 1;
      if (tok.text === "{") this.objectBrace.set(i, true);
      let j = i + 1;
      while (j < end) {
        if (this.t(j) === ",") {
          j++;
          continue;
        }
        if (tok.text === "{") {
          if (this.t(j) === "...") {
            j = this.pattern(j + 1, from, to);
          } else {
            // A key: an identifier, or `[computed]`, or a masked string (then `:` comes first).
            let key = j;
            if (this.t(j) === "[") key = this.match[j]! >= 0 ? this.match[j]! : j;
            if (this.t(key + 1) === ":") j = this.pattern(key + 2, from, to);
            else if (this.t(j) === ":") j = this.pattern(j + 1, from, to);
            else j = this.pattern(j, from, to);
          }
        } else {
          j = this.pattern(j, from, to);
        }
        if (this.t(j) === "=") j = this.skip(j + 1, [","], false, false);
        // Anything unrecognized: move on to the next element.
        if (j < end && this.t(j) !== ",") j = this.skip(j, [","], false, false);
      }
      return end + 1;
    }
    return i + 1;
  }

  /** A parameter list `(` … `)` at `open`, binding into [from, to]. */
  private params(open: number, from: number, to: number): void {
    const close = this.match[open]!;
    let j = open + 1;
    while (j < close) {
      if (this.t(j) === ",") {
        j++;
        continue;
      }
      if (this.t(j) === "this" && this.t(j + 1) === ":") {
        j = this.annotation(j + 2, [","]);
        continue;
      }
      j = this.pattern(j, from, to);
      if (this.t(j) === "?") j++;
      if (this.t(j) === ":") j = this.annotation(j + 1, [",", "="]);
      if (this.t(j) === "=") j = this.skip(j + 1, [","], false, false);
      if (j < close && this.t(j) !== ",") j = this.skip(j, [","], false, false);
    }
  }

  /** Index of the `{` opening a body after `)` at `close`, skipping a return-type annotation. */
  private bodyBrace(close: number): number {
    let j = close + 1;
    if (this.t(j) === ":") j = this.annotation(j + 1, ["{", "=>"]);
    return this.t(j) === "{" ? j : -1;
  }

  /** Skip a type annotation starting at `from`, recording it as a type position. */
  private annotation(from: number, stops: string[], asi = false): number {
    const end = this.skip(from, stops, true, asi);
    this.typeRanges.push([from, end - 1]);
    return end;
  }

  /** The end of an arrow body starting at `start`. */
  private arrowEnd(start: number): number {
    if (this.t(start) === "{" && this.match[start]! >= 0) return this.match[start]!;
    return this.skip(start, [",", ";"]);
  }

  private enclosingBlock(i: number): [number, number] {
    let best: [number, number] = [0, this.toks.length];
    for (let k = i - 1; k >= 0; k--) {
      if (this.t(k) !== "{" || this.objectBrace.get(k)) continue;
      const close = this.match[k]!;
      if (close > i) {
        best = [k, close];
        break;
      }
    }
    return best;
  }

  private enclosingFunction(i: number): [number, number] {
    let best = this.functions[0]!;
    for (const range of this.functions) {
      if (range[0] <= i && range[1] >= i && range[0] >= best[0]) best = range;
    }
    return best;
  }

  private collect(): void {
    const toks = this.toks;
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!;
      const prev = this.t(i - 1);
      if (prev === "." || prev === "?.") continue;

      // `(` … `)` — an arrow's, a function's or a method's parameter list, or a catch binding.
      if (tok.text === "(" && this.match[i]! > i) {
        const close = this.match[i]!;
        const before = toks[i - 1];
        let arrow = this.t(close + 1) === "=>" ? close + 1 : -1;
        if (arrow < 0 && this.t(close + 1) === ":") {
          const k = this.skip(close + 2, ["=>", "{", ";", ","], true, false);
          if (this.t(k) === "=>") {
            arrow = k;
            this.typeRanges.push([close + 2, k - 1]);
          }
        }
        if (arrow >= 0) {
          const end = this.arrowEnd(arrow + 1);
          this.functions.push([i, end]);
          this.params(i, i, end);
          continue;
        }
        if (before?.text === "catch") {
          const body = close + 1;
          if (this.t(body) === "{" && this.match[body]! > body) this.params(i, i, this.match[body]!);
          continue;
        }
        const isFunction =
          before?.text === "function" ||
          (before?.kind === "id" && !CONTROL.has(before.text) && (this.t(i - 2) === "function" || this.t(i - 2) === "*")) ||
          // A method: `name(` … `) {` directly inside an object literal or class body.
          (before?.kind === "id" && !CONTROL.has(before.text) && !KEYWORDS.has(before.text) && this.bodyBrace(close) >= 0 &&
            [",", "{", "}", ";", "get", "set", "async", "static"].includes(this.t(i - 2)));
        if (isFunction) {
          const body = this.bodyBrace(close);
          if (body >= 0 && this.match[body]! > body) {
            const end = this.match[body]!;
            this.functions.push([i, end]);
            this.params(i, i, end);
          }
        }
        continue;
      }

      if (tok.kind !== "id") continue;

      // `x as T` / `x satisfies T` — the type that follows.
      if ((tok.text === "as" || tok.text === "satisfies") && toks[i + 1]?.kind === "id" && i > 0) {
        this.typeRanges.push([i + 1, i + 1]);
        continue;
      }

      // `type T = …` / `interface T { … }` — a type declaration, all of it a type position.
      if ((tok.text === "type" || tok.text === "interface") && toks[i + 1]?.kind === "id" && !toks[i + 1]!.nl &&
        ["=", "<", "{", "extends"].includes(this.t(i + 2)) && (i === 0 || tok.nl || [";", "{", "}"].includes(prev))) {
        const end = tok.text === "type"
          ? this.skip(i + 2, [";"], true)
          : (() => {
              const brace = this.skip(i + 2, ["{"], true, false);
              return this.match[brace]! > brace ? this.match[brace]! : brace;
            })();
        this.declSites.add(i + 1);
        this.typeRanges.push([i + 1, end]);
        i = end;
        continue;
      }

      // `class X extends Y {` — mark the body, whose member names are not reads.
      if (tok.text === "class") {
        const brace = this.skip(i + 1, ["{"], true, false);
        if (this.t(brace) === "{") {
          this.classBodies.add(brace);
          this.objectBrace.set(brace, false);
        }
      }

      // `x => …` — a single unparenthesized parameter.
      if (this.t(i + 1) === "=>" && !KEYWORDS.has(tok.text)) {
        const end = this.arrowEnd(i + 2);
        this.functions.push([i, end]);
        this.declare(tok.text, i, i, end);
        continue;
      }

      if (tok.text === "let" || tok.text === "const" || tok.text === "var") {
        // `for (let x of …) body` — scoped to the loop.
        let range: [number, number];
        if (prev === "(" && this.t(i - 2) === "for") {
          const close = this.match[i - 1]!;
          const body = close + 1;
          const end = this.t(body) === "{" && this.match[body]! > body ? this.match[body]! : this.skip(body, [";"]);
          range = tok.text === "var" ? this.enclosingFunction(i) : [i, end];
        } else {
          range = tok.text === "var" ? this.enclosingFunction(i) : this.enclosingBlock(i);
        }
        let j = i + 1;
        for (;;) {
          j = this.pattern(j, range[0], range[1]);
          if (this.t(j) === "!") j++;
          if (this.t(j) === ":") j = this.annotation(j + 1, ["=", ",", ";", "of", "in"], true);
          if (this.t(j) === "=") j = this.skip(j + 1, [",", ";"]);
          if (this.t(j) !== ",") break;
          j++;
        }
        continue;
      }

      if ((tok.text === "function" || tok.text === "class") && toks[i + 1]?.kind === "id") {
        const nameAt = i + 1;
        const [from, to] = tok.text === "function" ? this.enclosingFunction(i) : this.enclosingBlock(i);
        // The exported function's own header name is not a local: only the body is sent.
        if (i === this.header) continue;
        this.declare(this.t(nameAt), nameAt, from, to);
      }
    }
  }

  /** Whether the identifier at `i` is an object-literal key rather than a read. */
  isKey(i: number): boolean {
    const prev = this.t(i - 1);
    const next = this.t(i + 1);
    let opener = -1;
    if (prev === "{") opener = i - 1;
    else if (prev === "," || ["get", "set", "async"].includes(prev)) {
      // Find the bracket this element sits in.
      let depth = 0;
      for (let k = i - 1; k >= 0; k--) {
        const t = this.t(k);
        if (CLOSE.has(t)) depth++;
        else if (OPEN[t] !== undefined) {
          if (depth === 0) {
            opener = k;
            break;
          }
          depth--;
        }
      }
    }
    if (opener < 0 || this.t(opener) !== "{" || !this.objectBrace.get(opener)) return false;
    return next === ":" || next === "(";
  }

  /** Index of the bracket directly enclosing token `i`, or -1. */
  private opener(i: number): number {
    for (let k = i - 1; k >= 0; k--) {
      const m = this.match[k]!;
      if (OPEN[this.t(k)] !== undefined && (m > i || m < 0)) return k;
      if (CLOSE.has(this.t(k)) && m >= 0) k = m;
    }
    return -1;
  }

  /** A class member's name: `total = 1`, `total: T`, `total() {}`, `static total`. */
  isClassMember(i: number): boolean {
    if (!this.classBodies.has(this.opener(i))) return false;
    const prev = this.t(i - 1);
    const lead = ["{", ";", "}", "static", "readonly", "private", "public", "protected", "declare", "override", "accessor", "async", "get", "set", "*"];
    if (!lead.includes(prev) && !this.toks[i]!.nl) return false;
    const next = this.toks[i + 1];
    return next === undefined || next.nl || ["=", ";", ":", "?", "!", "(", "}", "<"].includes(next.text);
  }

  /** A statement label (`total: for …`) or a jump to one (`continue total`). */
  isLabel(i: number): boolean {
    const prev = this.t(i - 1);
    if ((prev === "break" || prev === "continue") && !this.toks[i]!.nl) return true;
    if (this.t(i + 1) !== ":") return false;
    // After a line break only where ASI ends the statement — not `cond ?\n total : 0`.
    const asi = this.toks[i]!.nl && this.toks[i - 1]?.kind !== "punc";
    if (!(i === 0 || asi || [";", "{", "}"].includes(prev))) return false;
    const open = this.opener(i);
    return open < 0 || (this.t(open) === "{" && !this.objectBrace.get(open) && !this.classBodies.has(open));
  }

  /** Whether token `i` sits in a TypeScript type position. */
  inType(i: number): boolean {
    return this.typeRanges.some(([from, to]) => from <= i && i <= to);
  }

  /** Whether some declaration of `name` encloses token `i`. */
  shadowed(name: string, i: number): boolean {
    return this.scopes.some((s) => s.name === name && s.from <= i && i <= s.to);
  }
}

/** Whether the identifier token at `i` is read as a free variable. */
function isFreeRead(analysis: Analysis, i: number): boolean {
  const toks = analysis.toks;
  const tok = toks[i]!;
  const prev = toks[i - 1]?.text;
  if (prev === "." || prev === "?.") return false;
  if (analysis.header >= 0 && i <= analysis.header + 2) return false;
  if (analysis.declSites.has(i)) return false;
  if (analysis.isKey(i)) return false;
  if (analysis.isClassMember(i) || analysis.isLabel(i) || analysis.inType(i)) return false;
  return !analysis.shadowed(tok.text, i);
}

/**
 * Whether `mask` reads `name` as a free variable anywhere. The name in a
 * leading `function name` header names the function and is not a read.
 */
export function readsFreeName(mask: string, name: string): boolean {
  const analysis = new Analysis(mask, true);
  return analysis.toks.some((tok, i) => tok.kind === "id" && tok.text === name && isFreeRead(analysis, i));
}

/**
 * Every distinct name a function BODY reads as a free variable, in source
 * order. Keywords are left out; a leading `function name` here is a local
 * declaration, not a header.
 */
export function freeReads(mask: string): string[] {
  const analysis = new Analysis(mask, false);
  const seen = new Set<string>();
  analysis.toks.forEach((tok, i) => {
    if (tok.kind !== "id" || tok.text.startsWith("#") || KEYWORDS.has(tok.text) || seen.has(tok.text)) return;
    if (isFreeRead(analysis, i)) seen.add(tok.text);
  });
  return [...seen];
}
