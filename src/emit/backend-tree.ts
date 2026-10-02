/**
 * The file operations every command that REPLACES a decoded backend tree needs:
 * list what is there, check that what is about to be written stays inside it,
 * and clear it without following a link out of it.
 *
 * `pull` and `generate` both replace a tree, and each is only as safe as these
 * three steps. They live here once so a fix to one — the symlink rule, the
 * containment test — cannot land in one command and miss the other.
 *
 * Node-only (node:fs); imported by the command modules, never by the authoring
 * bundle.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { decodeDigest } from "./decode-record.js";

export { decodeDigest, decodeMarkerHead, decodeMarkerWith } from "./decode-record.js";

/**
 * Every file under `root`, relative to it with POSIX separators.
 *
 * `lstat`, not `stat`: a symlinked directory would otherwise be recursed into
 * and its targets deleted, which puts a replace outside the directory it is
 * allowed to replace. A link is listed as the single entry it is, so removing
 * it removes the link. POSIX separators because the paths are compared against
 * decode paths, which always are — on Windows every existing file would
 * otherwise read as a deletion.
 */
export function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (lstatSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

/**
 * Resolve each file against `root`, refusing any that lands outside it.
 *
 * A decoded path is derived from the source's own stored strings, and a source
 * is a remote backend — so a path that climbs out of `root` is an arbitrary
 * file write on the machine running the command. Run it BEFORE anything is
 * cleared, so a refusal leaves the existing tree intact. `refuse` builds the
 * command's own error for the first offending path. `from` is what the paths
 * are relative to, when that is not `root` itself (`pull`'s are project-relative).
 */
export function containedWrites<T extends { readonly path: string; readonly content: string }>(
  root: string,
  files: readonly T[],
  refuse: (path: string) => Error,
  from: string = root,
): Array<{ full: string; content: string }> {
  const base = resolve(root);
  return files.map((file) => {
    const full = resolve(from, file.path);
    if (full !== base && !full.startsWith(`${base}${sep}`)) throw refuse(file.path);
    return { full, content: file.content };
  });
}

/**
 * Remove each directory a removal left empty, deepest first, never `root`
 * itself and never a directory that still holds anything.
 */
export function removeEmptiedDirs(root: string, removed: readonly string[]): void {
  const dirs = new Set<string>();
  for (const rel of removed) {
    const parts = rel.split("/");
    for (let i = parts.length - 1; i > 0; i--) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const dir of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
    const full = join(root, dir);
    try {
      if (readdirSync(full).length === 0) rmdirSync(full);
    } catch {
      // Already gone, or not a directory: nothing of ours to tidy.
    }
  }
}

/**
 * Remove each `root`-relative file. A symlink is removed as the link it is:
 * `rmSync` refuses one that points at a directory, and recursing into it would
 * delete the target's files — outside the directory being replaced.
 */
export function removeFiles(root: string, rels: readonly string[]): void {
  for (const rel of rels) {
    const full = join(root, rel);
    if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
    else rmSync(full, { force: true });
  }
}

/** The codegen record every decode leaves in the tree it wrote. */
export const DECODE_MARKER = ".xanosdk-codegen.json";

/** What the previous decode recorded writing: its files, and each one's digest when recorded. */
export interface DecodeRecord {
  readonly files: ReadonlySet<string>;
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * The files the previous decode wrote into `dir`, from its marker.
 *
 * No marker (a hand-authored tree) records nothing, so nothing is removed on
 * its word. A marker from before the file record existed says the whole tree
 * was decoded without saying which files, so every `existing` file counts as
 * the decode's.
 */
export function readDecodeRecord(dir: string, existing: readonly string[]): DecodeRecord {
  const markerPath = join(dir, DECODE_MARKER);
  if (!existsSync(markerPath)) return { files: new Set(), digests: new Map() };
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { files?: unknown; digests?: unknown };
    if (Array.isArray(marker.files)) {
      const digests =
        marker.digests !== null && typeof marker.digests === "object"
          ? Object.entries(marker.digests as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            )
          : [];
      return {
        files: new Set(marker.files.filter((f): f is string => typeof f === "string")),
        digests: new Map(digests),
      };
    }
  } catch {
    // An unreadable marker still marks the tree as decoded; see below.
  }
  return { files: new Set(existing), digests: new Map() };
}

/** What replacing a decoded tree does to each file already in it, decided before any write. */
export interface DecodeReplacePlan {
  /** Files the previous decode wrote and this one does not: removed. */
  readonly removals: readonly string[];
  /**
   * The {@link removals} the author edited since the last decode — deleted with
   * their edits. A subset, named apart: the decode dropping a file is exactly
   * when an edit to it is easiest to lose without noticing.
   */
  readonly removedEdited: readonly string[];
  /** Files no decode wrote: the author's, kept and named. */
  readonly kept: readonly string[];
  /** Rewritten, and the author edited them since the last decode: those edits are lost. */
  readonly edited: readonly string[];
  /** Rewritten because the source changed; untouched since the last decode. */
  readonly changedBySource: readonly string[];
  /** Rewritten, with no recorded digest to say whether they were edited. */
  readonly rewrittenUnknown: readonly string[];
}

/**
 * Plan a replace of the decoded tree in `dir` by `incoming` (`dir`-relative path
 * → content) — one planner for `init --from`'s re-run and `pull`, so the two
 * cannot disagree about which files are yours.
 *
 * `existing` is the tree's current files minus the ones a refresh never
 * touches (the lock, the secret files, the marker itself).
 */
export function planDecodeReplace(
  dir: string,
  incoming: ReadonlyMap<string, string>,
  existing: readonly string[],
  record: DecodeRecord,
): DecodeReplacePlan {
  const edited: string[] = [];
  const changedBySource: string[] = [];
  const rewrittenUnknown: string[] = [];
  for (const p of existing) {
    const next = incoming.get(p);
    if (next === undefined) continue;
    let current: string;
    try {
      current = readFileSync(join(dir, p), "utf8");
    } catch {
      continue;
    }
    if (current === next) continue;
    const recorded = record.digests.get(p);
    if (recorded === undefined) rewrittenUnknown.push(p);
    else if (recorded === decodeDigest(current)) changedBySource.push(p);
    else edited.push(p);
  }
  const removals = existing.filter((p) => !incoming.has(p) && record.files.has(p));
  const removedEdited = removals.filter((p) => {
    const recorded = record.digests.get(p);
    if (recorded === undefined) return false;
    try {
      return recorded !== decodeDigest(readFileSync(join(dir, p), "utf8"));
    } catch {
      return false;
    }
  });
  return {
    removals,
    removedEdited,
    kept: existing.filter((p) => !incoming.has(p) && !record.files.has(p)),
    edited,
    changedBySource,
    rewrittenUnknown,
  };
}

/** Whether a plan changes or removes anything already on disk. */
export function planTouchesExisting(plan: DecodeReplacePlan): boolean {
  return plan.removals.length + plan.edited.length + plan.changedBySource.length + plan.rewrittenUnknown.length > 0;
}

/**
 * The listing a replace confirms by: what it deletes, what it rewrites (told
 * apart: a file only the source changed, one you edited, one nothing recorded),
 * each under `shown/`. `say` prints a headline, `item` one path.
 */
export function describeDecodeReplace(
  plan: DecodeReplacePlan,
  shown: string,
  label: string,
  /** One warning, with the files it names as its detail lines — so `--json` carries them too. */
  say: (line: string, files: string[]) => void,
): void {
  const n = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;
  const list = (paths: readonly string[]): string[] => [
    ...paths.slice(0, 20).map((p) => `${shown}/${p}`),
    ...(paths.length > 20 ? [`… and ${paths.length - 20} more`] : []),
  ];
  const untouchedRemovals = plan.removals.filter((p) => !plan.removedEdited.includes(p));
  if (untouchedRemovals.length > 0) {
    say(`${n(untouchedRemovals.length)} the previous decode wrote will be deleted:`, list(untouchedRemovals));
  }
  if (plan.removedEdited.length > 0) {
    say(
      `${n(plan.removedEdited.length)} you edited since the last decode will be DELETED — ${label} no longer ` +
        `has ${plan.removedEdited.length === 1 ? "it" : "them"}, and your edits will be lost:`,
      list(plan.removedEdited),
    );
  }
  if (plan.edited.length > 0) {
    say(`${n(plan.edited.length)} you edited since the last decode will be rewritten from ${label} — your edits will be lost:`, list(plan.edited));
  }
  if (plan.rewrittenUnknown.length > 0) {
    say(
      `${n(plan.rewrittenUnknown.length)} will be rewritten from ${label} — any edits in ${plan.rewrittenUnknown.length === 1 ? "it" : "them"} are lost:`,
      list(plan.rewrittenUnknown),
    );
  }
  if (plan.changedBySource.length > 0) {
    say(`${n(plan.changedBySource.length)} changed by ${label} will be rewritten (not edited since the last decode):`, list(plan.changedBySource));
  }
}
