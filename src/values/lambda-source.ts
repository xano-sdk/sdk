/**
 * Locating a function inside JavaScript/TypeScript SOURCE TEXT — the structural
 * half of lambda extraction.
 *
 * A lambda body reaches the engine as text cut out of its source: the inline
 * form reads a live function back with `toString()`, and `lam.file` reads a
 * module. Cutting by `indexOf` heuristics emitted wrong bodies for legal code —
 * a return type's `{ y: number }` taken as the body, a concise body continued on
 * the next line truncated at the newline — and a wrong body is a wrong value at
 * HTTP 200. So the cut is made over TOKENS with matched brackets:
 *
 * - {@link scanSource} blanks every string, comment, template literal and regex
 *   literal, keeping offsets, and records where each one is;
 * - {@link tokenize} turns that into tokens, each opaque literal one token, with
 *   the line breaks the statement rules need;
 * - {@link parseFunctionExpression} reads one function — the `function` form or
 *   an arrow, behind optional parentheses and `as` / `satisfies` casts — skipping
 *   type parameters and return types with a small TYPE grammar rather than
 *   guessing which `{` or `=>` is the function's own.
 *
 * A tokenizer and a few grammar rules, not a parser: the SDK carries no compiler
 * at runtime. Where the rules cannot read a shape unambiguously they throw a
 * {@link SourceShapeError} at the offset that stopped them; callers turn that
 * into a refusal. Never a guess.
 */

/** A region of source that is not code. */
export interface NonCodeSpan {
  kind: "string" | "template" | "regex" | "comment";
  start: number;
  end: number;
}

/** {@link maskNonCode}'s output, with the outermost non-code regions it blanked. */
export interface ScannedSource {
  mask: string;
  spans: NonCodeSpan[];
}

/** Keywords a regex literal may directly follow (`return /re/`, `typeof /re/`). */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "instanceof", "throw",
]);

/** A character that continues a word: identifier characters, and the backslash of an identifier escape (`\u00E9`). */
const WORD_CHAR = /^(?:[\p{ID_Continue}$\\]|\u200C|\u200D)$/u;

/** Keywords a regex may follow that open a block, not an object literal, with `{`. */
const BLOCK_KEYWORDS = new Set(["do", "else"]);

/** Keywords whose parenthesized head is followed by a statement, where a `/` opens a regex. */
const CONTROL_HEADS = new Set(["if", "while", "for", "with"]);

/**
 * Blank out everything that is not code — string bodies, comments, and regex
 * literal bodies — replacing each character with a space so every index still
 * lines up with the original. A template literal's `${…}` substitutions are NOT
 * blanked: they are code, and `` `${$var.x}` `` has to resolve `$var` as a real
 * binding reference. Their delimiters read as ` (` and `)`, so a substitution is
 * the parenthesized expression it is — `${{ a: 1 }.a}` holds an object literal,
 * not a block.
 */
export function maskNonCode(src: string): string {
  return scanSource(src).mask;
}

/**
 * {@link maskNonCode}, also recording each outermost string, template, regex and
 * comment. A regex literal is told from division by what precedes the `/` — the
 * standard rule over the previous significant TOKEN: an operator (not a
 * postfix `++`/`--`), an opening bracket, a keyword that takes an operand (not
 * a property name such as `o.return`), a block's `}` (not an object literal's),
 * or the `)` closing an `if`/`while`/`for` head.
 */
export function scanSource(src: string): ScannedSource {
  const out: string[] = [];
  const spans: NonCodeSpan[] = [];
  // Template-literal nesting: each entry is the depth of `{` inside a `${…}`, or -1 in literal text.
  const templates: number[] = [];
  let templateStart = -1;
  // Whether each open `(` heads a control statement.
  const parens: boolean[] = [];
  let i = 0;
  // The previous significant token, as much of it as the regex rule needs: its
  // last character, the whole word when it was a word (and whether that word
  // is a property name, after `.` or `#`), and the run of punctuation it ended.
  let prevSignificant = "";
  let prevWord = "";
  let wordIsProperty = false;
  let wordOpen = false;
  let punctRun = "";
  let punctOpen = false;
  let afterControlHead = false;
  // Whether each open `{` is an object literal (whose `}` ends an operand) rather than a block.
  const braces: boolean[] = [];
  let closedObject = false;

  const at = (k: number): string => src[k] ?? "";
  const top = (): number => templates[templates.length - 1] ?? 0;
  const setTop = (v: number): void => {
    templates[templates.length - 1] = v;
  };
  const push = (ch: string, masked = false, shown?: string): void => {
    out.push(shown ?? (masked ? (ch === "\n" ? "\n" : " ") : ch));
    if (/\s/.test(ch)) {
      // A break ends the token: `x⏎return` is two words, `+ +` two operators.
      wordOpen = false;
      punctOpen = false;
      return;
    }
    const before = prevSignificant;
    prevSignificant = ch;
    afterControlHead = false;
    closedObject = false;
    if (!masked && WORD_CHAR.test(ch)) {
      if (wordOpen) prevWord += ch;
      else {
        prevWord = ch;
        wordIsProperty = before === "." || before === "#";
      }
      wordOpen = true;
      punctRun = "";
      punctOpen = false;
      return;
    }
    prevWord = "";
    wordOpen = false;
    if (masked) {
      punctRun = "";
      punctOpen = false;
    } else {
      punctRun = punctOpen ? punctRun + ch : ch;
      punctOpen = true;
    }
  };
  const record = (kind: NonCodeSpan["kind"], start: number): void => {
    if (templates.length === 0) spans.push({ kind, start, end: i });
  };
  /** Whether a `/` here opens a regex literal rather than dividing. */
  const regexHere = (): boolean => {
    if (prevSignificant === "" || afterControlHead) return true;
    if (prevWord !== "") return !wordIsProperty && REGEX_PRECEDING_KEYWORDS.has(prevWord);
    // `a++ / b`: a postfix update ends an operand, and so does an object literal's `}`.
    if (punctRun.endsWith("++") || punctRun.endsWith("--") || closedObject) return false;
    // A spread `[...re]` takes an operand; a lone `.` ends a member access.
    if (punctRun.endsWith("...")) return true;
    return "(,=:[!&|?{};+-*%~^<>/".includes(prevSignificant);
  };
  /** Whether a `{` here opens an object literal: it stands where an operand is expected. */
  const objectHere = (): boolean => {
    if (prevSignificant === "" || afterControlHead) return false;
    if (prevWord !== "") return !wordIsProperty && REGEX_PRECEDING_KEYWORDS.has(prevWord) && !BLOCK_KEYWORDS.has(prevWord);
    if (punctRun.endsWith("=>")) return false;
    if (punctRun.endsWith("...")) return true;
    return "(,=:[!&|?+-*%~^<>/".includes(prevSignificant);
  };

  while (i < src.length) {
    const ch = at(i);
    const next = at(i + 1);

    // Inside a template's `${…}`: track braces so the closing one returns us to the literal.
    if (templates.length > 0 && top() >= 0) {
      if (ch === "{") setTop(top() + 1);
      else if (ch === "}") {
        setTop(top() - 1);
        if (top() === 0) {
          setTop(-1);
          push(ch, true, ")");
          i++;
          continue;
        }
      }
    }

    // Template literal text.
    if (templates.length > 0 && top() === -1) {
      if (ch === "\\") {
        push(ch, true);
        push(at(i + 1), true);
        i += 2;
        continue;
      }
      if (ch === "`") {
        templates.pop();
        push(ch, true);
        i++;
        if (templates.length === 0) spans.push({ kind: "template", start: templateStart, end: i });
        continue;
      }
      if (ch === "$" && next === "{") {
        setTop(1);
        push(ch, true);
        push("{", true, "(");
        i += 2;
        continue;
      }
      push(ch, true);
      i++;
      continue;
    }

    const start = i;
    if (ch === "/" && (next === "/" || next === "*")) {
      // A comment is not significant: what precedes it still decides a following `/`.
      const saved: [string, string, boolean, string, boolean, boolean] =
        [prevSignificant, prevWord, wordIsProperty, punctRun, afterControlHead, closedObject];
      if (next === "/") {
        while (i < src.length && at(i) !== "\n") push(at(i++), true);
      } else {
        push(at(i++), true);
        push(at(i++), true);
        while (i < src.length && !(at(i) === "*" && at(i + 1) === "/")) push(at(i++), true);
        if (i < src.length) {
          push(at(i++), true);
          push(at(i++), true);
        }
      }
      [prevSignificant, prevWord, wordIsProperty, punctRun, afterControlHead, closedObject] = saved;
      // It does separate tokens, though.
      wordOpen = false;
      punctOpen = false;
      record("comment", start);
      continue;
    }
    if (ch === '"' || ch === "'") {
      push(ch, true);
      i++;
      while (i < src.length && at(i) !== ch && at(i) !== "\n") {
        if (at(i) === "\\") push(at(i++), true);
        if (i < src.length) push(at(i++), true);
      }
      if (at(i) === ch) push(at(i++), true);
      record("string", start);
      continue;
    }
    if (ch === "`") {
      if (templates.length === 0) templateStart = i;
      templates.push(-1);
      push(ch, true);
      i++;
      continue;
    }
    if (ch === "/" && regexHere()) {
      push(ch, true);
      i++;
      while (i < src.length && at(i) !== "\n") {
        if (at(i) === "\\") {
          push(at(i++), true);
          if (i < src.length) push(at(i++), true);
          continue;
        }
        if (at(i) === "[") {
          while (i < src.length && at(i) !== "]" && at(i) !== "\n") {
            if (at(i) === "\\") push(at(i++), true);
            if (i < src.length) push(at(i++), true);
          }
          continue;
        }
        if (at(i) === "/") {
          push(at(i++), true);
          break;
        }
        push(at(i++), true);
      }
      // Flags (`/re/gi`) belong to the literal.
      while (/[A-Za-z]/.test(at(i))) push(at(i++), true);
      record("regex", start);
      // A regex literal is a complete operand: a `/` after it divides.
      prevSignificant = "/";
      prevWord = "re";
      wordIsProperty = true;
      continue;
    }
    if (ch === "(") {
      parens.push(!wordIsProperty && CONTROL_HEADS.has(prevWord));
      push(ch);
      i++;
      continue;
    }
    if (ch === ")") {
      const control = parens.pop() ?? false;
      push(ch);
      afterControlHead = control;
      i++;
      continue;
    }
    if (ch === "{") {
      braces.push(objectHere());
      push(ch);
      i++;
      continue;
    }
    if (ch === "}") {
      const object = braces.pop() ?? false;
      push(ch);
      closedObject = object;
      i++;
      continue;
    }
    push(ch);
    i++;
  }
  // An unterminated template still has to be reported as one region.
  if (templates.length > 0) spans.push({ kind: "template", start: templateStart, end: src.length });
  return { mask: out.join(""), spans };
}

// --- tokens ----------------------------------------------------------------------

/** One token of source. Strings, templates and regex literals are single opaque tokens; comments are dropped. */
export interface Token {
  kind: "id" | "num" | "punct" | "string" | "template" | "regex";
  text: string;
  start: number;
  end: number;
  /** A line break sits between this token and the previous one. */
  nl: boolean;
}

/**
 * Punctuators, longest first. `<` and `>` are never combined: in a type they
 * close nested type arguments (`Array<Array<T>>`), and an expression only needs
 * them as "an operator follows".
 */
const PUNCTUATORS = [
  "...", "??=", "&&=", "||=", "**=", "===", "!==",
  "?.", "??", "=>", "==", "!=", "**", "*=", "+=", "-=", "/=", "%=", "&&", "||", "&=", "|=", "^=", "++", "--",
];

/** A tokenized source, with the index of each bracket's partner (-1 when unbalanced). */
export interface Tokens {
  src: string;
  toks: Token[];
  match: number[];
}

/** Tokenize `src`, matching `(`/`[`/`{` with their closers. */
export function tokenize(src: string): Tokens {
  const { mask, spans } = scanSource(src);
  const toks: Token[] = [];
  const spanAt = new Map(spans.map((s) => [s.start, s]));
  let nl = false;
  let i = 0;
  while (i < mask.length) {
    const span = spanAt.get(i);
    if (span !== undefined) {
      if (span.kind === "comment") {
        if (src.slice(span.start, span.end).includes("\n")) nl = true;
      } else {
        toks.push({ kind: span.kind, text: src.slice(span.start, span.end), start: span.start, end: span.end, nl });
        nl = false;
      }
      i = Math.max(span.end, i + 1);
      continue;
    }
    const ch = mask[i]!;
    if (ch === "\n" || ch === " " || ch === " ") {
      nl = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = mask.slice(i);
    const word = /^[\p{ID_Start}$_#\\](?:[\p{ID_Continue}$\\]|‌|‍)*/u.exec(rest)?.[0];
    const num = /^(?:\d|\.\d)[\w.]*/.exec(rest)?.[0];
    let kind: Token["kind"];
    let text: string;
    if (num !== undefined) [kind, text] = ["num", num];
    else if (word !== undefined) [kind, text] = ["id", word];
    else {
      kind = "punct";
      text = PUNCTUATORS.find((p) => rest.startsWith(p) && !(p === "?." && /\d/.test(rest[2] ?? ""))) ?? ch;
    }
    toks.push({ kind, text, start: i, end: i + text.length, nl });
    nl = false;
    i += text.length;
  }
  const match = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  toks.forEach((t, k) => {
    if (t.kind !== "punct") return;
    if (t.text === "(" || t.text === "[" || t.text === "{") stack.push(k);
    else if (pair[t.text] !== undefined) {
      const open = stack[stack.length - 1];
      if (open === undefined || toks[open]!.text !== pair[t.text]) return;
      stack.pop();
      match[open] = k;
      match[k] = open;
    }
  });
  return { src, toks, match };
}

// --- reading a function ----------------------------------------------------------

/** A shape the rules cannot read with certainty, at a source offset. */
export class SourceShapeError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "SourceShapeError";
  }
}

/** One function located in source. Ranges are source offsets, end-exclusive. */
export interface FunctionShape {
  form: "function" | "arrow";
  /** The parameter list, parentheses included — or the single unparenthesized parameter. */
  params: [number, number];
  /** Whether the body is a `{ … }` block. */
  block: boolean;
  /** The body: inside the braces for a block, the expression for a concise body. */
  body: [number, number];
  /** The function's own name, when the `function` form carries one. */
  name: string | undefined;
}

/** Keywords that leave an expression incomplete (they take an operand). */
const OPERAND_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "yield", "await", "case", "do",
  "else", "extends", "as", "satisfies", "keyof", "function", "class", "if", "while", "for", "with", "switch", "try",
  "catch", "finally", "const", "let", "var", "import", "export", "default", "is",
]);

/** Punctuators that can never continue an expression from the start of a new line. */
const NON_CONTINUING = new Set(["!", "~", "++", "--", "{", ";", "@", "#", "..."]);

/** Reads functions and types over one tokenized source. */
export class SourceReader {
  readonly src: string;
  readonly toks: Token[];
  readonly match: number[];

  constructor(tokens: Tokens) {
    this.src = tokens.src;
    this.toks = tokens.toks;
    this.match = tokens.match;
  }

  /** The source offset of token `i` (the end of the source past the last token). */
  offset(i: number): number {
    return this.toks[i]?.start ?? this.src.length;
  }

  isP(i: number, text: string): boolean {
    const t = this.toks[i];
    return t?.kind === "punct" && t.text === text;
  }

  isId(i: number, text?: string): boolean {
    const t = this.toks[i];
    return t?.kind === "id" && (text === undefined || t.text === text);
  }

  fail(message: string, i: number): never {
    throw new SourceShapeError(message, this.offset(i));
  }

  /** The partner of the bracket at `i`, or a refusal. */
  close(i: number): number {
    const c = this.match[i] ?? -1;
    if (c < 0) this.fail(`an unbalanced \`${this.toks[i]?.text ?? ""}\``, i);
    return c;
  }

  /** Whether token `t` completes an operand, so a line break after it may end the statement. */
  endsOperand(t: Token | undefined): boolean {
    if (t === undefined) return false;
    if (t.kind === "id") return !OPERAND_KEYWORDS.has(t.text);
    if (t.kind === "punct") return t.text === ")" || t.text === "]" || t.text === "}" || t.text === "++" || t.text === "--";
    return true;
  }

  /** Whether token `t`, at the start of a line, continues the expression before it. */
  continues(t: Token | undefined): boolean {
    if (t === undefined) return false;
    if (t.kind === "punct") return !NON_CONTINUING.has(t.text);
    if (t.kind === "id") return t.text === "in" || t.text === "instanceof";
    return t.kind === "template";
  }

  /**
   * Index past the expression starting at `i`: it ends at a `;`, at a closer
   * that belongs to an enclosing bracket, or at a line break where JavaScript's
   * automatic semicolon insertion ends it — the token before completes an
   * operand and the token after cannot continue one. A comma at this level
   * refuses: an arrow's body and a default export are each ONE assignment
   * expression, so a comma there means the rules have misread something.
   */
  expressionEnd(i: number): number {
    let k = i;
    let prev: Token | undefined;
    for (;;) {
      const t = this.toks[k];
      if (t === undefined) return k;
      if (k > i && t.nl && this.endsOperand(prev) && !this.continues(t)) return k;
      if (t.kind === "punct") {
        if (t.text === ";" || t.text === ")" || t.text === "]" || t.text === "}") return k;
        if (t.text === ",") this.fail("a comma outside every bracket", k);
        if (t.text === "(" || t.text === "[" || t.text === "{") {
          k = this.close(k);
          prev = this.toks[k];
          k++;
          continue;
        }
        // A type assertion's `!` is postfix; a generic call's type arguments hold commas of their own.
        if (t.text === "!" && !t.nl && this.endsOperand(prev)) {
          prev = { ...t, text: ")" };
          k++;
          continue;
        }
        if (t.text === "<" && !t.nl && this.endsOperand(prev)) {
          const after = this.tryTypeArguments(k);
          if (after !== -1) {
            k = after;
            prev = undefined;
            continue;
          }
        }
      }
      if ((t.kind === "id" && (t.text === "as" || t.text === "satisfies")) && !t.nl && this.endsOperand(prev)) {
        k = this.skipType(k + 1);
        prev = { ...t, text: ")", kind: "punct" };
        continue;
      }
      prev = t;
      k++;
    }
  }

  /** Index past `<…>` type arguments at `i` when a call or tagged template follows them, else -1. */
  private tryTypeArguments(i: number): number {
    try {
      const after = this.skipAngle(i);
      return this.isP(after, "(") || this.toks[after]?.kind === "template" ? after : -1;
    } catch {
      return -1;
    }
  }

  /** Index past the `<…>` type parameter or argument list at `i`. */
  skipAngle(i: number): number {
    if (!this.isP(i, "<")) this.fail("expected `<`", i);
    let depth = 0;
    for (let k = i; k < this.toks.length; k++) {
      const t = this.toks[k]!;
      if (t.kind !== "punct") continue;
      if (t.text === "<") depth++;
      else if (t.text === ">" && --depth === 0) return k + 1;
      else if (t.text === "(" || t.text === "[" || t.text === "{") k = this.close(k);
      else if (t.text === ";" || t.text === ")" || t.text === "]" || t.text === "}") break;
    }
    return this.fail("an unclosed `<`", i);
  }

  /**
   * Index past the TypeScript type starting at `i`: unions and intersections of
   * keyword-prefixed operands (`keyof`, `typeof`, `readonly`, `infer`), function
   * and constructor types, object and tuple types, names with type arguments,
   * literals, type predicates, array suffixes, and conditional types.
   */
  skipType(i: number, noConditional = false): number {
    let k = i;
    if (this.isP(k, "|") || this.isP(k, "&")) k++;
    k = this.skipTypeOperand(k);
    while (this.isP(k, "|") || this.isP(k, "&")) k = this.skipTypeOperand(k + 1);
    if (!noConditional && this.isId(k, "extends") && !this.toks[k]!.nl) {
      k = this.skipType(k + 1, true);
      if (!this.isP(k, "?")) this.fail("a conditional type without `?`", k);
      k = this.skipType(k + 1);
      if (!this.isP(k, ":")) this.fail("a conditional type without `:`", k);
      k = this.skipType(k + 1);
    }
    return k;
  }

  private skipTypeOperand(i: number): number {
    let k = i;
    while (this.isId(k, "keyof") || this.isId(k, "readonly") || this.isId(k, "unique")) k++;
    const t = this.toks[k];
    if (t === undefined) return this.fail("a type is missing", k);
    if (this.isId(k, "infer") && this.isId(k + 1)) {
      k += 2;
    } else if (this.isId(k, "typeof")) {
      k++;
      if (this.isId(k, "import") && this.isP(k + 1, "(")) k = this.close(k + 1) + 1;
      else if (this.isId(k)) k++;
      else this.fail("`typeof` without a name", k);
      k = this.skipQualified(k);
    } else if (this.isP(k, "(")) {
      const c = this.close(k);
      if (this.startsFunctionType(k)) {
        if (!this.isP(c + 1, "=>")) this.fail("a function type without `=>`", c + 1);
        return this.skipType(c + 2);
      }
      k = c + 1;
    } else if (this.isP(k, "<")) {
      k = this.skipAngle(k);
      if (!this.isP(k, "(")) this.fail("a generic function type without parameters", k);
      k = this.close(k) + 1;
      if (!this.isP(k, "=>")) this.fail("a generic function type without `=>`", k);
      return this.skipType(k + 1);
    } else if (this.isId(k, "new") || (this.isId(k, "abstract") && this.isId(k + 1, "new"))) {
      k += this.isId(k, "abstract") ? 2 : 1;
      if (this.isP(k, "<")) k = this.skipAngle(k);
      if (!this.isP(k, "(")) this.fail("a constructor type without parameters", k);
      k = this.close(k) + 1;
      if (!this.isP(k, "=>")) this.fail("a constructor type without `=>`", k);
      return this.skipType(k + 1);
    } else if (this.isP(k, "{") || this.isP(k, "[")) {
      k = this.close(k) + 1;
    } else if (t.kind === "string" || t.kind === "num" || t.kind === "template") {
      k++;
    } else if (this.isP(k, "-") && this.toks[k + 1]?.kind === "num") {
      k += 2;
    } else if (this.isId(k, "asserts") && this.isId(k + 1) && !this.isP(k + 1, ".")) {
      k += 2;
      if (this.isId(k, "is")) return this.skipType(k + 1);
      return k;
    } else if (this.isId(k, "import") && this.isP(k + 1, "(")) {
      k = this.skipQualified(this.close(k + 1) + 1);
    } else if (t.kind === "id") {
      k = this.skipQualified(k + 1);
      if (this.isId(k, "is") && !this.toks[k]!.nl) return this.skipType(k + 1);
    } else {
      return this.fail(`\`${t.text}\` where a type was expected`, k);
    }
    while (this.isP(k, "[") && !this.toks[k]!.nl) k = this.close(k) + 1;
    return k;
  }

  /**
   * Whether the `(` at `i` opens a function type's parameters rather than a
   * parenthesized type — TypeScript's own rule: `()`, `(...`, or a first
   * parameter (a name, `this`, or a pattern, after any modifier) followed by
   * `:` `,` `?` `=`, or alone and followed by `) =>`. So `(x: T) => U` and
   * `(x) => U` are function types and `(A | B)` is not.
   */
  private startsFunctionType(i: number): boolean {
    let k = i + 1;
    if (this.isP(k, ")") || this.isP(k, "...")) return true;
    while (["public", "private", "protected", "readonly"].includes(this.toks[k]?.text ?? "") && this.isId(k + 1)) k++;
    if (this.isId(k)) k++;
    else if ((this.isP(k, "[") || this.isP(k, "{")) && (this.match[k] ?? -1) > 0) k = this.match[k]! + 1;
    else return false;
    if (this.isP(k, ":") || this.isP(k, ",") || this.isP(k, "?") || this.isP(k, "=")) return true;
    return this.isP(k, ")") && this.isP(k + 1, "=>");
  }

  /** Past `.Name` segments and type arguments after a type name. */
  private skipQualified(i: number): number {
    let k = i;
    while (this.isP(k, ".") && this.isId(k + 1)) k += 2;
    if (this.isP(k, "<") && !this.toks[k]!.nl) k = this.skipAngle(k);
    return k;
  }

  /**
   * Read one function expression at token `i` — `function` or arrow, optionally
   * `async`, with type parameters, parameter annotations and a return type of any
   * shape — behind optional parentheses and trailing `as T` / `satisfies T` /
   * `!`. Returns the shape and the token index past everything read.
   */
  parseFunctionExpression(i: number): { fn: FunctionShape; end: number } {
    if (this.isP(i, "(")) {
      const c = this.close(i);
      if (!this.isP(c + 1, "=>") && !this.isP(c + 1, ":")) {
        const inner = this.parseFunctionExpression(i + 1);
        if (inner.end !== c) this.fail("more than one function inside the parentheses", inner.end);
        let k = c + 1;
        for (;;) {
          const t = this.toks[k];
          if (t !== undefined && !t.nl && (this.isId(k, "as") || this.isId(k, "satisfies"))) {
            k = this.skipType(k + 1);
          } else if (t !== undefined && !t.nl && this.isP(k, "!")) {
            k++;
          } else break;
        }
        return { fn: inner.fn, end: k };
      }
    }
    return this.parseFunction(i);
  }

  private parseFunction(i: number): { fn: FunctionShape; end: number } {
    let k = i;
    if (this.isId(k, "async") && !this.isP(k + 1, "=>") && this.toks[k + 1] !== undefined && !this.toks[k + 1]!.nl) k++;
    if (this.isId(k, "function")) {
      k++;
      if (this.isP(k, "*")) k++;
      let name: string | undefined;
      if (this.isId(k)) name = this.toks[k++]!.text;
      if (this.isP(k, "<")) k = this.skipAngle(k);
      if (!this.isP(k, "(")) this.fail("a `function` without a parameter list", k);
      const pc = this.close(k);
      const params: [number, number] = [this.toks[k]!.start, this.toks[pc]!.end];
      k = pc + 1;
      if (this.isP(k, ":")) k = this.skipType(k + 1);
      if (!this.isP(k, "{")) this.fail("a `function` whose body does not follow its signature", k);
      const bc = this.close(k);
      return {
        fn: { form: "function", params, block: true, body: [this.toks[k]!.end, this.toks[bc]!.start], name },
        end: bc + 1,
      };
    }
    if (this.isP(k, "<")) k = this.skipAngle(k);
    let params: [number, number];
    if (this.isP(k, "(")) {
      const pc = this.close(k);
      params = [this.toks[k]!.start, this.toks[pc]!.end];
      k = pc + 1;
      if (this.isP(k, ":")) k = this.skipType(k + 1);
    } else if (this.isId(k) && !OPERAND_KEYWORDS.has(this.toks[k]!.text)) {
      params = [this.toks[k]!.start, this.toks[k]!.end];
      k++;
    } else {
      return this.fail("no parameter list where a function starts", k);
    }
    if (!this.isP(k, "=>")) this.fail("no `=>` after the parameter list", k);
    k++;
    if (this.isP(k, "{")) {
      const bc = this.close(k);
      return {
        fn: { form: "arrow", params, block: true, body: [this.toks[k]!.end, this.toks[bc]!.start], name: undefined },
        end: bc + 1,
      };
    }
    const end = this.expressionEnd(k);
    if (end === k) this.fail("an arrow with no body", k);
    return {
      fn: { form: "arrow", params, block: false, body: [this.toks[k]!.start, this.toks[end - 1]!.end], name: undefined },
      end,
    };
  }

  /**
   * Index past the statement at `i` by the same line-break rules as
   * {@link expressionEnd}, commas allowed. For the top-level statements a lambda
   * module may carry beside its default export: imports, `declare`, and re-exports.
   */
  statementEnd(i: number): number {
    let k = i;
    let prev: Token | undefined;
    for (;;) {
      const t = this.toks[k];
      if (t === undefined) return k;
      if (k > i && t.nl && this.endsOperand(prev) && !this.continues(t)) return k;
      if (this.isP(k, ";")) return k + 1;
      if (this.isP(k, "(") || this.isP(k, "[") || this.isP(k, "{")) k = this.close(k);
      prev = this.toks[k];
      k++;
    }
  }
}

/** 1-based line of a source offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset && k < src.length; k++) if (src[k] === "\n") line++;
  return line;
}
