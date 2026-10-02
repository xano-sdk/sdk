/**
 * Names that differ only in Unicode normalisation: `café` typed as `e` + a
 * combining accent (NFD) against `café` stored as one precomposed `é` (NFC).
 * They render identically, so a suggestion or a refusal that names one beside
 * the other has to say how they differ, or it reads as nonsense.
 */
import { safeText } from "./ui.js";

/** Whether `a` and `b` are different strings that normalise to the same one. */
export function differOnlyInNormalisation(a: string, b: string): boolean {
  return a !== b && a.normalize("NFC") === b.normalize("NFC");
}

/** The part of each string that differs, as code points: `U+0065 U+0301`. */
export function differingCodePoints(a: string, b: string): [string, string] {
  const x = [...a];
  const y = [...b];
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const points = (chars: string[]): string =>
    chars
      .slice(start, chars.length - end)
      .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(" ");
  return [points(x), points(y)];
}

/**
 * ` (it differs from "<typed>" only in Unicode normalisation: U+00E9 there,
 * U+0065 U+0301 typed)` when that is the whole difference; otherwise "".
 */
export function normalisationNote(typed: string, candidate: string): string {
  if (!differOnlyInNormalisation(typed, candidate)) return "";
  const [here, there] = differingCodePoints(candidate, typed);
  return ` (it differs from what was typed only in Unicode normalisation: ${here} there, ${there} typed)`;
}

/** `"a" or "b"`, as `orNames` spells it, each through `safeText` and with its {@link normalisationNote}. */
export function orNamesNoted(typed: string, names: readonly string[]): string {
  const q = names.map((n) => `"${safeText(n)}"${normalisationNote(typed, n)}`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}`;
}
