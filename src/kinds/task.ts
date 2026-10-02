/**
 * Task (scheduled/background job) kind → payload key `task`. Function-like
 * `run[]` plus a `schedule[]` of cron-like entries. Validated against
 * the Xano engine's persisted shape.
 */
import { describeEntry } from "../statements/args.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { brandDef } from "./def-brand.js";

export interface ScheduleDef {
  startsOn: string;
  /**
   * Repeat interval in seconds (`every("1d")` = 86400). Omitted, the task runs
   * ONCE at `startsOn` — the 86400 stored then is a placeholder the disabled
   * repeat never reads.
   */
  freq?: number;
  /**
   * Whether the schedule repeats. Defaults to `freq != null`; state it only to
   * reproduce a stored schedule that remembers a `freq` with the repeat off.
   */
  repeatEnabled?: boolean;
  /** End timestamp; when present, `ends.enabled` defaults to true. */
  endsOn?: string;
  /**
   * Whether the end date applies. Defaults to `endsOn != null`; state it only to
   * represent a stored schedule that REMEMBERS an end date with the gate off —
   * a state the derivation alone cannot spell, and one real tasks are in.
   */
  endsEnabled?: boolean;
}

export interface TaskDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "task";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  datasource?: string;
  /** Whether the schedule runs. Defaults to `true`; set `false` to deploy the task parked. */
  active?: boolean;
  tags?: string[];
  schedule?: ScheduleDef[];
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"task">;
  stack?: Statement[];
  /**
   * Pre/post middleware attachment. Tasks have no API-Group tier — an
   * un-customized phase inherits straight from the workspace. Providing a phase
   * sets its `_customize` flag; `pre: middleware.clear()` overrides with nothing.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit from the workspace (tasks have no
   * container tier). A scalar: `false` off, `true` on at default depth, a number
   * = capture depth, `"all"` unlimited. Any value stops inheriting. See
   * {@link HistoryInput}.
   */
  history?: HistoryInput;
}

export interface ScheduleXdo {
  starts_on: string;
  repeat: { enabled: boolean; ends: { enabled: boolean; on: string }; freq: number };
}

export interface TaskXdo {
  name: string;
  description: string;
  docs: string;
  datasource: string;
  active: boolean;
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
  run: StackItemXdo[];
  schedule: ScheduleXdo[];
}

/**
 * A schedule instant: a date, a separator, a time, and a zone.
 *
 * Both spellings are accepted, and the second one is why this is not a plain
 * ISO-8601 check. The docs say ISO-8601 (`2026-01-01T00:00:00Z`), but a REAL
 * captured workspace stores `2026-01-01 00:00:00+0000` — a space instead of the
 * `T`, and a zone with no colon. That is the format the engine itself persists,
 * so refusing it would make every pulled task fail to re-export. The corpus
 * fixture `task/ex_kind_nightly_cleanup.json` is the evidence.
 *
 * A regex first, then a real parse. `Date.parse` alone is far too permissive —
 * it accepts `"March 3 2026"`, a bare `"2026-01-01"`, and a zoneless
 * `"2026-01-01 00:00:00"` (silently local, not UTC), so a guard built on it
 * would let most typos through and be theatre. The regex alone is not enough
 * either: it admits `"2026-13-45T99:00:00Z"`, which is well-shaped and not a
 * date.
 */
const SCHEDULE_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Refuse a schedule timestamp the engine's scheduler cannot parse.
 *
 * Copied through verbatim, `"not-iso"` would deploy clean and the task would
 * then never fire — a silent operational outage
 * with nothing to notice, since a task that has not run yet looks exactly like a
 * task that will.
 */
function assertScheduleInstant(field: string, value: string | undefined): void {
  if (value === undefined) return;
  const wellShaped = SCHEDULE_INSTANT.test(value);
  // The parse catches a well-shaped string that is not a time at all
  // (`2026-13-45T99:00:00Z` → NaN). JavaScript rolls an impossible calendar
  // date forward instead (`2026-02-30` → March 2), so the date part is checked
  // against the day it round-trips to as well.
  const parsed = wellShaped ? Date.parse(value) : NaN;
  if (wellShaped && !Number.isNaN(parsed) && isCalendarDate(value)) return;
  if (wellShaped) {
    throw new Error(
      `task schedule: \`${field}\` is ${JSON.stringify(value)}, which names a date or time that does not exist — ` +
        `the month must be 01–12, the day one that month has, the hour 00–23, and minutes/seconds 00–59.`,
    );
  }
  throw new Error(
    `task schedule: \`${field}\` is ${JSON.stringify(value)}, which is not a schedule instant. ` +
      `Write it as "2026-01-01T00:00:00Z" — a date, a "T" (or a space), a time, and a ZONE ("Z", ` +
      `"+02:00" or "+0000"). The zone is the part most often left off, and without it the value ` +
      `is not an instant at all. ` +
      `The engine stores this string verbatim and does not validate it: a value it cannot parse ` +
      `deploys successfully and the task then never fires, which is indistinguishable from a ` +
      `task whose time has not come yet.`,
  );
}

/** `2026-02-30…` is not a day: the date part must survive a UTC round trip. */
function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

export function encodeSchedule(def: ScheduleDef): ScheduleXdo {
  assertScheduleInstant("startsOn", def.startsOn);
  assertScheduleInstant("endsOn", def.endsOn);
  const repeats = def.repeatEnabled ?? def.freq != null;
  const ends = def.endsEnabled ?? def.endsOn != null;
  const freq = def.freq ?? 86400;
  // Each deploys clean and the task then never runs (or runs forever): a
  // repeating schedule with no positive interval, and an end before its start.
  // The instance stores whole seconds, so a fraction is truncated and drifts on every deploy.
  if ((repeats || def.freq != null) && !(typeof freq === "number" && Number.isInteger(freq) && freq > 0)) {
    throw new Error(
      `task schedule: \`freq\` is ${typeof freq === "number" ? String(freq) : JSON.stringify(freq)} — a repeat interval is a positive whole number of seconds ` +
        `(3600 hourly, 86400 daily). Omit \`freq\` for a one-off run.`,
    );
  }
  if (ends && def.endsOn !== undefined && Date.parse(def.endsOn) < Date.parse(def.startsOn)) {
    throw new Error(
      `task schedule: \`endsOn\` (${def.endsOn}) is before \`startsOn\` (${def.startsOn}), so the task never ` +
        `runs. Set \`endsOn\` after \`startsOn\`, or drop it to repeat indefinitely.`,
    );
  }
  return {
    starts_on: def.startsOn,
    repeat: {
      enabled: repeats,
      ends: { enabled: ends, on: def.endsOn ?? def.startsOn },
      freq,
    },
  };
}

/** `schedule`, refused by name when it is not a list of `{ startsOn, freq }` entries. */
function scheduleList(def: TaskDef): ScheduleDef[] {
  const list: unknown = def.schedule;
  if (list === undefined || list === null) return [];
  const bad = Array.isArray(list) ? list.findIndex((e) => typeof e !== "object" || e === null || Array.isArray(e)) : -1;
  if (!Array.isArray(list) || bad !== -1) {
    const at = Array.isArray(list) ? `schedule[${bad}]` : "schedule";
    const got = Array.isArray(list) ? list[bad] : list;
    throw new Error(
      `task "${def.name}": \`${at}\` must be ${Array.isArray(list) ? "a { startsOn, freq } entry" : "a list of { startsOn, freq } entries"} — got ${describeEntry(got)}.`,
    );
  }
  return list as ScheduleDef[];
}

export function encodeTask(def: TaskDef): TaskXdo {
  if (!def.name) throw new Error("task: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    datasource: def.datasource ?? "",
    active: def.active ?? true,
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("task", def.history),
    run: encodeStack("task", def.name, def.stack),
    schedule: encodeTaskSchedule(def),
  };
}

/** Each `schedule` entry encoded; a refusal names the task and the entry. */
function encodeTaskSchedule(def: TaskDef): ScheduleXdo[] {
  return scheduleList(def).map((entry, i) => {
    try {
      return encodeSchedule(entry);
    } catch (err) {
      throw new Error((err as Error).message.replace(/^task schedule:/, `task "${def.name}" \`schedule[${i}]\`:`), { cause: err });
    }
  });
}

export const taskKind: ObjectKind<TaskDef, TaskXdo> = {
  name: "task",
  payloadKey: "task",
  encode: encodeTask,
};
registerKind(taskKind);

export function task(def: TaskDef): TaskDef {
  // Entries checked here too, so a bad one's stack points at this call, not the
  // registration; a `schedule` of the wrong shape is the registration's to name.
  const list: unknown = def.schedule;
  if (Array.isArray(list) && list.every((e) => typeof e === "object" && e !== null && !Array.isArray(e))) encodeTaskSchedule(def);
  return brandDef(def, "task");
}
