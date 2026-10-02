/**
 * Hand-authored control-flow block statements. These carry non-trivial
 * transforms in the engine (for, foreach, while, group), so they're authored by
 * hand — like `conditional` — rather than codegen'd. Each nests a `run[]` stack
 * encoded through the shared statement encoder, and `while` reuses the
 * conditional's `encodeComparison`.
 *
 * Stored shapes (from the Xano engine's persisted for/foreach/while shapes):
 *   for     → context: { as, cnt:<Value>,  run:[…] }
 *   foreach → context: { as, list:<Value>, run:[…] }
 *   while   → context: { expr:<comparison>, run:[…] }
 *   group   → context: { run:[…] }
 *
 * All four are golden-verified: `for`/`foreach` from vendored goldens, and
 * `while`/`group` from live engine captures. The
 * `while` shape (`expr` comparison + `run[]`) and `group`'s bare `{run}` are
 * confirmed byte-exact.
 */
import type { BodyBrand, MaybeBodyBrand, Statement } from "../statement.js";
import type { StatementAnnotations, StatementOptions } from "../statement.js";
import { encodeStatement, registerStatement, annotate, ANNOTATION_KEYS } from "../statement.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";
import type { Value } from "../../values/value.js";
import { encodeRuntimeCondition } from "../conditional.js";
import type { Condition } from "../conditional.js";
import { argsOrEmpty, assertArg, assertNewVarName, assertStatements, assertValueArg } from "../args.js";

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

function run(body: Statement[]): unknown[] {
  return body.map(encodeStatement);
}

export interface ForArgs extends StatementOptions {
  /** Loop variable name (the index). */
  as: string;
  /** Iteration count. */
  count: Value;
  body: Statement[];
}

const FOR_KEYS = /* @__PURE__ */ Object.keys({ as: 1, count: 1, body: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ForArgs>, 1>);

/** `for (as in 0..count) { body }` — count-bounded loop. */
export function forLoop<const B extends readonly Statement[] = Statement[]>(
  args: Omit<ForArgs, "body"> & { body: B },
): Statement & MaybeBodyBrand<B>;
export function forLoop(args: ForArgs): Statement;
export function forLoop(args: ForArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.for"`, args, FOR_KEYS);
  // `as` names the loop variable and is PASSED ALONG into `context.as`. Absent,
  // it serializes away entirely and the body's `ref("i")` resolves to nothing —
  // a loop that deploys clean and reads an unset variable on every iteration.
  assertArg("s.for", "as", args.as);
  assertNewVarName("s.for", args.as, "as");
  assertValueArg("s.for", "count", args.count);
  assertStatements("s.for", "body", args.body);
  return annotate({
    name: "mvp:for",
    context: { as: args.as, cnt: valueFields(args.count), run: run(args.body) },
    input: [],
  }, args);
}

export interface ForeachArgs extends StatementOptions {
  /** Loop variable name (the current item). */
  as: string;
  /** The list to iterate. */
  list: Value;
  body: Statement[];
}

const FOREACH_KEYS = /* @__PURE__ */ Object.keys({ as: 1, list: 1, body: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ForeachArgs>, 1>);

/** `foreach (as of list) { body }` — list iteration. */
export function foreachLoop<const B extends readonly Statement[] = Statement[]>(
  args: Omit<ForeachArgs, "body"> & { body: B },
): Statement & MaybeBodyBrand<B>;
export function foreachLoop(args: ForeachArgs): Statement;
export function foreachLoop(args: ForeachArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.foreach"`, args, FOREACH_KEYS);
  // Same as `for` above: `as` names the current item and reaches `context.as`
  // unread.
  assertArg("s.foreach", "as", args.as);
  assertNewVarName("s.foreach", args.as, "as");
  assertValueArg("s.foreach", "list", args.list);
  assertStatements("s.foreach", "body", args.body);
  return annotate({
    name: "mvp:foreach",
    context: { as: args.as, list: valueFields(args.list), run: run(args.body) },
    input: [],
  }, args);
}

export interface WhileArgs extends StatementAnnotations {
  when: Condition;
  body: Statement[];
}

const WHILE_KEYS = /* @__PURE__ */ Object.keys({ when: 1, body: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<WhileArgs>, 1>);

/** `while (when) { body }` — condition-bounded loop. */
export function whileLoop<const B extends readonly Statement[] = Statement[]>(
  args: Omit<WhileArgs, "body"> & { body: B },
): Statement & MaybeBodyBrand<B>;
export function whileLoop(args: WhileArgs): Statement;
export function whileLoop(args: WhileArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.while"`, args, WHILE_KEYS);
  assertArg("s.while", "when", args.when);
  assertStatements("s.while", "body", args.body);
  return annotate({
    name: "mvp:while",
    context: { expr: encodeRuntimeCondition(args.when, "s.while `when`"), run: run(args.body) },
    input: [],
  }, args);
}

/** `group { body }` — a labeled block grouping a sub-stack. */
export function group<const B extends readonly Statement[]>(body: B, a?: StatementAnnotations): Statement & BodyBrand<B> {
  assertStatements("s.group", "body", body as unknown as Statement[]);
  assertKnownKeys(`Statement "s.group": options`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:group", context: { run: run(body as unknown as Statement[]) }, input: [] }, a) as unknown as Statement &
    BodyBrand<B>;
}

registerStatement("mvp:for", forLoop);
registerStatement("mvp:foreach", foreachLoop);
registerStatement("mvp:while", whileLoop);
registerStatement("mvp:group", group);
