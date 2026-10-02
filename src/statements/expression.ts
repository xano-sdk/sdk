/**
 * The single boolean-expression algebra shared by every SDK surface that emits
 * the engine's `{ expression: [ … ] }` shape — conditionals, `while`,
 * `precondition`, table `where`, the `array.*` `!compare` predicate, and the
 * db.query/bulk/addon `where` search. One encoder for both, so the capability
 * set (grouping/full-ops, filtered operands) cannot diverge between them, and
 * `db-search` and `conditional` do not import each other.
 *
 * The engine node shapes (persisted form):
 *   statement : { type:"statement", or, group:{expression:[]}, statement:{ op, left, right } }
 *   group     : { type:"group",     or, group:{expression:[ …children… ]} }
 *   operand   : { operand, tag, filters }  (+ optional `ignore_empty` on the right)
 *
 * Operands pass their tag/filters straight through — a filtered operand
 * (`withFilters(...)`) is valid inline in every condition/`where` surface
 * (conditional, while, db.query/addon, …), verified against a live engine.
 */
import type { ExprGroup, ExprNode, ExprOperand, ExprStatement } from "../types/xdo.js";
import type { Value } from "../values/value.js";
import { describeEntry, isTaggedArg } from "./args.js";

// ---------------------------------------------------------------------------
// Narrow comparison — `expr()` (6 operators, single binary comparison). Stays
// the discoverable default; `cmp()` below is the full-operator power surface.
// ---------------------------------------------------------------------------

/**
 * The comparison operators, INCLUDING the strict pair.
 *
 * `===`/`!==` are not spellings of `=`/`!=` — the engine evaluates them as
 * strict and loose comparison respectively, so they differ exactly where type
 * coercion does (`"1" == 1` holds, `"1" === 1` does not). Aliasing them onto the
 * loose forms would silently downgrade every strict comparison an author wrote
 * and rewrite a pulled one into a different predicate. They are their own
 * operators.
 */
const SUPPORTED_OPS = ["=", "!=", "===", "!==", ">", "<", ">=", "<="] as const;
type EngineOp = (typeof SUPPORTED_OPS)[number];
/**
 * The one JS-style spelling that IS a synonym: the engine's own evaluator runs
 * `=` and `==` through the same loose branch (`case '=': case '==':`), so
 * normalizing `==` to `=` changes nothing. Nothing else belongs here.
 */
const OP_ALIASES = { "==": "=" } as const;
export type ComparisonOp = EngineOp | keyof typeof OP_ALIASES;

/** A minimal single binary comparison: `left op right`. */
export interface Comparison {
  left: Value;
  op: EngineOp;
  right: Value;
}

/** Build a single binary comparison for a conditional/while/predicate `when`. */
export function expr(left: Value, op: ComparisonOp, right: Value): Comparison {
  const normalized = (OP_ALIASES as Record<string, EngineOp>)[op] ?? (op as EngineOp);
  if (!SUPPORTED_OPS.includes(normalized)) {
    throw new Error(
      `expr(): Unsupported conditional operator ${typeof op === "string" ? `"${op}"` : describeEntry(op)}. ` +
        `Supported: ${SUPPORTED_OPS.join(", ")} (also ==, a synonym for =)`,
    );
  }
  assertOperand("expr", "left", left);
  assertOperand("expr", "right", right);
  return { left, op: normalized, right };
}

/**
 * A comparison operand must be a tagged value. Through `any`, `expr(null, "=",
 * 7)` built a comparison the encoder later failed on with a message naming
 * neither the helper nor the side.
 */
function assertOperand(helper: "expr" | "cmp", side: "left" | "right", v: unknown): void {
  if (isTaggedArg(v)) return;
  throw new Error(
    `${helper}(): the ${side} operand must be a value (\`c.*\`, \`ref()\`, \`inp()\`, \`col()\`, …) — got ` +
      `${describeEntry(v)}.`,
  );
}

// ---------------------------------------------------------------------------
// Full operator set — `cmp()` — and AND/OR grouping — `and()` / `or()`.
// ---------------------------------------------------------------------------

/**
 * The full engine operator set for a comparison (`op` values from the Xano
 * engine's operator definitions). `cmp(...)` accepts these; the narrow
 * `expr(...)` stays limited to `= != > < >= <=`.
 */
export type SearchOp =
  | "="
  | "=="
  | "!="
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not in"
  | "like"
  | "not like"
  | "ilike"
  | "not ilike"
  | "~"
  | "!~"
  | "between"
  | "not between"
  | "@>"
  | "contains"
  | "not contains"
  | "includes"
  | "not includes"
  | "overlaps"
  | "not overlaps"
  | "search";

const SEARCH_OPS = new Set<string>([
  "=", "==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "not in", "like", "not like", "ilike",
  "not ilike", "~", "!~", "between", "not between", "@>", "contains", "not contains",
  "includes", "not includes", "overlaps", "not overlaps", "search",
]);

/**
 * Whether an operator is one `cmp()` accepts — the guard below, as a predicate.
 *
 * Exported so the DECODER can decline a stored comparison the encoder would
 * refuse, instead of emitting a `cmp()` call that throws the moment the
 * generated tree is loaded. A blank `op` is what the editor stores for a filter
 * row that was added and never configured, and one of them made a whole
 * workspace's pull unexportable. One list, both directions.
 */
export function isSearchOp(op: unknown): op is SearchOp {
  return typeof op === "string" && SEARCH_OPS.has(op);
}

/** A comparison over the full {@link SearchOp} set, with an optional `ignore_empty`. */
export interface SearchComparison {
  left: Value;
  op: SearchOp;
  right: Value;
  /** Skip this clause when the resolved right value is empty (engine `right.ignore_empty`). */
  ignoreEmpty?: boolean;
}

/** A nested AND/OR group of nodes (`{type:"group"}`). */
export interface SearchGroup {
  /** How the group's children join each other: OR (`true`) or AND (`false`). */
  or: boolean;
  children: SearchNode[];
}

/**
 * One term after the first in a {@link mixed} container, with the join that
 * attaches it to everything before it. Exactly one key.
 */
export type MixedTerm = { and: SearchNode; or?: never } | { or: SearchNode; and?: never };

/**
 * A container whose terms do NOT all join the same way (`a AND b OR c`).
 *
 * ⚠ **Prefer `and()` / `or()` with explicit nesting.** This form exists because
 * the editor produces it — every condition row after the first carries its own
 * AND/OR choice, with nothing tying it to its siblings — so real workspaces hold
 * it and it has to be authorable to survive a round trip. It is not a good way
 * to write a new condition, for one concrete reason:
 *
 * **The same terms do not mean the same thing everywhere they can appear.** A
 * branch condition (`s.if`, `s.while`, a precondition) is folded strictly left
 * to right with no precedence, so `a OR b AND c` is `(a OR b) AND c`. A database
 * query's filter is handed to the engine as one flat chain, where AND binds
 * tighter than OR, so the same three terms select `a OR (b AND c)`. Nothing in
 * the stored form records which reading was intended.
 *
 * `and(or(a, b), c)` and `or(a, and(b, c))` each say one of those unambiguously,
 * in any context, and are what you want unless you are reproducing a workspace
 * exactly.
 */
export interface MixedGroup {
  /** The first term, then each following term with its own join. */
  readonly mixed: readonly [SearchNode, ...MixedTerm[]];
}

/** A node in the expression tree: a narrow `expr()`, a full `cmp()`, or a group. */
export type SearchNode = Comparison | SearchComparison | SearchGroup | MixedGroup;

/**
 * A boolean condition for a `when`/predicate surface (conditional, while,
 * precondition, array.* `!compare`, table `where`): one node, or a flat array of
 * nodes ANDed together. The full Xano expression tree — a single `expr()` stays
 * the discoverable common case.
 */
export type Condition = SearchNode | SearchNode[];

/**
 * Build a comparison over the full operator set (`in`, `like`, `ilike`,
 * `between`, `contains`, `overlaps`, `@>`, `~`, `search`, …). Distinct from the
 * narrow `expr()`.
 *
 * ⚠ **`opts.ignoreEmpty` DROPS the clause when its right value resolves empty —
 * it does not match zero rows.** On `in`/`not in` those are opposite results:
 * `cmp(col("owner"), "in", ids)` with an empty `ids` matches nothing, and the
 * same clause with `{ ignoreEmpty: true }` returns the UNFILTERED table. Never
 * put it on a clause that scopes rows to a permitted set — an empty permission
 * list then returns everything. It is for an OPTIONAL search filter,
 * where "the caller left this box blank" really does mean "do not filter".
 */
export function cmp(
  left: Value,
  op: SearchOp,
  right: Value,
  opts?: { ignoreEmpty?: boolean },
): SearchComparison {
  if (!SEARCH_OPS.has(op)) {
    throw new Error(
      `cmp(): unsupported operator ${typeof op === "string" ? `"${op}"` : describeEntry(op)}. ` +
        `Supported: ${[...SEARCH_OPS].join(", ")}.`,
    );
  }
  assertOperand("cmp", "left", left);
  assertOperand("cmp", "right", right);
  return { left, op, right, ignoreEmpty: opts?.ignoreEmpty };
}

/**
 * Every child of an `and()` / `or()` is a node — a comparison, a group, or a
 * value. Through `any`, a `null` child was stored and failed at encode with a
 * message naming neither helper.
 */
function assertChildren(helper: "and" | "or", children: readonly unknown[]): void {
  children.forEach((child, i) => {
    if (typeof child === "object" && child !== null && !Array.isArray(child)) return;
    if (isTaggedArg(child)) return;
    throw new Error(
      `${helper}(): argument ${i + 1} must be a condition (\`cmp()\`, \`expr()\`, \`and()\`/\`or()\`) — got ` +
        `${describeEntry(child)}.`,
    );
  });
}

/** Group nodes joined by AND (`and(a, b, or(c, d))`). */
export function and(...children: SearchNode[]): SearchGroup {
  assertChildren("and", children);
  return { or: false, children };
}

/** Group nodes joined by OR (`or(a, b)`). */
export function or(...children: SearchNode[]): SearchGroup {
  assertChildren("or", children);
  return { or: true, children };
}

/**
 * A container whose terms carry their own joins — `mixed(a, { or: b }, { and: c })`.
 *
 * ⚠ Reach for `and()` / `or()` first; see {@link MixedGroup} for why this one is
 * ambiguous by construction. It is here so a workspace that already contains a
 * mixed condition round-trips instead of degrading to `raw()`.
 */
export function mixed(first: SearchNode, ...rest: [MixedTerm, ...MixedTerm[]]): MixedGroup {
  if (rest.length === 0) {
    throw new Error(
      "mixed(): needs at least two terms — a single term has no join to mix. Pass the node on " +
        "its own, or use and()/or() for a uniform container.",
    );
  }
  for (const term of rest) {
    // Through `any`, a null or scalar term reached `Object.keys` and threw a
    // TypeError naming nothing the author wrote.
    if (typeof term !== "object" || term === null || Array.isArray(term)) {
      throw new Error(
        "mixed(): every term after the first is exactly one of `{ and: node }` or `{ or: node }` " +
          `— got ${describeEntry(term)}.`,
      );
    }
    const keys = Object.keys(term).filter((k) => (term as Record<string, unknown>)[k] !== undefined);
    if (keys.length !== 1 || (keys[0] !== "and" && keys[0] !== "or")) {
      throw new Error(
        "mixed(): every term after the first is exactly one of `{ and: node }` or `{ or: node }` " +
          `— got ${JSON.stringify(keys)}.`,
      );
    }
  }
  return { mixed: [first, ...rest] };
}

// ---------------------------------------------------------------------------
// Node guards.
// ---------------------------------------------------------------------------

/** A tagged {@link Value} (`{value, tag, filters}`) — the raw escape hatch. */
export function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

/** An and/or group node. */
export function isGroup(w: unknown): w is SearchGroup {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "children" in w;
}

/** A {@link MixedGroup} — a container whose terms carry their own joins. */
export function isMixed(w: unknown): w is MixedGroup {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "mixed" in w;
}

/** The terms of any container node, paired with the join each one carries. */
function containerTerms(node: SearchGroup | MixedGroup): Array<{ or: boolean; node: SearchNode }> {
  if (isMixed(node)) {
    return node.mixed.map((term, i) =>
      i === 0
        ? { or: false, node: term as SearchNode }
        : { or: "or" in (term as MixedTerm), node: ("or" in (term as MixedTerm) ? (term as { or: SearchNode }).or : (term as { and: SearchNode }).and) },
    );
  }
  return node.children.map((child, i) => ({ or: node.or && i > 0, node: child }));
}

/** A comparison node (narrow `expr()` or full `cmp()`) — has `left` + `op`, not a tagged value. */
export function isCmpNode(w: unknown): w is Comparison | SearchComparison {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "op" in w && "left" in w;
}

// ---------------------------------------------------------------------------
// Operand + tree encoding. `encodeContainer`/`toStatementNode` take an
// OperandEncoder so each surface controls operand handling without cloning the
// tree walk.
// ---------------------------------------------------------------------------

/** Encode one operand {@link Value} to the engine `{operand, tag, filters}` shape. */
function toOperand(v: Value): ExprOperand {
  return { operand: v.value, tag: v.tag, filters: v.filters };
}

/** One `{type:"statement", or, group:{expression:[]}, statement:{op,left,right}}` node. */
function toStatementNode(node: Comparison | SearchComparison, or: boolean): ExprStatement {
  const right = toOperand(node.right);
  if ((node as SearchComparison).ignoreEmpty) right.ignore_empty = true;
  return {
    type: "statement",
    or,
    group: { expression: [] },
    statement: { op: node.op, left: toOperand(node.left), right },
  };
}

/**
 * Encode a container of sibling nodes into `expression[]`. `joinOr` decides how
 * siblings after the first join the previous one (the engine's per-node `or`):
 * AND (`false`) for a flat container/`and(...)`, OR (`true`) for `or(...)`. The
 * first sibling never ORs to a nonexistent predecessor.
 */
export function encodeContainer(children: SearchNode[], joinOr: boolean): ExprNode[] {
  return encodeTerms(children.map((child, i) => ({ or: joinOr && i > 0, node: child })));
}

/** Encode already-joined terms — the one place a container's per-node `or` is written. */
function encodeTerms(terms: ReadonlyArray<{ or: boolean; node: SearchNode }>): ExprNode[] {
  return terms.map(({ or, node }): ExprNode => {
    if (isGroup(node) || isMixed(node)) {
      const group: ExprGroup = {
        type: "group",
        or,
        group: { expression: encodeTerms(containerTerms(node)) },
      };
      return group;
    }
    return toStatementNode(node, or);
  });
}

/**
 * How deeply containers may nest inside one condition.
 *
 * Nesting is **quadratic in the emitted bytes**: each `and(previous, term)` wraps
 * everything before it in one more `group.expression` level, so a left-folded
 * 128-term rule set is a 1.4 MiB condition and a 512-term one is 21 MiB, while
 * the same 512 terms as siblings of ONE container are 394 KiB and encode in a
 * flat pass. Past roughly a thousand levels the walk over that shape exhausted
 * the JavaScript call stack and the author got a bare `RangeError` from inside a
 * guard they never called.
 *
 * 128 is far above anything the editor produces — group nesting there is manual
 * clicking, and no workspace in the survey corpus comes near it — so a pulled
 * workspace still round-trips. It is a limit on the SHAPE, not on the number of
 * terms: a container may hold as many children as you like.
 */
export const MAX_EXPRESSION_DEPTH = 128;

/**
 * Refuse a container nested past {@link MAX_EXPRESSION_DEPTH}, in the author's
 * own terms, before any recursive walk reaches it.
 *
 * Iterative on purpose: a checker that recursed would hit the same stack limit
 * it exists to report.
 */
function assertExpressionDepth(nodes: readonly SearchNode[]): void {
  const stack: Array<{ node: SearchNode; depth: number }> = nodes.map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!isGroup(node) && !isMixed(node)) continue;
    if (depth > MAX_EXPRESSION_DEPTH) {
      throw new Error(
        `condition: expression containers are nested ${depth} levels deep, past the supported ` +
          `limit of ${MAX_EXPRESSION_DEPTH}. Nesting costs quadratic bytes — every level re-wraps ` +
          `everything below it — so a deep chain exports megabytes and eventually cannot be ` +
          `walked at all. This is almost always a rule set folded one term at a time ` +
          `(\`rules.reduce((acc, r) => and(acc, r))\`); pass the terms as SIBLINGS of one ` +
          `container instead (\`and(...rules)\` — flat, linear, unlimited in count), or balance ` +
          `the tree so its depth is logarithmic. Mixing joins? Group each run: ` +
          `\`and(or(...anyOf), ...allOf)\`.`,
      );
    }
    for (const term of containerTerms(node)) stack.push({ node: term.node, depth: depth + 1 });
  }
}

/**
 * Encode a single node or a flat (ANDed) array of nodes into the engine's
 * `{ expression: [ … ] }` shape — the one entry point every surface routes through.
 */
export function encodeExpression(input: Condition): { expression: ExprNode[] } {
  const nodes = Array.isArray(input) ? input : [input];
  assertExpressionDepth(nodes);
  // A root `or(...)` joins the ROOT siblings, rather than wrapping them in a
  // group that is then ANDed against nothing. This is the spelling real
  // workspaces store, and a group wrapper had no way to produce it.
  //
  // Live-verified before landing, because it changes emitted bytes for an
  // authoring form that already ships: on a real engine the two spellings select
  // the same rows and take the same branch across the whole truth table of a
  // two-term OR, in a query's search block and in a runtime conditional alike,
  // and the flat form survives an export unchanged.
  //
  // Only when the root is EXACTLY one ORed group: several root nodes are ANDed
  // together, so a group among them has to stay wrapped to keep its own join.
  //
  // This does make a WRAPPED root OR unauthorable, and that is deliberate rather
  // than overlooked: across 187 real workspaces, **zero** root containers hold a
  // single group node — the editor writes root siblings flat — so the form being
  // given up is one nothing stores, and it still round-trips exactly through
  // `raw()` if it ever appears.
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only !== undefined && isGroup(only) && only.or) {
    return { expression: encodeContainer(only.children, true) };
  }
  // A root `mixed(...)` flattens for the same reason a root `or(...)` does, and
  // with more force: the flat root IS the shape the editor writes, since each
  // row's own AND/OR choice lands directly on the root sibling. Every mixed
  // container in the survey corpus is a flat root.
  if (only !== undefined && isMixed(only)) {
    return { expression: encodeTerms(containerTerms(only)) };
  }
  return { expression: encodeContainer(nodes, false) };
}

// ---------------------------------------------------------------------------
// Surface split: which operators the RUNTIME evaluates.
// ---------------------------------------------------------------------------

/**
 * The operators a **runtime** condition can use — `s.conditional` (and each
 * `elif`), `s.while`, `s.precondition`, and the `array.*` `if` predicates.
 *
 * These surfaces are evaluated by the stack as it runs, and the runtime
 * comparison implements exactly this set. Everything else `cmp()` accepts
 * (`in`, `like`, `ilike`, `between`, `contains`, `includes`, `overlaps`, `@>`,
 * `~`, `search`, and their negations) is a DATABASE-search operator: it is
 * compiled into SQL for a `where`/`search` and has no runtime implementation.
 * Sending one into a condition stores and deploys clean, then fails the request
 * with `Invalid op: <op>` the first time the branch is reached — which is
 * usually a guard, i.e. the path that only runs when something is already
 * wrong. Hence the build-time refusal.
 *
 * The editor draws the same line: its condition row offers these eight, its
 * database-filter row the full set.
 */
const RUNTIME_OPS = new Set<string>(SUPPORTED_OPS);

/** Whether `op` is one a runtime condition can evaluate. See {@link RUNTIME_OPS}. */
export function isRuntimeConditionOp(op: unknown): boolean {
  return typeof op === "string" && (RUNTIME_OPS.has(op) || Object.hasOwn(OP_ALIASES, op));
}

/**
 * The `cond.*` helper that replaces each database-only operator, named in the
 * error for the operator the author actually wrote.
 *
 * A generic "use cond.*" leaves the reader to guess which member, and the two
 * they are most likely to guess wrong are the ones whose OPERAND ORDER differs
 * from the operator's — `cond.in(value, list)` emits `list | in: value`, because
 * the engine's filter pipes the array.
 */
const CONDITION_HINTS: Readonly<Record<string, string>> = {
  in: "`cond.in(value, list)`",
  "not in": "`cond.notIn(value, list)`",
  contains: "`cond.contains(text, needle)`",
  "not contains": "`cond.notContains(text, needle)`",
  includes: "`cond.contains(text, needle)`",
  like: "`cond.contains(text, needle)` (or `cond.startsWith`/`cond.endsWith`)",
  ilike: "`cond.icontains(text, needle)`",
  between: "`cond.between(value, lo, hi)`",
};

/** Throw on the first DB-search-only operator anywhere in a runtime condition. */
function assertRuntimeOps(node: SearchNode, surface: string): void {
  if (isGroup(node) || isMixed(node)) {
    for (const term of containerTerms(node)) assertRuntimeOps(term.node, surface);
    return;
  }
  // Not a comparison at all — `null`, `{}`, or a bare value such as
  // `c.bool(true)` (through `any`). It used to be read as an operator named
  // "undefined" and blamed as a database-search operator.
  if (!isCmpNode(node)) {
    throw new Error(
      `${surface}: a condition must be a comparison (\`expr(left, "=", right)\`, \`cond.*\`) or an ` +
        `and()/or() group — got ${describeEntry(node)}.` +
        (isValue(node) ? ` To test a value, compare it: \`expr(value, "=", c.bool(true))\`.` : ""),
    );
  }
  const op = node.op;
  if (isRuntimeConditionOp(op)) return;
  throw new Error(
    `${surface}: operator "${op}" is a database-search operator and cannot be evaluated in a ` +
      `condition — the request fails at runtime with \`Invalid op: ${op}\`. A condition ` +
      `evaluates ${SUPPORTED_OPS.join(", ")} (and \`==\`). Keep "${op}" for a db.query/bulk/addon ` +
      `\`where\`, a table view filter, or a database trigger \`search\`. In a condition, reach for ` +
      `\`cond.*\`, which builds the filter-then-compare form that DOES run here — ` +
      `${(Object.hasOwn(CONDITION_HINTS, op) ? CONDITION_HINTS[op] : undefined) ?? "`cond.in` / `contains` / `startsWith` / `endsWith` / `empty` / `between` / `isNull`"}.`,
  );
}

/**
 * {@link encodeExpression} for a surface the RUNTIME evaluates, refusing an
 * operator that surface cannot run. `surface` names the caller for the message.
 */
export function encodeRuntimeCondition(input: Condition, surface: string): { expression: ExprNode[] } {
  const nodes = Array.isArray(input) ? input : [input];
  // Depth first: `assertRuntimeOps` recurses, so an over-deep tree has to be
  // refused in the author's terms before it walks one.
  assertExpressionDepth(nodes);
  for (const node of nodes) assertRuntimeOps(node, surface);
  return encodeExpression(input);
}

/**
 * Encode a single binary comparison into the engine's `{expression:[…]}` shape.
 * Byte-identical to routing the comparison through {@link encodeExpression};
 * kept as a named helper for the conditional/while/`!compare`/table-`where`
 * callers that emit exactly one comparison.
 */
export function encodeComparison(when: Condition): { expression: ExprNode[] } {
  return encodeExpression(when);
}

/**
 * Encode one or more comparisons into the engine's `{expression:[…]}` shape,
 * ANDed together (`or:false`). Same algebra as {@link encodeComparison}, for the
 * query/trigger search surfaces that AND a list of clauses.
 */
export function encodeSearchExpression(clauses: Comparison[]): { expression: ExprNode[] } {
  return encodeExpression(clauses);
}
