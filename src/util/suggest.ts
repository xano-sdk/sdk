/**
 * The did-you-mean every refusal of a mistyped name uses — commands, flags,
 * profiles, marketplace modules. Dependency-free, so any layer can name a near
 * miss without importing the CLI command table.
 */

/**
 * Edit distance counting a swap of two adjacent letters as ONE edit (optimal
 * string alignment): `stauts` is one typo from `status`, not two. Inputs
 * here are short command and flag names.
 */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * A name with its look-alike characters folded together (`l`/`1`/`i`, `o`/`0`):
 * a typo between two of them is the likeliest, so it breaks a tie.
 */
function folded(name: string): string {
  return name.replace(/[1i|]/g, "l").replace(/0/g, "o");
}

/**
 * Every candidate at the smallest edit distance from `input` (2 or less), the
 * look-alike nearest first — or the one candidate `input` prefixes. Empty when
 * nothing is close. A tie is NAMED, not settled by list order (E2E pass 27:
 * `e2e27r-rl` offered only `e2e27r-r2`, though `e2e27r-r1` is the look-alike).
 */
export function suggestAll(input: string, candidates: readonly string[]): string[] {
  if (input === "") return [];
  const lower = input.toLowerCase();
  // Compared case-insensitively on BOTH sides, returned in the candidate's own
  // case: a lock key `query:api|GET|pingg` never matched `GET` against `get`.
  const prefix = candidates.filter((c) => c.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return [prefix[0]!];
  const scored = [...new Set(candidates)].map((c, i) => ({ c, i, d: distance(lower, c.toLowerCase()) }));
  const best = Math.min(3, ...scored.map((s) => s.d)); // only 0/1/2 qualify
  if (best > 2) return [];
  const look = (c: string): number => distance(folded(lower), folded(c.toLowerCase()));
  return scored
    .filter((s) => s.d === best)
    .sort((a, b) => look(a.c) - look(b.c) || a.i - b.i)
    .map((s) => s.c);
}

/**
 * The closest candidate to `input`, or undefined when nothing is close enough.
 * A prefix match wins outright (`work` → `workspace`); otherwise an edit
 * distance of 2 or less, which catches real typos without "correcting" a word
 * the user meant literally (`list` stays unsuggested under `workspace`). Of a
 * tie, the look-alike (see {@link suggestAll}, which names them all).
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  return suggestAll(input, candidates)[0];
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"` — a did-you-mean's names, quoted. */
export function orNames(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}`;
}
