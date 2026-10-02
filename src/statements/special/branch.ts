/**
 * Hand-authored branching block statements — `switch` and `try_catch`.
 * Both carry structural control-flow transforms in the engine, so
 * (like `conditional` and the loops) they're authored by hand rather than
 * codegen'd. Each nests `run[]` stacks encoded through the shared statement
 * encoder.
 *
 * Stored shapes (from the Xano engine's persisted switch / try_catch shapes):
 *   switch      → context: { value:<Value>, elif:{ run:[switch_case…] }, else:{ run:[…] } }
 *   switch_case → context: { value:<Value>, break?:bool, if:{ run:[…] } }
 *   try_catch   → context: { if:{ run:[…try…] }, else:{ run:[…catch…] }, then:{ run:[…finally…] } }
 *
 * In `switch`, `value` is the subject being matched and each `switch_case`'s
 * `value` is the literal a case compares against; `else.run` is the `default`
 * block. `break` (fallthrough control) is omitted unless explicitly set, matching
 * the golden fixture. In `try_catch`, the engine maps try→`if`, catch→`else`,
 * finally→`then`; all three blocks are always emitted (the engine's export
 * normalizes each to `{ run: [] }`).
 */
import type { BodyBrand, BranchesBrand, CatchBrand, MaybeBodyBrand, Statement } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";
import { encodeStatement, registerStatement, annotate } from "../statement.js";
import type { Value } from "../../values/value.js";
import { argsOrEmpty, assertArg, assertStatements, assertValueArg, describeEntry } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

function run(body: Statement[]): unknown[] {
  return body.map(encodeStatement);
}

export interface SwitchCaseArgs extends StatementAnnotations {
  /** The literal this case matches against the switch subject. */
  when: Value;
  /** Statements run when this case matches. */
  body: Statement[];
  /**
   * Whether to stop after this case (`true`) or fall through to the next
   * (`false`). Omitted from the stored shape entirely when not set.
   */
  break?: boolean;
}

const SWITCH_CASE_KEYS = /* @__PURE__ */ Object.keys({ when: 1, body: 1, break: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<SwitchCaseArgs>, 1>);

/** A single `case (when) { body }` clause of a `switch`. */
export function switchCase(args: SwitchCaseArgs, where = ""): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.switch"${where === "" ? "" : `: argument "${where.slice(0, -1)}"`}`, args, SWITCH_CASE_KEYS);
  assertValueArg("s.switch", `${where}when`, args.when);
  assertStatements("s.switch", `${where}body`, args.body);
  const context: Record<string, unknown> = { value: valueFields(args.when) };
  if (args.break !== undefined) {
    context.break = args.break;
  }
  context.if = { run: run(args.body) };
  return annotate({ name: "mvp:switch_case", context, input: [] }, args);
}

export interface SwitchArgs extends StatementAnnotations {
  /** The subject value being matched. */
  on: Value;
  /** Ordered `case` clauses. */
  cases: SwitchCaseArgs[];
  /** The `default` block, run when no case matches. */
  default?: Statement[];
}

/** One `case` as the typed overload reads it — its `body` keeps its tuple. */
type SwitchCaseBranch = Omit<SwitchCaseArgs, "body"> & { body: readonly Statement[] };

/** Every case body, end to end. */
type CaseBodies<Cs> = Cs extends readonly [infer H, ...infer R]
  ? H extends { body: infer B extends readonly unknown[] }
    ? [...B, ...CaseBodies<R>]
    : CaseBodies<R>
  : [];

/** Each case body as its own branch; an untyped list is one branch that binds nothing. */
type CaseBranches<Cs> = Cs extends readonly [infer H, ...infer R]
  ? H extends { body: infer B extends readonly unknown[] }
    ? [B, ...CaseBranches<R>]
    : CaseBranches<R>
  : Cs extends readonly [] ? [] : [[]];

const SWITCH_KEYS = /* @__PURE__ */ Object.keys({ on: 1, cases: 1, default: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<SwitchArgs>, 1>);

/** `switch (on) { case … default … }` — multi-way branch. */
export function switchStatement<
  const Cs extends readonly SwitchCaseBranch[],
  const D extends readonly Statement[] = [],
>(
  args: Omit<SwitchArgs, "cases" | "default"> & { cases: Cs; default?: D },
): Statement & MaybeBodyBrand<[...CaseBodies<Cs>, ...D]> & BranchesBrand<[...CaseBranches<Cs>, D]>;
export function switchStatement(args: SwitchArgs): Statement;
export function switchStatement(args: SwitchArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.switch"`, args, SWITCH_KEYS);
  assertValueArg("s.switch", "on", args.on);
  assertArg("s.switch", "cases", args.cases);
  if (!Array.isArray(args.cases)) {
    throw new Error(`Statement "s.switch": argument "cases" must be an array of { when, body } cases — got ${describeEntry(args.cases)}.`);
  }
  if (args.default !== undefined && args.default !== null) assertStatements("s.switch", "default", args.default);
  return annotate({
    name: "mvp:switch",
    context: {
      value: valueFields(args.on),
      elif: {
        run: args.cases.map((c, i) => {
          if (c === null || typeof c !== "object") {
            throw new Error(
              `Statement "s.switch": argument "cases[${i}]" must be a { when, body } case — got ${describeEntry(c)}.`,
            );
          }
          return encodeStatement(switchCase(c, `cases[${i}].`));
        }),
      },
      else: { run: run(args.default ?? []) },
    },
    input: [],
  }, args);
}

export interface TryCatchArgs extends StatementAnnotations {
  /** The protected block (engine `if`). */
  try: Statement[];
  /** Error-handler block (engine `else`). */
  catch?: Statement[];
  /** Always-run block (engine `then`). */
  finally?: Statement[];
}

/** `try_catch { try … catch … finally … }` — error handling block. */
export function tryCatch<
  const T extends readonly Statement[],
  const F extends readonly Statement[] = [],
  const C extends readonly Statement[] = [],
>(
  args: Omit<TryCatchArgs, "try" | "catch" | "finally"> & { try: T; catch?: C; finally?: F },
): Statement & BodyBrand<F> & CatchBrand<T, C> {
  return tryCatchStatement(argsOrEmpty(args as unknown as TryCatchArgs)) as Statement &
    BodyBrand<F> &
    CatchBrand<T, C>;
}

const TRY_CATCH_KEYS = /* @__PURE__ */ Object.keys({ try: 1, catch: 1, finally: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<TryCatchArgs>, 1>);

function tryCatchStatement(args: TryCatchArgs): Statement {
  assertKnownKeys(`Statement "s.try_catch"`, args, TRY_CATCH_KEYS);
  assertStatements("s.try_catch", "try", args.try);
  if (args.catch !== undefined && args.catch !== null) assertStatements("s.try_catch", "catch", args.catch);
  if (args.finally !== undefined && args.finally !== null) assertStatements("s.try_catch", "finally", args.finally);
  return annotate({
    name: "mvp:try_catch",
    context: {
      if: { run: run(args.try) },
      else: { run: run(args.catch ?? []) },
      then: { run: run(args.finally ?? []) },
    },
    input: [],
  }, args);
}

registerStatement("mvp:switch", switchStatement);
registerStatement("mvp:switch_case", switchCase);
registerStatement("mvp:try_catch", tryCatch);
