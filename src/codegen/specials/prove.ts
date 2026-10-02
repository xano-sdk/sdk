/**
 * The specials decoders' shared machinery.
 *
 * Every hand-written encoder has a hand-written inverse here, and each one is
 * held to the same contract as the spec arm: build a candidate, call the very
 * `s.<path>` factory the generated source will call, re-encode, and compare
 * against the stored statement. A decoder that guesses wrong produces `raw()`
 * output, never wrong output.
 *
 * That is what makes it safe to write these from the stored shape rather than
 * from a specification. The encoders carry non-obvious details — `nestedValueFields`
 * omitting an empty `filters`, an empty `settings_registry` canonicalized to
 * `null` — and getting one subtly wrong is caught here instead of on a user's
 * workspace.
 */
import type { StackItemXdo } from "../../types/xdo.js";
import { s } from "../../statements/s.js";
import { encodeStatement, type Statement } from "../../statements/statement.js";
import { normalize } from "../../validate/normalize.js";
import { SDK_MODULE, type DecodeContext } from "../context.js";
import { call, spread, type Expr } from "../print.js";
import { deepEqual } from "../field.js";
import {
  annotationCandidates,
  applyUnauthoredEnvelope,
  envelopePassthrough,
} from "../envelope-passthrough.js";
import { declineHere, recordProveAbort, recordProveDecline } from "../prove-diff.js";
import type { RefIndex, ResolveOptions } from "../ref-index.js";

/** What a special decoder is handed. */
export interface SpecialArgs {
  readonly ctx: DecodeContext;
  readonly refs: RefIndex;
  readonly stored: StackItemXdo;
  readonly resolve: ResolveOptions;
  /** Decode a nested `run[]` back through the full dispatch (for recursive families). */
  readonly decodeStack: (run: unknown) => { exprs: Expr[]; statements: Statement[] };
}

/** A decoder for one stored statement name. Returns null to fall through. */
export type SpecialDecoder = (args: SpecialArgs) => Expr | null;

/** Resolve a dotted `s.` path to its callable leaf. */
function leafOf(path: string): ((...args: unknown[]) => Statement) | null {
  const leaf = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined ? undefined : (node as Record<string, unknown>)[key],
      s,
    );
  return typeof leaf === "function" ? (leaf as (...args: unknown[]) => Statement) : null;
}

/**
 * Emit `s.<path>(...)` only if calling it with `runtime` reproduces `stored`.
 *
 * `runtime` and `sourceArgs` are parallel: the former is what the factory is
 * actually called with, the latter is what the generated file will read. They
 * must describe the same call — which is exactly what the comparison verifies,
 * because the source is evaluated back through the same factory in tests.
 */
export function prove(
  ctx: DecodeContext,
  stored: StackItemXdo,
  path: string,
  runtime: readonly unknown[],
  sourceArgs: readonly Expr[],
): Expr | null {
  const factory = leafOf(path);
  if (!factory) return declineHere(`${path}: no such factory on \`s\``);

  // `description`/`disabled` are arguments to every factory now, so they are
  // passed IN rather than patched on afterwards — each candidate below is a way
  // of passing them, and only one that reproduces the stored bytes is emitted.
  const passthrough = envelopePassthrough(stored, ctx);
  const candidates = annotationCandidates(
    runtime,
    sourceArgs,
    passthrough.annotations,
    passthrough.entries,
  );

  let lastError: unknown;
  let lastEncoded: StackItemXdo | undefined;
  for (const candidate of candidates) {
    let encoded: StackItemXdo;
    let entries: ReadonlyArray<readonly [string, Expr]>;
    try {
      const applied = applyUnauthoredEnvelope(factory(...candidate.runtime), passthrough);
      entries = applied.entries;
      encoded = encodeStatement(applied.statement);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!deepEqual(normalize(encoded), normalize(stored))) {
      lastEncoded = encoded;
      continue;
    }
    ctx.use(SDK_MODULE, "s");
    // A recovered `asFilters` chain emits `fl.*` calls; register the symbol only
    // on the candidate that actually won, so a declined attempt cannot add an
    // unused import to the generated file.
    for (const symbol of passthrough.symbols) ctx.use(SDK_MODULE, symbol);
    const expression = call(`s.${path}`, ...candidate.source);
    return entries.length > 0 ? spread(expression, entries) : expression;
  }

  if (lastEncoded === undefined && lastError !== undefined) {
    recordProveAbort("special", stored.name, `factory threw: ${String(lastError)}`);
    // The authoring surface rejected the recovered arguments. That message is
    // written for a human and names the exact conflict, so it beats "could not
    // reproduce" by a wide margin — carried through to the fallback report.
    return ctx.declined(
      `the recovered arguments were rejected by the authoring surface — ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
  if (lastEncoded !== undefined) {
    recordProveDecline("special", stored.name, normalize(lastEncoded), normalize(stored));
  }
  return null;
}

// Re-exported so a decoder imports its guard recorder from the same place it
// imports `prove` — the two are halves of one contract.
export { declineHere } from "../prove-diff.js";

/** Read a dotted path out of a stored object. */
export function getPath(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined ? undefined : (node as Record<string, unknown>)[key],
      root,
    );
}

/**
 * The report line for a blank reference (`table`/`addon`/`fn`/…).
 *
 * A blank reference means the target was deleted, or the binding was never made.
 * There is no second reading: this flow pulls and deploys a WHOLE workspace, so
 * there is no scoped export whose remap could have blanked a reference that
 * still exists upstream. So the line does not hedge between the two or tell the
 * reader to "re-pull with it in scope" — unactionable advice about a situation
 * this SDK cannot produce.
 */
export function blankRefDetail(what: string, noun: string): string {
  return (
    `${what}, recovered as \`${noun}: null\` — the ${noun} was deleted, or the binding was ` +
    "never made. Fix it upstream, or bind one in the generated source."
  );
}
