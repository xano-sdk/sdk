/**
 * Statement dispatch.
 *
 * The order is `registered special decoder → spec-inverse from GENERATED_SPECS →
 * raw()`. Specials come first because several families have hand-written
 * encoders whose stored shape a naive spec inversion would mangle.
 *
 * Every arm is proof-carrying: a decoder returns a source expression only when
 * that expression demonstrably re-encodes to the stored statement, so falling
 * through costs readability and never fidelity. `raw()` is the terminal arm and
 * is exact by construction, which is why the round trip stays green no matter
 * how much of the catalog is modelled.
 */
import type { StackItemXdo } from "../types/xdo.js";
import type { Statement } from "../statements/statement.js";
import { raw } from "../statements/special/raw.js";
import { STATEMENT_SURFACES } from "../statements/surfaces.js";
import { SUPERSEDED_STATEMENTS, supersededBy } from "../statements/superseded.js";
import { DECODE_ONLY_STATEMENTS } from "../statements/decode-only.js";
import { collectLambdaBodyProblems } from "../values/lambda.js";
import { retiredInputs, retiredInputSuccessor } from "../validate/normalize.js";
import { CODEGEN_MODULE, type DecodeContext } from "./context.js";
import { arr, call, lit, type Expr } from "./print.js";
import type { RefIndex, ResolveOptions } from "./ref-index.js";
import { decodeFromSpec, SPECS_BY_NAME } from "./spec-inverse.js";
import { SPECIAL_DECODERS } from "./specials/index.js";
import { withDeclineContext } from "./prove-diff.js";
import { hasUnreadableInput } from "../validate/normalize.js";

/** Decode one stored statement to a source expression. */
export function decodeStatement(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: StackItemXdo,
  resolve: ResolveOptions = {},
): Expr {
  // Discarding stored bytes is never silent, even when the discard is provably
  // safe. This one is: the statement's `input[]` cannot reach the engine (see
  // {@link hasUnreadableInput}), so it is dropped rather than carried — but a
  // reader comparing the tree against the workspace should be told, not left to
  // notice the entries are gone.
  const droppedInput = (stored as { input?: unknown }).input;
  if (hasUnreadableInput(stored.name) && Array.isArray(droppedInput) && droppedInput.length > 0) {
    ctx.problem(
      "expected-omission",
      `${stored.name} carries ${droppedInput.length} stored \`input[]\` ` +
        `${droppedInput.length === 1 ? "entry" : "entries"}, which this statement has no way to ` +
        "read — it declares no input schema, the engine hands it none, and its editor panel " +
        "offers no control that could set one. Not carried into the tree",
    );
  }
  // Guards inside the arms below report against this name (see `declineHere`).
  //
  // Lambda bodies are the one authoring guard suspended here. On this path the
  // author is not authoring — they are reading back a body that is already live
  // in the workspace — so a body the guard would refuse is a DEFECT IN THE
  // WORKSPACE, not a statement this SDK cannot model. Refusing it dropped the
  // statement to `raw()`, which hid the defect in a list of decoder limitations
  // and cost the pull its typed form. The guard keeps firing at
  // author time, which is the only place it can be acted on.
  const decoded = withDeclineContext(stored.name, () =>
    collectLambdaBodyProblems(
      (problem) =>
        ctx.problem(
          "workspace-defect",
          `this workspace stores a lambda whose body cannot work as written: ${problem}`,
          "lambda body",
        ),
      () => dispatch(ctx, refs, stored, resolve),
    ),
  );

  // An input the statement no longer declares. `normalize` drops it on both
  // sides so the statement can decode at all, and this is the other half of that
  // bargain: a dropped byte is never a silent one. The entry is dead — the
  // engine removed the field and the branch that read it — but a reader diffing
  // a pulled-then-deployed workspace against the original should be told, not
  // left to notice it went.
  //
  // Reported AFTER the dispatch, and only when the statement decoded to its
  // typed form. A `raw()` fallback carries the stored item verbatim, retired
  // entry included, so on that path the claim below would be the opposite of
  // what happens.
  if (!isRawFallback(decoded)) {
    const retired = retiredInputs(stored.name);
    const carried = Array.isArray(droppedInput)
      ? droppedInput.filter((e) => retired.includes(String((e as { name?: unknown })?.name ?? "")))
      : [];
    if (carried.length > 0) {
      // Each dropped name carries its OWN successor — a statement may retire
      // more than one input, and they need not have been replaced by the same
      // field.
      const named = carried.map((e) => {
        const input = String((e as { name?: unknown }).name ?? "");
        const successor = retiredInputSuccessor(stored.name, input);
        return successor ? `\`${input}\` (replaced by \`${successor}\`)` : `\`${input}\``;
      });
      ctx.problem(
        "expected-omission",
        `${stored.name} carries a stored ${named.join(", ")} input, which this statement no longer ` +
          `declares — the engine removed it. Nothing reads the stored entry, so it is not carried ` +
          `into the tree, and a deploy from this tree will not write it back`,
      );
    }
  }

  // A `name` stored beside a db statement's table binding `id`. The statement
  // reads `dbo.id` alone, so `normalize` drops the member on both sides; the
  // typed form does not write it back, and the pull says so.
  const dboName = (stored.context as { dbo?: { name?: unknown } } | null | undefined)?.dbo?.name;
  if (!isRawFallback(decoded) && stored.name.startsWith("mvp:dbo_") && dboName !== undefined) {
    ctx.problem(
      "expected-omission",
      `${stored.name} stores a \`name\` (${JSON.stringify(dboName)}) beside its table binding's id. The ` +
        "statement resolves its table by id and nothing reads the name, so it is not carried into the " +
        "tree, and a deploy from this tree will not write it back",
    );
  }

  return decoded;
}

/** Whether a decode result is the verbatim `raw(...)` carrier rather than a typed form. */
function isRawFallback(expr: Expr): boolean {
  return expr.kind === "call" && expr.callee === "raw";
}

/** The dispatch proper: special decoder → spec inverse → `raw()`. */
function dispatch(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: StackItemXdo,
  resolve: ResolveOptions,
): Expr {
  // A RETIRED version of a versioned family. Not attempted, because there is
  // nothing to attempt: this SDK deliberately models only the latest of each
  // family, so the earlier spellings have no authoring surface to decode to.
  // `raw()` carries them byte-exact and the report names the replacement, which
  // is the useful thing to tell whoever pulled the workspace.
  if (SUPERSEDED_STATEMENTS.has(stored.name)) {
    const replacement = supersededBy(stored.name, (n) =>
      STATEMENT_SURFACES.find(([, name]) => name === n)?.[0],
    );
    ctx.problem(
      "superseded",
      replacement === null
        ? `${stored.name} is a retired statement with no replacement; carried verbatim via raw()`
        : `${stored.name} is a superseded version — the platform offers \`${replacement}\` now, ` +
          "and the two are not interchangeable (each version was a breaking change). " +
          "Carried verbatim via raw(), so it keeps running exactly as stored",
    );
    ctx.use(CODEGEN_MODULE, "raw");
    return call("raw", lit(stored));
  }

  // A statement the engine WRITES but will not read back. It has no authoring
  // surface to decode to, and inventing one would hand back source that cannot
  // deploy. `raw()` keeps the bytes exact and the report says what it is and
  // what to do about it — the author has to replace it, and needs to know that
  // before they try to push.
  const decodeOnly = DECODE_ONLY_STATEMENTS.get(stored.name);
  if (decodeOnly !== undefined) {
    ctx.problem(
      "decode-only",
      `${stored.name} is ${decodeOnly}. Carried verbatim via raw() so nothing is lost, but ` +
        `\`export()\` refuses a bundle that still contains one.`,
    );
    ctx.use(CODEGEN_MODULE, "raw");
    return call("raw", lit(stored));
  }

  const special = SPECIAL_DECODERS.get(stored.name);
  if (special) {
    const decoded = ctx.speculate(() =>
      special({
        ctx,
        refs,
        stored,
        resolve,
        decodeStack: (run) => decodeNested(ctx, refs, run, resolve),
      }),
    );
    if (decoded) {
      ctx.takeDeclineNote();
      return decoded;
    }
  }

  const fromSpec = ctx.speculate(() => decodeFromSpec(ctx, stored));
  if (fromSpec) {
    ctx.takeDeclineNote();
    return fromSpec;
  }

  // "has no decoder" was reported for EVERY fallback, including the ones where a
  // decoder exists and simply declined — 81 of 181 sweep rows said it of
  // `mvp:dbo_view`, `mvp:conditional` and `mvp:set_var`, all of which have had
  // decoders for a long time. Read literally it sends a maintainer to write code
  // that is already there, and it hides the split that matters: a statement
  // nothing models is a COVERAGE gap, while one whose decoder declined is a
  // FIDELITY gap in a decoder that exists.
  const name = (stored as { name?: unknown }).name;
  const label = typeof name === "string" ? name : "(unnamed)";
  const modelled =
    typeof name === "string" && (SPECIAL_DECODERS.has(name) || SPECS_BY_NAME.has(name));
  // A decoder that knew exactly why it could not spell this says so here, rather
  // than leaving "could not reproduce" as the only clue (see `declined`).
  const note = ctx.takeDeclineNote();
  const why = note?.why;
  // A statement that stores NOTHING is not a decoder that failed — there is no
  // SQL, no connection, no arguments, because it was dragged onto a stack and
  // never configured. `raw()` is what an unconfigured stub looks like. The
  // decline carries that verdict, so this line neither infers it from prose nor
  // says "could not reproduce" about a statement with nothing in it to
  // reproduce. Six such rows in the survey corpus read as fidelity gaps.
  if (note?.category === "unconfigured-stub") {
    ctx.problem("unconfigured-stub", `${label} ${why}`);
  } else if (note?.category === "workspace-defect") {
    // Broken where it lives: the decode is faithful, the defect is upstream.
    ctx.problem("workspace-defect", `${label} ${why}. Carried verbatim via raw()`);
  } else {
    ctx.problem(
      "raw-fallback",
      modelled
        ? `${label} is modelled, but its decoder could not reproduce the stored statement` +
          (why ? `: ${why}. Emitted` : "; emitted") +
          " verbatim via raw()"
        : `${label} has no decoder; emitted verbatim via raw()`,
    );
  }
  ctx.use(CODEGEN_MODULE, "raw");
  return call("raw", lit(stored));
}

/**
 * Decode a nested `run[]` for a recursive family.
 *
 * Returns the source expressions *and* the runtime statements side by side: the
 * enclosing decoder needs the latter to prove its own call, and both must
 * describe the same stack. The runtime side rebuilds each child through `raw()`
 * rather than re-deriving it, so proving an outer statement never depends on how
 * well its children decoded — a `raw()` child at depth still lets the loop or
 * conditional around it come out readable.
 */
function decodeNested(
  ctx: DecodeContext,
  refs: RefIndex,
  run: unknown,
  resolve: ResolveOptions,
): { exprs: Expr[]; statements: Statement[] } {
  const items = Array.isArray(run) ? (run as StackItemXdo[]) : [];
  return {
    exprs: items.map((item, i) =>
      ctx.at(`run[${i}]`, () => decodeStatement(ctx, refs, item, resolve)),
    ),
    statements: items.map((item) => raw(item as unknown as Record<string, unknown>)),
  };
}

/** Decode a stored `run[]` stack, tagging report entries with each index. */
export function decodeStack(
  ctx: DecodeContext,
  refs: RefIndex,
  run: unknown,
  resolve: ResolveOptions = {},
): Expr {
  const items = Array.isArray(run) ? (run as StackItemXdo[]) : [];
  return arr(
    items.map((item, i) =>
      ctx.at(`stack[${i}]`, () => decodeStatement(ctx, refs, item, resolve)),
    ),
  );
}
