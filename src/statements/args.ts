/**
 * Argument guards for the hand-authored statement wrappers.
 *
 * Deliberately import-free. Every wrapper in the tree calls these, including
 * ones the coercion plumbing imports from, so anything pulled in here would
 * close an import cycle and strand a module initializer.
 */

/**
 * Normalize a missing argument object to `{}`.
 *
 * Only untyped JavaScript can reach a wrapper with nothing — TypeScript rejects
 * `s.db.get()` at the type. What it reached with mattered: the wrapper coerces
 * its fields before delegating, so it read a property off `undefined` and
 * reported `Cannot read properties of undefined (reading 'table')` instead of
 * naming the field the author has to supply. Normalizing here lets the
 * downstream required-field throw — the one `s.db.get({})` already produces —
 * do the reporting. `encodeFromSpec` does the same for the generated factories.
 *
 * `test/statements/zero-arg-message.test.ts` walks the whole `s.` surface and
 * fails on any leaf that still answers a zero-argument call with a `TypeError`.
 */
export function argsOrEmpty<T>(a: T): T {
  return (a ?? {}) as T;
}

/**
 * Assert a required argument the wrapper is about to DEREFERENCE is present.
 *
 * The `{}` fallback above stops a missing argument object from blaming an
 * arbitrary property, but the field inside it is the next thing read — a
 * hand-authored wrapper reaches straight for `args.fn.guid` or `args.body.map`,
 * with no spec to check it against the way `encodeFromSpec` does. So each
 * wrapper names its own, in the shape `encodeFromSpec` uses for a missing
 * field, and an author reads one message format either way.
 *
 * `statement` is the `s.` path the author called (`"s.db.add"`). A stored
 * `mvp:` name passed through a shared helper loses its wire prefix here — the
 * stored spelling is never what an author reads.
 *
 * `null` counts as absent. Through `any` or untyped JavaScript, `s.for({ count:
 * null })` or `s.try_catch({ try: null })` reached the dereference behind this
 * guard and reported `Cannot read properties of null` — naming nothing the
 * author wrote. The few fields where `null` IS an authored answer —
 * `s.db.query({ table: null })` is an unbound query, not a mistake — pass
 * `{ nullable: true }`.
 */
export function assertArg(
  statement: string,
  name: string,
  v: unknown,
  opts?: { readonly nullable?: boolean },
): void {
  if (v === undefined || (v === null && !opts?.nullable))
    throw new Error(
      `Statement "${label(statement)}": required argument "${name}" is missing${v === null ? " (got null)" : ""}.`,
    );
}

/** The `s.` path an author reads — a stored `mvp:` name loses its wire prefix. */
function label(statement: string): string {
  return statement.replace(/^mvp:/, "");
}

/** Why a literal `__proto__:` key is refused, and the spelling that works. */
export const PROTO_KEY =
  "a literal `__proto__:` key sets the object's prototype in JavaScript — write it computed: `[\"__proto__\"]: …`";

/**
 * True for a record whose prototype a literal `__proto__:` key set.
 *
 * TypeScript reads `{ a, __proto__: x }` as a member named `__proto__` —
 * `InferRow`/`InferInput` carry it — but JavaScript makes `x` the prototype, so
 * every walker that reads own keys lost it without a word, and one that reads
 * `.tag` saw `x`'s tag and took the whole record for `x`. A class instance's
 * prototype owns its `constructor`; a literal-set one (a plain record, a tagged
 * value) does not, which is what separates the two. `__proto__: null` leaves no
 * trace to find, and JavaScript ignores a primitive there.
 */
export function protoKeyed(v: unknown): boolean {
  const p = typeof v === "object" && v !== null ? (Object.getPrototypeOf(v) as object | null) : null;
  return p !== null && p !== Object.prototype && !Object.hasOwn(p, "constructor");
}

/**
 * A short, non-leaking description of what arrived instead of a value — the one
 * every refusal shares, so a tagged value is never "a plain object", a function
 * never "undefined", and a `Date` never "a plain object" either.
 */
export function describeArg(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `a JS array (${v.length} item${v.length === 1 ? "" : "s"})`;
  // Before the tagged test: `{ a, __proto__: ref("v") }` INHERITS `tag`/`value`.
  if (protoKeyed(v)) return `a record with a \`__proto__\` key (${PROTO_KEY})`;
  if (isTaggedArg(v)) return `a tagged value (${valueSpelling((v as { tag: string }).tag)})`;
  if (typeof v === "function") return "a function";
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto === null || proto === Object.prototype) return "a plain object";
    const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name !== "string" || name === "") return "a class instance";
    if (["Date", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Promise", "Error"].includes(name)) return `a ${name}`;
    // By how the name is SAID: "a URL instance", "a Uint8Array instance". A
    // constructor name only (not `util/article.ts`: this module ships in every
    // browser bundle and stays import-free), so only the "you" sounds matter.
    return `${/^[AEIOU]/.test(name) && !/^U(RL|RI|UID|int|ni|se)/.test(name) ? "an" : "a"} ${name} instance`;
  }
  return `a ${typeof v}`;
}

/** The helper an author writes for a stored tag: `const:bool` → `c.bool(…)`, `var` → `ref(…)`. */
function valueSpelling(tag: string): string {
  if (tag.startsWith("const:")) return `c.${tag.slice("const:".length)}(…)`;
  const helper: Record<string, string> = { var: "ref", input: "inp", setting: "env", col: "col", auth: "auth", const: "c.text" };
  return helper[tag] !== undefined ? `${helper[tag]}(…)` : `tag "${tag}"`;
}

/**
 * Structural tagged-value test — `{tag, value, filters}`. The tag is not checked
 * against the known set (a pulled `rawValue()` carries a stored one through),
 * and a CALLABLE value passes because a trigger field accessor (`t.new`) is one.
 */
export function isTaggedArg(v: unknown): boolean {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { tag?: unknown }).tag === "string" &&
    "value" in (v as object) &&
    Array.isArray((v as { filters?: unknown }).filters)
  );
}

/**
 * Assert a required argument is a tagged value (`c.*`, `ref()`, `inp()`, …)
 * before the wrapper copies `tag`/`value`/`filters` off it.
 *
 * Absent or `null` is the required-argument message; anything else untagged —
 * a bare string, a JS array of rows, a plain record — says what arrived and how
 * to wrap it. Copying off a plain value emits an empty slot that deploys clean
 * and fails every request, so it is refused here rather than at runtime.
 */
export function assertValueArg(statement: string, name: string, v: unknown): void {
  assertArg(statement, name, v);
  if (isTaggedArg(v)) return;
  throw new Error(valueArgMessage(statement, name, v));
}

/**
 * An OPTIONAL tagged-value argument: `undefined` and `null` are both the absent
 * argument (`false` is returned and nothing is written); anything else must be a
 * tagged value. Guarding with `=== undefined` alone let `null` reach the
 * `.value` copy behind it — `s.util.get_input({ encoding: null })` reported a
 * raw TypeError — and let a bare `5` through as an empty slot.
 */
export function presentValueArg(statement: string, name: string, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (isTaggedArg(v)) return true;
  throw new Error(valueArgMessage(statement, name, v));
}

/** A wrap that runs for this number, or why none does. */
function numberRemedy(v: number): string {
  if (!Number.isFinite(v)) return ` ${v} is not representable as a stored number — use a finite value, or \`c.null()\` for none.`;
  if (Number.isSafeInteger(v)) return ` Wrap it: \`c.int(${v})\`.`;
  if (Number.isInteger(v)) {
    return ` It is past Number.MAX_SAFE_INTEGER, so the literal was already rounded — write the exact digits as \`c.int("<digits>")\` or \`c.int(<digits>n)\`.`;
  }
  return ` Wrap it: \`c.decimal(${v})\`.`;
}

/** The "must be a value" message, shared with the lean-input builder. */
export function valueArgMessage(statement: string, name: string, v: unknown): string {
  const plain = Array.isArray(v) || (typeof v === "object" && v !== null);
  return (
    `Statement "${label(statement)}": argument "${name}" must be a tagged value (\`c.*\`, \`ref()\`, \`inp()\`, …) — got ${describeArg(v)}.` +
    (plain
      ? " A plain JS value stores an empty slot that deploys clean and then fails every request — " +
        "an array of rows is `c.array([{ … }])` (plain JSON inside), a record is `c.obj({ … })`."
      : typeof v === "number"
        ? numberRemedy(v)
        : typeof v === "string"
          ? ` Wrap it: \`c.text(${JSON.stringify(v)})\`.`
          : typeof v === "boolean"
            ? ` Wrap it: \`c.bool(${v})\`.`
            : "")
  );
}

/**
 * Assert an argument restricted to a closed set holds one of its members.
 * Through `any`, an out-of-set literal used to be stored and fail only when the
 * engine read it.
 */
export function assertOneOf(
  statement: string,
  name: string,
  v: unknown,
  allowed: readonly string[],
): void {
  if (v === undefined) return;
  if (typeof v === "string" && allowed.includes(v)) return;
  throw new Error(
    `Statement "${label(statement)}": argument "${name}" accepts only ${allowed.map((a) => JSON.stringify(a)).join(" | ")} — got ${typeof v === "string" ? JSON.stringify(v) : describeArg(v)}.`,
  );
}

/**
 * Assert a statement-list argument (`body`, a loop's or group's stack) is an
 * array before the wrapper maps over it. Through `any` or untyped JavaScript,
 * `s.group(null)` reached `.map` and reported a bare TypeError naming nothing
 * the author wrote.
 */
export function assertStatements(statement: string, name: string, v: unknown): void {
  assertArg(statement, name, v);
  if (!Array.isArray(v)) {
    throw new Error(
      `Statement "${label(statement)}": argument "${name}" must be an array of statements — got ${describeArg(v)}.`,
    );
  }
  // Every ENTRY too: `then: [null]` (or the `false` plain JavaScript's
  // `cond && s.x()` leaves) reached `encodeStatement` and reported `Cannot read
  // properties of null (reading 'Symbol(xanosdk.statement.rawEnvelope)')`.
  // Refused, not skipped — the same rule `assertStatementList` states for a
  // def's own stack.
  v.forEach((entry, i) => {
    if (isStatementEntry(entry)) return;
    throw new Error(
      `Statement "${label(statement)}": argument "${name}[${i}]" must be a statement (\`s.*\`) — got ${describeStatementEntry(entry)}.${conditionalEntryHint(entry)}`,
    );
  });
}

/** What an entry of a list argument has to be: a predicate, and how to say it. */
export interface ListItemRule {
  readonly test: (v: unknown) => boolean;
  /** "a column path string", "an addon spec ({ addon, as })", … */
  readonly want: string;
}

/**
 * Assert an OPTIONAL list argument (`output`, `addon`, `eval`, `sort`, `bind`,
 * `args`, …) is an array whose every entry passes `item`, before a wrapper maps
 * over it. Absent and `null` pass — both are the empty list the wrapper
 * defaults to. Through `any`, a string reached `.map` (`specs.map is not a
 * function`) and `[null]` reached a property read (`reading 'split'`), both
 * naming nothing the author wrote.
 */
export function assertListArg(statement: string, name: string, v: unknown, item?: ListItemRule): void {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) {
    throw new Error(
      `Statement "${label(statement)}": argument "${name}" must be an array${item ? ` of ${item.want}` : ""} — got ${describeEntry(v)}.`,
    );
  }
  if (item === undefined) return;
  v.forEach((entry, i) => {
    if (item.test(entry)) return;
    throw new Error(`Statement "${label(statement)}": argument "${name}[${i}]" must be ${item.want} — got ${describeEntry(entry)}.`);
  });
}

/** A non-null, non-array object — the shape every spec-like list entry has. */
export function isRecordArg(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The remedy for the `false`/`undefined` a plain-JavaScript `cond && s.x()`
 * leaves in a statement list — empty for any other entry.
 */
export function conditionalEntryHint(entry: unknown): string {
  return entry === false || entry === undefined
    ? " A `cond && s.x()` entry leaves false/undefined behind — spread it instead: `...(cond ? [s.x()] : [])`, " +
        "or use `s.conditional` for a runtime condition."
    : "";
}

/** `Symbol.for`, so this stays import-free — the same key `raw()` sets. */
const RAW_ENVELOPE_KEY = Symbol.for("xanosdk.statement.rawEnvelope");

/** A built statement (a `name`), or a `raw()` carrier of a persisted one. */
export function isStatementEntry(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  if ((v as Record<symbol, unknown>)[RAW_ENVELOPE_KEY] !== undefined) return true;
  return typeof (v as { name?: unknown }).name === "string";
}

/**
 * {@link describeEntry} for a slot that wants a STATEMENT. A tagged value there
 * (`ref("x")`, `c.int(1)`) is a structurally ordinary object, so it read as "a
 * plain object" — true, and no help to an author who wrote a value where a step
 * goes.
 */
export function describeStatementEntry(v: unknown): string {
  return isTaggedArg(v) ? "a value (`c.*`/`ref()`), not a statement" : describeEntry(v);
}

/** {@link describeArg}, with a primitive's value shown — `false` says more than "a boolean". */
export function describeEntry(v: unknown): string {
  if (typeof v === "boolean" || typeof v === "number") return `${typeof v} ${String(v)}`;
  if (typeof v === "bigint") return `bigint ${String(v)}n`;
  if (typeof v === "string") return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  return describeArg(v);
}

/**
 * The positional variable name. Through `any`, `s.set_var(undefined, …)` stored
 * a statement binding nothing, and a later `ref()` to it read an unset variable.
 */
export function assertVarName(statement: string, name: unknown, arg = "name"): void {
  assertArg(statement, arg, name);
  if (typeof name !== "string") {
    throw new Error(`Statement "${statement}": argument "${arg}" must be the variable name as a string — got ${describeEntry(name)}.`);
  }
}

/**
 * The variable-name rule the editor enforces on a new variable: a letter or
 * underscore, then letters, digits and underscores. `s.set_var("a b")` was
 * stored, and `$a b` is not a name any later `ref()` can reach. A loop's `as`
 * binds a variable the same way, so `s.for`/`s.foreach` share the rule —
 * `s.foreach({ as: "" })` was stored with nothing to `ref()`.
 */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The editor's variable-name rule: a letter or underscore, then letters, digits and underscores. */
export function isVarName(name: string): boolean {
  return VAR_NAME.test(name);
}

export function assertNewVarName(statement: string, name: unknown, arg = "name"): void {
  assertVarName(statement, name, arg);
  if (name === "") throw new Error(`Statement "${statement}": argument "${arg}" is empty — name the variable.`);
  if (!VAR_NAME.test(name as string)) {
    throw new Error(
      `Statement "${statement}": ${JSON.stringify(name)} is not a variable name — use a letter or underscore, ` +
        `then letters, digits and underscores (e.g. "order_total").`,
    );
  }
}
