/**
 * A tiny, dependency-free semver: version precedence, and whether a version
 * falls inside a declared range.
 *
 * ── Why not a semver package ────────────────────────────────────────────────
 *
 * This SDK ships two runtime dependencies, and the two questions it actually
 * asks of semver are small: "is this release newer than that one" (the update
 * notice) and "does the running SDK satisfy the range a toolchain module
 * declares" ({@link satisfiesRange}). Both are answered here so the answers
 * cannot drift apart, which two hand-rolled copies in two files would.
 *
 * ── A range this file does not understand has NO OPINION ────────────────────
 *
 * {@link satisfiesRange} returns `null`, never `false`, for anything outside
 * the subset below. That asymmetry is the whole posture. Its one caller refuses
 * a module on `false`, so a `false` produced by this parser's own gap would
 * cost someone a working module over a range shape npm reads perfectly well.
 * `null` means "this file cannot say", and the caller carries on.
 *
 * The subset is what the ecosystem actually writes for a `@xano/sdk` peer:
 * `>=x.y.z <a.b.c` (what `sdkDep()` scaffolds), `^`, `~`, exact pins, `*`, and
 * `||` unions of those. Partial versions (`>=1.2`), hyphen ranges (`1.2.3 -
 * 2.0.0`), `x`-in-position wildcards (`1.x`), and anything with a prerelease
 * identifier are all deliberately unparsed rather than approximated: a guard
 * that is right about a narrow set beats one that guesses about a wide one.
 */

/** A parsed `x.y.z[-pre.n]`. */
export interface ParsedVersion {
  readonly nums: readonly [number, number, number];
  readonly pre: readonly string[];
}

/** Parse `x.y.z[-pre.n]`, or null when it is not one (a git build, `"unknown"`). */
export function parseSemver(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver precedence: negative when `a` sorts below `b`, 0 when equal. */
export function compareSemver(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i]! !== b.nums[i]!) return a.nums[i]! > b.nums[i]! ? 1 : -1;
  }
  // Equal x.y.z: a release outranks any prerelease of the same version.
  if (a.pre.length === 0) return b.pre.length === 0 ? 0 : 1;
  if (b.pre.length === 0) return -1;
  return comparePre(a.pre, b.pre);
}

/** Semver prerelease precedence: numeric ids sort below alphanumeric; more fields wins. */
export function comparePre(a: readonly string[], b: readonly string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // fewer fields → lower precedence
    if (i >= b.length) return 1;
    const x = a[i]!;
    const y = b[i]!;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether `version` falls inside `range` — or `null` when this file cannot say.
 *
 * `null` for an unparseable version (`"unknown"`, a git build), for a
 * prerelease version (prerelease matching is its own sub-language, and a local
 * build must never be refused because this checker declined to implement it),
 * and for any range shape outside the documented subset.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const v = parseSemver(version);
  if (!v || v.pre.length > 0) return null;

  const text = range.trim();
  if (text === "" || text === "*" || text === "x" || text === "X") return true;

  let unknown = false;
  for (const group of text.split("||")) {
    const result = satisfiesAll(v, group);
    if (result === true) return true;
    if (result === null) unknown = true;
  }
  // A definite `false` from every group is only definite if no group declined.
  return unknown ? null : false;
}

/** One `||` arm: every whitespace-separated comparator in it must hold. */
function satisfiesAll(v: ParsedVersion, group: string): boolean | null {
  // `>= 0.0.30` is one comparator npm reads perfectly well, and splitting on
  // whitespace alone would tear it into a bare `>=` (unparsed) and a bare
  // `0.0.30` read as an EXACT PIN — which then settles the arm false for every
  // version but one. The operator is rejoined to its version before tokenizing.
  const tokens = group
    .trim()
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length === 0) return true; // an empty arm is `any`
  // A hyphen range (`1.2.3 - 2.0.0`) is NOT a conjunction, and reading it as
  // one would evaluate its lower bound as an exact pin and settle the arm
  // false BEFORE the unparsed half is ever reached. Declined whole rather than
  // half-understood — and on a LEADING hyphen too, because `1.2.3 -2.0.0`
  // tokenizes without a bare `-` and would otherwise slip through the same way.
  // A prerelease comparator (`>=1.2.3-rc.1`) carries its hyphen inside the
  // token and is declined by `satisfiesComparator` instead.
  if (tokens.some((t) => t === "-" || t.startsWith("-"))) return null;
  let unknown = false;
  for (const token of tokens) {
    const result = satisfiesComparator(v, token);
    // AND short-circuits on a definite miss: one comparator this file DID
    // understand and that failed settles the arm, whatever the rest are.
    if (result === false) return false;
    if (result === null) unknown = true;
  }
  return unknown ? null : true;
}

/** One comparator (`>=1.2.3`, `^1.2.3`, `1.2.3`, `*`), or null when unparsed. */
function satisfiesComparator(v: ParsedVersion, token: string): boolean | null {
  if (token === "*" || token === "x" || token === "X") return true;

  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "=";
  const target = parseSemver(m[2]!);
  // A partial version, a tag, a `workspace:` protocol, or a prerelease bound.
  if (!target || target.pre.length > 0) return null;

  const cmp = compareSemver(v, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    // `^` allows changes that do not modify the left-most NON-ZERO field, which
    // is why `^0.0.30` is an exact pin and `^0.2.3` stops at 0.3.0.
    case "^":
      return cmp >= 0 && compareSemver(v, { nums: caretCeiling(target), pre: [] }) < 0;
    // `~` allows patch-level changes: `~1.2.3` stops at 1.3.0.
    case "~":
      return (
        cmp >= 0 &&
        compareSemver(v, { nums: [target.nums[0]!, target.nums[1]! + 1, 0], pre: [] }) < 0
      );
    default:
      return null;
  }
}

/** The exclusive upper bound of a caret range. */
function caretCeiling(target: ParsedVersion): [number, number, number] {
  const [major, minor, patch] = target.nums;
  if (major !== 0) return [major + 1, 0, 0];
  if (minor !== 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}
