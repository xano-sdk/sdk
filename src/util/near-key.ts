/**
 * Did-you-mean matching for a misspelled name. A leaf with no imports, so a
 * browser bundle that only needs a suggestion does not pull the statement
 * catalog in with it.
 */

/**
 * The declared key a misspelling most likely meant: the same letters once case
 * and `_` are ignored (`perPage` → `per_page`, `system_prompt` → `systemPrompt`),
 * else one edit away (`filter` → `filters`, `temprature` → `temperature`, `tabel` → `table`).
 */
export function nearestKey(key: string, known: readonly string[]): string | undefined {
  const fold = (s: string): string => s.toLowerCase().replace(/_/g, "");
  return known.find((k) => fold(k) === fold(key)) ?? known.find((k) => oneEdit(fold(k), fold(key)));
}

/**
 * Whether `a` and `b` are one Damerau edit apart: an insertion, deletion,
 * substitution, or swap of two adjacent letters (`respones` → `response`,
 * `tabel` → `table`).
 */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const tail = (x: string, n: number): string => x.slice(i + n);
  return (
    tail(a, 1) === tail(b, 1) ||
    tail(a, 1) === tail(b, 0) ||
    tail(a, 0) === tail(b, 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && tail(a, 2) === tail(b, 2))
  );
}
