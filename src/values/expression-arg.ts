/**
 * The filters whose argument is Xano **Expression Engine** source — and the
 * guard that refuses the two ways of writing it that fail silently.
 *
 * `fl.transform` reads as a sibling of the eight lambda filters and is not one.
 * It runs on the expression path, not the JavaScript one, and it binds the piped
 * operand POSITIONALLY: `$0`, or equivalently `$$` at the top level of the
 * expression. `$this` — the name the engine's own catalog description advertises
 * — is not a binding here at all.
 *
 * What makes it worth a guard rather than only a doc fix is that the failure is
 * not reliably loud. A live probe (`scripts/probe-transform-expression.ts`,
 * recorded in `vendor/transform-expression.json`) over the operand `5`:
 *
 *   $this                    → null          (silent)
 *   $this ?? "was-null"      → "was-null"    (silent — null propagated)
 *   $this => $this * 2       → false         (silent, HTTP 200)
 *   const x = $0; return x   → "const x"     (silent, HTTP 200)
 *   return $0 * 2            → exception "Not numeric."
 *
 * Three of those return a plausible wrong answer with a 200. So the guard fires
 * at authoring time on the two classes it can identify with certainty from the
 * text — an unbound `$this`/`$parent`/`$index`/`$result`, and a JavaScript body —
 * and stays out of the way otherwise. It cannot check the expression itself:
 * there is no expression validator to check it against, and one that guessed
 * would reject correct code.
 *
 * One hazard is documented rather than guarded, because catching it reliably
 * would require parsing the expression. Inside an object or array literal, a
 * filter ARGUMENT's comma is read as the key separator:
 *
 *   { a: $0|to_text:"", b: 1 }     → {"a":"5"}            — `b` vanishes
 *   { a: ($0|to_text:""), b: 1 }   → {"a":"5","b":1}      — parenthesized
 *   { a: $0|to_text, b: 1 }        → {"a":"5","b":1}      — no argument, fine
 *
 * The middle case is the rule; the last is why it is easy to learn wrong. The
 * catalog description and `FILTER_NOTES` both carry it.
 */
import type { Value } from "./value.js";

/**
 * Filter → the argument slot holding expression source.
 *
 * A table rather than a special case, so a second such filter cannot be added
 * without deciding its slot. `to_expr` is deliberately absent: its source
 * arrives as the PIPED value rather than an argument, and it has no operand
 * binding at all (probed — `$0` is null there), so nothing here applies to it.
 */
export const EXPRESSION_ARG_FILTERS: Readonly<Record<string, number>> = {
  transform: 0,
};

/**
 * The bindings of the OTHER surfaces, which a `transform` expression resolves to
 * null. `$this` leads because it is the one the wrong upstream description
 * teaches, and the one the bug report used.
 */
const UNBOUND_HERE = ["$this", "$parent", "$index", "$result"] as const;

/**
 * Blank out string literals before scanning for JavaScript syntax.
 *
 * `$0|split:";"` is a correct expression whose argument contains a semicolon,
 * and `"a => b"` is a correct string. Scanning the raw text would reject both.
 * Replacing each literal's CONTENTS with spaces preserves every offset, so the
 * scan still sees the structure and none of the payload.
 */
function withoutStringLiterals(source: string): string {
  return source.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1?/g, (m) => {
    // An UNTERMINATED literal runs to end-of-string and has no closing quote to
    // keep — blank the whole remainder rather than leaving its last character
    // behind, so nothing inside a quote can ever reach the scan.
    const closed = m.length > 1 && m.at(-1) === m[0];
    return m[0] + " ".repeat(m.length - (closed ? 2 : 1)) + (closed ? m[0] : "");
  });
}

/**
 * Refuse an expression argument that cannot mean what its author intended.
 *
 * Fires only on an INSPECTABLE argument — an unfiltered `const` string. A `ref`,
 * an input binding, or a filtered value carries no text to read, and a guard
 * that fired on those would be guessing. An EMPTY argument is left alone too:
 * the editor saves a freshly-added filter with no expression, so a pulled
 * workspace holding that default has to keep round-tripping.
 *
 * The escape hatch, for a stored value this refuses, is `rawValue({…})` — which
 * carries the whole value through verbatim without reaching this choke point.
 * Codegen already takes it automatically when a guard rejects a chain.
 */
export function assertExpressionFilterArgs(name: string, args: ReadonlyArray<Value | undefined>): void {
  const slot = (Object.hasOwn(EXPRESSION_ARG_FILTERS, name) ? EXPRESSION_ARG_FILTERS[name] : undefined);
  if (slot === undefined) return;
  const arg = args[slot];
  if (!isInspectableSource(arg) || arg.value.trim() === "") return;
  assertExpressionArg(arg.value, `fl.${name}`);
}

/** An argument whose text can be read at all: an unfiltered `const` string. */
function isInspectableSource(arg: unknown): arg is Value & { value: string } {
  return (
    typeof arg === "object" &&
    arg !== null &&
    (arg as Value).tag === "const" &&
    typeof (arg as Value).value === "string" &&
    ((arg as Value).filters?.length ?? 0) === 0
  );
}

/**
 * The check itself, exported for the tests and for any future surface that takes
 * the same argument.
 */
export function assertExpressionArg(source: string, fn: string): void {
  const scannable = withoutStringLiterals(source);

  const unbound = UNBOUND_HERE.find((b) => new RegExp(`\\${b}\\b`).test(scannable));
  if (unbound !== undefined) {
    const bare = unbound.slice(1);
    throw new Error(
      `${fn}: \`${unbound}\` is not bound in an expression — it resolves to null, and the filter still returns ` +
        `HTTP 200 with a wrong answer. ${fn} takes Xano Expression Engine source, and the piped value arrives in the ` +
        `POSITIONAL slot: write \`$0\` (or \`$$\`) where you wrote \`${unbound}\`. ` +
        `${unbound === "$this" ? "The engine's own filter description says `$this`; it is wrong. " : ""}` +
        `\`$var\`, \`$input\`, \`$env\` and \`$auth\` DO resolve. ` +
        `(If a stack variable is genuinely named \`${bare}\`, spell it \`$var.${bare}\`.)`,
    );
  }

  // `return` as a KEYWORD — not `$return` (a stack variable a workspace may
  // legitimately hold) and not `.return` (an object key). A bare `\breturn\b`
  // matches both, because `$` and `.` are word boundaries.
  const js =
    (/(?<![$\w.])return\b/.test(scannable) && "a `return` statement") ||
    (/=>/.test(scannable) && "an arrow function") ||
    (/;/.test(scannable) && "a statement separator (`;`)");
  if (js) {
    throw new Error(
      `${fn}: the expression contains ${js}, so it is being written as a JavaScript body. ${fn} is NOT a lambda — ` +
        `it takes Xano Expression Engine source, which is a single expression with no \`return\`. The engine parses ` +
        `it either way: \`return $0 * 2\` throws "Not numeric.", and \`const x = $0; return x\` returns the text ` +
        `"const x" with HTTP 200. Write the expression alone — \`$0 * 2\` — using \`$0\` (or \`$$\`) for the piped ` +
        `value. For real JavaScript use \`fl.lambda\`, whose body DOES bind \`$this\`.`,
    );
  }
}
