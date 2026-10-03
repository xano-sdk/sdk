/**
 * Why a decoder declined — maintainer instrumentation for `codegen:sweep`.
 *
 * Every non-`raw` decode arm is proof-carrying: it builds a candidate, calls the
 * real `s.<path>` factory, re-encodes, and compares against the stored statement.
 * A candidate that does not reproduce the bytes returns `null` and the statement
 * degrades to `raw()` — exact, but unreadable. The decline itself is silent,
 * which makes a sweep report *that* thousands of statements fell back without
 * ever saying *why*.
 *
 * With `XANOSDK_PROVE_DIFF` set to a file path, each decline appends one JSON
 * line naming the stored statement, the arm that declined, and the key paths
 * where the re-encode disagreed. Clustering those key paths is what turns "85
 * statement types have no decoder" into a handful of shared canonicalization
 * gaps.
 *
 * **A decline is not a fallback.** Every candidate is recorded, including ones a
 * later arm goes on to prove — a name can decline through its spec inverse and
 * still decode fine through a special. Decline counts are therefore an upper
 * bound on `raw-fallback` counts, and reading them as the same number is the
 * first wrong conclusion this data invites. Cross-reference the sweep CSV for
 * what actually fell back.
 *
 * Unset (the default, and always in a user's install) this costs one property
 * read per decline and writes nothing.
 */
import { readPathEnvVar } from "../util/home-path.js";
import { appendFileSync } from "node:fs";

/** Key paths recorded per decline. A pathological statement must not write unbounded output. */
const MAX_PATHS = 40;
/** How deep the differ walks before giving up on a divergence. */
const MAX_DEPTH = 12;
/** How much of a disagreeing value is quoted. Enough to recognize, not enough to flood. */
const MAX_PREVIEW = 60;

/** The sink path, or `undefined` when instrumentation is off. Read per call so tests can toggle it. */
function sink(): string | undefined {
  return readPathEnvVar("XANOSDK_PROVE_DIFF");
}

/** A disagreeing value, JSON-quoted and clipped. */
function preview(v: unknown): string {
  const json = JSON.stringify(v) ?? "undefined";
  return json.length > MAX_PREVIEW ? `${json.slice(0, MAX_PREVIEW)}…` : json;
}

function walk(encoded: unknown, stored: unknown, path: string, out: string[], depth: number): void {
  if (out.length >= MAX_PATHS || depth > MAX_DEPTH) return;

  const bothObjects =
    encoded !== null &&
    stored !== null &&
    typeof encoded === "object" &&
    typeof stored === "object";
  if (!bothObjects) {
    if (JSON.stringify(encoded) !== JSON.stringify(stored)) {
      out.push(`${path}: encoded=${preview(encoded)} stored=${preview(stored)}`);
    }
    return;
  }

  const encodedIsArray = Array.isArray(encoded);
  if (encodedIsArray !== Array.isArray(stored)) {
    // The empty-array/empty-object split: one side decoded a JSON `[]` where the
    // other built `{}`. Naming the shape is the whole finding, so stop here.
    out.push(
      `${path}: shape encoded=${encodedIsArray ? "array" : "object"} stored=${Array.isArray(stored) ? "array" : "object"}`,
    );
    return;
  }

  if (encodedIsArray) {
    const a = encoded as unknown[];
    const b = stored as unknown[];
    if (a.length !== b.length) out.push(`${path}: length encoded=${a.length} stored=${b.length}`);
    // Collapse indices to `[]` so N sibling entries diverging the same way
    // cluster as one signature instead of N.
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      walk(a[i], b[i], `${path}[]`, out, depth + 1);
    }
    return;
  }

  const a = encoded as Record<string, unknown>;
  const b = stored as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (out.length >= MAX_PATHS) return;
    if (!(key in a)) out.push(`${path}.${key}: MISSING from encoded (stored=${preview(b[key])})`);
    else if (!(key in b)) out.push(`${path}.${key}: EXTRA in encoded (${preview(a[key])})`);
    else walk(a[key], b[key], `${path}.${key}`, out, depth + 1);
  }
}

/**
 * The key paths where a re-encode disagreed with the stored statement.
 *
 * Pass values that have already been through `normalize()` — the point is to see
 * what survives canonicalization, not to re-report what it already elides.
 */
export function diffKeyPaths(encoded: unknown, stored: unknown): string[] {
  const out: string[] = [];
  walk(encoded, stored, "", out, 0);
  return out;
}

/** How many disagreeing key paths a decline note quotes before summarizing the rest. */
const NOTE_PATHS = 3;

/**
 * Record a declined proof, and leave the disagreeing key paths as the note.
 *
 * The JSON line is still conditional on `XANOSDK_PROVE_DIFF`, but the diff walk
 * is not: a byte-mismatch decline is the one kind that knows precisely which
 * stored detail it failed to carry, and withholding that from the report is what
 * left "could not reproduce the stored statement" as a user's only clue. The
 * walk is bounded (see `MAX_PATHS`/`MAX_DEPTH`) and runs only on a decline.
 *
 * The paths are storage paths rather than authoring ones on purpose. They are
 * what the stored bytes actually disagree on, so they say the true thing, and a
 * reader chasing one has something exact to search for.
 */
export function recordProveDecline(
  arm: string,
  name: unknown,
  encoded: unknown,
  stored: unknown,
): void {
  const diffs = diffKeyPaths(encoded, stored);
  if (diffs.length > 0) {
    const shown = diffs.slice(0, NOTE_PATHS).join("; ");
    const rest = diffs.length - NOTE_PATHS;
    noteDecline(
      `the re-encode disagrees with the stored bytes at ${shown}` +
        (rest > 0 ? ` (and ${rest} more)` : ""),
    );
  }
  const file = sink();
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify({ arm, name, diffs })}\n`);
}

/**
 * Record a candidate that could not even be built — the factory threw before any
 * comparison happened. Distinguishing this from a byte mismatch matters: a throw
 * means the recovered arguments were the wrong *shape*, not the wrong value.
 *
 * This one does NOT note. The throw message needs framing to read as an
 * explanation rather than a stack-trace fragment, and only the caller knows
 * which surface rejected what — so both call sites wrap it themselves.
 */
export function recordProveAbort(arm: string, name: unknown, why: string): void {
  const file = sink();
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify({ arm, name, diffs: [`ABORT: ${why}`] })}\n`);
}

/**
 * The stored statement a decoder is currently working on.
 *
 * A guard deep inside a decoder — inside a shared helper several frames down —
 * has no handle on the statement being decoded, but the cluster it lands in is
 * only useful with the name attached. The dispatch sets this around each decode
 * and restores it afterwards, so nesting (a conditional's `run[]`, an addon's
 * `children[]`) reports against the innermost statement rather than the outermost.
 */
let currentName: unknown = undefined;

/** Run `body` with `name` as the statement guards inside it report against. */
export function withDeclineContext<T>(name: unknown, body: () => T): T {
  const previous = currentName;
  currentName = name;
  try {
    return body();
  } finally {
    currentName = previous;
  }
}

/**
 * Why the decode that just declined could not spell this statement.
 *
 * A decline is not a report entry: another arm may still prove, and a report
 * describing an attempt that was thrown away is simply false. But when EVERY arm
 * declines, "its decoder could not reproduce the stored statement" is all a
 * reader gets, and the decoder usually knew exactly why. This is the channel for
 * the ones that do.
 *
 * It lives here rather than on the context because its two writers cannot both
 * reach a context: `prove` has one, and `declineHere` — several frames down
 * inside a shared helper — does not. Two stores would drift, and the drift would
 * be invisible, so there is one (invariant 4). The dispatch takes the note on
 * every path out of a statement decode, which is what stops it outliving the
 * statement it describes.
 */
let pendingNote: PendingDecline | undefined;

/**
 * A decline note, plus the category the resulting report line should carry.
 *
 * Almost every decline is a fidelity gap and takes the default `raw-fallback`.
 * The exception is a statement that stores nothing at all: `raw()` is not a
 * failure to recover it, because there is nothing there to recover. Carrying the
 * category on the note is what lets the dispatch file the right line without
 * pattern-matching the prose — prose that exists to be read by a human and is
 * reworded whenever it reads badly.
 */
export interface PendingDecline {
  readonly why: string;
  /**
   * `unconfigured-stub`: the statement stores nothing to recover.
   * `workspace-defect`: it stores a shape the engine fails or ignores on every
   * run — `raw()` is its faithful reading, and the defect is upstream.
   */
  readonly category?: "unconfigured-stub" | "workspace-defect";
}

/**
 * Record why this decode declined. **First writer wins**, and that direction is
 * load-bearing: the most specific reason is the one that fires deepest, and a
 * coarse outer guard runs strictly after it. A condition that declined with
 * "the first sibling carries an `or` flag, which joins it to nothing" is
 * immediately followed by its statement's "context.expr is not a decodable
 * condition" — true, and useless next to what it would have overwritten.
 *
 * Safe because the note's lifetime is one statement: the dispatch takes it on
 * every path out, so "first" never reaches back into a previous statement.
 */
export function noteDecline(why: string, category?: PendingDecline["category"]): null {
  pendingNote ??= category === undefined ? { why } : { why, category };
  return null;
}

/** Read and clear the pending decline note. */
export function takePendingDecline(): PendingDecline | undefined {
  const note = pendingNote;
  pendingNote = undefined;
  return note;
}

/**
 * Record a decoder giving up at an internal guard, and return `null` for the
 * caller to propagate.
 *
 * The two proof-arm recorders above only see a candidate that was *built* — a
 * byte mismatch or a factory throw. A decoder that cannot recover its arguments
 * at all returns `null` from a guard long before either, which is why 483 `raw()`
 * fallbacks reported only 153 declines and why `db.query` was the largest
 * undiagnosable family in the sweep.
 *
 * `where` names the decoder and the guard (`"db.query: where[] is not a decodable
 * condition"`) rather than quoting the offending value, so that declines cluster.
 * **It is also read by users**: it becomes the reason on the `raw-fallback`
 * report line, because a guard is the one decline that always knows exactly what
 * it refused and a label that clusters is already most of the way to a sentence
 * that explains. Write it to be read — name the surface, then what it could not
 * recover — and keep it stable enough to cluster on.
 *
 * The note is recorded whether or not `XANOSDK_PROVE_DIFF` is set; only the
 * JSON line is conditional. The report must not depend on maintainer
 * instrumentation being switched on.
 *
 * **Only fatal guards belong here.** Several helpers return `null` to mean "not
 * applicable" — an absent `addon[]`, an empty `sort[]` — and their callers go on
 * to decode fine. Recording those would drown the real signal *and* attach a
 * reason to a statement that decoded, so the call sits at the site that actually
 * abandons the statement, not at every `return null`.
 */
export function declineHere(where: string, category?: PendingDecline["category"]): null {
  noteDecline(where, category);
  const file = sink();
  if (file === undefined || file === "") return null;
  appendFileSync(
    file,
    `${JSON.stringify({ arm: "guard", name: currentName, diffs: [`GUARD: ${where}`] })}\n`,
  );
  return null;
}
