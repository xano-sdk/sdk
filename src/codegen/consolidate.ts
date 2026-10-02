/**
 * Reconcile a source archive that repeats one stored object.
 *
 * ## The failure this exists to prevent
 *
 * A `packageExport` can carry the SAME object more than once — three copies of
 * one addon, three of each function — every copy repeating the stored guid and
 * differing only in generated editor ids. Nothing in the decoder noticed:
 * `RefIndex.fromPayload` keyed a map by guid and let the last write win, while
 * the project assembler still emitted every record, allocating `useraddon.ts`,
 * `useraddon_2.ts`, `useraddon_3.ts` — each pinning the same explicit `guid`.
 *
 * The tree then failed its own round-trip check with
 * `Duplicate object guid (…) shared by "addon/user" and "addon/user"`, which
 * reads like a naming mistake the user made. They authored nothing: the repeat
 * came from the archive. By then the files were written and dependencies
 * installed, so the first thing a new user saw of an importable workspace was
 * an unusable project.
 *
 * ## Why this runs BEFORE anything is generated
 *
 * The exporter's uniqueness guard is correct and stays — it is the last line of
 * defence, and it fired exactly as designed. But it can only speak once a tree
 * exists, which is far too late to be actionable. Reconciling at the decode
 * boundary means the repeat is resolved (or refused) while the only thing in
 * hand is the archive, which is the one moment the remedy is cheap.
 *
 * ## What is safe to merge, and what must never be
 *
 * Two records under one guid are the SAME stored identity, so renaming one or
 * minting a fresh guid would be a lie — references resolve by that guid, and
 * either "fix" silently repoints them. The only safe merge is one that changes
 * nothing, so the bar is equivalence, not similarity:
 *
 *   - identical, or differing ONLY at keys named `_xsid`  -> keep the first
 *   - anything else                                       -> refuse, and say where
 *
 * The first record is kept VERBATIM rather than normalized. That matters: a
 * normalized copy would drop literal application data that happens to be spelled
 * `_xsid`, and the kept record is what gets generated into source.
 *
 * ## Why not the shared normalizer
 *
 * {@link ../validate/normalize.ts} exists for a different question — "did these
 * two round-trip to the same authored logic" — and strips `guid`, `id`,
 * `workspace`, `branch`, `market_item`, `xanoscript`, `lastRun` and more to ask
 * it. Every one of those is a difference that MATTERS here: two records that
 * disagree about `workspace` are not the same object, and merging them would
 * discard real data under the banner of tidying metadata. So this compares
 * everything and forgives one key, rather than comparing little and forgiving
 * the rest.
 */
import { PAYLOAD_ARRAY_KEYS } from "../workspace/export.js";

/** The one generated key a repeat is allowed to disagree about. */
const EDITOR_METADATA_KEY = "_xsid";

/** How many differing paths a conflict reports before it stops listing them. */
const MAX_REPORTED_PATHS = 12;

/** Two records share a guid and are NOT the same object. */
export interface DuplicateSourceGuid {
  /** The section both records sit in, or the two sections for a cross-kind collision. */
  readonly payloadKey: string;
  readonly guid: string;
  /** The kept record's name, and the conflicting one's — often equal, which is itself the point. */
  readonly name: string;
  readonly otherName: string;
  /** Positions within the section, so a reader can find both records in the archive. */
  readonly position: number;
  readonly otherPosition: number;
  /**
   * Where they disagree, as slash-joined paths. Empty for a cross-kind
   * collision, where the disagreement is the section itself rather than a field.
   */
  readonly paths: readonly string[];
  /** True when the two records are in DIFFERENT sections — one guid, two kinds. */
  readonly crossKind: boolean;
  /** The other section, for a cross-kind collision. */
  readonly otherPayloadKey?: string;
}

/** One merged repeat, for the "consolidated N" report. */
export interface ConsolidatedDuplicate {
  readonly payloadKey: string;
  readonly guid: string;
  readonly name: string;
  /** How many records collapsed into the kept one (2 means one repeat was dropped). */
  readonly copies: number;
  /** True when the copies were not byte-identical but differed only in `_xsid`. */
  readonly metadataOnly: boolean;
}

export interface ConsolidationResult {
  /**
   * The archive with equivalent repeats removed. The SAME object when nothing
   * was repeated, so the common path allocates nothing and cannot perturb a
   * payload it did not need to touch.
   */
  readonly payload: Record<string, unknown>;
  readonly consolidated: readonly ConsolidatedDuplicate[];
  readonly conflicts: readonly DuplicateSourceGuid[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every path at which `a` and `b` disagree, deepest-first, capped.
 *
 * Collects PATHS rather than answering a boolean because both callers need
 * them: the equivalence test asks whether every path is forgivable, and the
 * refusal prints them so a reader can look at the two records and see what
 * actually differs. A boolean would make the diagnostic guess.
 *
 * A differing array LENGTH reports the array itself rather than descending —
 * element-wise paths past the shorter end would name positions that exist on
 * one side only, which reads as many unrelated differences instead of one.
 */
function differingPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= MAX_REPORTED_PATHS) return out;
  if (a === b) return out;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(path || "/");
      return out;
    }
    for (let i = 0; i < a.length; i++) differingPaths(a[i], b[i], `${path}/${i}`, out);
    return out;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    // Union of keys, so a key present on one side only is a difference rather
    // than an absence nobody looked at.
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      differingPaths(a[key], b[key], `${path}/${key}`, out);
    }
    return out;
  }

  // Primitives, or a type change (object vs array vs scalar). `a === b` above
  // already cleared the equal case; NaN is not a value any payload carries.
  out.push(path || "/");
  return out;
}

/**
 * True when every difference sits at a key named `_xsid`.
 *
 * Deliberately keyed on the path's LAST segment rather than on a stripped copy:
 * stripping would also remove a literal `_xsid` inside application data, and the
 * record kept here is emitted as source. Two copies of one stored object carry
 * identical literal data anyway, so tolerating the leaf costs nothing real.
 */
function onlyEditorMetadataDiffers(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.slice(p.lastIndexOf("/") + 1) === EDITOR_METADATA_KEY);
}

interface Seen {
  readonly payloadKey: string;
  readonly index: number;
  readonly name: string;
  readonly position: number;
  readonly record: Record<string, unknown>;
}

function nameOf(record: Record<string, unknown>): string {
  return typeof record.name === "string" ? record.name : "";
}

/**
 * Collapse equivalent repeats and name the conflicting ones.
 *
 * Pure: the input payload is never mutated. A section that loses a record is
 * rebuilt; every other section is carried over by reference.
 *
 * Order is preserved, and the FIRST record of a guid is the one kept, so the
 * generated tree matches what a reader sees at the top of the archive.
 */
export function consolidateSourceDuplicates(payload: Record<string, unknown>): ConsolidationResult {
  const consolidated: ConsolidatedDuplicate[] = [];
  const conflicts: DuplicateSourceGuid[] = [];
  /** guid -> the first record that claimed it, across ALL sections. */
  const byGuid = new Map<string, Seen>();
  /** payloadKey -> indexes to drop from that section. */
  const drop = new Map<string, Set<number>>();
  /** guid -> how many records collapsed into the kept one. */
  const copies = new Map<string, { count: number; metadataOnly: boolean }>();

  for (const payloadKey of PAYLOAD_ARRAY_KEYS) {
    const section = payload[payloadKey];
    if (!Array.isArray(section)) continue;

    section.forEach((entry, index) => {
      if (!isPlainObject(entry)) return;
      const guid = entry.guid;
      // No usable guid means nothing to group on. `RefIndex` already reports
      // that as its own problem; duplicating the complaint here would double it.
      if (typeof guid !== "string" || guid === "") return;

      const first = byGuid.get(guid);
      if (first === undefined) {
        byGuid.set(guid, { payloadKey, index, name: nameOf(entry), position: index, record: entry });
        return;
      }

      // One guid under two kinds is never a repeat — it is two different
      // objects claiming one identity, and no merge could be correct.
      if (first.payloadKey !== payloadKey) {
        conflicts.push({
          payloadKey: first.payloadKey,
          otherPayloadKey: payloadKey,
          guid,
          name: first.name,
          otherName: nameOf(entry),
          position: first.position,
          otherPosition: index,
          paths: [],
          crossKind: true,
        });
        return;
      }

      const paths = differingPaths(first.record, entry);
      if (paths.length === 0 || onlyEditorMetadataDiffers(paths)) {
        let bucket = drop.get(payloadKey);
        if (bucket === undefined) drop.set(payloadKey, (bucket = new Set()));
        bucket.add(index);
        const tally = copies.get(guid) ?? { count: 1, metadataOnly: false };
        tally.count += 1;
        tally.metadataOnly = tally.metadataOnly || paths.length > 0;
        copies.set(guid, tally);
        return;
      }

      conflicts.push({
        payloadKey,
        guid,
        name: first.name,
        otherName: nameOf(entry),
        position: first.position,
        otherPosition: index,
        paths,
        crossKind: false,
      });
    });
  }

  if (drop.size === 0) return { payload, consolidated: [], conflicts };

  const next: Record<string, unknown> = { ...payload };
  for (const [payloadKey, indexes] of drop) {
    const section = payload[payloadKey] as unknown[];
    next[payloadKey] = section.filter((_, i) => !indexes.has(i));
  }

  for (const [guid, tally] of copies) {
    const first = byGuid.get(guid)!;
    consolidated.push({
      payloadKey: first.payloadKey,
      guid,
      name: first.name,
      copies: tally.count,
      metadataOnly: tally.metadataOnly,
    });
  }

  return { payload: next, consolidated, conflicts };
}

/** The sentence a refusal prints for one conflict. */
export function describeConflict(c: DuplicateSourceGuid): string {
  if (c.crossKind) {
    return (
      `${c.payloadKey}[${c.position}] "${c.name}" and ${c.otherPayloadKey}[${c.otherPosition}] ` +
      `"${c.otherName}" are different kinds sharing guid ${c.guid}; one identity cannot name both`
    );
  }
  const shown = c.paths.slice(0, MAX_REPORTED_PATHS).join(", ");
  const more = c.paths.length > MAX_REPORTED_PATHS ? `, and more` : "";
  return (
    `${c.payloadKey}[${c.position}] "${c.name}" and ${c.payloadKey}[${c.otherPosition}] ` +
    `"${c.otherName}" share guid ${c.guid} but differ at ${shown}${more} — ` +
    `one guid cannot describe two different objects, so the repeat has to be resolved in the ` +
    `source before it can be imported`
  );
}
