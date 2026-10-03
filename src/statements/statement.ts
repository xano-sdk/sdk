/**
 * Statement model, base envelope encoder, and registry (the extensibility
 * seam).
 *
 * The real stored statement shape (from the golden fixture's `run[0]`) is lean:
 * `{name, as?, context, input}`. The base encoder fills the common envelope
 * (`input: []` default) so each concrete statement factory only declares its
 * `name`, optional `as`, and `context`. The registry maps statement name →
 * factory so the eventual ~500-statement catalog plugs in here.
 */
import type { FilterXdo, StackItemXdo } from "../types/xdo.js";
import type { MockMap, MockXdo } from "../values/mock.js";
import { encodeMockMap } from "../values/mock.js";
import { conditionalEntryHint, describeEntry, describeStatementEntry, isStatementEntry, isVarName } from "./args.js";

/**
 * A stored statement name without its wire prefix (`mvp:set_var` → `set_var`),
 * for anything a person reads. The stored spelling is a wire detail. Not the
 * full `s.` path: that mapping is the statement catalog, which this browser-safe
 * module does not carry.
 */
export function readableStatementName(storedName: string): string {
  return storedName.replace(/^mvp:/, "");
}

/**
 * The type-level contract linking a branded db statement (the **producer** —
 * `db.get`/`db.query`/`db.add`/`db.edit`/`db.patch`/`db.add_or_edit`/`db.has`/
 * `db.bulk.patch`/`db.bulk.delete`, each returning `Statement & AsShapeBrand<…>`)
 * to `InferResponse`'s single-variable trace (the **consumer** — `TraceVar`,
 * which destructures this shape). Both `__as` (the stack variable the statement
 * binds) and `__shape` (the row shape it produces) are phantom carriers — never
 * present at runtime. Naming the contract here keeps producer and consumer
 * compiler-linked, so any further branded statement joins the trace by extending
 * this type with zero edits to the trace logic.
 */
export type AsShapeBrand<As extends string, Shape> = {
  readonly __as: As;
  readonly __shape: Shape;
};

/**
 * The type-level mark of a statement that PROVES the stack variable `Name` is
 * non-null by the time the next statement runs — `guard.found` (and
 * `guard.owner`'s first step), which raise before continuing on a null binding.
 * `InferResponse`'s trace drops `| null` from `Name`'s shape when one follows its
 * binding. Phantom like {@link AsShapeBrand}: never present at runtime.
 */
export type FoundBrand<Name extends string> = {
  readonly __found: Name;
};

/**
 * The type-level mark of a statement whose sub-stack `Body` ALWAYS runs, in
 * place — `db.transaction`, `group`, and `try_catch`'s `finally`.
 * `InferResponse`'s trace reads `Body` as if it sat inline, so a binding made
 * inside one is visible. A conditional body carries none. Phantom: never
 * present at runtime.
 */
export type BodyBrand<Body extends readonly unknown[]> = {
  readonly __body: Body;
};

/**
 * The type-level mark of a sub-stack that MAY run — a loop body, a conditional
 * branch, a switch case. A re-binding inside it unions with the binding from
 * before it (it may never happen), and an {@link AppendBrand} inside it widens
 * the list it appends to. Phantom.
 */
export type MaybeBodyBrand<Body extends readonly unknown[]> = {
  readonly __maybe: Body;
};

/**
 * The type-level mark of an in-place list mutator (`array.push`/`unshift`, and
 * `merge` spreading a list): stack variable `Name` gains `Value`'s type as an
 * element, so an accumulator seeded with `c.array([])` traces to that element's
 * list instead of the empty tuple it was bound as. Phantom.
 */
export type AppendBrand<Name extends string, V, Spread extends boolean = false> = {
  readonly __append: readonly [Name, V, Spread];
};

/**
 * The type-level mark of a `try_catch`. `try` runs in place but may stop at any
 * statement, and `catch` may run in place of the rest of it: a name `try`
 * re-binds unions with its binding from before, and a name BOTH bind is either
 * one after it. Phantom: never present at runtime.
 */
export type CatchBrand<Try extends readonly unknown[], Catch extends readonly unknown[]> = {
  readonly __catch: [Try, Catch];
};

/**
 * The type-level mark of a statement that runs EXACTLY ONE of `Branches` — a
 * `conditional`'s `then`, each `elif` and `else`, or a `switch`'s cases and
 * `default`. When every branch re-binds a name at its top level the value from
 * before is gone, so `InferResponse` traces the union of the branches alone. A
 * missing `else`/`default` is an empty branch, which re-binds nothing. Phantom.
 */
export type BranchesBrand<Branches extends readonly (readonly unknown[])[]> = {
  readonly __branches: Branches;
};

/**
 * The type-level mark of a dotted `s.update_var("row.title", …)`: member `Path`
 * of stack variable `Name` now holds `Shape`, so `InferResponse` sets that
 * member's type (a union with the old one where the update may not run). Phantom.
 */
export type MemberUpdateBrand<Name extends string, Path extends string, Shape> = {
  readonly __memberUpdate: readonly [Name, Path, Shape];
};

/**
 * The two envelope members every stack item carries, whatever it does.
 *
 * They are editor affordances rather than statement arguments — `disabled` is
 * how a step is commented out (it stays in the stack; the run engine skips it),
 * and `description` is the note shown on the step. `encodeStatement` writes both
 * for every statement, so every factory accepts them: the generated ones as two
 * more optional fields on their argument object, the positional specials as a
 * trailing options argument.
 *
 * Both are elided at their defaults on both sides of a round trip, so setting one
 * to `false`/`""` is the same bytes as omitting it.
 */
export interface StatementAnnotations {
  /** Leave the step in the stack but skip it at runtime — Xano's "disable step". */
  disabled?: boolean;
  /** Free-text note on the step, shown in the editor beside it. */
  description?: string;
  /**
   * Per-test MOCKS — what this step returns instead of running, keyed by the
   * name of the test the mock applies to.
   *
   * `{ "happy path": c.int(1) }` makes the step return `1` while the test named
   * "happy path" runs, and changes nothing about a normal request. Wrap an
   * entry as `{ value, enabled: false }` to keep a mock switched off.
   *
   * Every name must match a test declared on the object this statement belongs
   * to; an unmatched name throws at encode time, because the engine silently
   * ignores a mock whose key is not a real test id.
   */
  mock?: MockMap;
}

/**
 * {@link StatementAnnotations} plus the result-filter option, for the statements
 * that bind an `as` variable.
 *
 * Split from the annotations rather than folded into them so `asFilters` is only
 * offered where there is a binding to attach it to: a statement that returns
 * nothing (`precondition`, `switch`, `while`, …) should not surface the option
 * in autocomplete at all. The runtime guard in {@link assertBindsAs} still
 * backs this up for callers that reach past the types.
 */
export interface StatementOptions extends StatementAnnotations {
  /**
   * Filters piped onto the result before it is bound — the editor's
   * `return as token | upper`.
   *
   * Authored from the same `fl.*` catalog as value filters and applied in
   * order, so `asFilters: [fl.trim(), fl.upper()]` trims and then upper-cases.
   *
   * The bound variable is RETYPED by the chain: `InferResponse` folds each
   * filter's declared result, so a `db.query` bound through `[fl.count()]` is a
   * `number`. Filters the engine declares as returning `any` (`get`, `set`,
   * `json_decode`, …) fold to `unknown` — see `values/filter-result.ts`.
   */
  asFilters?: FilterXdo[];
  /**
   * Bind `as` to a name the variable-name rule refuses — `"2343434"`,
   * `"root-folder-contents"` — which a pulled workspace already stores. The
   * engine binds the variable and reads it back by that exact name
   * (`ref("root-folder-contents")`); this skips the name check only. A new
   * binding takes a real variable name instead.
   */
  uncheckedAs?: boolean;
}

/**
 * Where {@link StatementOptions.uncheckedAs} rides on a built statement: an
 * enumerable symbol, so it survives the `{...stmt}` copies a statement goes
 * through and never reaches the encoded bytes.
 */
const UNCHECKED_AS = Symbol.for("xanosdk.statement.uncheckedAs");

/** Whether `stmt` was built with `uncheckedAs: true`. */
export function isUncheckedAs(stmt: object): boolean {
  return (stmt as Record<symbol, unknown>)[UNCHECKED_AS] === true;
}

/**
 * `disabled` must be a boolean and `description` a string, on every statement.
 *
 * Through `any`, `{ disabled: "yes", description: 42 }` was stored as-is: a
 * truthy string in a flag the engine reads as a boolean, and a number where the
 * editor shows a note. Checked where the options are applied and again at
 * encode, so a factory that writes the envelope itself is covered too.
 */
export function assertAnnotations(stmt: Pick<Statement, "name" | "disabled" | "description" | "as">): void {
  // The binding too: `s.db.query({ as: 42 })` stored a number where every
  // later `ref()` looks for a variable name.
  if (stmt.as != null && typeof stmt.as !== "string") {
    throw new Error(
      `Statement "${statementLabel(stmt.name)}": argument \`as\` must be the variable name as a string — got ` +
        `${describeEntry(stmt.as)}.`,
    );
  }
  // A non-empty binding follows the same variable-name rule as `s.set_var`'s
  // name: `s.db.query({ as: "bad name" })` and `as: "$x"` were stored, and no
  // later `ref()` can reach either. `""` is the statement that binds nothing.
  // A stored binding carried with `uncheckedAs` is the one exception.
  if (typeof stmt.as === "string" && stmt.as !== "" && !isVarName(stmt.as) && !isUncheckedAs(stmt)) {
    throw new Error(
      `Statement "${statementLabel(stmt.name)}": argument \`as\` is ${JSON.stringify(stmt.as)}, which is not a variable name — ` +
        `use a letter or underscore, then letters, digits and underscores (e.g. "order_total")` +
        `${stmt.as.startsWith("$") ? `; \`as\` takes the bare name, without the "$"` : ""}.`,
    );
  }
  for (const [option, flag] of [["disabled", stmt.disabled], ["uncheckedAs", (stmt as Record<symbol, unknown>)[UNCHECKED_AS]]]) {
    if (flag != null && typeof flag !== "boolean") {
      throw new Error(
        `Statement "${statementLabel(stmt.name)}": option \`${option}\` must be true or false — got ${describeEntry(flag)}.`,
      );
    }
  }
  if (stmt.description != null && typeof stmt.description !== "string") {
    throw new Error(
      `Statement "${statementLabel(stmt.name)}": option \`description\` must be a string — got ` +
        `${describeEntry(stmt.description)}.`,
    );
  }
}

/** The keys of {@link StatementAnnotations}: what a positional option bag (`s.group(body, opts)`) may carry. */
export const ANNOTATION_KEYS: readonly string[] = /* @__PURE__ */ Object.keys({ disabled: 1, description: 1, mock: 1 } satisfies Record<keyof StatementAnnotations, 1>);

/** The keys of {@link StatementOptions}: {@link ANNOTATION_KEYS} plus `asFilters`. */
export const OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.keys({ disabled: 1, description: 1, mock: 1, asFilters: 1, uncheckedAs: 1 } satisfies Record<keyof StatementOptions, 1>);

/**
 * Apply {@link StatementOptions} to a built statement.
 *
 * Only members that were actually authored are copied, so a factory's own
 * `description` (a few statements route one) is not clobbered by an absent key.
 *
 * `asFilters` merges into the `output` envelope rather than replacing it: a db
 * statement's column selection (`output.items`) and its result filters live in
 * the same block, and dropping one to write the other would silently discard
 * whichever the factory set first.
 */
export function annotate<T extends Statement>(stmt: T, a?: StatementOptions): T {
  // `null` is the absent option it means, as it is for every optional value.
  if (a?.disabled !== undefined && a.disabled !== null) stmt.disabled = a.disabled;
  if (a?.description !== undefined && a.description !== null) stmt.description = a.description;
  if (a?.uncheckedAs != null && a.uncheckedAs !== false) (stmt as Record<symbol, unknown>)[UNCHECKED_AS] = a.uncheckedAs;
  assertAnnotations(stmt);
  if (a?.mock !== undefined && a.mock !== null) {
    try {
      stmt.mocks = encodeMockMap(a.mock);
    } catch (err) {
      throw new Error(`Statement "${statementLabel(stmt.name)}": ${(err as Error).message}`);
    }
  }
  // `null` is the absent chain it means; anything else has to be a list of
  // `fl.*` filters. Through `any`, `asFilters: null` used to read `.length` off
  // null, and `[null]` stored a filter the engine cannot read.
  if (a?.asFilters !== undefined && a.asFilters !== null) assertFilterList(stmt, a.asFilters);
  if (a?.asFilters !== undefined && a.asFilters !== null && a.asFilters.length > 0) {
    assertBindsAs(stmt, "asFilters");
    stmt.output = { ...((stmt.output ?? {}) as Record<string, unknown>), filters: a.asFilters };
  }
  return stmt;
}

/**
 * Refuse an option that filters a result the statement never binds.
 *
 * The engine reads a statement's filter chain off the `as` argument, so without
 * a binding there is nothing for the chain to attach to — the filters would be
 * persisted and never run. Caught at author time because the failure is
 * otherwise invisible: the deploy succeeds and the filter simply does nothing.
 */
export function assertBindsAs(stmt: Statement, option: string): void {
  if (stmt.as) return;
  throw new Error(
    `Statement "${statementLabel(stmt.name)}" binds no \`as\` variable, so \`${option}\` has nothing to filter. ` +
      "Bind the result with `as` first, or drop the option.",
  );
}

/** Refuse an `asFilters` that is not a list of `fl.*` filters, naming the statement. */
function assertFilterList(stmt: Statement, list: unknown): void {
  const where = `Statement "${statementLabel(stmt.name)}": argument "asFilters`;
  if (!Array.isArray(list)) {
    throw new Error(`${where}" must be an array of filters (\`fl.*\`) — got ${describeEntry(list)}.`);
  }
  list.forEach((f, i) => {
    if (typeof f !== "object" || f === null || typeof (f as { name?: unknown }).name !== "string") {
      throw new Error(`${where}[${i}]" must be a filter (\`fl.*\`) — got ${describeEntry(f)}.`);
    }
  });
}


/** What a statement factory returns before base-envelope encoding. */
export interface Statement {
  name: string;
  as?: string;
  context: unknown;
  input?: unknown[];
  /** `output` envelope. Lean (`{filters:[]}`) or rich (`{customize,filters,items}`) forms are both accepted and normalized to the full rich form. */
  output?: unknown;
  /** Statement description (defaults to `""`). */
  description?: string;
  /** Settings-registry bindings (defaults to `null`). */
  settings_registry?: unknown[] | null;
  /** Attached addons (defaults to `[]`). */
  addon?: unknown[];
  /** Async/runtime block (e.g. `mvp:call_agent`'s `{ mode }`); defaults to `null`. */
  runtime?: unknown;
  /**
   * Encoded per-test mocks, keyed by test NAME until the owning kind rewrites
   * the keys to test ids. Authored via the `mock` option, not set directly.
   */
  mocks?: Record<string, MockXdo> | unknown;
  /** Whether the statement is disabled in the stack (defaults to `false`). */
  disabled?: boolean;
}

/**
 * Return a statement sequence from a helper **without losing the tuple**.
 *
 * `InferResponse` traces the `as` binding a `response` names by walking the
 * stack's TUPLE type. Spreading anything typed `Statement[]` widens the whole
 * array, and every binding — including ones declared *after* the spread —
 * becomes invisible, so the response silently resolves to
 * {@link StackTupleWidened}. A helper that emits more than one statement has to
 * return an array, so any shared helper triggers it:
 *
 * ```ts
 * // ✗ widens: every `as` in the calling stack stops being traceable
 * function assertOk(v: string): Statement[] { return [s.lambda({…}), s.precondition({…})]; }
 *
 * // ✓ tuple survives the spread
 * function assertOk(v: string) { return statements(s.lambda({…}), s.precondition({…})); }
 * ```
 *
 * Type-level only — the returned array is the arguments verbatim, so there is no
 * encoder involvement and no cost.
 *
 * **Fixed arity only.** A helper that builds its array in a loop cannot be a
 * tuple; declare `responseShape` on the calling def instead.
 */
export function statements<const T extends readonly Statement[]>(...items: T): T {
  return items;
}

/**
 * Marker carrying an already-persisted envelope that `encodeStatement` must
 * return **verbatim**, skipping the registry check and the whole canonical
 * rebuild below. Set only by `raw()` (see `special/raw.ts`), which is reachable
 * from `@xano/sdk/codegen` and deliberately not from the `s` namespace.
 *
 * `Symbol.for` rather than a fresh `Symbol` so a decode tree compiled against a
 * duplicate copy of the package still short-circuits.
 */
export const RAW_ENVELOPE: unique symbol = Symbol.for("xanosdk.statement.rawEnvelope") as never;

/** Registry of known statement names → factory (for catalog extensibility). */
const registry = new Map<string, (...args: any[]) => Statement>();

/**
 * Stored name → the `s.` path an author calls it by (`mvp:dbo_getby` →
 * `s.db.get`). Every message a person reads names the statement this way — the
 * stored name appears nowhere in authored code. Filled from a spec's `factory`
 * when one registers, and from the assembled `s` tree by {@link registerFactoryPaths}.
 */
const factoryPaths = new Map<string, string>();

/** Registered factory function → its stored name, so a walk of `s` can learn each path. */
const namesByFactory = new Map<unknown, string>();

/**
 * Register a statement factory under its stored `name` (e.g. `mvp:set_var`).
 * `path` is the `s.` factory an author calls it by, when the caller knows it.
 */
export function registerStatement(
  name: string,
  factory: (...args: any[]) => Statement,
  path?: string,
): void {
  registry.set(name, factory);
  namesByFactory.set(factory, name);
  if (path !== undefined && !factoryPaths.has(name)) factoryPaths.set(name, path);
}

/**
 * Learn the `s.` path of every registered factory reachable from `tree` (the
 * assembled `s` namespace). The first path found for a stored name wins, so an
 * alias later in the tree (`s.util.get_input` beside `get_raw_input`) does not
 * rename it.
 */
export function registerFactoryPaths(tree: unknown, prefix: string, seen = new Set<unknown>()): void {
  if (tree === null || (typeof tree !== "object" && typeof tree !== "function") || seen.has(tree)) return;
  seen.add(tree);
  const name = namesByFactory.get(tree);
  if (name !== undefined && !factoryPaths.has(name)) factoryPaths.set(name, prefix);
  for (const [key, child] of Object.entries(tree as Record<string, unknown>)) {
    registerFactoryPaths(child, `${prefix}.${key}`, seen);
  }
}

/**
 * The name a person reads for a stored statement: its `s.` factory path when
 * known (`s.db.get`), else the stored name without its wire prefix.
 */
export function statementLabel(storedName: string): string {
  return factoryPaths.get(storedName) ?? readableStatementName(storedName);
}

/**
 * Assert every entry of a statement list is a statement, naming the owner and
 * the position of the first that is not.
 *
 * `null`, `{}`, a string, and the `false`/`undefined` that plain JavaScript's
 * `cond && s.x()` leaves behind are all REFUSED rather than skipped: a list that
 * silently drops an entry also drops the one a helper forgot to `return`, and
 * the deploy would succeed without it. A conditional step is spread in —
 * `...(cond ? [s.x()] : [])` — or, for a runtime condition, `s.conditional`.
 */
export function assertStatementList(owner: string, where: string, list: unknown): void {
  if (!Array.isArray(list)) {
    throw new Error(`${owner}: \`${where}\` must be an array of statements (\`s.*\`) — got ${describeEntry(list)}.`);
  }
  list.forEach((entry, i) => {
    if (isStatementEntry(entry)) return;
    throw new Error(
      `${owner}: \`${where}[${i}]\` must be a statement (\`s.*\`) — got ${describeStatementEntry(entry)}.${conditionalEntryHint(entry)}`,
    );
  });
}

/**
 * Encode a def's top-level stack, refusing a non-statement entry with the def
 * named — `function "checkout": \`stack[2]\` must be a statement … got null` —
 * before `encodeStatement` reads a property off it.
 */
export function encodeStack(kind: string, name: string | undefined, stack: unknown): StackItemXdo[] {
  if (stack === undefined || stack === null) return [];
  assertStatementList(`${kind} "${name ?? "?"}"`, "stack", stack);
  return (stack as Statement[]).map(encodeStatement);
}

/**
 * Every registered statement name.
 *
 * Exported for the maintainer audits, which need the POPULATION rather than a
 * single lookup: `scripts/special-required.ts` subtracts the generated catalog
 * from this to get the hand-authored wrappers, which are exactly the statements
 * no spec checks. Reading `s.` instead would miss any wrapper reachable only
 * through the decoder, and reading the source would miss any registered
 * dynamically.
 */
export function registeredStatementNames(): string[] {
  return [...registry.keys()];
}

/** True when a statement name has a registered factory. */
export function isRegisteredStatement(name: string): boolean {
  return registry.has(name);
}

/** Look up a registered factory, throwing a clear error when absent. */
export function getStatementFactory(name: string): (...args: any[]) => Statement {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown statement "${readableStatementName(name)}": no factory is registered for it in this copy of @xano/sdk.`,
    );
  }
  return factory;
}

/**
 * Normalize a statement `input[]` entry to the full stored binding shape. The
 * persisted form is uniform across every statement type — `{name, value, tag,
 * filters, ignore, expand, children}` — so any missing members are filled with
 * their defaults (confirmed against live `mvp_query`/`mvp_tool`: 100% of entries
 * carry all seven keys).
 */
function fullInputEntry(raw: unknown): Record<string, unknown> {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    name: e.name,
    value: e.value,
    tag: e.tag,
    filters: e.filters ?? [],
    ignore: e.ignore ?? false,
    expand: e.expand ?? false,
    children: e.children ?? [],
  };
}

/**
 * Encode a statement into the stored `StackItemXdo`, filling the **full**
 * persisted envelope. Every stored statement carries the same 12 keys
 * regardless of type (confirmed against live `mvp_query`/`mvp_tool`), so the
 * envelope is uniform here rather than per-statement: empty members are emitted
 * with their canonical defaults so the output is 1:1 with the engine's
 * persisted form. `_xsid` is engine-generated on import; we emit `""` (the
 * stored placeholder) so the key is present for comparison.
 */
/**
 * A fact a factory knew about a statement that its bytes cannot say — the
 * microservice def that built its `host` — carried onto the encoded form, so a
 * check on an encoded stack reads it per statement rather than by its text.
 */
const marks = new WeakMap<object, string>();

/** Record `mark` on `stmt`; its encoded form carries it. */
export function markStatement(stmt: object, mark: string): void {
  marks.set(stmt, mark);
}

/** The mark recorded on a statement or its encoded form. */
export function statementMark(stmt: object): string | undefined {
  return marks.get(stmt);
}

export function encodeStatement(stmt: Statement): StackItemXdo {
  const encoded = encodeStatementBytes(stmt);
  const mark = marks.get(stmt);
  if (mark) marks.set(encoded, mark);
  return encoded;
}

function encodeStatementBytes(stmt: Statement): StackItemXdo {
  // `raw()` short-circuit: the envelope is already persisted, so returning it
  // untouched is the whole point — the rebuild below would drop any key outside
  // the canonical shape, which is exactly what raw() exists to preserve.
  const rawEnvelope = (stmt as Partial<Record<typeof RAW_ENVELOPE, StackItemXdo>>)[RAW_ENVELOPE];
  if (rawEnvelope !== undefined) return rawEnvelope;

  if (!isRegisteredStatement(stmt.name)) {
    throw new Error(
      `Cannot encode unregistered statement "${readableStatementName(stmt.name)}": it is not registered in this copy of @xano/sdk. ` +
        `A def is encoded by the SDK copy that built it — when two copies are loaded (a global \`xanosdk\` ` +
        `and a project install), run the project's own (\`npx xanosdk\`), or encode through the def's own workspace.`,
    );
  }
  assertAnnotations(stmt);
  // `output` is always the rich `{items, filters, customize}` form in the
  // persisted corpus; merge any authored output (lean or rich) over the default.
  const output = {
    items: [],
    filters: [],
    customize: false,
    ...((stmt.output ?? {}) as Record<string, unknown>),
  };
  // The persisted form stores an empty settings-registry as `null` (not `[]`);
  // the older parser fixtures emit `[]`. Canonicalize empty → null so the raw
  // output matches the engine; a populated binding list is kept verbatim.
  const sr = stmt.settings_registry;
  const settings_registry = sr == null || (Array.isArray(sr) && sr.length === 0) ? null : sr;
  return {
    as: stmt.as ?? "",
    name: stmt.name,
    _xsid: "",
    addon: stmt.addon ?? [],
    input: (stmt.input ?? []).map(fullInputEntry),
    mocks: stmt.mocks ?? {},
    output,
    context: stmt.context,
    runtime: stmt.runtime ?? null,
    disabled: stmt.disabled ?? false,
    description: stmt.description ?? "",
    settings_registry,
  };
}
