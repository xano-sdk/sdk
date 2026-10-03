/**
 * Boolean-expression inverse — the engine's `{expression: […]}` tree back to the
 * `expr` / `cmp` / `and` / `or` algebra.
 *
 * One inverse for every surface that emits the tree: conditionals, `while`,
 * `precondition`, table `where`, the `array.*` predicate, and the db search
 * family. The encoder consolidated these into a single algebra precisely so the
 * two historical encoders could not re-diverge; decoding them in one place keeps
 * that property.
 *
 * The `or` flag lives on each *sibling*, not on the container: `encodeContainer`
 * writes `or = joinOr && i > 0`, so a container is uniformly ANDed or uniformly
 * ORed and the flag on the second child is what reveals which. A container with
 * a single child is genuinely ambiguous — both `and(x)` and `or(x)` encode
 * identically — so it decodes to the AND form, which is correct by construction
 * rather than by guess.
 */
import type { ExprNode } from "../types/xdo.js";
import type { TaggedValue } from "../types/xdo.js";
import { SDK_MODULE, type DecodeContext } from "./context.js";
import { arr, call, lit, obj, type Expr } from "./print.js";
import { decodeValue } from "./value.js";
import { isBlankGroupStatement } from "../validate/normalize.js";
import { isRuntimeConditionOp, isSearchOp } from "../statements/expression.js";

/** The narrow operators `expr()` accepts; anything else needs `cmp()`. */
const NARROW_OPS = new Set(["=", "!=", ">", "<", ">=", "<="]);

/** A decoded expression tree: the source form and the runtime condition. */
export interface DecodedCondition {
  readonly expr: Expr;
  readonly runtime: unknown;
}

/** Coerce a stored `{operand, tag, filters}` to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const operand = raw as { operand?: unknown; tag?: unknown; filters?: unknown };
  if (typeof operand.tag !== "string" || operand.operand === undefined) return null;
  return {
    value: operand.operand as string,
    tag: operand.tag as TaggedValue["tag"],
    filters: (Array.isArray(operand.filters) ? operand.filters : []) as TaggedValue["filters"],
  };
}

/**
 * An empty condition container, in either stored spelling.
 *
 * A half-configured `if`/`while` — dropped into a stack and never given a
 * condition — stores `{expression: []}` (9 real statements) or the empty
 * associative-map form `[]` (8 more). Both mean the same "nothing configured",
 * and both are AUTHORABLE: `Condition` is `SearchNode | SearchNode[]`, and
 * `encodeComparison([])` produces exactly `{expression: []}`. So the empty
 * condition round-trips byte-for-byte — nothing is invented and nothing the
 * engine evaluates changes.
 */
export function isEmptyCondition(block: unknown): boolean {
  if (Array.isArray(block)) return block.length === 0;
  const expression = (block as { expression?: unknown })?.expression;
  return Array.isArray(expression) && expression.length === 0;
}

/**
 * {@link decodeCondition}, plus the empty container it declines.
 *
 * Kept separate so only the surfaces whose factory takes a whole `Condition`
 * (`if`, `while`, an `elif` branch) recover an empty one. A `db.query` search
 * has its own empty handling and must not start emitting `where: []`.
 */
export function decodeConditionOrEmpty(
  ctx: DecodeContext,
  block: unknown,
  opts?: DecodeConditionOpts,
): DecodedCondition | null {
  if (isEmptyCondition(block)) return { expr: arr([]), runtime: [] };
  return decodeCondition(ctx, block, opts);
}

/**
 * `runtimeSurface` marks a condition the RUNTIME evaluates (`s.conditional`,
 * `s.while`, `s.precondition`, the `array.*` predicates) rather than one the
 * database compiles (`where`/`search`). Those surfaces evaluate a narrower
 * operator set, and the encoder refuses the rest — so a stored tree
 * carrying one is declined here instead of being emitted as a `cmp()` call the
 * generated tree would throw on. Same contract as the blank-`op` decline below:
 * the caller falls back to `raw()` and the bytes survive exactly.
 */
export interface DecodeConditionOpts {
  readonly runtimeSurface?: boolean;
  /**
   * A db statement's `where` — a condition compiled into SQL, where a leading
   * `or` is inert the same way it is on the runtime surface (see
   * `decodeCondition`).
   */
  readonly sqlWhere?: boolean;
}

/** Decode one comparison node. */
function decodeStatementNode(
  ctx: DecodeContext,
  node: ExprNode,
  opts?: DecodeConditionOpts,
): DecodedCondition | null {
  const statement = (node as { statement?: { op?: unknown; left?: unknown; right?: unknown } })
    .statement;
  if (!statement || typeof statement.op !== "string") return null;
  // An operator no authoring form accepts — a blank one is what the editor
  // stores for a filter row added and never configured. Emitting `cmp(…, "", …)`
  // for it produced a tree that threw on load, so the whole workspace failed to
  // verify over one unconfigured row; declining hands the caller its own exact
  // fallback (`raw()`, or a reported view) instead.
  if (!isSearchOp(statement.op)) return null;
  // A db-search operator stored on a surface the runtime evaluates: unauthorable
  // by construction, and it would fail the request if it ever ran. See
  // {@link DecodeConditionOpts}.
  if (opts?.runtimeSurface && !isRuntimeConditionOp(statement.op)) return null;

  const left = toValue(statement.left);
  const right = toValue(statement.right);
  if (!left || !right) return null;

  const ignoreEmpty = (statement.right as { ignore_empty?: unknown }).ignore_empty === true;
  const leftExpr = decodeValue(ctx, left);
  const rightExpr = decodeValue(ctx, right);

  // `expr()` is the discoverable narrow form; `cmp()` is required for the wider
  // operator set and for `ignoreEmpty`, which `expr()` has no slot for.
  if (NARROW_OPS.has(statement.op) && !ignoreEmpty) {
    ctx.use(SDK_MODULE, "expr");
    return {
      expr: call("expr", leftExpr, lit(statement.op), rightExpr),
      runtime: { left, op: statement.op, right },
    };
  }

  ctx.use(SDK_MODULE, "cmp");
  const args: Expr[] = [leftExpr, lit(statement.op), rightExpr];
  if (ignoreEmpty) args.push(obj([["ignoreEmpty", lit(true)]]));
  return {
    expr: call("cmp", ...args),
    runtime: { left, op: statement.op, right, ...(ignoreEmpty ? { ignoreEmpty: true } : {}) },
  };
}

/** Decode a sibling list, which is uniformly ANDed or uniformly ORed. */
function decodeContainer(
  ctx: DecodeContext,
  nodes: readonly ExprNode[],
  opts?: DecodeConditionOpts,
): DecodedCondition[] | null {
  const out: DecodedCondition[] = [];
  for (const node of nodes) {
    const decoded =
      (node as { type?: unknown }).type === "group"
        ? decodeGroup(ctx, node, opts)
        : decodeStatementNode(ctx, node, opts);
    if (!decoded) return null;
    out.push(decoded);
  }
  return out;
}

/**
 * Emit a `mixed(...)` container for siblings whose joins are not uniform.
 *
 * The joins come straight off each stored node, so nothing is inferred — which
 * matters here more than usual, because the same flat shape reads differently in
 * a branch (left fold) than in a query filter (the database's AND-before-OR
 * precedence). `mixed` is the only spelling that neither picks a reading nor
 * loses the bytes, and it is REPORTED so a pull surfaces every one.
 */
function emitMixed(
  ctx: DecodeContext,
  nodes: readonly ExprNode[],
  decoded: readonly DecodedCondition[],
): DecodedCondition {
  ctx.use(SDK_MODULE, "mixed");
  ctx.problem(
    "ambiguous-condition",
    "a condition mixes AND and OR at one level (`a AND b OR c`) — a state the editor allows, " +
      "since every row after the first carries its own join. Recovered exactly as `mixed(...)`, " +
      "but what it MEANS depends on where it sits: a branch folds the terms strictly left to " +
      "right, while a database query applies the engine's AND-before-OR precedence, and the " +
      "stored form records neither. Rewrite it as nested `and(...)`/`or(...)` to say which one " +
      "you meant",
  );
  const terms = decoded.map((d, i) =>
    i === 0
      ? d.expr
      : obj([[(nodes[i] as { or?: unknown }).or === true ? "or" : "and", d.expr]]),
  );
  return {
    expr: call("mixed", ...terms),
    runtime: {
      mixed: decoded.map((d, i) =>
        i === 0
          ? d.runtime
          : { [(nodes[i] as { or?: unknown }).or === true ? "or" : "and"]: d.runtime },
      ),
    },
  };
}

/** Decode a `{type:"group"}` node into `and(...)` / `or(...)` / `mixed(...)`. */
function decodeGroup(
  ctx: DecodeContext,
  node: ExprNode,
  opts?: DecodeConditionOpts,
): DecodedCondition | null {
  const children = (node as { group?: { expression?: unknown } }).group?.expression;
  if (!Array.isArray(children)) return null;

  // The node's own `statement` is the DEAD branch — `type` selects `group`, and
  // nothing reads the other member (checked across the engine's two expression
  // walkers, the frontend's renderer, and the frontend's own type-toggle). A
  // non-blank one is a snapshot of the condition from the moment it was wrapped
  // in this group, left behind by an editor that copies it in and does not clear
  // the original. Dropped rather than carried, and reported when it held
  // something, because discarding stored bytes should never be silent.
  const dead = (node as { statement?: unknown }).statement;
  if (dead !== undefined && !isBlankGroupStatement(dead)) {
    ctx.problem(
      "expected-omission",
      "an expression group carries a leftover comparison on its unused `statement` branch — " +
        "the editor copies the condition into the group when you wrap it and does not clear " +
        "the original. Nothing reads it (the engine and the UI both switch on `type`), so it " +
        "is not carried into the tree",
    );
  }
  const decoded = decodeContainer(ctx, children as ExprNode[], opts);
  if (!decoded) return null;

  // The second sibling's `or` flag is what distinguishes the two join modes; a
  // one-child group cannot express the difference and either form re-encodes
  // identically, so it takes the AND form.
  const joinOr = (children[1] as { or?: unknown } | undefined)?.or === true;
  // …but only if EVERY later sibling agrees. A group whose children do not all
  // join the same way needs the explicit form; `and(...)`/`or(...)` would have
  // re-encoded every one of them the same way.
  const uniform = (children as Array<{ or?: unknown }>).every(
    (child, i) => i === 0 || (child?.or === true) === joinOr,
  );
  if (!uniform) return emitMixed(ctx, children as ExprNode[], decoded);
  const helper = joinOr ? "or" : "and";
  ctx.use(SDK_MODULE, helper);
  return {
    expr: call(helper, ...decoded.map((d) => d.expr)),
    runtime: { or: joinOr, children: decoded.map((d) => d.runtime) },
  };
}

/**
 * Decode a stored `{expression: […]}` block into a `Condition`.
 *
 * Top-level siblings are always ANDed (`encodeExpression` passes `joinOr:false`),
 * so a single node decodes bare and several decode to the flat array form.
 */
export function decodeCondition(
  ctx: DecodeContext,
  block: unknown,
  opts?: DecodeConditionOpts,
): DecodedCondition | null {
  const expression = (block as { expression?: unknown })?.expression;
  if (!Array.isArray(expression)) return null;
  if (expression.length === 0) return null;

  const decoded = decodeContainer(ctx, expression as ExprNode[], opts);
  if (!decoded) return null;

  // Root siblings carry their own join, exactly like a group's do. A flat ORed
  // root is spelled `or(...)`; the array form means ANDed, so reading an ORed
  // container as an array would quietly change what it means.
  const nodes = expression as Array<{ or?: unknown }>;
  const ored = nodes.map((node, i) => i > 0 && node?.or === true);
  // A leading `or` joins to nothing. On a RUNTIME-evaluated condition that is
  // now read as the ordinary leading term rather than declined: `ored` above
  // already ignores it (`i > 0`), and `normalize` clears the same flag from the
  // stored side, so the two spellings compare equal and an ordinary
  // editor-built condition comes back as `and(...)`/`or(...)`.
  //
  // "The flag is inert" has three independent supports on the runtime surface:
  // repeated sightings in a workspace audit;
  // the engine's runtime evaluator, which does not consult the flag on the
  // first term (its accumulator starts unset, and the combination branch for
  // that case never reads it); and the engine's own renderer, which emits no
  // separator before the first row.
  //
  // A db statement's `where` is inert the same way. The engine's SQL builder
  // drops the boolean before the FIRST clause of every WHERE / ON list it
  // compiles, and the stored search is the first clause of its list — the
  // query's own filter is applied before any clause the engine adds, which it
  // adds ANDed and grouped, and a join's filter is the whole of its ON list.
  //
  // Every other surface keeps the decline: a decline that names the shape beats
  // a fallback whose only clue is a byte diff.
  if (nodes[0]?.or === true && !opts?.runtimeSurface && !opts?.sqlWhere)
    return ctx.declined(
      "the condition's first sibling carries an `or` flag, which joins it to nothing — " +
        "there is no preceding term for it to OR with, and no authored form says it",
    );
  if (ored.some(Boolean)) {
    // A MIXED container (`a AND b OR c`). This is a first-class editor state,
    // not a corruption: every row after the first has its own AND/OR choice with
    // nothing tying it to its siblings, so a user reaches this in two clicks.
    //
    // It is declined because the SDK has no honest spelling for it, and the
    // reason is worse than "we did not get to it yet": **the same stored shape
    // does not mean the same thing in both places it can appear.** A branch
    // condition is folded strictly left to right with no precedence, so
    // `a OR b AND c` is `(a OR b) AND c`. A query's filter is handed to the
    // database as one flat chain, where AND binds tighter than OR, so the same
    // three terms mean `a OR (b AND c)`. Any surface for this has to make the
    // grouping explicit rather than let a reader supply precedence — which is a
    // language decision, not a decoding one.
    //
    // `and(...)` / `or(...)` join every sibling the same way, so emitting either
    // would silently change which rows match. `raw()` keeps it exact.
    if (!ored.slice(1).every(Boolean)) return emitMixed(ctx, nodes as ExprNode[], decoded);
    ctx.use(SDK_MODULE, "or");
    return {
      expr: call("or", ...decoded.map((d) => d.expr)),
      runtime: { or: true, children: decoded.map((d) => d.runtime) },
    };
  }
  if (decoded.length === 1) return decoded[0]!;
  return {
    expr: arr(decoded.map((d) => d.expr)),
    runtime: decoded.map((d) => d.runtime),
  };
}
