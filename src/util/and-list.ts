/**
 * Join items as a sentence does: `a`, `a and b`, `a, b and c`.
 *
 * `join(" and ")` read as "a and b and c" once a refusal named three flags.
 */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
