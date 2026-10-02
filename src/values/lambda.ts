/**
 * `lam.*` — write a lambda body as a real, typed TypeScript function instead of
 * an opaque string.
 *
 * Every JavaScript surface in Xano takes its body as text: the lambda statement's
 * `code` field, and the code argument of `fl.map` / `filter` / `some` / `every` /
 * `find` / `findIndex` / `reduce` / `lambda`. That text runs against a small,
 * closed set of injected identifiers — and which ones are in scope depends on
 * WHICH surface it is. Getting it wrong is silent: an author reached for `$acc` as
 * the reduce accumulator, the real name is `$result`, and the first signal was a
 * wrong value at runtime, because a body that throws comes back as its own
 * diagnostic text in the value slot with HTTP 200.
 *
 * So the binding set is the type here. The author writes an arrow function whose
 * first parameter destructures the bindings; the editor supplies them, `$acc` is
 * a compile error, and {@link lam.fn} extracts the body text at author time. What
 * reaches the wire is the same `const:text` a hand-written `c.text(...)` produced
 * — this is purely an authoring layer, with no encoder, normalizer, or codegen
 * change behind it.
 *
 * The build-time guard is a whitelist, and it is sound rather than heuristic: a
 * stack variable is NOT injected as a bare `$name` identifier (it is reached as
 * `$var.name`), so any `$identifier` outside {@link LAMBDA_BINDINGS} for that
 * surface is provably undefined at runtime. Live-probed and recorded in
 * `vendor/lambda-bindings.json`; `test/values/lambda.test.ts` fails if this table
 * and that record drift apart.
 *
 * ```ts
 * withFilters(ref("prices"), fl.reduce({ initial: 0, code: lam.fn(({ $result, $this }) => $result + $this) }))
 * s.lambda({ as: "total", code: lam.fn(({ $var }) => $var.subtotal * 1.2) })
 * ```
 */
import { article } from "../util/article.js";
import { SourceReader, SourceShapeError, lineOf, maskNonCode, tokenize } from "./lambda-source.js";
import type { FunctionShape } from "./lambda-source.js";
import { ID_CHAR, IDENT, decodeIdentifierEscapes, isIdentifierName, isQuotedShorthand } from "./lambda-ident.js";
import { c } from "./value.js";
import type { Value } from "./value.js";

/** A surface that takes a JavaScript body: the lambda statement, or a filter. */
export type LambdaSurface =
  | "s.lambda"
  | "fl.lambda"
  | "map"
  | "filter"
  | "some"
  | "every"
  | "find"
  | "findIndex"
  | "reduce";

/**
 * Surface → the identifiers a body may reference. Live-probed rather than read
 * off any documentation, and asserted against the recorded probe output in the
 * tests, so the guard, the types, and the docs cannot disagree with the engine
 * or with each other.
 *
 * `console` and `crypto` are globals inside the body rather than destructured
 * bindings, so they are legal to reference but are not part of the parameter
 * type. Every other entry is `$`-prefixed, which is what makes the scan below
 * able to see a violation at all.
 */
export const LAMBDA_BINDINGS: Readonly<Record<LambdaSurface, readonly string[]>> = {
  // Runs once, over no element and no piped value.
  "s.lambda": ["$env", "$input", "$var", "$auth"],
  // Runs once, over the piped value — which it binds as `$this` (NOT `$parent`).
  "fl.lambda": ["$env", "$input", "$var", "$auth", "$this"],
  // The array-iterating filters: one run per element.
  map: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  filter: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  some: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  every: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  find: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  findIndex: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  // …plus the accumulator, which is `$result`.
  reduce: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent", "$result"],
} as const;

/** Globals a body may use that are not `$`-bindings (so the scan never sees them). */
export const LAMBDA_GLOBALS: readonly string[] = ["console", "crypto"];

/**
 * The libraries the engine preloads as GLOBALS in a lambda body — the only
 * dependency route that works on every instance.
 *
 * A body is prepared for execution in one of two ways depending on the
 * instance's executor generation, and the two disagree about `import()`:
 *
 *   - one transpiles the body and lets the runtime resolve a specifier when the
 *     `import()` actually runs, so `node:*`, `npm:*`, a bare package and a URL
 *     all resolve;
 *   - the other BUNDLES the body before running it, which resolves every
 *     LITERAL specifier ahead of time against the container's filesystem —
 *     where none of them exist. `await import("node:crypto")` comes back as the
 *     text `Could not resolve "node:crypto"`, with HTTP 200. A literal
 *     `require("axios")` fails there for the same reason.
 *
 * These names need no specifier, so they are unaffected by which generation
 * runs the body. Live-probed from `Object.keys(globalThis)` inside a body; the
 * evidence is `s.lambda.globalThis` in `vendor/lambda-bindings.json`, and
 * `test/values/lambda.test.ts` fails if this list drifts from it.
 *
 * Not exhaustive by design: it lists what an author is likely to reach for. A
 * body can always read `Object.keys(globalThis)` for its own instance.
 */
export const LAMBDA_MODULE_GLOBALS: readonly string[] = [
  "_",
  "aws4",
  "axios",
  "cryptojs",
  "DateTime",
  "ethers",
  "fastXmlParser",
  "jose",
  "luxon",
  "mailparser",
  "math",
  "moment",
  "nodemailer",
  "socks",
  "uuid",
  "utils",
];

/**
 * Every filter that takes a JavaScript body → which positional slot the body
 * occupies, and which binding set it runs against.
 *
 * The slot is fixed rather than looked up because it is what the guard has to
 * key on: `filter()` sees positions, not argument names. `reduce`'s body is the
 * SECOND argument (the accumulator's initial value comes first, and that slot
 * being invisible is the other half of the same failure); every other lambda
 * filter's is the
 * first.
 *
 * `fl.transform` is deliberately absent. It takes Xano Expression Engine source,
 * not a JavaScript body, and binds the operand as `$0` rather than `$this` — so
 * validating it against THIS contract would reject correct code. It has its own
 * guard, on its own probed contract, in `./expression-arg.ts`; a
 * `return` there is not merely refused but sometimes silently mis-evaluated.
 * `test/values/filters.test.ts` enumerates the `code`-taking filters from
 * `FILTER_SPECS` and fails if one is missing here.
 */
export const LAMBDA_CODE_FILTERS: Readonly<Record<string, { readonly slot: number; readonly surface: LambdaSurface }>> = {
  lambda: { slot: 0, surface: "fl.lambda" },
  map: { slot: 0, surface: "map" },
  filter: { slot: 0, surface: "filter" },
  some: { slot: 0, surface: "some" },
  every: { slot: 0, surface: "every" },
  find: { slot: 0, surface: "find" },
  findIndex: { slot: 0, surface: "findIndex" },
  reduce: { slot: 1, surface: "reduce" },
};

/**
 * Run the body guard on a filter's code argument, where there is one to see.
 *
 * The choke point matters more than the form: an author who never adopts `lam.*`
 * — who writes `fl.reduce(0, c.text("return $acc + $this"))`, or reaches for the
 * low-level `filter()` — gets the same answer at the same moment as one who
 * does. It fires only on an inspectable, unfiltered `const` body; a `ref`, an
 * input, or a filtered value is left alone, because the guard must not pretend
 * to check what it cannot read.
 *
 * An EMPTY body is left alone here too, though `lam.fn`/`lam.raw` refuse to
 * author one: the editor saves a freshly-added lambda with no code at all, so a
 * pulled workspace holding that default has to keep round-tripping. Authoring a
 * blank body is a mistake; carrying one that already exists is not.
 */
export function assertLambdaFilterArgs(name: string, args: ReadonlyArray<Value | undefined>): void {
  const site = (Object.hasOwn(LAMBDA_CODE_FILTERS, name) ? LAMBDA_CODE_FILTERS[name] : undefined);
  if (site === undefined) return;
  const code = args[site.slot];
  if (!isInspectableBody(code) || code.value.trim() === "") return;
  assertLambdaBody(code.value, site.surface, `fl.${name}`);
}

/**
 * The statements that take a JavaScript body → the field carrying it and the
 * bindings it runs against. One today; a table so a second cannot be added
 * without deciding its surface.
 */
export const LAMBDA_STATEMENTS: Readonly<Record<string, { readonly field: string; readonly surface: LambdaSurface }>> = {
  "mvp:lambda": { field: "code", surface: "s.lambda" },
};

/**
 * Resolve an INLINE body in a statement's code field against that statement's
 * surface, returning the authored args unchanged when there is nothing to
 * resolve. See {@link toLambdaValue}.
 */
export function coerceLambdaFields(
  storedName: string,
  authored: Record<string, unknown>,
): Record<string, unknown> {
  const site = (Object.hasOwn(LAMBDA_STATEMENTS, storedName) ? LAMBDA_STATEMENTS[storedName] : undefined);
  if (site === undefined || typeof authored[site.field] !== "function") return authored;
  return { ...authored, [site.field]: toLambdaValue(authored[site.field] as LambdaBody, site.surface, storedName === "mvp:lambda" ? "s.lambda" : storedName) };
}

/** Run the body guard on a statement's code field. See {@link assertLambdaFilterArgs}. */
export function assertLambdaStatement(storedName: string, authored: Record<string, unknown>): void {
  const site = (Object.hasOwn(LAMBDA_STATEMENTS, storedName) ? LAMBDA_STATEMENTS[storedName] : undefined);
  if (site === undefined) return;
  const code = authored[site.field];
  if (!isInspectableBody(code) || code.value.trim() === "") return;
  assertLambdaBody(code.value, site.surface, "s.lambda");
}

/**
 * Whether a value's body text can be read at all: an unfiltered `const` string.
 * A `ref`, an input binding, or a filtered value carries no text to check, and a
 * guard that fired on those would be guessing.
 */
function isInspectableBody(code: unknown): code is Value & { value: string } {
  return (
    typeof code === "object" &&
    code !== null &&
    (code as Value).tag === "const" &&
    typeof (code as Value).value === "string" &&
    ((code as Value).filters?.length ?? 0) === 0
  );
}

/**
 * Ambient request state, in scope at every surface.
 *
 * Typed `any` deliberately: `$var` holds the enclosing function's stack
 * variables and `$input` its declared inputs, and threading those inferred
 * shapes in here is a substantial type-level piece of work in its own right. The
 * value this parameter carries today is the NAMES — that a binding exists, is
 * spelled this way, and exists at this surface.
 */
export interface AmbientBindings {
  /** Workspace environment variables and request settings. */
  $env: any;
  /** The enclosing function's inputs, by name. */
  $input: any;
  /** The enclosing function's stack variables, by name — `$var.total`. A stack
   * variable is NOT also injected as a bare `$total`. */
  $var: any;
  /** The authenticated caller, when the request carries a token. */
  $auth: any;
}

/** Ambient state plus the per-element bindings of an iterating filter. */
export interface IteratingBindings extends AmbientBindings {
  /** The current element. */
  $this: any;
  /** The current element's position, from 0. */
  $index: number;
  /** The whole array the filter is applied to. */
  $parent: any;
}

/** The bindings in scope in a body at `S` — the type of a {@link lam.fn} parameter. */
export type LambdaBindings<S extends LambdaSurface = "reduce"> = S extends "reduce"
  ? IteratingBindings & {
      /** The accumulator. Commonly mis-typed as `$acc`. */
      $result: any;
    }
  : S extends "s.lambda"
    ? AmbientBindings
    : S extends "fl.lambda"
      ? AmbientBindings & {
          /** The piped value the filter is applied to. */
          $this: any;
        }
      : IteratingBindings;

/**
 * A lambda body written INLINE at the call site, where the surface is already
 * known — `fl.map(({ $this }) => $this * 2)`.
 *
 * This is the form to reach for. `lam.fn` exists for a body that is shared,
 * captured, or otherwise built away from where it runs; everywhere else the
 * call site knows which surface it is, so naming the surface a second time is
 * something for the SDK to do rather than the author. TypeScript types the
 * parameter contextually from the position, so `$this` autocompletes inside
 * `fl.map` and `$result` does not compile there.
 */
export type LambdaBody<S extends LambdaSurface = LambdaSurface> = (
  bindings: LambdaBindings<S>,
  captured: Record<string, CaptureValue>,
) => unknown;

/**
 * Accept either a {@link Value} or an inline {@link LambdaBody} wherever a
 * lambda body is taken, resolving the function form against the surface the CALL
 * SITE knows.
 *
 * A function reaching a `code` argument can only be an authored body, so this
 * needs no marker to recognize one — and the surface it validates against is the
 * one it was written at, not one the author had to restate.
 */
export function toLambdaValue<T>(x: T | LambdaBody, surface: LambdaSurface, source: string): T | Value {
  if (typeof x !== "function") return x;
  const { body, captureReads } = extractFunction(String(x), source);
  return lambdaValue(body, { surface }, source, true, captureReads);
}

/** A JSON value a capture entry can carry into the body. */
export type CaptureValue = string | number | boolean | null | { [k: string]: CaptureValue } | CaptureValue[];

/**
 * The CHECKING form of {@link CaptureValue}, used wherever a capture is
 * constrained rather than described.
 *
 * `CaptureValue` names the shape for a reader, but it cannot be a constraint on
 * its own: its object arm is an index signature, and TypeScript hands an
 * implicit index signature to type ALIASES only — never to an `interface`, which
 * stays open to declaration merging. So `capture: { band }` compiled when `band`
 * was a `type` and failed when the identical shape was an `interface`, with the
 * error naming `CaptureValue` rather than the one keyword that differed, and the
 * body's second parameter then degrading to the constraint.
 *
 * A homomorphic mapped type is the way through: `keyof` an interface is the same
 * as `keyof` the alias, so this accepts both and still rejects what genuinely
 * cannot cross the boundary as text — functions, `undefined`, `symbol`, `bigint`
 * — matching the runtime check in {@link capturePrelude}.
 */
export type Capturable<T> = T extends string | number | boolean | null
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends readonly (infer U)[]
      ? readonly Capturable<U>[]
      : T extends object
        ? { [K in keyof T]: Capturable<T[K]> }
        : never;

/** A capture bag: every value {@link Capturable}, whatever it was declared as. */
export type CaptureRecord<T> = { [K in keyof T]: Capturable<T[K]> };

/** Options shared by every `lam.*` form. */
export interface LambdaOptions<C = Record<string, never>> {
  /**
   * Which surface the body will run at, which is what decides the legal
   * bindings.
   *
   * Omit it and the check is DEFERRED to the call site, which knows the answer:
   * dropping the body into `fl.map(...)` or `s.lambda({...})` validates it there,
   * against that surface. Naming it here is for a body built away from its call
   * site — a shared constant, or one that should fail at its own definition
   * rather than at its use.
   *
   * Better still, write the body inline (`fl.map(({ $this }) => …)`), where the
   * surface is implied and TypeScript types the bindings from the position.
   */
  surface?: LambdaSurface;
  /**
   * Values from the enclosing TypeScript scope to carry into the body, emitted
   * as a `const` prelude.
   *
   * Nothing crosses the boundary implicitly: the body is extracted as TEXT and
   * runs in a different process, so a closed-over `const rate` is simply
   * undefined at runtime. Rather than guess at free variables (which needs a
   * JavaScript parser this package deliberately does not have), capture is
   * explicit and the second parameter of the body destructures it.
   */
  capture?: C;
}

// --- body extraction ------------------------------------------------------------

/** The error prefix every `lam.*` diagnostic carries, so they read as one family. */
const PREFIX = "lam";

/**
 * Extract the body text of a function from its SOURCE.
 *
 * Two forms reach here — a block body (`(b) => { … }`) and a concise expression
 * body (`(b) => expr`) — and they must produce the same text, because they are
 * the same lambda as far as the engine is concerned. The concise form becomes
 * `return <expr>;`.
 *
 * Exported so `lam.file` can extract from a file's default export with exactly
 * the same rule the inline form uses — one extraction, so the two authoring
 * forms cannot diverge.
 */
export function extractFunctionBody(source: string, caller: string): string {
  return extractFunction(source, caller).body;
}

/** A function's body text, and the capture keys its second parameter destructures and the body reads. */
export interface ExtractedFunction {
  body: string;
  captureReads: readonly string[];
}

/** {@link extractFunctionBody}, also returning the capture keys the body reads. */
export function extractFunction(source: string, caller: string): ExtractedFunction {
  const src = source.trim();
  if (src.includes("[native code]")) {
    throw new Error(
      `${caller}: this function has no readable source (it is native, bound, or otherwise not authored here), ` +
        `so there is no body to send to the engine. Write the body inline as an arrow function, or use lam.raw(...) ` +
        `with the code as text.`,
    );
  }
  const fn = readFunction(src, caller);
  const [ps, pe] = fn.params;
  const [bs, be] = fn.body;
  // Analysed with identifier escapes decoded (a loader writes `café` as
  // `caf\u00E9`); the body is emitted as written.
  const params = decodeIdentifierEscapes(src.slice(ps, pe));
  const captureReads = assertDestructuredParams(params, maskNonCode(params), maskNonCode(decodeIdentifierEscapes(src.slice(bs, be))), caller);
  const text = src.slice(bs, be);
  if (fn.block) return { body: stripKeepNames(dedent(text.trim())), captureReads };
  // Concise body: `(b) => expr` is `return expr;`. One that starts its own line
  // keeps that line's indentation in the dedent, so its continuation lines stay
  // indented relative to it.
  const lead = /[ \t]*$/.exec(src.slice(0, bs))?.[0] ?? "";
  const ownLine = /(^|\n)[ \t]*$/.test(src.slice(0, bs));
  const expr = ownLine ? dedent(`\n${lead}${text}`).slice(1).trimStart() : dedent(text);
  const body = `return ${expr};`;
  return { body: stripKeepNames(body), captureReads };
}

/**
 * Locate the one function `src` holds — the whole of it, behind optional
 * parentheses and casts — or refuse. Reading by tokens and matched brackets is
 * what keeps a return type's `{ … }` or `=>`, a type parameter's braces, and a
 * concise body continued on the next line from being taken for the body's edge.
 */
export function readFunction(src: string, caller: string): FunctionShape {
  const reader = new SourceReader(tokenize(src));
  const refuse = (reason: string): never => {
    throw new Error(
      `${caller}: could not read ${JSON.stringify(src.slice(0, 80))} as one arrow function or function expression ` +
        `(${reason}), so the body cannot be located with certainty. Write the function itself — ` +
        `\`({ $var }: …) => …\` or \`function ({ $var }: …) { … }\` — and nothing else. A class method or an object ` +
        `shorthand method does not extract; write it as an arrow function.`,
    );
  };
  try {
    const { fn, end } = reader.parseFunctionExpression(0);
    let k = end;
    while (reader.isP(k, ";")) k++;
    if (k < reader.toks.length) reader.fail(`\`${reader.toks[k]!.text}\` after the function`, k);
    return fn;
  } catch (e) {
    if (e instanceof SourceShapeError) return refuse(`${e.message} at line ${lineOf(src, e.offset)}`);
    throw e;
  }
}

/**
 * Undo esbuild's `keepNames` rewrite, which the body would otherwise ship.
 *
 * A body is read back with `Function.prototype.toString`, and under a `.ts`
 * loader — `tsx`, which is how the CLI evaluates a TypeScript entry — that
 * returns TRANSPILED source, not what the author wrote. esbuild runs with
 * `keepNames: true`, so every function that gets its name by INFERENCE is
 * wrapped in a call to a module-scope helper:
 *
 * ```
 * function round(n){…}__name(round,"round");   // a declaration
 * const g=__name(function(n){…},"g");          // a named function expression
 * const h=__name(n=>n,"h");                    // a named arrow
 * class K{static{__name(this,"K")}…}           // a class
 * ```
 *
 * The helper is defined at MODULE scope and the body travels alone, so what
 * reaches the engine calls an identifier that is not there — and a throwing body
 * comes back as its own diagnostic text in the value slot with HTTP 200.
 * Anonymous callbacks (`items.map((i) => …)`) get no name to keep and are
 * untouched, which is why most lambdas in a project work and hide this.
 *
 * `__name(X, "n")` evaluates to `X`, and a function's `.name` is meaningless in a
 * body shipped as TEXT — so removing the wrapper restores exactly the source the
 * author wrote, rather than refusing it. The declaration form is dropped whole
 * (it is a bare `round;` expression statement once unwrapped); everywhere else
 * the first argument is spliced in, which is safe unparenthesized because name
 * inference only fires in a value position (an initializer, a property, an
 * argument), never in statement position.
 *
 * Helpers this does NOT know how to undo are refused by {@link assertLambdaBody}
 * instead — a build error, never a wrong value at runtime.
 */
const KEEP_NAMES_CALL = new RegExp(String.raw`()(?<!${ID_CHAR}|[\\.])__name\s*\(`, "u");

function stripKeepNames(body: string): string {
  let out = body;
  // One call per pass, re-masking each time: a nested `__name` shifts every
  // index after it, and the innermost calls are reached by repetition.
  for (;;) {
    const mask = maskNonCode(out);
    const call = KEEP_NAMES_CALL.exec(mask);
    if (call === null) break;
    const start = call.index + (call[1] ?? "").length;
    const open = mask.indexOf("(", start);
    const close = closingParen(mask, start) - 1;
    // An unbalanced call is not something to guess at — leave it for the guard.
    if (close <= open) break;
    const args = out.slice(open + 1, close);
    const comma = splitTopLevel(maskNonCode(args))[0]?.length ?? args.length;
    const first = args.slice(0, comma).trim();
    // `}__name(round,"round");` — the whole statement exists only to set the
    // name, so it goes rather than becoming a no-op `round;`.
    const before = mask.slice(0, start);
    const isStatement = /(^|[;{}])\s*$/.test(before) && isIdentifierName(first);
    const trailing = isStatement ? /^\s*;?/.exec(out.slice(close + 1))?.[0].length ?? 0 : 0;
    out = out.slice(0, start) + (isStatement ? "" : first) + out.slice(close + 1 + trailing);
  }
  return out.trim();
}

/**
 * Strip the indentation an authored body inherited from where it was written.
 *
 * A lambda nested three levels deep in a workspace definition would otherwise
 * store three levels of leading spaces, and the SAME lambda moved to the top
 * level would store different bytes — a diff in a byte-exact corpus with no
 * change in meaning. The block and file forms of one body also have to agree.
 *
 * Skipped when the body contains a backtick: a multi-line template literal's
 * leading whitespace is part of its value, and no tokenizer-level check can tell
 * which lines those are without tracking the literal across the dedent.
 */
function dedent(body: string): string {
  if (body.includes("`")) return body;
  const lines = body.split("\n");
  const indents = lines.slice(1).filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const common = indents.length ? Math.min(...indents) : 0;
  if (common === 0) return body;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(common))].join("\n");
}

/**
 * Refuse a parameter the body then dereferences by name.
 *
 * The parameters are a fiction: only the BODY is sent, and the engine injects
 * the bindings as free identifiers. So `({ $this }) => $this * 2` works —
 * destructuring names the bindings and disappears — while `(b) => b.$this * 2`
 * emits `return b.$this * 2;`, and `b` is undefined at runtime. That failure
 * comes back as diagnostic text in the value slot with HTTP 200, which is the
 * exact shape of the accumulator failure above, so it is caught here instead.
 *
 * The same holds for any name a destructuring pattern introduces other than the
 * binding's own: `({ $this: item })`, `({ $var: { total } })`, `({ ...rest })`
 * and a default (`{ $this = 1 }`) all vanish with the parameter list, and an
 * alias that matches a preloaded library (`({ $this: _ }) => _ * 2`) would read
 * THAT library instead of failing. So the first two positions accept only a
 * plain list of names.
 *
 * An unreferenced parameter is fine (`(_, { rate }) => rate`): nothing that
 * survives into the body depends on it.
 */
function assertDestructuredParams(params: string, paramsMask: string, bodyMask: string, caller: string): string[] {
  const open = paramsMask.indexOf("(");
  const close = open === -1 ? -1 : closingParen(paramsMask, open) - 1;
  const [inner, innerMask] =
    open === -1 || close <= open
      ? [params, paramsMask]
      : [params.slice(open + 1, close), paramsMask.slice(open + 1, close)];
  let at = 0;
  const captureReads: string[] = [];
  splitTopLevel(innerMask).forEach((partMask, index) => {
    const part = inner.slice(at, at + partMask.length);
    at += partMask.length + 1;
    const lead = /^\s*/.exec(partMask)?.[0].length ?? 0;
    if (partMask[lead] === "{" || partMask[lead] === "[") {
      assertPlainPattern(part, partMask, lead, index, bodyMask, caller);
      if (index === 1) {
        const end = closingBracket(partMask, lead);
        captureReads.push(...patternNames(partMask.slice(lead, end), part.slice(lead, end)).filter((n) => readsName(bodyMask, n)));
      }
      return;
    }
    const name = new RegExp(String.raw`^\s*(?:\.\.\.)?\s*(${IDENT})`, "u").exec(partMask)?.[1];
    if (name === undefined) return;
    if (!readsName(bodyMask, name)) return;
    // The first parameter carries the bindings and the second the capture; a
    // later one carries nothing at all.
    const fix =
      index === 0
        ? `DESTRUCTURE the bindings instead: \`({ ${name.startsWith("$") ? name : "$this"} }) => …\` rather than ` +
          `\`(${name}) => … ${name}.$this …\`.`
        : index === 1
          ? `The second parameter carries \`capture\` only: DESTRUCTURE the keys you captured (\`(_, { rate }) => … ` +
            `rate …\`), or declare \`${name}\` inside the body (\`const ${name} = …\`).`
          : `Nothing arrives there: a lambda receives its bindings and its capture only. Declare \`${name}\` inside ` +
            `the body (\`const ${name} = …\`), or bring a value in through \`capture\`.`;
    throw new Error(
      `${caller}: the body reads \`${name}\`, but a lambda's parameters are not real — only the BODY is sent, and ` +
        `the engine injects the bindings as free identifiers. ${fix} As written, ` +
        `\`${name}\` is undefined at runtime and the engine returns that failure as text in the value slot.`,
    );
  });
  return captureReads;
}

/** Whether the masked body reads `name` as a value (not as a `.property`). */
function readsName(bodyMask: string, name: string): boolean {
  return new RegExp(`(?<!${ID_CHAR}|\\.)${name.replace(/\$/g, "\\$")}(?!${ID_CHAR})`, "u").test(bodyMask);
}

/**
 * Refuse a destructuring parameter that is not a plain list of names.
 *
 * `part` is one top-level parameter (`{ $var }: { $var: T }` included — only the
 * balanced pattern at its start is read, so a type annotation never counts).
 */
function assertPlainPattern(
  part: string,
  partMask: string,
  lead: number,
  index: number,
  bodyMask: string,
  caller: string,
): void {
  const end = closingBracket(partMask, lead);
  const pattern = part.slice(lead, end);
  const patternMask = partMask.slice(lead, end);
  const notReal =
    `a lambda's parameters are not real — only the BODY is sent, and the engine injects each ` +
    (index === 0 ? "binding" : "capture key") +
    ` under its OWN name`;
  if (index >= 2) {
    const read = patternNames(patternMask, pattern).find((n) => readsName(bodyMask, n));
    if (read === undefined) return;
    throw new Error(
      `${caller}: the body reads \`${read}\`, but ${notReal}, and nothing arrives in a third parameter. Declare ` +
        `\`${read}\` inside the body (\`const ${read} = …\`), or bring a value in through \`capture\`.`,
    );
  }
  const plain = `({ $this }) => $this.price`;
  const fix =
    index === 0
      ? `Destructure the bindings by their own names, with no renaming, nesting, default or rest — \`${plain}\`, ` +
        `\`({ $var }) => $var.subtotal\` — and read deeper values in the body.`
      : `Destructure the capture keys by their own names — \`(_, { rate }) => rate\` — and pick the name in ` +
        `\`capture\` itself (\`capture: { r: rate }\`, read as \`(_, { r }) => r\`).`;
  if (patternMask.startsWith("[")) {
    throw new Error(
      `${caller}: the ${index === 0 ? "first" : "second"} parameter is an array pattern \`${pattern}\`, but ` +
        `${notReal}, so nothing it names exists at runtime. ${fix}`,
    );
  }
  let at = 1;
  for (const propMask of splitTopLevel(patternMask.slice(1, -1))) {
    const prop = pattern.slice(at, at + propMask.length).trim();
    at += propMask.length + 1;
    if (propMask.trim() === "" || isIdentifierName(propMask.trim()) || isQuotedShorthand(prop)) continue;
    const what = /^\s*\.\.\./.test(propMask)
      ? "a rest element"
      : hasTopLevel(propMask, ":")
        ? "a renamed or nested property"
        : hasTopLevel(propMask, "=")
          ? "a default (it never applies)"
          : "a computed or quoted key";
    const alias = hasTopLevel(propMask, ":") ? patternNames(`{${propMask}}`, `{${prop}}`)[0] : undefined;
    throw new Error(
      `${caller}: \`${prop}\` in the parameter pattern \`${pattern}\` is ${what}, but ${notReal}` +
        (alias === undefined
          ? `, so the pattern does nothing at runtime.`
          : isFreeIdentifier(alias)
            ? `, so \`${alias}\` is never defined: the body throws, and the engine returns that failure as text ` +
              `in the value slot with HTTP 200.`
            : `, so \`${alias}\` reads the global of that name instead — a wrong value with HTTP 200.`) +
        ` ${fix}`,
    );
  }
}

/** Index just past the bracket matching the `{`/`[` at `from`. */
function closingBracket(mask: string, from: number): number {
  let depth = 0;
  for (let i = from; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && --depth === 0) return i + 1;
  }
  return mask.length;
}

/** Whether `ch` occurs outside every bracket pair (an `=` of `=>`/`==` excluded). */
function hasTopLevel(mask: string, ch: ":" | "="): boolean {
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ch && !(ch === "=" && /[=>]/.test(mask[i + 1] ?? ""))) return true;
  }
  return false;
}

/** Every name a destructuring pattern binds (keys and default values excluded). */
function patternNames(mask: string, text: string): string[] {
  const m = mask.trim();
  const offset = mask.indexOf(m);
  const t = text.slice(offset, offset + m.length);
  if (m.startsWith("{") || m.startsWith("[")) {
    const end = closingBracket(m, 0);
    const names: string[] = [];
    let at = 1;
    for (const elMask of splitTopLevel(m.slice(1, end - 1))) {
      const el = t.slice(at, at + elMask.length);
      at += elMask.length + 1;
      // Drop a default; for an object property, keep only the value side of `key: value`.
      let cut = elMask.length;
      let depth = 0;
      let colon = -1;
      for (let i = 0; i < elMask.length; i++) {
        const c = elMask[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && c === ":" && colon === -1 && m.startsWith("{")) colon = i;
        else if (depth === 0 && c === "=" && !/[=>]/.test(elMask[i + 1] ?? "")) {
          cut = i;
          break;
        }
      }
      const from = colon === -1 ? 0 : colon + 1;
      const target = elMask.slice(from, cut).replace(/^(\s*)\.\.\./, "$1   ");
      names.push(...patternNames(target, el.slice(from, cut)));
    }
    return names;
  }
  const id = new RegExp(`^${IDENT}`, "u").exec(m)?.[0];
  return id === undefined ? [] : [id];
}

/** Split a parameter list on its top-level commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Index just past the `)` closing the parameter list that opens at or after `from`. */
function closingParen(mask: string, from: number): number {
  const open = mask.indexOf("(", from);
  if (open === -1) return from;
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === "(") depth++;
    else if (mask[i] === ")" && --depth === 0) return i + 1;
  }
  return from;
}

// --- the scan --------------------------------------------------------------------

export { maskNonCode };

/**
 * Every `$identifier` the body DECLARES for itself — a local, a parameter, a
 * catch binding.
 *
 * `$` is a legal identifier character, so a body may perfectly well write
 * `const $tmp = …` or `$parent.map(($x) => $x + 1)`. Those are not engine
 * bindings and flagging them would be a build error on correct code, which is
 * the worst failure this guard can have. Declaration sites are recognized
 * rather than parsed — the four shapes below cover what a lambda body actually
 * writes — and anything recognized is excluded from the scan.
 */
function declaredLocals(mask: string, pattern = new RegExp(String.raw`\$${ID_CHAR}*`, "gu")): Set<string> {
  const declared = new Set<string>();
  const add = (text: string | undefined): void => {
    for (const m of (text ?? "").matchAll(pattern)) declared.add(m[0]);
  };
  // `const $x = …`, `let $a = 1, $b = 2`, `const { $a, $b } = …`. Each declarator
  // contributes only the text BEFORE its `=`: an initializer may legitimately
  // mention a real binding (`const $x = $acc`), and treating that as a
  // declaration would whitelist the very name the scan exists to catch.
  for (const m of mask.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const declarator of (m[1] ?? "").split(",")) add(declarator.split("=")[0]);
  }
  for (const m of mask.matchAll(new RegExp(String.raw`\b(?:function|class)\s+(${IDENT})`, "gu"))) add(m[1]);
  for (const m of mask.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(m[1]);
  // Arrow parameters: `($x) => …`, `$x => …`, `async ($x, { $y }) => …`.
  for (const m of mask.matchAll(new RegExp(String.raw`(\([^()]*\)|${IDENT})\s*=>`, "gu"))) add(m[1]);
  // `function (…)` / method parameter lists.
  for (const m of mask.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) add(m[1]);
  return declared;
}

/** Every distinct `$identifier` referenced as code, in source order. Takes the MASKED body. */
function dollarTokens(mask: string): string[] {
  return tokens(mask, new RegExp(String.raw`(^|\.\.\.|[^\p{ID_Continue}$.])(\$${ID_CHAR}+)`, "gu"));
}

/**
 * Every distinct identifier matching `pattern` (capture group 2 is the name), in
 * source order. Takes the MASKED body.
 *
 * `skipKeys` drops occurrences in object-LITERAL key position (`{ h2: 1 }`),
 * where the name is a property rather than a reference to anything. Decided per
 * OCCURRENCE, so a name used as both a key and a reference still reports. Off
 * for the `$`-binding scan, which predates this and has its own pinned
 * behaviour.
 */
function tokens(mask: string, pattern: RegExp, skipKeys = false): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Not preceded by an identifier character or a member `.`, so `a.$x` (a
  // property) and `x$y` (part of a longer name) are not references to a `$x`
  // binding; a spread `...$x` is.
  for (const m of mask.matchAll(pattern)) {
    const name = m[2] ?? "";
    if (name === "" || seen.has(name)) continue;
    if (skipKeys) {
      const before = mask.slice(0, m.index + (m[1] ?? "").length).trimEnd().slice(-1);
      const after = mask.slice(m.index + m[0].length).trimStart().slice(0, 1);
      // `{ h2: … }` / `…, h2: …` — a key. A ternary branch (`x ? h2 : y`) and a
      // `case h2:` are real references and are not preceded by `{` or `,`.
      if (after === ":" && (before === "{" || before === ",")) continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The bundler helpers a transpiled body is known to reference, and what each one
 * means the author wrote.
 *
 * `__name` never reaches here — {@link stripKeepNames} undoes it. The rest are
 * emitted only when a loader downlevels syntax the engine's runtime supports
 * natively, so seeing one means the body was transpiled harder than expected:
 * there is no safe rewrite, and a build error is the whole point.
 */
const BUNDLER_HELPERS: Readonly<Record<string, string>> = {
  __name: "a named inner function",
  __publicField: "a class field",
  __privateGet: "a #private field", __privateSet: "a #private field",
  __privateAdd: "a #private field", __privateMethod: "a #private method",
  __decorateClass: "a decorator", __decorateParam: "a parameter decorator",
  __async: "async/await", __generator: "a generator", __await: "await",
  __forAwait: "for await", __yieldStar: "yield*",
  __spreadValues: "an object spread", __spreadProps: "an object spread",
  __objRest: "a rest destructuring", __restKey: "a rest destructuring",
  __pow: "the `**` operator", __using: "`using`", __callDispose: "`using`",
  __toESM: "an import", __toCommonJS: "an export", __require: "a require",
  __awaiter: "async/await", __assign: "an object spread", __rest: "a rest destructuring",
  __decorate: "a decorator", __extends: "a class", __spreadArray: "an array spread",
};

/**
 * Identifiers a body may legitimately write with a `__` prefix, so the helper
 * guard cannot fail a correct body. `__proto__` is an object-literal key and a
 * property name; the two Node globals are neither defined nor harmful to name.
 */
const HELPER_LOOKALIKES: ReadonlySet<string> = new Set(["__proto__", "__dirname", "__filename"]);

/**
 * The binding an unknown `$identifier` most likely meant, or undefined.
 *
 * Answers with the real name where one is knowable: `$acc` for `$result` (plus
 * the other accumulator names an author reaches for), and
 * otherwise a same-name binding that exists at a DIFFERENT surface — which is
 * the second real failure, reusing a `map` body inside `s.lambda`.
 */
function suggestion(token: string, surface: LambdaSurface): string | undefined {
  const ACCUMULATOR_GUESSES = ["$acc", "$accumulator", "$carry", "$memo", "$total", "$prev", "$previous"];
  if (ACCUMULATOR_GUESSES.includes(token) && LAMBDA_BINDINGS[surface].includes("$result")) {
    return `\`$result\` is the accumulator at this surface`;
  }
  if (ACCUMULATOR_GUESSES.includes(token)) {
    return `\`$result\` is the accumulator, and only \`reduce\` binds it`;
  }
  const elsewhere = (Object.keys(LAMBDA_BINDINGS) as LambdaSurface[]).filter((s) =>
    LAMBDA_BINDINGS[s].includes(token),
  );
  if (elsewhere.length) return `\`${token}\` is bound at ${elsewhere.join(", ")}, but not here`;
  if (token === "$parent" || token === "$this") {
    return `the value a filter is applied to is \`$this\` in \`fl.lambda\`, and \`$parent\` in the array-iterating filters`;
  }
  return undefined;
}

/**
 * Reject a body that cannot work at `surface`, before it can reach a live
 * request. Three failures are unwritable after this:
 *
 * 1. an `$identifier` outside the surface's binding set — provably undefined at
 *    runtime, because a stack variable is only ever reachable as `$var.name`;
 * 2. a top-level `import`/`export`, which is a syntax error in a function body
 *    (a dependency comes from {@link LAMBDA_MODULE_GLOBALS}, which needs no
 *    specifier — see there for why a literal `import()` one is not portable);
 * 3. an empty body, which stores a statement the engine refuses at import.
 *
 * Exported so the statement and filter factories can run the same check on a
 * plain `c.text(...)` body — an author who never adopts `lam.*` gets the same
 * answer at the same moment.
 */
export function assertLambdaBody(body: string, surface: LambdaSurface, source = `${PREFIX}.fn`): void {
  try {
    assertBody(body, surface, source);
  } catch (err) {
    // A collector is installed only while a STORED workspace is being decoded,
    // where the author is not authoring: they are reading back a body that is
    // already live. Refusing it there dropped the statement to `raw()` and filed
    // a live workspace bug as a decoder limitation — the guard firing at the
    // wrong moment, not the wrong guard. The message is the same
    // one an author would have seen; only its destination changes.
    if (collector === null) throw err;
    collector(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Where a rejected lambda body goes while a stored workspace is being decoded.
 * Null everywhere else, which is the authoring path — and there the guard throws.
 */
let collector: ((problem: string) => void) | null = null;

/**
 * Run `fn` with lambda-body rejections REPORTED to `onProblem` instead of
 * thrown.
 *
 * Scoped to one decode and restored in `finally`, so an authoring call that
 * happens to run underneath one (there is none today) cannot inherit the
 * suspension permanently. Nesting is not expected and would be a bug in the
 * caller, so the previous collector is restored rather than chained.
 */
export function collectLambdaBodyProblems<T>(onProblem: (problem: string) => void, fn: () => T): T {
  const previous = collector;
  collector = onProblem;
  try {
    return fn();
  } finally {
    collector = previous;
  }
}

/** Where {@link installLambdaSyntaxCheck} puts the parser — shared by every copy of the SDK in a process. */
const SYNTAX_CHECK = Symbol.for("xanosdk.lambda.syntax-check");

/** Where {@link installLambdaFreeReads} puts the scope-aware reader — shared like {@link SYNTAX_CHECK}. */
const FREE_READS = Symbol.for("xanosdk.lambda.free-reads");

/**
 * Install (or, with `undefined`, remove) the scope-aware reader the binding
 * and closure checks use: every name a body reads as a free variable. It lives on the Node
 * side (installed with the syntax check) so a browser bundle does not carry it.
 */
export function installLambdaFreeReads(reader: ((mask: string) => string[]) | undefined): void {
  (globalThis as Record<symbol, unknown>)[FREE_READS] = reader;
}

/** A syntax error in a lambda body: 1-based line and column within the body, and the parser's message. */
export interface LambdaSyntaxError {
  line: number;
  column: number;
  message: string;
  lineText: string;
}

/**
 * Install (or, with `undefined`, remove) the parser that reports a lambda
 * body's syntax error. The body is TypeScript-tolerant source, so the parser
 * is a TypeScript one — which needs Node, so the Node entry and the CLI install
 * it and a browser export skips the check. Keyed on a global symbol so a
 * project's own SDK copy, which builds the defs, sees the CLI's.
 */
export function installLambdaSyntaxCheck(check: ((body: string) => LambdaSyntaxError | undefined) | undefined): void {
  (globalThis as Record<symbol, unknown>)[SYNTAX_CHECK] = check;
}

/** The installed parser's verdict on `body`, or undefined when it parses (or no parser is installed). */
export function lambdaSyntaxError(body: string): LambdaSyntaxError | undefined {
  const check = (globalThis as Record<symbol, unknown>)[SYNTAX_CHECK];
  return typeof check === "function" ? (check as (b: string) => LambdaSyntaxError | undefined)(body) : undefined;
}

/** The guard proper. See {@link assertLambdaBody}, which routes its failures. */
function assertBody(body: string, surface: LambdaSurface, source: string): void {
  if (body.trim() === "") {
    throw new Error(
      `${source}: the lambda body is empty. A lambda must return a value — the engine refuses a statement with no code.`,
    );
  }

  const mask = maskNonCode(decodeIdentifierEscapes(body));
  const legal = LAMBDA_BINDINGS[surface];
  // Scope-aware where the Node reader is installed: an object key, a class
  // member, a label, or a `$name` declared in a scope enclosing the read is not
  // a binding the body expects. Without it, any `$name` the body declares
  // anywhere counts as its own.
  const scoped = (globalThis as Record<symbol, unknown>)[FREE_READS];
  const candidates =
    typeof scoped === "function"
      ? (scoped as (m: string) => string[])(mask).filter((n) => n.startsWith("$"))
      : (() => {
          const locals = declaredLocals(mask);
          return dollarTokens(mask).filter((n) => !locals.has(n));
        })();
  for (const token of candidates) {
    if (legal.includes(token)) continue;
    const hint = suggestion(token, surface);
    throw new Error(
      `${source}: \`${token}\` is not a binding in a \`${surface}\` lambda body${hint ? ` — ${hint}` : ""}. ` +
        `It reads as undefined at runtime and raises NOTHING: the body runs, \`typeof\` reports "undefined", the ` +
        `value comes back null with HTTP 200, and a defensive \`typeof x !== "undefined"\` guard takes the wrong ` +
        `branch. Author time is the only place this is catchable. ` +
        `Bound here: ${legal.join(", ")} (plus the ${LAMBDA_GLOBALS.join(" / ")} globals). ` +
        `A stack variable is reached as \`$var.name\`, never as \`$name\`.`,
    );
  }

  assertNoBundlerHelpers(mask, source);

  // `import(` / `import.meta` are the dynamic forms and stay legal — they run on
  // some instances (see LAMBDA_MODULE_GLOBALS) and this is not the place to
  // refuse working code; a bare `import`/`export` keyword in statement position
  // is the module-only syntax the engine rejects outright, everywhere.
  const moduleSyntax = /(^|[;{}\n])\s*(import|export)\b(?![\s]*[.(])/.exec(mask);
  if (moduleSyntax) {
    const kw = moduleSyntax[2];
    throw new Error(
      `${source}: a top-level \`${kw}\` is a syntax error in a lambda body — the body is a function body, not a ` +
        `module, so it must \`return\` its value and cannot declare module syntax. Reach a dependency through the ` +
        `PRELOADED globals, which need no specifier: ${LAMBDA_MODULE_GLOBALS.join(", ")} (plus ` +
        `${LAMBDA_GLOBALS.join(" / ")}, fetch, Buffer, TextEncoder). A dynamic \`import("...")\` or ` +
        `\`require("...")\` with a literal specifier is NOT portable: on an instance that bundles the body before ` +
        `running it, every literal specifier is resolved ahead of time and none of them exist, so the call comes ` +
        `back as the text \`Could not resolve "..."\` with HTTP 200.`,
    );
  }

  const syntax = lambdaSyntaxError(body);
  if (syntax !== undefined) {
    throw new Error(
      `${source}: the lambda body does not parse — ${syntax.message} (body line ${syntax.line}, column ${syntax.column}: ` +
        `\`${syntax.lineText.trim()}\`). A body that does not parse cannot run.`,
    );

  }
}

/**
 * Names a body may reference without declaring them: the language's own
 * globals and literals, the web/runtime globals a body's host provides, and the
 * engine's preloaded libraries. Keywords are here too, since the scan below
 * sees every word. Not exhaustive of the host — {@link isFreeIdentifier} also
 * accepts whatever the AUTHORING host's `globalThis` carries, so a missing
 * builtin can only make the guard quieter, never louder.
 */
const KNOWN_NAMES: ReadonlySet<string> = new Set([
  // keywords and literals
  "await", "async", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof",
  "let", "new", "null", "of", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
  "undefined", "var", "void", "while", "with", "yield", "get", "set", "arguments", "NaN", "Infinity", "as",
  // ECMAScript globals
  "globalThis", "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date",
  "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
  "AggregateError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Proxy",
  "Reflect", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
  "BigUint64Array", "Intl", "Atomics", "Iterator", "Function", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent", "escape", "unescape", "eval",
  // web / runtime globals a body's host provides (live-probed; see LAMBDA_MODULE_GLOBALS)
  "fetch", "Request", "Response", "Headers", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Buffer",
  "atob", "btoa", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "structuredClone", "AbortController", "AbortSignal", "Blob", "File", "FormData", "ReadableStream",
  "WritableStream", "TransformStream", "performance", "Deno", "process", "require", "self", "navigator",
  "EventSource", "WebSocket", "Event", "EventTarget", "CompressionStream", "DecompressionStream",
  "reportError", "promisify", "dns", "http", "https", "net", "url", "zeebe", "azure", "rjsf",
  ...LAMBDA_GLOBALS,
  ...LAMBDA_MODULE_GLOBALS,
]);

/** Whether `name` resolves in a body without being declared in it. */
function isFreeIdentifier(name: string): boolean {
  if (KNOWN_NAMES.has(name)) return false;
  // The authoring host's own globals: a builtin this list forgot must not fail a
  // correct body. At worst this admits a host-only name the engine lacks.
  return !(name in globalThis);
}

/**
 * Every name the body declares, over-approximated: a name wrongly counted as
 * declared can only keep {@link assertNoClosure} quiet, never make it fire.
 * Bracket-aware, so a declaration list or parameter list holding a nested
 * block, call or pattern is read whole.
 */
function closureDeclarations(mask: string): Set<string> {
  const declared = new Set<string>();
  const bind = (target: string): void => {
    const t = target.replace(/^\s*\.\.\./, "");
    for (const name of patternNames(t, t)) declared.add(name);
  };
  // A declaration list runs to the `;` or unmatched closing bracket at its own
  // depth (`const a = () => { …; }, b = 2;`), across lines; each declarator
  // binds the pattern before its own top-level `=` (or `of`/`in` in a loop
  // head). Matched at every keyword, so a declaration nested in another's
  // initializer is read on its own too.
  for (const m of mask.matchAll(new RegExp(String.raw`(?<!${ID_CHAR}|\.)(?:const|let|var)(?!${ID_CHAR})`, "gu"))) {
    const from = m.index + m[0].length;
    for (const declarator of splitTopLevel(mask.slice(from, listEnd(mask, from)))) {
      bind(declarator.slice(0, topLevelIndex(declarator, DECLARATOR_END)));
    }
  }
  // `function round(…)`, `class Money`.
  for (const m of mask.matchAll(new RegExp(String.raw`\b(?:function\*?|class)\s*\*?\s*(${IDENT})`, "gu"))) {
    if (m[1] !== undefined) declared.add(m[1]);
  }
  // A parameter list: a function's, a method's or an arrow's `(…)`, followed by
  // a block or `=>` — unless a control keyword owns the parentheses (`if (x) {`
  // declares nothing). Each parameter binds its pattern; a default does not.
  for (let i = mask.indexOf("("); i !== -1; i = mask.indexOf("(", i + 1)) {
    const word = new RegExp(String.raw`(${IDENT})\s*$`, "u").exec(mask.slice(Math.max(0, i - 64), i))?.[1];
    if (word !== undefined && /^(if|while|for|switch|with)$/.test(word)) continue;
    const close = closingParen(mask, i);
    if (close === i) continue;
    if (!/^\s*(?:\{|=>)/.test(mask.slice(close))) continue;
    for (const param of splitTopLevel(mask.slice(i + 1, close - 1))) {
      bind(param.slice(0, topLevelIndex(param, PARAM_DEFAULT)));
    }
  }
  // A bare arrow parameter: `n => …`.
  for (const m of mask.matchAll(new RegExp(String.raw`(?<!${ID_CHAR}|\.)(${IDENT})\s*=>`, "gu"))) {
    if (m[1] !== undefined) declared.add(m[1]);
  }
  return declared;
}

/** Where a declaration list starting at `from` ends: its top-level `;`, an unmatched closer, or the end. */
function listEnd(mask: string, from: number): number {
  let depth = 0;
  for (let i = from; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return i;
    } else if (ch === ";" && depth === 0) return i;
  }
  return mask.length;
}

/** The first top-level offset in `text` where the sticky `at` matches (the text's length when none does). */
function topLevelIndex(text: string, at: RegExp): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0) {
      at.lastIndex = i;
      if (at.test(text)) return i;
    }
  }
  return text.length;
}

/** A default's `=` — not `==`, `=>`, or the tail of `<=`/`+=`/…; in a declarator, also a loop head's `of`/`in`. */
const PARAM_DEFAULT = /(?<![=!<>+\-*/%&|^?])=(?![=>])/uy;
const DECLARATOR_END = new RegExp(String.raw`${PARAM_DEFAULT.source}|(?<![\p{ID_Continue}$])(?:of|in)(?![\p{ID_Continue}$])`, "uy");

/**
 * Refuse an inline body that reads a name from the scope it was WRITTEN in.
 *
 * An inline body is recovered with `toString()` and only its text travels, so a
 * module-scope `const RATE = 1.2` the body mentions is not there when it runs:
 * the body throws `RATE is not defined`, and the engine returns that failure as
 * TEXT in the value slot with HTTP 200 — a wrong value, not an error.
 *
 * Recognized rather than parsed, and tuned to stay quiet on correct code: a name
 * is reported only when it is used as a VALUE (not a property after `.`, not an
 * object key, not a method's name, not the operand of `typeof`), is not declared
 * anywhere in the body (a `const`/`let`/`var`, a parameter, a `function`/`class`
 * name, a `catch` binding, a capture), and is neither a language/runtime global
 * nor one of the engine's preloaded libraries. `$`- and `__`-prefixed names are
 * left to the binding and bundler-helper guards, which own them.
 */
const CLOSURE_CANDIDATE = new RegExp(
  // A `.` before a name is a member access — unless it ends a spread `...`.
  String.raw`(^|\.\.\.|[^\p{ID_Continue}$\u200C\u200D.#])([\p{ID_Start}_][\p{ID_Continue}\u200C\u200D]*)(?!${ID_CHAR})`,
  "gu",
);

function assertNoClosure(code: string, source: string): void {
  const mask = maskNonCode(decodeIdentifierEscapes(code));
  const declared = closureDeclarations(mask);
  // Scope-aware where the Node reader is installed: a name it finds declared in
  // a scope enclosing every read is the body's own, whatever the recognizer saw.
  const scoped = (globalThis as Record<symbol, unknown>)[FREE_READS];
  const free = typeof scoped === "function" ? new Set((scoped as (m: string) => string[])(mask)) : undefined;
  for (const m of mask.matchAll(CLOSURE_CANDIDATE)) {
    const name = m[2]!;
    if (name.startsWith("__") || !isFreeIdentifier(name)) continue;
    // The scope-aware reader decides alone: a name it reports free is read from
    // outside even where the body declares the same name in some other scope.
    // Without it, a declaration anywhere in the body counts.
    if (free !== undefined ? !free.has(name) : declared.has(name)) continue;
    const start = m.index + (m[1] ?? "").length;
    const before = mask.slice(0, start).trimEnd();
    const after = mask.slice(start + name.length).trimStart();
    // `typeof X` is the one safe way to name an undeclared identifier.
    if (/\btypeof$/.test(before)) continue;
    // An object key (`{ rate: 1 }`) or a label, not a reference.
    if (after.startsWith(":") && !after.startsWith("::") && /[{,;]$|^$/.test(before)) continue;
    // A label wherever a statement starts (`items: for (…)`), and the label a
    // `break`/`continue` names — neither reads a binding. Not a ternary's
    // branch before an object literal (`c ? rate : { … }`), which follows an operator.
    if (/^:\s*(?:(?:for|while|do|switch)\b|\{)/.test(after) && !/[-+*/%&|^!~?<>=,.([]$/.test(before)) continue;
    if (/\b(break|continue)$/.test(before)) continue;
    // A method name (`{ total() { … } }`, `get total() { … }`): the `(…)` it
    // opens is followed by a block. Never right after a `)`, where it is a call
    // closing a statement head (`if (x) helper()` then a block).
    if (
      after.startsWith("(") &&
      !before.endsWith(")") &&
      mask.slice(closingParen(mask, start)).trimStart().startsWith("{")
    ) {
      continue;
    }
    // A bare assignment target in statement position.
    if (/^=(?![=>])/.test(after) && /[{};]$|^$/.test(before)) continue;
    if (isClassMemberName(mask, start, name.length)) continue;
    throw new Error(
      `${source}: the lambda body reads \`${name}\`, which it does not declare — it comes from the scope the ` +
        `function was WRITTEN in, and only the body's text reaches the engine. There \`${name}\` is not defined: ` +
        `the body throws, and the engine returns that failure as TEXT in the value slot with HTTP 200 — a wrong ` +
        `value, not an error. Inline the value as a literal, pass it through the stack (\`$var.${name}\` after a ` +
        `\`s.set_var\`, or an input as \`$input.${name}\`), or carry it in with \`lam.fn(body, { capture: { ${name} } })\`.`,
    );
  }
}

/**
 * Whether the name at `start` names a member of the class body it sits in
 * directly (`x = 1`, `static s = 2`, `accessor a`, `y;`, newline-separated
 * fields without semicolons) rather than being read. A name inside a field's
 * initializer is not in member position, so it stays a read.
 */
function isClassMemberName(mask: string, start: number, length: number): boolean {
  let depth = 0;
  let open = -1;
  for (let i = start - 1; i >= 0; i--) {
    const ch = mask[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1 || mask[open] !== "{") return false;
  const header = new RegExp(String.raw`(?<!${ID_CHAR}|\.)class(?:\s+${IDENT})?(?:\s+extends(?!${ID_CHAR})[^{};]*)?\s*$`, "u");
  if (!header.test(mask.slice(Math.max(0, open - 256), open))) return false;
  const lead = mask.slice(open + 1, start);
  const before = lead.trimEnd();
  const memberStart =
    before === "" ||
    /[{};]$/.test(before) ||
    new RegExp(String.raw`(?<!${ID_CHAR}|\.)(?:static|accessor|async|get|set)$`, "u").test(before) ||
    // A line break ends a field whose initializer does not continue past it.
    (/\n\s*$/.test(lead) && !/[-+*/%&|^!~?:<>=,.([]$/.test(before));
  if (!memberStart) return false;
  const after = mask.slice(start + length);
  return /^\s*(?:=(?![=>])|;|\}|\(|$)/.test(after) || /^[ \t]*\n/.test(after) || new RegExp(String.raw`^\s+${IDENT}`, "u").test(after);
}

/**
 * Refuse a body carrying a bundler helper the loader left behind.
 *
 * The body is read back from the LIVE function, so under a `.ts` loader it is
 * transpiled source. {@link stripKeepNames} undoes the one rewrite that is
 * safely undoable; anything else that survives references a module-scope helper
 * the body travels without, which is a `ReferenceError` at runtime — and the
 * engine hands a throwing body back as its own diagnostic TEXT in the value slot
 * with HTTP 200, so the wrong value is the only symptom. Build time is the only
 * place it is catchable.
 *
 * Only `__`-prefixed identifiers are considered, minus what the body declares
 * for itself and {@link HELPER_LOOKALIKES} — a correct body failing this guard
 * would be the worst outcome it can have.
 */
function assertNoBundlerHelpers(mask: string, source: string): void {
  const declared = declaredLocals(mask, new RegExp(String.raw`__${ID_CHAR}*`, "gu"));
  for (const token of tokens(mask, new RegExp(String.raw`(^|\.\.\.|[^\p{ID_Continue}$\u200C\u200D.])(__\p{ID_Start}${ID_CHAR}*)`, "gu"), true)) {
    if (declared.has(token) || HELPER_LOOKALIKES.has(token)) continue;
    const wrote = (Object.hasOwn(BUNDLER_HELPERS, token) ? BUNDLER_HELPERS[token] : undefined);
    throw new Error(
      `${source}: \`${token}\` is a bundler helper, not something this body can call — the body was TRANSPILED ` +
        `before it could be read back${wrote ? `, because it writes ${wrote}` : ""}. An inline body is recovered ` +
        `from the live function with \`toString()\`, and a \`.ts\` loader (tsx/esbuild, which is how a TypeScript ` +
        `entry is evaluated) returns rewritten source. The helper is defined at MODULE scope and only the body ` +
        `travels, so \`${token}\` is undefined at runtime: the body throws, and the engine returns that failure as ` +
        `TEXT in the value slot with HTTP 200 — a wrong value, not an error. ` +
        `Move the body to its own module and load it with \`lam.file(...)\`, or write it as text with ` +
        `\`lam.raw(...)\`; neither is transpiled.`,
    );
  }
}

// --- capture ------------------------------------------------------------------------

/**
 * Class instances whose `JSON.stringify` form is a LIE — it succeeds, so the
 * prelude would emit a plausible-looking literal, and the body then reads
 * something of a different type than the captured value (and than the type
 * TypeScript inferred for it from `capture`).
 *
 * `new Date(0)` becomes the string `"1970-01-01T00:00:00.000Z"`, so `d.getTime()`
 * in the body is a `TypeError`; a `Map`/`Set` becomes `{}`, so every lookup
 * silently misses; a `RegExp` becomes `{}`, so `.test()` throws. All four fail
 * INSIDE the engine, which returns the failure as TEXT in the value slot with
 * HTTP 200 — a wrong value, not an error. Each entry carries the
 * round-trip an author actually wants.
 */
const UNREPRESENTABLE_CLASSES: ReadonlyArray<{
  ctor: abstract new (...args: never[]) => object;
  name: string;
  fix: string;
}> = [
  {
    ctor: Date,
    name: "Date",
    fix: "capture the epoch number (`d.getTime()`) or the ISO string and rebuild it in the body (`new Date(d)`)",
  },
  {
    ctor: Map,
    name: "Map",
    fix: "capture a plain object (`Object.fromEntries(m)`) — or the entries array, and rebuild with `new Map(entries)` in the body",
  },
  {
    ctor: Set,
    name: "Set",
    fix: "capture an array (`[...s]`) — and rebuild with `new Set(arr)` in the body if you need set semantics",
  },
  {
    ctor: RegExp,
    name: "RegExp",
    fix: "capture the source and flags as strings and rebuild with `new RegExp(src, flags)` in the body",
  },
];

/**
 * Refuse a capture value that cannot survive the trip to the engine as JSON.
 *
 * The body is sent as TEXT and runs in a different process, so whatever
 * `JSON.stringify` writes into the prelude is ALL the body gets — and anything
 * it would quietly change reaches the body as a different value than the one
 * TypeScript typed: `NaN` and `Infinity` become `null`, a hole in an array
 * becomes `null`, a typed array becomes an index-keyed object, and a class
 * instance (`Error`, `URL`, a `new String`) becomes `{}` or whatever its
 * `toJSON` returns. Each is refused at any depth, with the path to it.
 *
 * Top-level `undefined` is refused, as there is nothing to declare, and so is
 * an `undefined` array element, which encodes as `null`. An `undefined` object
 * property is left alone deliberately: `JSON.stringify` drops it, and a body
 * reading the key gets `undefined` either way, so refusing it would cost
 * authors a normal spelling to prevent nothing.
 *
 * {@link UNREPRESENTABLE_CLASSES} carry their own message, with the round-trip
 * an author actually wants.
 */
function assertJsonCapture(name: string, value: unknown, source: string): void {
  if (value === undefined) {
    throw new Error(
      `${source}: capture \`${name}\` is undefined, which cannot cross into the engine — the body is sent as TEXT ` +
        `and runs in a different process. Capture JSON data (string, number, boolean, null, object, array).`,
    );
  }
  assertJsonValue(name, value, source, new Map());
}

/** Walk a capture value, refusing anything `JSON.stringify` would drop or rewrite. */
/**
 * `ancestors` maps each container on the path down to `value` to its own path:
 * meeting one again is a cycle. A container reached twice by different paths
 * is a shared reference, which JSON encodes as two copies, and is checked twice.
 */
function assertJsonValue(path: string, value: unknown, source: string, ancestors: Map<object, string>): void {
  const refuse = (what: string, becomes: string, fix = "Capture the plain JSON form and rebuild it in the body."): never => {
    throw new Error(
      `${source}: capture \`${path}\` is ${what}, which cannot cross into the engine — the body is sent as TEXT, and ` +
        `JSON-encoding it yields ${becomes}. The body would read a different value than the one TypeScript gave it, ` +
        `and the engine returns what it computes from that with HTTP 200 — a wrong value rather than an error. ${fix}`,
    );
  };
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    refuse(`${article(type)} ${type}`, type === "bigint" ? "an error" : "nothing", "Capture JSON data; for behaviour, inline it in the body.");
  }
  if (type === "number" && !Number.isFinite(value)) {
    refuse(`\`${String(value)}\``, "`null`", "Capture it as a string (`String(n)`) and rebuild with `Number(s)` in the body.");
  }
  if (value === null || type !== "object") return;
  const object = value as object;
  for (const entry of UNREPRESENTABLE_CLASSES) {
    if (!(object instanceof entry.ctor)) continue;
    refuse(
      `${article(entry.name)} ${entry.name}`,
      entry.name === "Date" ? "a string" : "`{}`",
      `Instead, ${entry.fix}.`,
    );
  }
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    refuse(`a binary buffer (\`${object.constructor.name}\`)`, "an index-keyed object or `{}`", "Capture a plain array (`Array.from(bytes)`) and rebuild it in the body.");
  }
  const cycleAt = ancestors.get(object);
  if (cycleAt !== undefined) {
    throw new Error(
      `${source}: capture \`${path}\` is \`${cycleAt}\` itself — a cycle, which JSON cannot encode. ` +
        "Capture an acyclic copy and rebuild the link in the body.",
    );
  }
  ancestors.set(object, path);
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!(i in object)) refuse(`a sparse array (no element at [${i}])`, "`null` in every hole", "Fill the holes explicitly.");
      if (object[i] === undefined) refuse(`an array holding \`undefined\` at [${i}]`, "`null` there", "Use `null` explicitly, or leave the element out.");
      assertJsonValue(`${path}[${i}]`, object[i], source, ancestors);
    }
    ancestors.delete(object);
    return;
  }
  const proto = Object.getPrototypeOf(object) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const name = (object as { constructor?: { name?: unknown } }).constructor?.name;
    refuse(
      `an instance of \`${typeof name === "string" && name !== "" ? name : "a class"}\``,
      "`{}` or whatever its `toJSON` returns",
      "Capture a plain object of its JSON data and rebuild the instance in the body.",
    );
  }
  for (const [key, item] of Object.entries(object)) {
    if (key === "toJSON" && typeof item === "function") refuse("an object with a `toJSON` method", "what `toJSON` returns", "Capture that value itself.");
    if (item === undefined) continue;
    assertJsonValue(`${path}.${key}`, item, source, ancestors);
  }
  ancestors.delete(object);
}

/** Serialize the capture list as the `const` prelude that opens the body.
 * Exported so every `lam.*` form emits an identical prelude. */
export function capturePrelude(capture: Record<string, unknown> | undefined, source: string): string {
  if (capture === undefined) return "";
  const lines: string[] = [];
  for (const [name, value] of Object.entries(capture)) {
    if (!new RegExp(`^${IDENT}$`, "u").test(name)) {
      throw new Error(`${source}: capture key ${JSON.stringify(name)} is not a valid JavaScript identifier.`);
    }
    assertJsonCapture(name, value, source);
    lines.push(`const ${name} = ${JSON.stringify(value)};`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Refuse a capture key the loader renamed inside the body but not in the prelude.
 *
 * A capture key is destructured from the body's second parameter, so it is an
 * ordinary binding — and when it collides with a MODULE-scope name of its own
 * (`import { CURRENCY_SYMBOLS }` in the file that also captures it), esbuild
 * renames the inner one to `CURRENCY_SYMBOLS2` to keep the two apart. It renames
 * the declaration and every reference together, so a body-local collision stays
 * correct; the capture is the one case that does not, because the declaration is
 * the prelude {@link capturePrelude} writes AFTER the rename, under the original
 * name. The body then reads a free `CURRENCY_SYMBOLS2` — a `ReferenceError` that
 * the engine returns as TEXT with HTTP 200.
 *
 * Refused rather than renamed back. `foo2` in a body that captures `foo` is not
 * PROVABLY the rename — an author may have written a genuinely free `foo2`, and
 * silently binding that to captured data would turn a `ReferenceError` into a
 * plausible wrong number, which is the failure this whole guard exists to stop.
 */
function assertCaptureNotRenamed(
  body: string,
  capture: Record<string, unknown> | undefined,
  source: string,
): void {
  if (capture === undefined) return;
  const keys = Object.keys(capture);
  if (keys.length === 0) return;
  const mask = maskNonCode(decodeIdentifierEscapes(body));
  const declared = declaredLocals(mask, new RegExp(IDENT, "gu"));
  for (const token of tokens(mask, new RegExp(String.raw`(^|\.\.\.|[^\p{ID_Continue}$\u200C\u200D.])(${IDENT}[0-9])(?!${ID_CHAR})`, "gu"), true)) {
    if (declared.has(token)) continue;
    const key = keys.find((k) => new RegExp(`^${k.replace(/\$/g, "\\$")}[0-9]+$`).test(token));
    if (key === undefined) continue;
    throw new Error(
      `${source}: capture key \`${key}\` collides with a module-scope binding of the same name, so the body was ` +
        `rewritten to read \`${token}\` — which the capture prelude does not declare. An inline body is recovered ` +
        `from the live function with \`toString()\`, and a \`.ts\` loader (tsx/esbuild) renames one of two same-named ` +
        `bindings; the prelude is written afterwards, under the ORIGINAL name. As it stands \`${token}\` is undefined ` +
        `at runtime: the body throws, and the engine returns that failure as TEXT in the value slot with HTTP 200 — ` +
        `a wrong value, not an error. Give the capture a key that nothing at module scope shares — it does not have ` +
        `to keep the name of what it carries (\`capture: { <newName>: ${key} }\`, destructured as ` +
        `\`(_, { <newName> }) => …\`) — or move the body to its own module with \`lam.file(...)\`.`,
    );
  }
}

/**
 * Refuse a capture key the body's second parameter destructures and reads when
 * no `capture` entry supplies it. Nothing declares it in the prelude, so the body
 * reads whatever global shares the name (`_` is lodash) or throws — a wrong value
 * or a failure as text, with HTTP 200 either way.
 */
function assertCaptureSupplied(
  reads: readonly string[],
  capture: Record<string, unknown> | undefined,
  source: string,
): void {
  const missing = reads.find((name) => capture === undefined || !Object.hasOwn(capture, name));
  if (missing === undefined) return;
  const how =
    capture === undefined
      ? `there is no \`capture\` here${source.startsWith(`${PREFIX}.`) ? "" : " (an inline body takes none)"}`
      : `\`capture\` has no \`${missing}\` key`;
  // `lam.file(<path>)` names its own call, so the remedy is that call with a capture added.
  const file = /^lam\.file\((.*)\)$/s.exec(source)?.[1];
  const remedy = file === undefined ? `lam.fn(body, { capture: { ${missing} } })` : `lam.file(${JSON.stringify(file)}, { capture: { ${missing} } })`;
  throw new Error(
    `${source}: the body reads \`${missing}\` from its second parameter, but ${how}, so nothing declares it at ` +
      `runtime — the body reads any global of that name instead, or throws. Supply it with ` +
      `\`${remedy}\`, or declare it inside the body.`,
  );
}

// --- the surface ------------------------------------------------------------------------

/**
 * The last step of every `lam.*` form: prepend the capture prelude, validate for
 * the surface, and emit the `const:text` a hand-written `c.text(...)` produced.
 *
 * One function so the three authoring forms cannot drift apart — a body that
 * `lam.fn` accepts is one `lam.raw` and `lam.file` accept, byte for byte.
 */
export function lambdaValue(
  body: string,
  opts: LambdaOptions<Record<string, unknown>> | undefined,
  source: string,
  fromFunction = false,
  captureReads: readonly string[] = [],
): Value {
  // The prelude first: it is what validates the keys, and a key that is not an
  // identifier deserves that message rather than one about a rename.
  const code = capturePrelude(opts?.capture, source) + body;
  assertCaptureSupplied(captureReads, opts?.capture, source);
  assertCaptureNotRenamed(body, opts?.capture, source);
  // Only a body read back from a LIVE function can close over something: text
  // (`lam.raw`, `c.text`) was written for the engine and has no enclosing scope.
  if (fromFunction) assertNoClosure(code, source);
  // No surface named: the call site validates, and it is the one that knows.
  // What comes back is an ordinary `const:text`, so the statement and filter
  // guards see it exactly as they see a hand-written `c.text(...)`.
  if (opts?.surface !== undefined) {
    // Through a cast or plain JS, `surface: "lambda"` crashed the body scan
    // with "Cannot read properties of undefined".
    if (!Object.hasOwn(LAMBDA_BINDINGS, opts.surface)) {
      throw new Error(
        `${source}: surface ${JSON.stringify(opts.surface)} is not a lambda surface — use one of ` +
          `${Object.keys(LAMBDA_BINDINGS).map((k) => JSON.stringify(k)).join(", ")}.`,
      );
    }
    assertLambdaBody(code, opts.surface, source);
  }
  return c.text(code);
}

/**
 * Author a lambda body as a typed TypeScript function.
 *
 * The first parameter destructures the bindings for the surface, so the editor
 * supplies them and a wrong name is a compile error rather than a wrong value at
 * runtime. The body is extracted at author time and emitted as the same
 * `const:text` a hand-written `c.text(...)` produced.
 *
 * ```ts
 * lam.fn(({ $result, $this }) => $result + $this)                 // reduce
 * lam.fn(({ $var }) => $var.subtotal * 1.2, { surface: "s.lambda" })
 * lam.fn(({ $this }, { capturedRate }) => $this * capturedRate, { surface: "map", capture: { capturedRate: rate } })
 * ```
 *
 * Nothing from the enclosing scope crosses implicitly — a closed-over value is
 * undefined at runtime — so anything the body needs from outside goes in
 * `capture` and arrives as the second parameter. Give the capture a key nothing
 * at module scope shares (it need not keep the name of what it carries); a
 * collision is refused at build time, because the loader renames one of the two
 * and the prelude is written under the original name.
 */
function fn<S extends LambdaSurface = "reduce", C extends CaptureRecord<C> = Record<string, never>>(
  body: (bindings: LambdaBindings<S>, captured: C) => unknown,
  opts?: LambdaOptions<C> & { surface?: S },
): Value {
  const extracted = extractFunction(String(body), `${PREFIX}.fn`);
  return lambdaValue(extracted.body, opts, `${PREFIX}.fn`, true, extracted.captureReads);
}

/**
 * The escape hatch: a lambda body as text, validated exactly like {@link fn}.
 *
 * For a body that genuinely cannot be an authored function — one assembled at
 * build time, or lifted verbatim out of a pulled workspace. It is guarded, not
 * extracted, so the guard cannot be sidestepped by choosing this form.
 */
function raw(code: string, opts?: LambdaOptions<Record<string, CaptureValue>>): Value {
  return lambdaValue(code, opts, `${PREFIX}.raw`);
}

/**
 * Reading a file needs a filesystem, so `lam.file` lives on the Node entry only
 * — but the isomorphic `lam` still carries this stub, because the alternative is
 * `lam.file is not a function` from any position loose enough to reach it.
 * It never touches `node:fs`, so the isomorphic entry stays bundleable.
 */
function fileOnNodeEntryOnly(): never {
  throw new Error(
    `${PREFIX}.file: this entry has no filesystem. It ships on the Node entry only — ` +
      `\`import { lam } from "@xano/sdk/node"\` (that \`lam\` carries \`fn\` and \`raw\` too). ` +
      `In a browser bundle, use \`${PREFIX}.raw(code, { surface })\` with the body as text.`,
  );
}

/**
 * Lambda authoring. `lam.fn` for an inline typed body, `lam.raw` for text, and
 * `lam.file` (from `@xano/sdk/node`) for a body big enough to want its own
 * type-checked module. All three produce the same `const:text` {@link Value} and
 * pass the same validation.
 *
 * `file` is deliberately absent from the TYPE here so `lam.file` off this entry
 * is a compile error that names the Node entry; the runtime stub only catches
 * the calls types didn't.
 */
export const lam: { fn: typeof fn; raw: typeof raw } = Object.assign({ fn, raw }, { file: fileOnNodeEntryOnly });
