/**
 * Schema-DSL interpreter. Turns a declarative statement schema's
 * `transform` rules into a runtime encoder, so the ~169 declarative statements
 * are driven by data (a `StatementSpec`) rather than hand-written per statement.
 *
 * A `StatementSpec` is a flat list of `FieldRule`s — one per authored field the
 * statement consumes — mirroring the engine's `transform.args` / `transform.blocks`
 * entries. Each rule says where one authored field lands in the stored statement:
 *  - `route: { kind: "as" }`             → the statement's top-level `as`.
 *  - `route: { kind: "context-plain" }`  → a plain string written at `context.<path>`.
 *  - `route: { kind: "context-spread" }` → a Value's `{value,tag,filters}` spread
 *      directly into `context` (the `!assign context` rule).
 *  - `route: { kind: "context-nest" }`   → a Value's `{value,tag,filters}` nested
 *      under `context.<path>` (the `!assign context.<key>` rule).
 *
 * Rules carry optionality + an optional string `default` (the schema's `?=X`).
 * `output` (whether the stored item carries `output:{filters:[]}`) is NOT
 * derivable from the transform schema — it is engine statement-class metadata
 * (e.g. `uuid4` has an `as` but no `output`; `return` has a value block but no
 * `output`). The codegen pins it from the persisted golden fixture,
 * never guessing.
 *
 * Validated against real persisted fixtures (math_add, bitwise_and, object_keys,
 * array_push, array_pop). The codegen pipeline populates the
 * spec catalog from the Xano engine's schema definitions; uninterpretable schemas are
 * logged, never guessed.
 */
import type { Statement } from "../statement.js";
import { registerStatement, annotate, readableStatementName } from "../statement.js";
import type { Value } from "../../values/value.js";
import type { MockMap } from "../../values/mock.js";
import type { FilterXdo } from "../../types/xdo.js";
import { leanInput } from "../lean-input.js";
import { assertValueArg, describeEntry } from "../args.js";
import { isIgnored } from "../../values/ignored.js";
import { resolveEnumValue } from "./enum-guard.js";
import { encodeRuntimeCondition } from "../conditional.js";
import type { Condition } from "../conditional.js";
import { assertLambdaStatement, coerceLambdaFields } from "../../values/lambda.js";
import { assertKnownKeys } from "../../util/known-keys.js";

/**
 * What kind of authored value a field consumes:
 *  - `string`     — a plain `static:text` arg.
 *  - `boolean`    — a plain `static:bool` arg, authored as a real boolean.
 *  - `value`      — a `!kinds assign` tagged Value.
 *  - `comparison` — a `Condition` expression tree (the `!compare` directive).
 */
export type FieldType = "string" | "boolean" | "value" | "comparison";

/** Where one authored field lands in the stored statement. */
export type Route =
  | { kind: "as" }
  | { kind: "context-plain"; path: string }
  | { kind: "context-spread" }
  | { kind: "context-nest"; path: string }
  | { kind: "context-compare"; path: string }
  | { kind: "input"; name: string };

/**
 * Per-statement envelope shape, pinned from the persisted fixture — the
 * engine-class metadata that isn't in the transform schema. "Full" statements
 * (api_request, db ops, file ops) carry richer `input[]` entries and extra
 * top-level keys; lean statements (math, array, object) carry none of these.
 */
export interface EnvelopeProfile {
  /** `input[]` entries carry `ignore/expand/children` (vs the lean `{name,value,tag,filters}`). */
  inputFull?: boolean;
  /** Always emit `as` (default `""`) even when no rule sets it. */
  emitAs?: boolean;
  /** Emit `description:""`. */
  description?: boolean;
  /** Emit `settings_registry:[]`. */
  settingsRegistry?: boolean;
  /** Emit `addon:[]`. */
  addon?: boolean;
  /** `output` is the rich `{customize:false,filters:[],items:[]}` (vs lean `{filters:[]}`). */
  richOutput?: boolean;
}

/** One authored field → its routing into the stored statement. */
export interface FieldRule {
  /** Authored field name (e.g. "as", "name", "value", "filename"). */
  field: string;
  /** String arg vs Value(assign) — determines how `default`/missing is handled. */
  type: FieldType;
  /** Optional in authoring (the schema's trailing `?`). */
  optional: boolean;
  /** Literal default for string fields when not provided (the schema's `?=X`). */
  default?: string;
  /**
   * The field's closed set of legal values, harvested from the engine's runtime
   * input schema ({@link ./input-schema.ts}) and attached by
   * {@link ./enums.ts attachEnums}. Absent on all but the ~36 constrained
   * fields. Drives three things: the generated factory's literal-union
   * signature, the bare-literal shorthand, and the encode-time guard in
   * {@link encodeFromSpec}.
   */
  enum?: string[];
  /**
   * Written as an empty text constant when the author omits it, rather than
   * left out. Set by `overrides.ts` for a field that is optional to author but
   * that the engine reads unconditionally — it refuses a statement missing the
   * key at run time, after a clean deploy. The empty constant is what the
   * engine's own XanoScript form stores for "unset". An authored `null` writes
   * no key at all — the spelling a pull uses for a statement stored without it.
   */
  emptyWhenAbsent?: true;
  /** Routing target. */
  route: Route;
}

export interface StatementSpec {
  /** Stored statement name, e.g. "mvp:math_add". */
  name: string;
  /**
   * The `s.` path the author calls this statement by (`"s.math.add"`) — what
   * every error names, since the stored name appears nowhere in authored code.
   * Written by the codegen beside the name, so naming the factory costs no
   * lookup table in the client bundle.
   */
  factory?: string;
  /** Marks the engine's argNameIsVar family (informational; does not affect encoding). */
  argNameIsVar?: boolean;
  /** Ordered field rules. */
  rules: FieldRule[];
  /** Emit `output` when true (pinned from the golden fixture; shape per `envelope.richOutput`). */
  output?: boolean;
  /** Per-statement envelope shape pinned from the fixture; absent = lean. */
  envelope?: EnvelopeProfile;
}

/**
 * Authored `output` envelope shaping (the frontend's "Output" tab). Any of the
 * three stored members may be set; omitted members keep their empty default.
 * `filters` attaches a filter chain to the result variable; `customize`/`items`
 * drive response field-mapping. Merged over the spec's default `output` shape.
 *
 * Prefer `asFilters` for the filter chain — it is typed, reaches every statement
 * rather than the subset declaring an `output`, and guards the no-binding case.
 * `filters` here remains the escape hatch for a chain the typed surface cannot
 * express; setting both throws.
 */
export interface OutputAuthored {
  filters?: unknown[];
  customize?: boolean;
  items?: unknown[];
}

/**
 * Authored inputs for a spec-driven statement, keyed by field name. Besides the
 * spec's rule fields, five reserved envelope keys are honored: `disabled`,
 * `description`, `mock`, and `asFilters` ({@link StatementAnnotations} —
 * accepted on every statement) and `output` (an {@link OutputAuthored} shaping
 * the result envelope, only where the statement carries one). No engine
 * statement routes a rule field by any of those five names, so they are
 * unambiguous.
 */
export type Authored = Record<
  string,
  string | boolean | Value | Condition | OutputAuthored | FilterXdo[] | MockMap | undefined
>;

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/**
 * A `context-nest` value block (`error`, `payload`, `array`, …). Unlike an
 * expression operand or a `context-spread`, the engine schema types `filters`
 * here WITHOUT a default (an optional `filters[]`), so the
 * persisted form omits the key entirely when empty and keeps it only when a
 * filter is attached (verified against the live xdo corpus: 19/19 precondition
 * `error` blocks are `{tag,value}` with no `filters`). Mirror that.
 */
function nestedValueFields(v: Value): Record<string, unknown> {
  const fields: Record<string, unknown> = { value: v.value, tag: v.tag };
  if (Array.isArray(v.filters) && v.filters.length > 0) fields.filters = v.filters;
  return fields;
}

/** Shallow-copy only the defined own keys of an object (drops `undefined`). */
function pickDefined(o: OutputAuthored): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Write `value` at a dotted `path` inside `obj`, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Build a statement `input[]` argument binding from an authored Value.
 *
 * An `ignored()` binding keeps its value and is skipped at runtime — the engine
 * records `"<name>:ignore"` and never binds it. The flag rides a non-enumerable
 * marker on the value, so it lands here rather than in the serialized value.
 *
 * It is written on EVERY statement, lean envelope or full. `ignore`
 * is not a property of the full envelope: the lean and full spellings are two
 * serializations of one entry model, and a real engine capture of a lean-spec
 * statement (`mvp:redis_ratelimit`, in this repo's middleware corpus) stores
 * `ignore`/`expand`/`children` on every entry. What the lean form omits is those
 * members at their DEFAULTS, which is why only a true flag is written here —
 * an ordinary binding still emits the identical lean bytes, and `normalize`
 * already reads an absent `ignore` and `ignore:false` as the same thing.
 *
 * Before this, `ignored()` on any of the 43 lean-envelope specs (the Redis, S3,
 * storage and IP-lookup families) was silently discarded, so a clause an author
 * meant to skip when empty was bound anyway — a divergence that appears only on
 * the empty-value branch at runtime.
 */
/**
 * Refuse `ignored()` on a field routed somewhere with no `ignore` slot.
 *
 * The flag lives on an `input[]` ENTRY. A field routed into `context` — spread,
 * plain, or nested — is stored as bare value members with nowhere to hang it,
 * so wrapping one is a no-op the author cannot see: the statement encodes, the
 * bundle deploys, and the clause is bound anyway. That is the same silent
 * failure {@link inputEntry} exists to close, so it is refused rather than
 * documented (`s.math.mul` and the rest of the mutation family are the
 * population).
 */
function assertIgnorable(statement: string, field: string, provided: unknown): void {
  if (!isIgnored(provided)) return;
  throw new Error(
    `Statement "${statement}": \`ignored()\` on \`${field}\` cannot be stored — the skip flag ` +
      `lives on an \`input[]\` entry, and this field is written into \`context\`, which has no ` +
      `slot for it. It would be silently dropped and the value bound anyway. Drop the ` +
      `\`ignored()\` wrapper, or omit the field.`,
  );
}

function inputEntry(name: string, v: Value, full: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...leanInput(name, v) };
  const ignore = isIgnored(v);
  if (full) {
    entry.ignore = ignore;
    entry.expand = false;
    entry.children = [];
  } else if (ignore) {
    entry.ignore = true;
  }
  return entry;
}

/** The name a spec's errors use: its `s.` factory path, or the bare stored name without one. */
export function specLabel(spec: StatementSpec): string {
  return spec.factory ?? readableStatementName(spec.name);
}

/** The step annotations every spec-driven statement reads besides its own fields. */
const SPEC_ENVELOPE_KEYS = ["disabled", "description", "mock", "asFilters", "uncheckedAs", "output"] as const;

/** Encode authored inputs into a `Statement` using a spec's field rules. */
export function encodeFromSpec(spec: StatementSpec, authored: Authored): Statement {
  // A statement whose arguments are ALL required generates no `= {}` default,
  // so an untyped JavaScript caller reaches here with nothing. Reading a field
  // off that is a TypeError naming whichever rule the loop happens to hit first
  // -- `s.lambda()` blamed `code`, `s.api.request()` blamed `certificate`, and
  // neither told the author what to add. Treat it as the empty object it means,
  // and the required-field throw below names the field the way it already does
  // for `s.lambda({})`. Ahead of the lambda passes: both read `authored`, so a
  // guard placed after them just relocates the TypeError.
  authored ??= {} as Authored;
  const label = specLabel(spec);
  // Only the declared fields and the step annotations are read; anything else
  // reached through `any` would be dropped on emit without a word.
  assertKnownKeys(`Statement "${label}"`, authored, [...spec.rules.map((r) => r.field), ...SPEC_ENVELOPE_KEYS]);
  // A statement carrying a JavaScript body resolves an INLINE body against its
  // own surface — the call site knows which one — and then gets that body
  // checked against the bindings the surface actually injects, before it can
  // reach a live request. Both are no-ops for every other
  // statement.
  authored = coerceLambdaFields(spec.name, authored as Record<string, unknown>) as Authored;
  assertLambdaStatement(spec.name, authored as Record<string, unknown>);
  const env = spec.envelope;
  const context: Record<string, unknown> = {};
  const input: Record<string, unknown>[] = [];
  let as: string | undefined;

  for (const rule of spec.rules) {
    let provided = authored[rule.field];
    // `null` reaches here only through `any` or untyped JavaScript — no field
    // is typed nullable. On a required field it is the missing argument it
    // means; on an optional one it is a mistake the value check below names.
    // Either way it never reaches `valueFields`, which read `.value` off it and
    // reported a bare `Cannot read properties of null`.
    if (provided === null) {
      if (!rule.optional && rule.default === undefined) {
        throw new Error(`Statement "${label}": required argument "${rule.field}" is missing (got null).`);
      }
      // An optional plain field (a name, a flag) left `null` means "unset".
      if (rule.route.kind === "context-plain" || rule.route.kind === "as") continue;
      // On a field the SDK fills when omitted, `null` is the one way to say
      // "no key at all" — the stored form of statements saved before the fill,
      // which a pull has to reproduce byte-for-byte. Typed `| null` on exactly
      // these fields by the factory generator.
      if (rule.emptyWhenAbsent) continue;
      throw new Error(
        `Statement "${label}": argument "${rule.field}" is null — pass ${
          rule.route.kind === "context-compare"
            ? "a condition (`expr(…)`, `and(…)`, …)"
            : "a value (`c.*`, `ref()`, `inp()`, …)"
        } or leave it out.`,
      );
    }
    if (provided === undefined) {
      if (rule.emptyWhenAbsent) {
        provided = { value: "", tag: "const", filters: [] };
      } else if (rule.default !== undefined && rule.type === "string") {
        provided = rule.default;
      } else if (rule.optional || rule.default !== undefined) {
        // Optional, or a value-field with a default we can't synthesize → omit.
        continue;
      } else {
        throw new Error(`Statement "${label}": required argument "${rule.field}" is missing.`);
      }
    }
    switch (rule.route.kind) {
      case "as":
        as = provided as string;
        break;
      case "context-plain":
        assertIgnorable(label, rule.field, provided);
        setPath(context, rule.route.path, provided);
        break;
      case "context-spread":
        assertIgnorable(label, rule.field, provided);
        assertValueArg(label, rule.field, provided);
        Object.assign(context, valueFields(provided as Value));
        break;
      case "context-nest":
        assertIgnorable(label, rule.field, provided);
        if (typeof provided !== "string") assertValueArg(label, rule.field, provided);
        // A bare string is written bare. The engine keeps whichever spelling it
        // is given (live-verified on `precondition.error`, where the editor
        // writes a plain string and the schema declares a value), so both are
        // authorable and a pulled workspace can reproduce what it stored.
        setPath(
          context,
          rule.route.path,
          typeof provided === "string" ? provided : nestedValueFields(provided as Value),
        );
        break;
      case "context-compare":
        if (provided === null || typeof provided !== "object") {
          throw new Error(
            `Statement "${label}": argument "${rule.field}" must be a condition (\`expr(…)\`, \`and(…)\`, …) — got ${describeEntry(provided)}.`,
          );
        }
        setPath(
          context,
          rule.route.path,
          // Every statement carrying a `comparison` rule (`precondition`, the
          // `array.*` predicates) has its condition evaluated by the runtime,
          // so the operator set is the runtime one.
          encodeRuntimeCondition(provided as Condition, `${label} "${rule.field}"`),
        );
        break;
      case "input": {
        // An enum-constrained field takes the bare-literal shorthand and is
        // checked when the authored value is statically decidable; every other
        // field passes straight through. See ./enum-guard.ts.
        const value = rule.enum
          ? resolveEnumValue(label, rule.field, rule.enum, provided)
          : (provided as Value);
        assertValueArg(label, rule.field, value);
        input.push(inputEntry(rule.route.name, value, env?.inputFull ?? false));
        break;
      }
    }
  }

  const stmt: Statement = { name: spec.name, context, input };
  if (as !== undefined) stmt.as = as;
  else if (env?.emitAs) stmt.as = "";
  // The envelope profile decides whether a description is emitted at its empty
  // DEFAULT (a byte detail pinned from each statement's golden); an AUTHORED one
  // is honoured on every statement, profile or not, because `encodeStatement`
  // writes the member unconditionally. `annotate` applies `disabled` the same way.
  if (env?.description) stmt.description = "";
  const authoredOut = authored.output as OutputAuthored | undefined;
  const asFilters = authored.asFilters as FilterXdo[] | undefined;
  // Two spellings of one concept. `asFilters` is the documented surface and the
  // reserved `output` key is the escape hatch; authoring both invites them to
  // disagree, and silently picking a winner is how a filter chain goes missing.
  if (asFilters?.length && authoredOut?.filters !== undefined) {
    throw new Error(
      `Statement "${label}": \`asFilters\` and \`output.filters\` both set the same ` +
        "filter chain. Keep `asFilters` and drop `output.filters`.",
    );
  }
  annotate(stmt, {
    // Passed as authored: `annotate` refuses a non-boolean / non-string, where
    // dropping it here stored a step the author thought was disabled as live.
    disabled: authored.disabled as boolean | undefined,
    description: authored.description as string | undefined,
    asFilters,
    mock: authored.mock as MockMap | undefined,
    uncheckedAs: authored.uncheckedAs as boolean | undefined,
  });
  if (env?.settingsRegistry) stmt.settings_registry = [];
  if (spec.output) {
    const base = env?.richOutput ? { customize: false, filters: [], items: [] } : { filters: [] };
    // Reserved envelope key: authored output shaping merged over the default —
    // and over whatever `annotate` already wrote, so an `asFilters` chain on a
    // spec that also declares `output` is not overwritten by the empty default.
    const fromAnnotate = (stmt.output ?? {}) as Record<string, unknown>;
    stmt.output = { ...base, ...fromAnnotate, ...(authoredOut ? pickDefined(authoredOut) : {}) };
  }
  if (env?.addon) stmt.addon = [];
  return stmt;
}

/** Register a spec on the statement registry; returns its factory. */
export function registerSpec(spec: StatementSpec): (authored: Authored) => Statement {
  const factory = (authored: Authored): Statement => encodeFromSpec(spec, authored);
  registerStatement(spec.name, factory, spec.factory);
  return factory;
}
