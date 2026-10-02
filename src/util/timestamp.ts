/**
 * A timestamp as ISO 8601 UTC, or the raw string when it does not parse.
 *
 * Meta API routes disagree on format — `2026-09-10 20:58:50+0000` from a list,
 * `2026-09-10T20:58:50.000000Z` from a create — for the same instant. ISO 8601
 * UTC is the one that survives: the space-separated form is not ISO, and
 * parsing it at all is a V8 extension rather than anything a consumer in
 * another language can rely on.
 *
 * Unparseable input is passed through untouched: it is still the only record of
 * when the thing happened, and dropping it would turn a formatting surprise into
 * missing data. An absent or empty value is `undefined`.
 */
export function asTimestamp(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? v : parsed.toISOString();
}
