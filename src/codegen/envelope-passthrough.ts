/**
 * A stored statement's `disabled` / `description`, recovered as factory arguments.
 *
 * Both annotate the stack item rather than argue the statement — `disabled` is the
 * engine's way of leaving a step in place while the run engine skips it, and
 * `description` is the note beside it. Every `s.*` factory accepts them, so a
 * pulled statement carrying either is rebuilt by CALLING its factory with them:
 *
 *   s.set_var("payload", c.expression("…"), { disabled: true })
 *   s.db.add({ table: users, data: [...], description: "why" })
 *
 * Overriding them on the factory's result and spreading over the emitted call
 * (`{...s.set_var(…), disabled: true}`) would be exact, and would round-trip,
 * but it puts an object spread in front of every reader of a generated workspace
 * to express what is an ordinary argument.
 *
 * Which call shape absorbs them is not assumed — {@link annotationCandidates}
 * offers the object-arg form and the trailing-options form, and the caller keeps
 * whichever REPRODUCES THE STORED BYTES. A wrong guess cannot emit wrong source; it
 * fails the same comparison every other decode decision goes through.
 */
import type { FilterXdo, StackItemXdo } from "../types/xdo.js";
import type { Statement } from "../statements/statement.js";
import { hasUnreadableInput } from "../validate/normalize.js";
import { isVarName } from "../statements/args.js";
import { decodeFilterChain, decodeValue } from "./value.js";
import type { DecodeContext } from "./context.js";
import type { Value } from "../values/value.js";
import type { MockMap } from "../values/mock.js";
import { encodeMockMap } from "../values/mock.js";
import { arr, lit, obj, type Expr } from "./print.js";

/** What a stored statement carries beyond its factory's declared arguments. */
export interface EnvelopePassthrough {
  /** `{disabled?, description?, asFilters?}` as a factory argument — empty when all are at their default. */
  readonly annotations: Record<string, unknown>;
  /** The same members as source entries, for whichever call shape wins. */
  readonly entries: ReadonlyArray<readonly [string, Expr]>;
  /** Symbols the entries need from `@xano/sdk` (`fl` for a filter chain). */
  readonly symbols: readonly string[];
  /**
   * The stored `mocks` map, verbatim (keyed by test id).
   *
   * Re-applied to the built statement rather than rebuilt from the authored
   * `mock` argument, because the encode-side name→id rewrite runs at KIND level
   * — a statement encoded on its own always produces NAME-keyed mocks, which
   * would never match the id-keyed bytes this proof compares against.
   */
  readonly storedMocks: Record<string, unknown> | undefined;
  /**
   * Stored `input[]` entries for a statement whose schema declares none.
   *
   * Applied by the caller ONLY when the factory itself produced no input, so it
   * can never mask a real disagreement about entries the statement does declare.
   * `create_image` is the case that motivates it: 26 real statements store an
   * auth binding its declared context schema has no slot for, and a live round
   * trip confirms the engine persists it verbatim — so dropping it would discard
   * a stored binding, which is the one thing this decoder must never do. It has
   * no authoring surface at all, so unlike the annotations it still rides a spread.
   */
  readonly undeclaredInput: readonly unknown[] | undefined;
  /**
   * The stored result binding, when the statement has a non-empty one.
   *
   * `as` is a member of the stack-item envelope, not an argument of a particular
   * statement — every stored item carries it, and the engine binds whatever the
   * statement class returned. Most factories take it as an ordinary argument and
   * their decoders recover it there, which is the readable form and stays the
   * preferred one.
   *
   * This is the floor under that: applied by {@link applyUnauthoredEnvelope}
   * ONLY when the factory produced no binding of its own, so it can never
   * override or mask one a decoder recovered properly. Two statements in the
   * audit corpus reached it (`db_transaction` and `redis.remove`, both since
   * given real arguments), and losing the binding is not cosmetic: every later
   * step reads the variable by that name, so a dropped `as` turns a valid
   * workspace into one whose references resolve to nothing.
   */
  readonly as: string | undefined;
}

/**
 * Read the annotations off a stored statement.
 *
 * Each is included only when it departs from its envelope default (`""` for a
 * description, `false` for disabled) — at the default it is already implicit, and
 * emitting it would add noise the normalizer would then have to elide.
 */
/**
 * One mock back to source: the bare value when it is enabled (the common case),
 * otherwise the `{ value, enabled: false }` form that keeps it switched off.
 */
function mockValue(entry: unknown): Value | null {
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const raw = typeof rec.value === "number" ? String(rec.value) : rec.value;
  if (typeof rec.tag !== "string" || typeof raw !== "string") return null;
  return { tag: rec.tag as Value["tag"], value: raw, filters: (Array.isArray(rec.filters) ? rec.filters : []) as FilterXdo[] };
}

/** The `{ value, enabled: false }` form, for a mock kept but switched off. */
function disabledMock(ctx: DecodeContext, value: Value): Expr {
  return obj([
    ["value", decodeValue(ctx, value)],
    ["enabled", lit(false)],
  ]);
}

/** What the authored map encodes to, with names mapped back to stored ids. */
function idKeyed(authored: MockMap, ctx: DecodeContext): Record<string, unknown> {
  const byName = ctx.testIds();
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(encodeMockMap(authored))) {
    out[byName.get(key) ?? key] = entry;
  }
  return out;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  const rec = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, sortKeys(rec[k])]));
}

export function envelopePassthrough(
  stored: StackItemXdo,
  ctx?: DecodeContext,
): EnvelopePassthrough {
  const annotations: Record<string, unknown> = {};
  const entries: Array<readonly [string, Expr]> = [];
  const symbols: string[] = [];

  const description = (stored as { description?: unknown }).description;
  if (typeof description === "string" && description !== "") {
    annotations.description = description;
    entries.push(["description", lit(description)]);
  }

  const disabled = (stored as { disabled?: unknown }).disabled;
  if (disabled === true) {
    annotations.disabled = true;
    entries.push(["disabled", lit(true)]);
  }

  // The filter chain on the result binding (`… as $x|upper`). It rides the same
  // "offer both call shapes, keep whichever reproduces the bytes" machinery as
  // the annotations above, for the same reason: no factory declares it as an
  // argument, and which slot absorbs it is not knowable from here.
  //
  // Carried only when the statement actually binds a result. A chain stored
  // against no `as` cannot run, and `asFilters` refuses it — re-emitting one
  // would produce source that throws on its own re-encode. Such a statement
  // keeps its `output` block by the ordinary route instead.
  const outputFilters = (stored as { output?: { filters?: unknown } | null }).output?.filters;
  if (stored.as && Array.isArray(outputFilters) && outputFilters.length > 0) {
    const chain = decodeFilterChain(outputFilters as FilterXdo[]);
    annotations.asFilters = outputFilters;
    entries.push(["asFilters", arr(chain.exprs)]);
    symbols.push(...chain.symbols);
  }

  // A binding stored under a name the variable-name rule refuses. The engine
  // binds and reads it by that exact name, so the pull keeps it and says so.
  if (typeof stored.as === "string" && stored.as !== "" && !isVarName(stored.as)) {
    annotations.uncheckedAs = true;
    entries.push(["uncheckedAs", lit(true)]);
  }

  // An `input[]` the engine cannot reach is dropped rather than carried: the
  // normalizer elides it on both sides of the round trip, so spreading it here
  // would put an envelope literal in the generated source to preserve bytes the
  // comparison no longer looks at. Keyed on the normalizer's own list.
  const input = (stored as { input?: unknown }).input;
  const undeclaredInput =
    Array.isArray(input) && input.length > 0 && !hasUnreadableInput(stored.name)
      ? input
      : undefined;

  // Per-test mocks. Written back keyed by test NAME — what the editor shows and
  // what the `mock` option takes. An id with no matching test is an ORPHAN (a
  // mock can outlive the test it was keyed to) and keeps its raw id, which the
  // authoring surface accepts verbatim for exactly this case.
  const storedMocksRaw = (stored as { mocks?: unknown }).mocks;
  const rawMocks =
    storedMocksRaw !== null &&
    typeof storedMocksRaw === "object" &&
    !Array.isArray(storedMocksRaw) &&
    Object.keys(storedMocksRaw).length > 0
      ? (storedMocksRaw as Record<string, unknown>)
      : undefined;
  let storedMocks: Record<string, unknown> | undefined;
  if (rawMocks && ctx) {
    const cells: Array<readonly [string, Expr]> = [];
    const authored: MockMap = {};
    let readable = true;
    for (const [id, entry] of Object.entries(rawMocks)) {
      const value = mockValue(entry);
      if (!value) {
        readable = false;
        break;
      }
      const name = ctx.testName(id);
      if (name === undefined) {
        ctx.problem(
          "value-fallback",
          `a statement mocks test id ${JSON.stringify(id)}, which this object no longer ` +
            `declares — an orphaned mock the engine ignores. Carried by id, since there ` +
            `is no name left to author it by`,
        );
      }
      const key = name ?? id;
      const enabled = (entry as { enabled?: unknown }).enabled !== false;
      authored[key] = enabled ? value : { value, enabled: false };
      cells.push([key, enabled ? decodeValue(ctx, value) : disabledMock(ctx, value)]);
    }
    // Only re-apply the stored map once the AUTHORED form provably reproduces
    // it. `applyUnauthoredEnvelope` copies `storedMocks` onto the built
    // statement before `prove` compares, so setting it unconditionally would
    // exempt the emitted `mock:` argument from the one guarantee this decoder
    // makes — a wrong guess degrades to `raw()`, never to wrong output. A
    // stored entry with no `enabled` key round-trips as `enabled: true`, which
    // is a real byte difference the comparison must be allowed to see.
    if (readable && deepEqualJson(idKeyed(authored, ctx), rawMocks)) {
      storedMocks = rawMocks;
      entries.push(["mock", obj(cells)]);
    }
  }

  const storedAs = (stored as { as?: unknown }).as;
  return {
    annotations,
    entries,
    symbols,
    storedMocks,
    undeclaredInput,
    as: typeof storedAs === "string" && storedAs !== "" ? storedAs : undefined,
  };
}

/** One way of passing the annotations: the arguments to call, and the source to emit. */
export interface AnnotationCandidate {
  readonly runtime: readonly unknown[];
  readonly source: readonly Expr[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The call shapes that could carry `annotations`, most idiomatic first.
 *
 * An object-arg factory takes them as two more members of the object it already
 * receives; a positional one takes a trailing options object. Both are offered
 * whenever the shapes allow, because the discriminator is not knowable from here:
 * a positional factory's last argument is often a plain object too (a `Value` is
 * one), so "the last argument is an object" does not mean "merge into it". The
 * byte comparison decides.
 */
export function annotationCandidates(
  runtime: readonly unknown[],
  sourceArgs: readonly Expr[],
  annotations: Record<string, unknown>,
  entries: ReadonlyArray<readonly [string, Expr]>,
): AnnotationCandidate[] {
  if (entries.length === 0) return [{ runtime, source: sourceArgs }];
  const out: AnnotationCandidate[] = [];

  const lastRuntime = runtime[runtime.length - 1];
  const lastSource = sourceArgs[sourceArgs.length - 1];
  if (
    runtime.length === sourceArgs.length &&
    isPlainObject(lastRuntime) &&
    lastSource?.kind === "object"
  ) {
    // A decoder that already emitted one of these (a `description` a special
    // reads off the same stored key) would otherwise print it twice — legal
    // JavaScript, invisible to the round trip, since the runtime merge below
    // collapses the duplicate. Drop the earlier cell, matching that precedence.
    const annotated = new Set(entries.map(([field]) => field));
    out.push({
      runtime: [...runtime.slice(0, -1), { ...lastRuntime, ...annotations }],
      source: [
        ...sourceArgs.slice(0, -1),
        obj([...lastSource.entries.filter(([field]) => !annotated.has(field)), ...entries]),
      ],
    });
  }

  out.push({ runtime: [...runtime, annotations], source: [...sourceArgs, obj(entries)] });
  return out;
}

/**
 * Add stored envelope members to a built statement where its factory offered no
 * way to author them — the stored `input[]`, and the result binding.
 *
 * Both are applied ONLY when the factory produced nothing of its own for that
 * member, so neither can mask a real disagreement about state the statement does
 * declare. What they cannot ride is a factory argument, so they ride a spread:
 * `{...s.x({…}), as: "var_3"}` is honest about there being no argument for it,
 * and it still re-encodes to the stored bytes, which is what the proof checks.
 *
 * Returns the statement to encode plus the source entries that still have to be
 * spread.
 */
export function applyUnauthoredEnvelope(
  built: Statement,
  passthrough: EnvelopePassthrough,
): { statement: Statement; entries: ReadonlyArray<readonly [string, Expr]> } {
  const entries: Array<readonly [string, Expr]> = [];
  let statement = built;

  const ownInput = (statement as { input?: unknown }).input;
  if (passthrough.undeclaredInput && !(Array.isArray(ownInput) && ownInput.length > 0)) {
    statement = { ...statement, input: [...passthrough.undeclaredInput] };
    entries.push(["input", lit(passthrough.undeclaredInput)] as const);
  }

  if (passthrough.storedMocks) {
    statement = { ...statement, mocks: passthrough.storedMocks };
  }

  if (passthrough.as !== undefined && !statement.as) {
    statement = { ...statement, as: passthrough.as };
    entries.push(["as", lit(passthrough.as)] as const);
  }

  return { statement, entries };
}
