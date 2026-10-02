/**
 * Spec-inverse statement decoder — the 155 declarative statements.
 *
 * `encodeFromSpec` routes each authored field into the stored statement through
 * one of six route kinds, and every one of them is mechanically readable back.
 * This inverts them, then **proves the result before emitting it**: the recovered
 * record is passed to the very `s.<sPath>` function the generated source will
 * call, re-encoded, and compared against the stored statement. Only an exact
 * match is emitted.
 *
 * Proving through the real `s` leaf rather than through `encodeFromSpec` is what
 * makes this safe without a maintained exclusion list. Four surfaces
 * (`api.request`, `api.stream`, `webflow.request`, `microservice.request`) have
 * hand-authored factories that shadow their generated ones with a different
 * argument shape; calling those with a spec-shaped record simply fails to
 * reproduce the bytes, so they fall through to the next dispatch arm instead of
 * being silently mis-emitted. The same is true of any future override.
 *
 * It also subsumes the total-coverage gate: a stored key no rule accounts for
 * cannot survive a byte comparison, so "every stored key was consumed" is
 * checked as a consequence rather than as a separate heuristic — and unlike a
 * key-coverage check, this also catches a *value* decoded to a near-miss.
 */
import type { StackItemXdo, TaggedValue } from "../types/xdo.js";
import { GENERATED_SPECS } from "../statements/generated/specs.generated.js";
import { specLabel, type FieldRule, type StatementSpec } from "../statements/schema-dsl/interpret.js";
import { STATEMENT_SURFACES, sPathOf } from "../statements/surfaces.js";
import { s } from "../statements/s.js";
import { encodeStatement, type Statement } from "../statements/statement.js";
import { filledContext, normalize } from "../validate/normalize.js";
import { ignored as ignoredValue } from "../values/ignored.js";
import { SDK_MODULE, type DecodeContext } from "./context.js";
import { call, lit, obj, spread, type Expr } from "./print.js";
import { deepEqual } from "./field.js";
import { applyUnauthoredEnvelope, envelopePassthrough } from "./envelope-passthrough.js";
import { declineHere, recordProveAbort, recordProveDecline } from "./prove-diff.js";
import { decodeCondition } from "./expression.js";
import { decodeValue } from "./value.js";

/**
 * Statement fields whose value is a regex PATTERN rather than ordinary text,
 * keyed `<stored name>|<field>`.
 *
 * `s.expect.to_match`'s `value` is handed straight to PHP `preg_*`, so the
 * readable spelling is `c.regex("…")` and a `c.text("…")` there is a live bug.
 * The filter-chain half of the same reading is inferred
 * from the chain (`REGEX_PATTERN_FILTERS` in `codegen/value.ts`); a statement
 * field carries no such signal, so it is named here.
 */
const REGEX_PATTERN_SLOTS: ReadonlySet<string> = new Set(["mvp:test_expect_to_match|value"]);

/** Specs by stored name. */
export const SPECS_BY_NAME: ReadonlyMap<string, StatementSpec> = new Map(
  GENERATED_SPECS.map((spec) => [spec.name, spec]),
);

/**
 * Stored name → the public `s.` paths that reach it, sorted for determinism.
 * Two names map to more than one path: `mvp:get_input` (harmless aliases of one
 * factory) and `mvp:function` (genuinely distinct factories). Both are handled
 * by trying each candidate and keeping the one that proves.
 */
const SPATHS_BY_NAME: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [surface, storedName] of STATEMENT_SURFACES) {
    const paths = out.get(storedName) ?? [];
    paths.push(sPathOf(surface));
    out.set(storedName, paths);
  }
  for (const paths of out.values()) paths.sort();
  return out;
})();

/** Resolve a dotted `s.` path to its callable leaf. */
function leafOf(path: string): ((authored: Record<string, unknown>) => Statement) | null {
  const leaf = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined
          ? undefined
          : (node as Record<string, unknown>)[key],
      s,
    );
  return typeof leaf === "function"
    ? (leaf as (authored: Record<string, unknown>) => Statement)
    : null;
}

/** Read a dotted path out of a stored object. */
function getPath(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined
          ? undefined
          : (node as Record<string, unknown>)[key],
      root,
    );
}

/** Coerce a stored `{value, tag, filters?}` block to a full tagged value. */
function toTaggedValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** One recovered authored field: its runtime value and its source form. */
interface Recovered {
  readonly field: string;
  readonly runtime: unknown;
  readonly expr: Expr;
  /** True when the stored value equals the rule's declared default. */
  readonly isDefault: boolean;
}

/** Recover one rule's authored field from the stored statement, or null. */
function recoverRule(
  ctx: DecodeContext,
  rule: FieldRule,
  stored: StackItemXdo,
): Recovered | null {
  const context = (stored.context ?? {}) as Record<string, unknown>;
  // Declared-pattern slots decode to `c.regex(...)` — see {@link REGEX_PATTERN_SLOTS}.
  const valueOpts = { regexPattern: REGEX_PATTERN_SLOTS.has(`${stored.name}|${rule.field}`) };

  switch (rule.route.kind) {
    case "as": {
      const as = (stored as { as?: unknown }).as;
      if (typeof as !== "string" || as === "") return null;
      return { field: rule.field, runtime: as, expr: lit(as), isDefault: false };
    }
    case "context-plain": {
      const raw = getPath(context, rule.route.path);
      if (raw === undefined) return null;
      return {
        field: rule.field,
        runtime: raw,
        expr: lit(raw),
        isDefault: rule.default !== undefined && raw === rule.default,
      };
    }
    case "context-spread": {
      // The spread writes `{value, tag, filters}` onto `context` itself, so the
      // sibling `context-plain` keys sit alongside it — read the three by name
      // rather than assuming the spread owns the object.
      //
      // An EMPTY context is the members the engine's optional-schema pass fills
      // in, at this statement's declared default tag — one stored spelling of
      // the blank value, not an unreadable statement. 22 statements in the
      // survey corpus stored it, one each, and every one of them fell back to
      // `raw()` on the same required-field guard (see {@link filledContext}).
      const value = toTaggedValue(context) ?? toTaggedValue(filledContext(stored));
      if (!value) return null;
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value, valueOpts), isDefault: false };
    }
    case "context-nest": {
      const stored_ = getPath(context, rule.route.path);
      // The engine keeps whichever spelling it is given here: a tagged value, or
      // the bare string the editor writes (live-verified on `precondition.error`,
      // where real workspaces store `error: "Access Denied."` while the schema
      // declares a value). Both are authorable, so both decode.
      if (typeof stored_ === "string") {
        return { field: rule.field, runtime: stored_, expr: lit(stored_), isDefault: false };
      }
      // A field the encoder fills when omitted has THREE stored states: a value,
      // the empty filler (read back as omitted, below), and no key at all — what
      // a statement saved before the fill carries. Omitting it would re-encode
      // the filler, so absence is authored as the explicit `null` that writes
      // no key.
      if (stored_ === undefined && rule.emptyWhenAbsent === true) {
        return { field: rule.field, runtime: null, expr: lit(null), isDefault: false };
      }
      const value = toTaggedValue(stored_);
      if (!value) return null;
      // A field the encoder fills when omitted reads back as omitted when it
      // holds exactly that filler — the proof below re-encodes to confirm.
      const isDefault =
        rule.emptyWhenAbsent === true &&
        value.tag === "const" &&
        value.value === "" &&
        (value.filters ?? []).length === 0;
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value, valueOpts), isDefault };
    }
    case "input": {
      const entries = Array.isArray(stored.input) ? stored.input : [];
      const entry = entries.find(
        (candidate) => (candidate as { name?: unknown })?.name === (rule.route as { name: string }).name,
      );
      const value = toTaggedValue(entry);
      if (!value) return null;
      // A stored `ignore: true` entry is skipped by the engine but keeps its
      // value. Wrapping it re-encodes the flag; without this the binding came
      // back as an ordinary one and the statement degraded to `raw()`.
      if ((entry as { ignore?: unknown })?.ignore === true) {
        ctx.use(SDK_MODULE, "ignored");
        return {
          field: rule.field,
          runtime: ignoredValue(value),
          expr: call("ignored", decodeValue(ctx, value, valueOpts)),
          isDefault: false,
        };
      }
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value, valueOpts), isDefault: false };
    }
    case "context-compare": {
      // The same `{expression: […]}` boolean tree conditionals and db searches
      // use, so it inverts through the shared algebra rather than one of its own.
      // This is what makes the predicate-taking statements (`array.find`,
      // `array.filter`, `array.every`, …) readable instead of raw.
      // Every `comparison` rule sits on a runtime-evaluated surface
      // (`precondition`, the `array.*` predicates), so the narrower operator set
      // applies — matching what the encoder accepts.
      const condition = decodeCondition(ctx, getPath(context, rule.route.path), {
        runtimeSurface: true,
      });
      if (!condition) return null;
      return {
        field: rule.field,
        runtime: condition.runtime,
        expr: condition.expr,
        isDefault: false,
      };
    }
  }
}

/**
 * Whether a stored `output` envelope shapes nothing.
 *
 * There is no single spelling of "shapes nothing". The corpus holds
 * `{items: [], filters: []}` 4,900 times, a bare `null` 518 times, `{filters: []}`
 * 146 times, and `{}` besides — the engine writes whichever its generation and
 * the statement's own envelope produce.
 *
 * Comparing against the one spelling a spec would emit let the others through as
 * an authored value, and `null` is not assignable to `OutputAuthored` — so the
 * generated statement did not compile. `normalize` already collapses all four to
 * nothing, and it is the oracle the round trip is judged against, so asking it
 * makes the elision provably safe rather than merely plausible.
 */
function shapesNothing(output: unknown): boolean {
  return deepEqual(normalize({ output }), {});
}

/**
 * Build the reserved envelope entries (`description`, `output`) a spec allows.
 *
 * `carriesAsFilters` says the passthrough is already recovering the stored
 * `output.filters` as an `asFilters` argument. The two spellings are mutually
 * exclusive by construction — the authoring surface throws when both are set —
 * so the filters are dropped from the `output` literal here rather than emitted
 * twice into source that would refuse to build. What remains of `output` (a
 * column selection, a `customize` flag) still rides as a literal, and an
 * `output` left with nothing but the filters is dropped entirely.
 */
function envelopeEntries(
  spec: StatementSpec,
  stored: StackItemXdo,
  carriesAsFilters: boolean,
): Recovered[] {
  const out: Recovered[] = [];
  const description = (stored as { description?: unknown }).description;
  if (spec.envelope?.description && typeof description === "string" && description !== "") {
    out.push({ field: "description", runtime: description, expr: lit(description), isDefault: false });
  }
  let storedOutput = (stored as { output?: unknown }).output;
  if (carriesAsFilters && storedOutput !== null && typeof storedOutput === "object") {
    const rest = { ...(storedOutput as Record<string, unknown>) };
    delete rest.filters;
    storedOutput = rest;
  }
  if (spec.output && storedOutput !== undefined && !shapesNothing(storedOutput)) {
    out.push({ field: "output", runtime: storedOutput, expr: lit(storedOutput), isDefault: false });
  }
  return out;
}

/**
 * Whether the stored statement carries anything at `rule`'s route.
 *
 * Deliberately shallow: it answers "is there a value at this address", not "can
 * it be read back", which is the question `recoverRule` already answered with
 * no. Only the `input` route is inspected because that is the one whose absence
 * is ambiguous — a stored input list either names the field or does not.
 */
function storedCarries(stored: StackItemXdo, rule: FieldRule): boolean {
  if (rule.route.kind !== "input") return false;
  const entries = (stored as { input?: unknown }).input;
  if (!Array.isArray(entries)) return false;
  const name = rule.route.name;
  return entries.some((entry) => (entry as { name?: unknown } | null)?.name === name);
}

/** Statement equality under the round-trip contract's comparator. *//** Statement equality under the round-trip contract's comparator. */
function sameStatement(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/**
 * Decode a stored statement through its declarative spec.
 *
 * Returns null when no spec applies, a rule cannot be read back, or the
 * recovered record does not re-encode to the stored bytes — in every case the
 * caller falls through to the next dispatch arm.
 */
export function decodeFromSpec(ctx: DecodeContext, stored: StackItemXdo): Expr | null {
  const spec = SPECS_BY_NAME.get(stored.name);
  if (!spec) return null;

  const recovered: Recovered[] = [];
  for (const rule of spec.rules) {
    const field = recoverRule(ctx, rule, stored);
    if (field !== null) recovered.push(field);
    else if (!rule.optional && rule.default === undefined) {
      // A required field that is not present cannot be re-authored; emitting the
      // call anyway would produce source that throws at compile time.
      //
      // WHICH of the cases it is decides who fixes it, so the message names it.
      // A CLASS_REQUIRED field means the spec is stricter than upstream ON
      // PURPOSE, and the right response is to leave both the override and this
      // fallback alone. "The engine did not store this" means the spec is
      // over-strict about a field the engine treats as optional — an upstream
      // schema correction. "It is stored but nothing reads it back" means the
      // inverse route is missing — ours. The two look identical from here
      // without checking whether the stored statement carries the field at all.
      return declineHere(
        storedCarries(stored, rule)
          ? `spec: "${rule.field}" IS stored, but nothing reads it back from its ` +
              `${rule.route.kind} route — the inverse route is missing`
          : `spec: "${rule.field}" is required and the stored statement does not carry it, ` +
              `so there is nothing to recover. The statement is kept verbatim and re-exports ` +
              `byte-for-byte; nothing is lost. It cannot be re-authored as a typed call ` +
              `because the engine has no default for "${rule.field}" — supply one to author ` +
              `this statement fresh.`,
      );
    }
  }
  // A field the engine reads unconditionally, stored with no key: the statement
  // answers `Missing param` on every request. It decodes to the `null` that
  // reproduces it, and the pull says so rather than carrying it silently.
  const absent = recovered.filter(
    (entry) => entry.runtime === null && spec.rules.some((r) => r.field === entry.field && r.emptyWhenAbsent),
  );
  if (absent.length > 0) {
    const list = absent.map((entry) => `\`${entry.field}\``).join(" and ");
    ctx.problem(
      "workspace-defect",
      `\`${specLabel(spec)}\` is stored with no ${list} key, which the engine rejects at run time ` +
        `(\`Missing param: ${absent[0]!.field}\`). Decoded as \`${absent[0]!.field}: null\` so it re-exports ` +
        `byte-for-byte; omit the field to send an empty password, or pass a value.`,
      "zip password",
    );
  }
  // Read the passthrough before the envelope entries: whether it recovered the
  // stored `output.filters` as an `asFilters` argument decides whether those
  // same filters may also ride inside the `output` literal.
  const passthroughForOutput = envelopePassthrough(stored, ctx);
  recovered.push(
    ...envelopeEntries(spec, stored, passthroughForOutput.annotations.asFilters !== undefined),
  );

  // Leanest first: a field sitting at its rule default reads as noise, and the
  // proof below is what licenses dropping it.
  const candidates: Recovered[][] = [];
  const lean = recovered.filter((entry) => !entry.isDefault);
  if (lean.length < recovered.length) candidates.push(lean);
  candidates.push(recovered);

  // `disabled` and `description` annotate the stack item; every generated factory
  // takes both as members of the args object it already receives, so they join
  // that object rather than being patched onto the result and spread over the
  // call — otherwise an annotated `precondition`, `send_email`, `setheader`, or
  // `template_string` would degrade to a spread purely for carrying a comment.
  const passthrough = passthroughForOutput;

  for (const sPath of SPATHS_BY_NAME.get(stored.name) ?? []) {
    const factory = leafOf(sPath);
    if (!factory) continue;
    for (const candidate of candidates) {
      const authored: Record<string, unknown> = {};
      for (const entry of candidate) authored[entry.field] = entry.runtime;

      let encoded: StackItemXdo;
      let entries: ReadonlyArray<readonly [string, Expr]>;
      try {
        const applied = applyUnauthoredEnvelope(
          factory({ ...authored, ...passthrough.annotations }),
          passthrough,
        );
        entries = applied.entries;
        encoded = encodeStatement(applied.statement);
      } catch (error) {
        recordProveAbort(`spec:${sPath}`, stored.name, `factory threw: ${String(error)}`);
        // The authoring surface rejected the recovered arguments, and its message
        // names the exact conflict for a human — carried through to the fallback
        // report exactly as the special arm does it.
        ctx.declined(
          `the recovered arguments were rejected by the authoring surface — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (!sameStatement(encoded, stored)) {
        recordProveDecline(`spec:${sPath}`, stored.name, normalize(encoded), normalize(stored));
        continue;
      }

      ctx.use(SDK_MODULE, "s");
      // A recovered `asFilters` chain emits `fl.*` calls. Registered only on the
      // winning candidate, so a declined attempt cannot leave an unused import.
      for (const symbol of passthrough.symbols) ctx.use(SDK_MODULE, symbol);
      // A spec whose envelope profile permits a `description` recovers it as an
      // ordinary field, and the passthrough carries the SAME stored key — so both
      // would print, and an object literal with two `description:` members is
      // legal JavaScript that nothing downstream complains about. The round trip
      // cannot see it either: the runtime merge above is `{...authored,
      // ...annotations}`, where the duplicate collapses. So the earlier cell is
      // dropped here, matching that merge's precedence exactly.
      const annotated = new Set(passthrough.entries.map(([field]) => field));
      const cells: Array<readonly [string, Expr]> = [
        ...candidate.filter((e) => !annotated.has(e.field)).map((e) => [e.field, e.expr] as const),
        ...passthrough.entries,
      ];
      const args = cells.length > 0 ? [obj(cells)] : [];
      const expression = call(`s.${sPath}`, ...args);
      return entries.length > 0 ? spread(expression, entries) : expression;
    }
  }
  return null;
}
