/**
 * The sync baseline: what a workspace branch held, object by object, the last
 * time this project and that branch matched. With it, `workspace diff` can say
 * which side changed since then.
 *
 * Without a baseline a diff has two states and no history, so "differing" can
 * mean an edit made in the Xano editor, an edit made here, or both. Those call
 * for opposite remedies: a pull, a deploy, or a merge by hand. A content digest
 * per object, taken when the two sides last agreed, separates them:
 *
 *   here changed   the project's object no longer digests to the baseline
 *   there changed  the branch's object no longer digests to the baseline
 *
 * The baseline is recorded by the commands that make the two sides agree: a
 * deploy or promote that landed on the branch, and an `init --from` or `pull`
 * that decoded it. It lives in `xano.lock` beside the landing record, keyed by
 * the same destination and then by branch label, so it is committed with the
 * code it describes. A teammate who checks out the commit gets the baseline
 * that commit was synced against.
 *
 * **One canonical form.** A digest is taken over {@link canonicalRow}, the exact
 * form `compareToLive` compares. Two rows that compare equal therefore digest
 * equal, so an object the comparison calls unchanged can never read as
 * changed here. A digest can only err toward "changed": a rule added to
 * `normalize()` after the baseline was recorded makes the old digest differ
 * from the new one on both sides. That reads as a conflict, which is the
 * conservative mistake. It never hides an edit made in Xano.
 *
 * **A digest scheme.** A change to what {@link canonicalRow} produces (a new
 * `normalize()` rule, say) changes the digest of an object nobody touched, so
 * every baseline taken before it would read as changed on both sides. Such a
 * change bumps {@link DIGEST_SCHEME}; a baseline taken under another scheme is
 * not compared (the diff says `baseline: null`) and the next sync replaces it.
 * A test pins the digests of a fixed project, so a change that moves them
 * fails until the scheme is bumped.
 *
 * **Slugs are not digested.** Whether a slug is compared depends on which slugs
 * the project pins, and each recording command sees that set differently (a
 * release archive, a decoded tree, a compile). A digest that depended on it
 * could disagree with itself across commands and invent a change made in
 * Xano. A slug change still shows in `differing`, unclassified.
 *
 * **Whose objects.** A baseline keeps the project's objects (`objects`) apart
 * from the rest of what the branch held (`others`): a merge deploy leaves
 * objects another source put there, and a decode does not write every section
 * into the tree. Without that split, an object the project never held reads as
 * one it deleted the moment it shows up in `unexpected`.
 *
 * Pure and browser-safe, like the lock; storing a baseline is `lock/synced.ts`.
 */
import { canonicalJson } from "../bundle/hash.js";
import { md5Hex } from "../util/hash.js";
import { canonicalRow, payloadOf, rowLabeler, sectionKind, SETTINGS_LABEL, type Convergence } from "./live-diff.js";
import { sectionOmission } from "../codegen/omissions.js";
import type { SyncBaseline, SyncSource } from "../lock/lock.js";
import type { SyncDigests } from "../lock/synced.js";

export type { SyncBaseline, SyncSource };

/** The digest scheme this build takes digests under. Bump it whenever the digest of an unchanged object changes. */
export const DIGEST_SCHEME = 1;

/**
 * Sections that are not objects of their own. Env is compared by name in the
 * settings comparison, and the archive's own `metadata`/`partial` describe the
 * bundle rather than anything on the branch.
 */
const SKIPPED_SECTIONS: ReadonlySet<string> = new Set(["env", "metadata", "partial", "workspace"]);

/** The digest of one canonical row. */
function digestOf(canonical: unknown): string {
  return md5Hex(canonicalJson(canonical));
}

/**
 * Every object a bundle carries, by the label `workspace diff` prints, with
 * its content digest.
 *
 * `which` narrows it to the sections a decode writes into the tree
 * (`"carried"`) or to the ones it deliberately leaves out (`"uncarried"`, see
 * `sectionOmission`). A project never holds an uncarried section, so a
 * baseline files those under `others`.
 *
 * The slug (`canonical`) is never part of the digest; see the module note.
 *
 * The workspace's own settings row is not digested. Its comparison is
 * one-directional (the branch is read at the project's defaults, a subset
 * check), so the two sides never digest alike even when they match. A
 * difference there is reported without a direction.
 */
export function objectDigests(bundle: unknown, which: "all" | "carried" | "uncarried" = "all"): Record<string, string> {
  const payload = payloadOf(bundle);
  const label = rowLabeler(payload);
  const out: Record<string, string> = {};
  for (const [key, section] of Object.entries(payload)) {
    if (SKIPPED_SECTIONS.has(key)) continue;
    if (which !== "all" && (sectionOmission(key) === undefined) !== (which === "carried")) continue;
    if (!Array.isArray(section)) {
      if (section !== undefined && section !== null) out[`${sectionKind(key)}:(settings)`] = digestOf(canonicalRow(key, { value: section }, true));
      continue;
    }
    for (const row of section) {
      if (row === null || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      out[label(key, record)] = digestOf(canonicalRow(key, record, false));
    }
  }
  return out;
}

/**
 * The digests a sync records, from the bundles that describe the branch now.
 *
 * - `held`: what the project holds there. Its carried sections become
 *   `objects`; later bundles win.
 * - `heldLabels`: when given, only these labels of `held` are the project's,
 *   and the rest of it is `others`. A promote reads the whole branch back but
 *   landed only what its release carried.
 * - `others`: the rest of the branch, not the project's (a merge's read of the
 *   branch before it wrote).
 *
 * An object in both is the project's: a merge overwrote it.
 */
export function syncDigests(opts: { held: readonly unknown[]; heldLabels?: ReadonlySet<string>; others?: readonly unknown[] }): SyncDigests {
  const objects: Record<string, string> = {};
  const others: Record<string, string> = {};
  for (const bundle of opts.others ?? []) Object.assign(others, objectDigests(bundle));
  for (const bundle of opts.held) {
    for (const [label, digest] of Object.entries(objectDigests(bundle, "carried"))) {
      if (opts.heldLabels === undefined || opts.heldLabels.has(label)) objects[label] = digest;
      else others[label] = digest;
    }
    Object.assign(others, objectDigests(bundle, "uncarried"));
  }
  for (const label of Object.keys(objects)) delete others[label];
  return { scheme: DIGEST_SCHEME, objects, others };
}

/** Which side changed each object since the baseline, as `workspace diff --json` reports it. */
export interface SyncDirection {
  /** The baseline the answer is read against, or `null` when there is none for this branch. */
  readonly baseline: { readonly at: string; readonly by: SyncSource } | null;
  /** Changed (or added, or deleted) on the branch since the baseline, and not here. */
  readonly changedThere: readonly string[];
  /** Changed (or added, or deleted) in this project since the baseline, and not there. */
  readonly changedHere: readonly string[];
  /** Changed on both sides since the baseline: a real conflict. */
  readonly changedBoth: readonly string[];
  /**
   * Different on the two sides, but the baseline cannot say which one moved:
   * the object has no baseline entry, or both sides still digest to it (they
   * already differed when the baseline was taken), or it is the workspace
   * settings row (see {@link objectDigests}).
   */
  readonly unclassified: readonly string[];
}

/** What {@link syncDirection} reads off the comparison: its three lists, uncapped. */
type Compared = Pick<Convergence, "differing" | "missing" | "liveOnly">;

/**
 * Which side changed each difference `compareToLive` found, read against the
 * baseline.
 *
 * `result` must be an uncapped comparison (`sample: "all"`) of `local` against
 * `live`. Only the objects it reports are
 * classified. An object the two sides agree on has nothing to direct, even if
 * both changed the same way since the baseline.
 *
 * - **differing**: each side's digest against the baseline's.
 * - **missing** (here, not there): the project held it → deleted there, or
 *   deleted there AND changed here. Not in the baseline → added here.
 * - **liveOnly** (there, not here; `unexpected` in the diff's output): the
 *   project held it → deleted here, or deleted here AND changed there. The
 *   branch held it for someone else → changed there only if its digest moved.
 *   Not in the baseline → added there, but only when the baseline is
 *   complete. Otherwise it may predate this project and is left as
 *   `unexpected` alone, unclassified and uncounted, as a merge leaves it.
 */
export function syncDirection(
  local: unknown,
  live: unknown,
  result: Compared,
  baseline: SyncBaseline | undefined,
): SyncDirection {
  // Digests taken under another scheme cannot be compared with today's.
  if (baseline === undefined || baseline.scheme !== DIGEST_SCHEME) {
    return { baseline: null, changedThere: [], changedHere: [], changedBoth: [], unclassified: [] };
  }
  const here = objectDigests(local);
  const there = objectDigests(live);
  const held = baseline.objects;
  const others = baseline.others ?? {};
  const digest = (map: Readonly<Record<string, string>>, label: string): string | undefined =>
    Object.hasOwn(map, label) ? map[label] : undefined;
  const changedThere: string[] = [];
  const changedHere: string[] = [];
  const changedBoth: string[] = [];
  const unclassified: string[] = [];
  const file = (label: string, movedHere: boolean, movedThere: boolean): void => {
    if (movedHere && movedThere) changedBoth.push(label);
    else if (movedHere) changedHere.push(label);
    else if (movedThere) changedThere.push(label);
    else unclassified.push(label);
  };
  for (const label of result.differing) {
    // One the branch held and the project did not is one the project took
    // over since: its digest against what the branch held says which moved.
    const b = digest(held, label) ?? digest(others, label);
    const h = digest(here, label);
    const t = digest(there, label);
    if (label === SETTINGS_LABEL || b === undefined || h === undefined || t === undefined) {
      unclassified.push(label);
      continue;
    }
    file(label, h !== b, t !== b);
  }
  for (const label of result.missing) {
    const b = digest(held, label);
    if (b !== undefined) file(label, digest(here, label) !== b, true);
    // The branch had it and the project did not: the project added it and the
    // branch dropped it.
    else if (digest(others, label) !== undefined) file(label, true, true);
    else changedHere.push(label);
  }
  for (const label of result.liveOnly) {
    const b = digest(held, label);
    const other = digest(others, label);
    if (b !== undefined) file(label, true, digest(there, label) !== b);
    // Not the project's, then or now: only an edit made there is news.
    else if (other !== undefined) {
      if (digest(there, label) !== other) changedThere.push(label);
    } else if (baseline.complete) changedThere.push(label);
  }
  return { baseline: { at: baseline.at, by: baseline.by }, changedThere, changedHere, changedBoth, unclassified };
}
