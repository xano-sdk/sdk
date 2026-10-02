/**
 * `conditional` statement — control flow that proves the registry/base
 * seam generalizes beyond `set_var`: nested `run[]` stacks plus a boolean
 * comparison expression.
 *
 * Stored shape (from the Xano engine's persisted conditional shape):
 *   context: {
 *     expr: { expression: [{ type:"statement", or:false, group:{expression:[]},
 *                            statement:{ op, left, right } }] },
 *     if:   { run: [...statements] },
 *     else: { run: [...statements] },
 *   }
 * Operands use the `operand` key (not `value`). The persisted form does NOT
 * carry `ignore_empty` (optional/`?=false` in the engine schema, dropped at its
 * default on save).
 *
 * The expression algebra (`expr`/`Comparison`/`encodeComparison` + the full
 * `cmp`/`and`/`or` tree) lives in {@link ./expression.js}; re-exported here
 * so existing `./conditional.js` importers keep resolving.
 */
import type { ConditionalContext, ConditionalElifContext } from "../types/xdo.js";
import type { BranchesBrand, MaybeBodyBrand, Statement } from "./statement.js";
import type { StatementAnnotations } from "./statement.js";
import { encodeStatement, registerStatement, annotate } from "./statement.js";
import { encodeRuntimeCondition, type Condition } from "./expression.js";

export {
  expr,
  cmp,
  and,
  or,
  mixed,
  encodeComparison,
  encodeRuntimeCondition,
  encodeSearchExpression,
  type Comparison,
  type ComparisonOp,
  type Condition,
  type MixedGroup,
  type MixedTerm,
} from "./expression.js";
import { argsOrEmpty, assertArg, assertStatements, describeEntry } from "./args.js";
import { assertKnownKeys, type AllKeys } from "../util/known-keys.js";

export const CONDITIONAL = "mvp:conditional";
export const CONDITIONAL_ELIF = "mvp:conditional_elif";

/** One `else if (when) { then }` branch of a {@link conditional}'s elif stack. */
export interface ConditionalElifArgs extends StatementAnnotations {
  when: Condition;
  then: Statement[];
}

const ELIF_KEYS = /* @__PURE__ */ Object.keys({ when: 1, then: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ConditionalElifArgs>, 1>);

/**
 * A single elif branch (`mvp:conditional_elif`). Carries its own condition +
 * body but no `else`/nested-`elif` — it's a leaf in the parent conditional's
 * `elif.run` stack, the direct analogue of a `switch_case` under `mvp:switch`.
 */
export function conditionalElif(args: ConditionalElifArgs, where = "then"): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.conditional"${where === "then" ? "" : `: argument "${where.replace(/\.then$/, "")}"`}`, args, ELIF_KEYS);
  const label = where === "then" ? "when" : where.replace(/\.then$/, ".when");
  assertArg("s.conditional", label, args.when);
  assertStatements("s.conditional", where, args.then);
  const context: ConditionalElifContext = {
    expr: encodeRuntimeCondition(args.when, "s.conditional elif `when`"),
    if: { run: args.then.map(encodeStatement) },
  };
  return annotate({ name: CONDITIONAL_ELIF, context, input: [] }, args);
}

export interface ConditionalArgs extends StatementAnnotations {
  when: Condition;
  then: Statement[];
  /** Ordered `else if` branches, each `{ when, then }`. */
  elif?: ConditionalElifArgs[];
  else?: Statement[];
}

/** One `elif` branch as the typed overload reads it — its `then` keeps its tuple. */
type ElifBranch = Omit<ConditionalElifArgs, "then"> & { then: readonly Statement[] };

/** Every `elif` body, end to end. */
type ElifBodies<L> = L extends readonly [infer H, ...infer R]
  ? H extends { then: infer B extends readonly unknown[] }
    ? [...B, ...ElifBodies<R>]
    : ElifBodies<R>
  : [];

/** Each `elif` body as its own branch; an untyped list is one branch that binds nothing. */
type ElifBranches<L> = L extends readonly [infer H, ...infer R]
  ? H extends { then: infer B extends readonly unknown[] }
    ? [B, ...ElifBranches<R>]
    : ElifBranches<R>
  : L extends readonly [] ? [] : [[]];

const CONDITIONAL_KEYS = /* @__PURE__ */ Object.keys({ when: 1, then: 1, elif: 1, else: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ConditionalArgs>, 1>);

/** A branching statement: `if (when) { then } [else if …] else { else }`. */
export function conditional<
  const T extends readonly Statement[] = Statement[],
  const E extends readonly Statement[] = [],
  const L extends readonly ElifBranch[] = [],
>(
  args: Omit<ConditionalArgs, "then" | "else" | "elif"> & { then: T; elif?: L; else?: E },
): Statement & MaybeBodyBrand<[...T, ...E, ...ElifBodies<L>]> & BranchesBrand<[T, E, ...ElifBranches<L>]>;
export function conditional(args: ConditionalArgs): Statement;
export function conditional(args: ConditionalArgs): Statement {
  args = argsOrEmpty(args);
  assertKnownKeys(`Statement "s.conditional"`, args, CONDITIONAL_KEYS);
  assertArg("s.conditional", "when", args.when);
  assertStatements("s.conditional", "then", args.then);
  if (args.elif !== undefined && args.elif !== null && !Array.isArray(args.elif)) {
    throw new Error(
      `Statement "s.conditional": argument "elif" must be an array of { when, then } branches — got ${describeEntry(args.elif)}.`,
    );
  }
  if (args.else !== undefined && args.else !== null) assertStatements("s.conditional", "else", args.else);
  const context: ConditionalContext = {
    expr: encodeRuntimeCondition(args.when, "s.conditional `when`"),
    if: { run: args.then.map(encodeStatement) },
    elif: {
      run: (args.elif ?? []).map((e, i) => {
        if (e === null || typeof e !== "object") {
          throw new Error(
            `Statement "s.conditional": argument "elif[${i}]" must be a { when, then } branch — got ${describeEntry(e)}.`,
          );
        }
        return encodeStatement(conditionalElif(e, `elif[${i}].then`));
      }),
    },
    else: { run: (args.else ?? []).map(encodeStatement) },
  };
  return annotate({ name: CONDITIONAL, context, input: [] }, args);
}

registerStatement(CONDITIONAL, conditional);
registerStatement(CONDITIONAL_ELIF, conditionalElif);
