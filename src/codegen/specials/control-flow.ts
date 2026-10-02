/**
 * Control-flow, loop, and variable decoders.
 *
 * These are the recursive families: `conditional`, `switch`, `try_catch`, the
 * three loops, `group`, `post_process`, and `expect.to_throw` all nest a `run[]`,
 * and each one recurses through the *full* dispatch rather than a private path.
 * That is what makes a `raw()` fallback work at depth — an unmodelled statement
 * inside a loop inside a conditional still round-trips, and the enclosing
 * statements stay readable around it.
 */
import type { StackItemXdo, TaggedValue } from "../../types/xdo.js";
import { arr, lit, obj, type Expr } from "../print.js";
import { decodeValue } from "../value.js";
import { decodeConditionOrEmpty } from "../expression.js";
import { filledContext } from "../../validate/normalize.js";
import { envelopePassthrough } from "../envelope-passthrough.js";
import { declineHere, getPath, prove, type SpecialArgs, type SpecialDecoder } from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** Decode a nested `run[]` at a stored path, or an empty block when absent. */
function nested(a: SpecialArgs, path: string): { exprs: Expr[]; statements: unknown[] } {
  const run = getPath(a.stored.context, path);
  return a.decodeStack(run);
}

/** `var $as { value }` — 78% of a typical workspace's statements. */
const setVar: SpecialDecoder = (a) => {
  // An empty context is the blank const the engine's optional-schema pass fills
  // in, not an unreadable statement (see {@link filledContext}).
  const value = toValue(a.stored.context) ?? toValue(filledContext(a.stored));
  const as = (a.stored as { as?: unknown }).as;
  if (!value) return declineHere("set_var: context is not a tagged value");
  if (typeof as !== "string" || as === "") return declineHere("set_var: as is blank");
  return prove(a.ctx, a.stored, "set_var", [as, value], [lit(as), decodeValue(a.ctx, value)]);
};

/** `update $name { value }` — reassignment of an existing stack variable. */
const updateVar: SpecialDecoder = (a) => {
  const stored = (a.stored.context ?? {}) as Record<string, unknown>;
  // An empty context is the blank scaffold the engine's optional pass fills in —
  // the same state `set_var` recovers one line up, and `update_var` was already
  // in the fill table. What blocked it was reading the NAME off the raw context:
  // this statement carries its target inside `context`, so an empty one has to
  // take BOTH members from the fill or neither. Every member is a scalar
  // (`{name, value, tag?=const, filters[]}`), so the pass materializes all of
  // them, and the editor saves this state — its context form carries no required
  // validator, only the output-variable field does.
  const context = (toValue(stored) ? stored : (filledContext(a.stored) ?? stored)) as Record<
    string,
    unknown
  >;
  const value = toValue(context);
  const name = context.name;
  if (!value) return declineHere("update_var: context is not a tagged value");
  if (typeof name !== "string") return declineHere("update_var: context.name is not a string");
  return prove(
    a.ctx,
    a.stored,
    "update_var",
    [name, value],
    [lit(name), decodeValue(a.ctx, value)],
  );
};

/** One `elif` branch of a conditional. */
function decodeElifBranch(a: SpecialArgs, branch: unknown): { expr: Expr; runtime: unknown } | null {
  const context = (branch as { context?: unknown }).context;
  const when = decodeConditionOrEmpty(a.ctx, getPath(context, "expr"), { runtimeSurface: true });
  if (!when) return declineHere("conditional: an elif branch's expr is not a decodable condition");
  const body = a.decodeStack(getPath(context, "if.run"));
  return {
    expr: obj([
      ["when", when.expr],
      ["then", arr(body.exprs)],
    ]),
    runtime: { when: when.runtime, then: body.statements },
  };
}

/** `if (when) { then } [else if …] [else { … }]`. */
const conditional: SpecialDecoder = (a) => {
  const when = decodeConditionOrEmpty(a.ctx, getPath(a.stored.context, "expr"), { runtimeSurface: true });
  if (!when) return declineHere("conditional: context.expr is not a decodable condition");

  const then = nested(a, "if.run");
  const elseBody = nested(a, "else.run");
  const elifStored = getPath(a.stored.context, "elif.run");
  const elifBranches = Array.isArray(elifStored) ? elifStored : [];

  const elif: Array<{ expr: Expr; runtime: unknown }> = [];
  for (const branch of elifBranches) {
    const decoded = decodeElifBranch(a, branch);
    if (!decoded) return null;
    elif.push(decoded);
  }

  const entries: Array<[string, Expr]> = [
    ["when", when.expr],
    ["then", arr(then.exprs)],
  ];
  const runtime: Record<string, unknown> = { when: when.runtime, then: then.statements };
  // Branch order is load-bearing — `elif` is an ordered stack, and `else` only
  // means anything after it.
  if (elif.length > 0) {
    entries.push(["elif", arr(elif.map((e) => e.expr))]);
    runtime.elif = elif.map((e) => e.runtime);
  }
  if (elseBody.exprs.length > 0) {
    entries.push(["else", arr(elseBody.exprs)]);
    runtime.else = elseBody.statements;
  }
  return prove(a.ctx, a.stored, "conditional", [runtime], [obj(entries)]);
};

/** `switch (on) { case … default … }`. */
const switchStatement: SpecialDecoder = (a) => {
  const on = toValue(getPath(a.stored.context, "value"));
  if (!on) return declineHere("switch: context.value is not a tagged value");

  const casesStored = getPath(a.stored.context, "elif.run");
  const cases: Array<{ expr: Expr; runtime: unknown }> = [];
  for (const stored of Array.isArray(casesStored) ? casesStored : []) {
    const context = (stored as { context?: Record<string, unknown> }).context ?? {};
    const when = toValue(context.value);
    if (!when) return declineHere("switch: a case's value is not a tagged value");
    const body = a.decodeStack(getPath(context, "if.run"));
    const entries: Array<readonly [string, Expr]> = [
      ["when", decodeValue(a.ctx, when)],
      ["body", arr(body.exprs)],
    ];
    const runtime: Record<string, unknown> = { when, body: body.statements };
    // `break` is omitted from the stored shape entirely when unset, so its
    // presence — not its value — is what must be carried back.
    if (context.break !== undefined) {
      entries.push(["break", lit(context.break)]);
      runtime.break = context.break;
    }
    // A case is a STACK ITEM, so it carries the same universal envelope as any
    // other statement — and the same shared reader recovers it, rather than a
    // second hand-rolled copy that can forget a member the way this site forgot
    // `disabled`. That one matters beyond fidelity: a case disabled in
    // the editor and re-enabled on deploy starts running branch logic the author
    // switched off, silently.
    //
    // Unlike a top-level statement the cases are not decoded through the
    // dispatch — `switch` reads `elif.run[]` itself, because a case is not
    // authorable on its own — so without this the envelope inversion simply
    // never ran at this nesting level.
    const envelope = envelopePassthrough(stored as StackItemXdo, a.ctx);
    entries.push(...envelope.entries);
    Object.assign(runtime, envelope.annotations);
    cases.push({ expr: obj(entries), runtime });
  }

  const defaultBody = nested(a, "else.run");
  const entries: Array<[string, Expr]> = [
    ["on", decodeValue(a.ctx, on)],
    ["cases", arr(cases.map((c) => c.expr))],
  ];
  const runtime: Record<string, unknown> = { on, cases: cases.map((c) => c.runtime) };
  if (defaultBody.exprs.length > 0) {
    entries.push(["default", arr(defaultBody.exprs)]);
    runtime.default = defaultBody.statements;
  }
  return prove(a.ctx, a.stored, "switch", [runtime], [obj(entries)]);
};

/** `try_catch { try … catch … finally … }` — engine `if`/`else`/`then`. */
const tryCatch: SpecialDecoder = (a) => {
  const tryBody = nested(a, "if.run");
  const catchBody = nested(a, "else.run");
  const finallyBody = nested(a, "then.run");

  const entries: Array<[string, Expr]> = [["try", arr(tryBody.exprs)]];
  const runtime: Record<string, unknown> = { try: tryBody.statements };
  if (catchBody.exprs.length > 0) {
    entries.push(["catch", arr(catchBody.exprs)]);
    runtime.catch = catchBody.statements;
  }
  if (finallyBody.exprs.length > 0) {
    entries.push(["finally", arr(finallyBody.exprs)]);
    runtime.finally = finallyBody.statements;
  }
  return prove(a.ctx, a.stored, "try_catch", [runtime], [obj(entries)]);
};

/** A loop carrying `as` plus one value field (`cnt` for `for`, `list` for `foreach`). */
function loopDecoder(path: string, storedField: string, defField: string): SpecialDecoder {
  return (a) => {
    const context = (a.stored.context ?? {}) as Record<string, unknown>;
    const as = context.as;
    // An ABSENT iterand is REPAIRED to the empty one it lost, and reported.
    //
    // This is not a default the engine supplies — a live engine says the
    // opposite, raising "For Each Loop: missing list argument" / faulting on
    // `Undefined array key "cnt"`. The key went missing on the way out and the
    // stored statement throws. The repair gives it the benign reading of the
    // empty value (`[]`, `0`), which is a no-op rather than a fault, so it
    // EVALUATES DIFFERENTLY and every site says so.
    const stored = context[storedField];
    const repaired = stored === undefined ? (filledContext(a.stored) ?? {})[storedField] : undefined;
    const value = toValue(stored) ?? toValue(repaired);
    if (value && repaired !== undefined) {
      a.ctx.problem(
        "modernized",
        `${path} has no ${storedField} — the stored statement is missing its ` +
          `${defField} and THROWS at runtime ("missing ${storedField} argument"). ` +
          `Recovered as the empty ${defField} it lost, which EVALUATES DIFFERENTLY: ` +
          `the loop now runs zero times instead of failing. Confirm nothing depended ` +
          `on that error`,
      );
    }
    if (typeof as !== "string") return declineHere(`${path}: context.as is not a string`);
    if (!value) return declineHere(`${path}: context.${storedField} is not a tagged value`);
    const body = a.decodeStack(context.run);
    return prove(
      a.ctx,
      a.stored,
      path,
      [{ as, [defField]: value, body: body.statements }],
      [
        obj([
          ["as", lit(as)],
          [defField, decodeValue(a.ctx, value)],
          ["body", arr(body.exprs)],
        ]),
      ],
    );
  };
}

/** `while (when) { body }`. */
const whileLoop: SpecialDecoder = (a) => {
  const when = decodeConditionOrEmpty(a.ctx, getPath(a.stored.context, "expr"), { runtimeSurface: true });
  if (!when) return declineHere("while: context.expr is not a decodable condition");
  const body = a.decodeStack(getPath(a.stored.context, "run"));
  return prove(
    a.ctx,
    a.stored,
    "while",
    [{ when: when.runtime, body: body.statements }],
    [
      obj([
        ["when", when.expr],
        ["body", arr(body.exprs)],
      ]),
    ],
  );
};

/** A statement whose only content is a nested stack, passed positionally. */
function blockDecoder(path: string, runPath = "run"): SpecialDecoder {
  return (a) => {
    const body = a.decodeStack(getPath(a.stored.context, runPath));
    return prove(a.ctx, a.stored, path, [body.statements], [arr(body.exprs)]);
  };
}

/** A statement carrying a single value in `context` (`return`, `die`, `debug.log`). */
function valueDecoder(path: string): SpecialDecoder {
  return (a) => {
    const value = toValue(a.stored.context);
    if (!value) return declineHere(`${path}: context is not a tagged value`);
    return prove(a.ctx, a.stored, path, [value], [decodeValue(a.ctx, value)]);
  };
}

/** A statement with no arguments at all. */
function nullaryDecoder(path: string): SpecialDecoder {
  return (a) => prove(a.ctx, a.stored, path, [], []);
}

/** `expect.to_throw { body }` with an optional expected exception. */
const expectToThrow: SpecialDecoder = (a) => {
  const body = a.decodeStack(getPath(a.stored.context, "run"));
  // `value1` — the numbered operand slot every `expect.*` statement stores its
  // matcher in. Through 2.0.21 this SDK wrote `exception` instead, a key the
  // engine never reads; such a bundle cannot byte-prove and so
  // decodes to `raw()`, which is the honest report of a statement whose matcher
  // was inert.
  const exception = toValue(getPath(a.stored.context, "value1"));
  const entries: Array<[string, Expr]> = [["body", arr(body.exprs)]];
  const runtime: Record<string, unknown> = { body: body.statements };
  if (exception) {
    entries.push(["exception", decodeValue(a.ctx, exception)]);
    runtime.exception = exception;
  }
  return prove(a.ctx, a.stored, "expect.to_throw", [runtime], [obj(entries)]);
};

/** `comment` — the text rides the envelope's `description`, not the context. */
const comment: SpecialDecoder = (a) => {
  const text = (a.stored as { description?: unknown }).description;
  if (typeof text !== "string") return declineHere("comment: description is not a string");
  return prove(
    a.ctx,
    a.stored,
    "comment",
    text === "" ? [] : [text],
    text === "" ? [] : [lit(text)],
  );
};


/** Control-flow, loop, and variable decoders by stored name. */
export const CONTROL_FLOW_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<
  string,
  SpecialDecoder
>([
  ["mvp:set_var", setVar],
  ["mvp:update_var", updateVar],
  ["mvp:conditional", conditional],
  ["mvp:switch", switchStatement],
  ["mvp:try_catch", tryCatch],
  ["mvp:for", loopDecoder("for", "cnt", "count")],
  ["mvp:foreach", loopDecoder("foreach", "list", "list")],
  ["mvp:while", whileLoop],
  ["mvp:group", blockDecoder("group")],
  ["mvp:post_process", blockDecoder("util.post_process")],
  ["mvp:test_expect_to_throw", expectToThrow],
  ["mvp:return", valueDecoder("return")],
  ["mvp:foreach_break", nullaryDecoder("foreach_break")],
  ["mvp:foreach_continue", nullaryDecoder("foreach_continue")],
  ["mvp:foreach_remove", nullaryDecoder("foreach_remove")],
  ["mvp:comment", comment],
  // No `mvp:placeholder` decoder: it has no authoring surface to decode TO.
  // `decodeStatement` intercepts it ahead of this map and emits `raw()` with the
  // reason — see DECODE_ONLY_STATEMENTS.
]);
