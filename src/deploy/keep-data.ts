/**
 * `deploy --keep-data`: when a redeploy may merge into the environment it is
 * refreshing instead of replacing it, and the marker that decides it.
 *
 * Node-free and pure, so both deploy arms and their tests share one reading.
 */

/**
 * Proof that an import into an environment COMPLETED, stamped with the URL the
 * environment served at when it did.
 *
 * Existence of an environment record is not that proof: both deploy arms write
 * their record BEFORE the import, so a first deploy whose import failed leaves a
 * record behind an empty workspace. Merging into that would keep nothing and
 * seed nothing. The URL stamp answers the other trap — an engine restarted under
 * the same name serves at a fresh port with none of the rows the marker vouched
 * for.
 */
export interface FilledMarker {
  /** The base URL the environment served at when the import completed. */
  url: string;
  /** Epoch ms the import completed. */
  at: number;
}

/**
 * A marker read off disk, or `undefined` when there is none or it is malformed.
 *
 * A marker that cannot be read means "never filled", which fails safe: the next
 * deploy replaces and seeds rather than merging into something unproven.
 */
export function readFilledMarker(value: unknown): FilledMarker | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { url, at } = value as { url?: unknown; at?: unknown };
  if (typeof url !== "string" || url === "" || typeof at !== "number") return undefined;
  return { url, at };
}

/**
 * A record read off disk with its marker validated: kept when well-formed,
 * dropped otherwise. Both state stores read through this, so they cannot
 * disagree about which markers are trusted.
 */
export function withValidFilled<T extends { filled?: unknown }>(record: T): T {
  const { filled, ...rest } = record;
  const marker = readFilledMarker(filled);
  return (marker === undefined ? rest : { ...rest, filled: marker }) as T;
}

/** A marker for an import that just completed at `url`. */
export function filledAt(url: string): FilledMarker {
  return { url, at: Date.now() };
}

/**
 * Why a `--keep-data` deploy replaced anyway. Carried into the deploy summary as
 * `keepDataSkipped`, so the value set is a published shape.
 *
 * - `new` — nothing was recorded for this project; there was nothing to keep.
 * - `recreated` — an environment was recorded, but the one serving now is not
 *   it: an ephemeral that expired, or an engine restarted under a new URL.
 * - `never-filled` — the environment is the recorded one, but no import into
 *   it ever completed.
 * - `reset` — `--reset` asked for a clean slate, and wins.
 */
export type KeepDataSkipped = "new" | "recreated" | "never-filled" | "reset";

/** Which import a deploy runs: merge into what is there, or replace it. */
export type DeployArm = { arm: "merge" } | { arm: "replace"; skipped?: KeepDataSkipped };

/** Everything {@link selectDeployArm} decides on. Both destinations can answer all of it. */
export interface ArmInput {
  keepData: boolean;
  reset: boolean;
  /** This run created the environment (a new ephemeral, a freshly started engine). */
  created: boolean;
  /** A previous environment was recorded for this project, whatever became of it. */
  hadRecord: boolean;
  /** The completed-import marker as it was BEFORE this run rewrote the record. */
  priorFilled: FilledMarker | undefined;
  /** Where the environment serves now. */
  url: string;
}

/**
 * Merge or replace, decided once for both destinations.
 *
 * A merge needs positive proof that the environment holds what an earlier
 * deploy put there: reused rather than created, a completed-import marker, and
 * that marker stamped with the URL serving now. Anything short of that
 * replaces, with the reason, so a new environment is seeded rather than left
 * empty. Without `--keep-data` there is no reason to give: replace is simply
 * what a deploy does.
 */
export function selectDeployArm(input: ArmInput): DeployArm {
  if (!input.keepData) return { arm: "replace" };
  if (input.reset) return { arm: "replace", skipped: "reset" };
  if (input.created) return { arm: "replace", skipped: input.hadRecord ? "recreated" : "new" };
  if (input.priorFilled === undefined) return { arm: "replace", skipped: "never-filled" };
  if (input.priorFilled.url !== input.url) return { arm: "replace", skipped: "recreated" };
  return { arm: "merge" };
}
