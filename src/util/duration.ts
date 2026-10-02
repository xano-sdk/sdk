/**
 * `every("15m")` — a duration string as SECONDS.
 *
 * Every repeat/expiry knob in the engine is a bare second count: a task's
 * `schedule[].freq`, a query's cache `ttl`, `s.redis.set({ ttl })`, a channel's
 * conversation `ttl`. Authors write `freq: 900` and the next reader has to do
 * the arithmetic backwards to find out it means fifteen minutes — and `86400`
 * and `84600` look alike enough that the transposition ships.
 *
 * This is a compile-time conversion with no engine involvement: the emitted
 * bundle carries the same integer it always did, so a schedule written with
 * `every()` and one written by hand are byte-identical.
 *
 * ```ts
 * task({ name: "sweep", schedule: [{ startsOn: "2026-01-01T00:00:00Z", freq: every("15m") }] })
 * query({ …, cache: { active: true, ttl: every("1h") } })
 * ```
 *
 * Units: `s` seconds, `m` minutes, `h` hours, `d` days, `w` weeks. Terms
 * concatenate — `every("1h30m")` is 5400 — and may repeat in any order. There is
 * deliberately no month or year unit: neither has a fixed length in seconds, so
 * a `freq` spelled that way would drift against the calendar it looks like it
 * follows. Cron and timezone-aware schedules are an engine capability the task
 * kind does not have; this sugar does not pretend otherwise.
 */

/** Seconds per unit. No `M`/`y`: a month is not a fixed number of seconds. */
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const TERM = /(\d+)([smhdw])/g;
const WHOLE = /^(\d+[smhdw])+$/;

/**
 * Convert a duration string to seconds. See {@link ./duration.js the module doc}
 * for the accepted units.
 *
 * Throws on anything it cannot read, rather than returning `NaN` or `0`: a
 * silently-zero `freq` is a task that re-fires as fast as the scheduler allows,
 * and a silently-`NaN` one serializes as `null` and deploys.
 */
export function every(duration: string): number {
  if (!WHOLE.test(duration)) {
    throw new Error(
      `every(${JSON.stringify(duration)}): not a duration. Write one or more ` +
        `<number><unit> terms with no spaces — "30s", "15m", "1h", "7d", "2w", "1h30m". ` +
        `Units are s/m/h/d/w; there is no month or year unit because neither is a fixed ` +
        `number of seconds. For a plain second count, pass the number itself.`,
    );
  }
  let total = 0;
  for (const match of duration.matchAll(TERM)) {
    total += Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
  }
  if (total === 0) {
    throw new Error(
      `every(${JSON.stringify(duration)}) is zero seconds. A repeat frequency of 0 is not a ` +
        `schedule — the task would re-fire as fast as the scheduler dequeues it.`,
    );
  }
  return total;
}
