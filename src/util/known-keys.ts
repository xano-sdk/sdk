import { nearestKey } from "./near-key.js";

export { nearestKey };

/**
 * Refuse a key a nested argument record does not declare.
 *
 * The encoders read the keys they know and ignore the rest, so a misspelling
 * reached through `any` or a widened generic (`paging: { perPage }`, an eval
 * `filter:`, `llm: { system_prompt }`) was dropped without a word and the
 * statement ran on the default. The type is the first line of defence; this is
 * the same rule for everything that gets past it.
 */
export function assertKnownKeys(where: string, v: unknown, known: readonly string[]): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return;
  for (const key of Object.keys(v)) {
    if (known.includes(key)) continue;
    const near = nearestKey(key, known);
    throw new Error(
      `${where}: unknown key "${key}" — ${near ? `did you mean "${near}"? It` : "it"} ` +
        `would be dropped on emit; expected one of: ${known.join(", ")}.`,
    );
  }
}

/**
 * Every key of every member of `T` (`keyof` of a union keeps only the shared
 * ones). A wrapper's key list is written `Object.keys({ … } satisfies
 * Record<AllKeys<Args>, 1>)`, so the list and the type cannot drift apart.
 */
export type AllKeys<T> = T extends unknown ? keyof T : never;
