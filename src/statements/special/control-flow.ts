/**
 * Hand-authored `!class` control-flow / terminal statements. These carry
 * PHP transforms in the engine, so they're authored by hand and validated
 * against persisted fixtures rather than codegen'd. (`conditional` — also a
 * `!class` special — already lives in `src/statements/conditional.ts`.)
 *
 * - `return` / `die` / `debug_log`: carry a single Value in `context`.
 * - `foreach_break` / `foreach_continue` / `foreach_remove`: empty `context`.
 */
import type { Statement } from "../statement.js";
import { registerStatement, annotate, ANNOTATION_KEYS } from "../statement.js";
import { assertKnownKeys } from "../../util/known-keys.js";
import type { StatementAnnotations } from "../statement.js";
import type { Value } from "../../values/value.js";
import { assertArg, describeEntry } from "../args.js";

/** Accept either a bare `Value` or the object form `{ value }` for ergonomics. */
type ValueArg = Value | { value: Value };

/** A `Value` has a `tag`; the `{ value }` wrapper does not — use that to unwrap. */
function asValue(arg: ValueArg): Value {
  return "tag" in arg ? arg : arg.value;
}

function valueContext(statement: string, arg: ValueArg) {
  // A terminal statement's value is POSITIONAL, so there is no argument object
  // to normalize — an untyped `s.return()` has to be named here or it reports
  // an `in`-operator TypeError against `undefined`.
  assertArg(statement, "value", arg);
  // `null`, `{}` or a bare string reach here through `any`; each read a
  // property off something that has none and threw a TypeError naming nothing.
  // A trigger field accessor (`t.action`) is a callable Value — a function —
  // and is the value itself, not a `{ value }` wrapper.
  const value = arg !== null && (typeof arg === "object" || typeof arg === "function") ? asValue(arg) : undefined;
  if (value === null || (typeof value !== "object" && typeof value !== "function") || typeof (value as { tag?: unknown }).tag !== "string") {
    throw new Error(
      `Statement "${statement}": argument "value" must be a value (\`c.*\`, \`ref()\`, \`inp()\`, …) — got ` +
        `${describeEntry(arg)}.`,
    );
  }
  return { value: value.value, tag: value.tag, filters: value.filters };
}

/** `return <value>` — terminate and return a value. */
export function returnValue(value: ValueArg, a?: StatementAnnotations): Statement {
  const context = valueContext("s.return", value);
  assertKnownKeys(`Statement "s.return": options`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:return", context }, a);
}

/**
 * `die <value>` — terminate the request: HTTP 200 with
 * `{ payload: <value>, statement: "Stop & Debug" }`, not an error status (use
 * `s.precondition` for one).
 *
 * The same statement as `s.debug.stop` (both emit `mvp:die`), and the one flat
 * alias whose name does not mirror its `s.*` path — there is no `s.die`. Despite
 * living under `debug`, it is real control flow rather than a development aid.
 * Compare `s.throw`, which raises a catchable named error.
 */
export function die(value: ValueArg, a?: StatementAnnotations): Statement {
  const context = valueContext("s.debug.stop", value);
  assertKnownKeys(`Statement "s.debug.stop": options`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:die", context }, a);
}

/** `debug_log <value>` — emit a debug log entry. */
export function debugLog(value: ValueArg, a?: StatementAnnotations): Statement {
  const context = valueContext("s.debug.log", value);
  assertKnownKeys(`Statement "s.debug.log": options`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:debug_log", context }, a);
}

/** `foreach_break` — break out of the enclosing loop. */
export function foreachBreak(a?: StatementAnnotations): Statement {
  assertKnownKeys(`Statement "s.foreach_break"`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:foreach_break", context: {} }, a);
}

/** `foreach_continue` — continue the enclosing loop. */
export function foreachContinue(a?: StatementAnnotations): Statement {
  assertKnownKeys(`Statement "s.foreach_continue"`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:foreach_continue", context: {} }, a);
}

/**
 * `foreach_remove` — remove the current item from the iterated collection.
 *
 * ⚠ It rewrites the VARIABLE named by the loop's `list`, so the loop must
 * iterate a bare `ref("arr")` (a stack var): the shrunk list is visible on that
 * var AFTER the loop. On an `inp()` list — or any non-`ref` value — it silently
 * does NOTHING (nothing to write back to) and reports nothing. Removing during
 * iteration does not skip the next item. Copy an input into a var first
 * (`s.set_var("arr", inp("items"))`) to use it.
 */
export function foreachRemove(a?: StatementAnnotations): Statement {
  assertKnownKeys(`Statement "s.foreach_remove"`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:foreach_remove", context: {} }, a);
}

registerStatement("mvp:return", returnValue);
registerStatement("mvp:die", die);
registerStatement("mvp:debug_log", debugLog);
registerStatement("mvp:foreach_break", foreachBreak);
registerStatement("mvp:foreach_continue", foreachContinue);
registerStatement("mvp:foreach_remove", foreachRemove);
