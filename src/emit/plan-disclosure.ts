/**
 * What a landing does to the tables it lands in, said the same way on every
 * path that lands one: `deploy --keep-data`, `deploy --to`, `promote` and
 * `tenant deploy`.
 *
 * Two landing modes, measured on a live engine, and the effects differ:
 *
 * - **merge** (`deploy --keep-data`, `deploy --to`, `promote`): the definition
 *   is rewritten over the rows and the stored values stay — a retype re-reads
 *   them, a removed enum value reads null, and both read again once undone.
 * - **replace** (`tenant deploy`): the tenant becomes exactly the release. A
 *   table it does not carry is DROPPED with its rows, and a retype CONVERTS the
 *   stored values for good.
 *
 * (`rebuild` is a `deploy --replace`, which recreates every table and its rows:
 * only a dropped column is said there.) The server's own plan says none of it,
 * and a promote or a tenant deploy has no plan at all — so each path reads the
 * target's tables and runs them through {@link tableEffects}, and each finding
 * is printed by {@link discloseTableEffects} under one stable code:
 *
 * | code                      | the change                                        |
 * | ------------------------- | ------------------------------------------------- |
 * | `plan.table-drop`         | a table the target has and a replace does not     |
 * | `plan.column-drop`        | a column the target has and the landing does not  |
 * | `plan.column-retype`      | a column kept under another type                  |
 * | `plan.enum-values-removed`| an enum column kept with values removed           |
 * | `plan.tableref-retarget`  | a table reference pointed at another table        |
 * | `plan.index-change`       | an index added or dropped                         |
 * | `plan.not-null-kept`      | a column made nullable (NOT NULL stays)           |
 * | `plan.not-null-tightened` | a column made non-nullable over rows holding null |
 * | `plan.table-rename`       | a table matched by identity under another name    |
 * | `plan.schema-additive`    | new tables and columns (said where asked for)     |
 *
 * Node-only through its imports; pure apart from the warnings it prints.
 */
import type { ExportedBundle } from "../deploy/workspace-export.js";
import { authoredFieldType } from "../codegen/field.js";
import {
  diffAgainstLive,
  payloadOf,
  sectionKind,
  tableAdditions,
  vectorSize,
  type IndexChange,
  type LiveDiff,
  type NarrowedEnum,
  type RetargetedRef,
  type RetypedColumn,
  type StorageModeChange,
  type StoredColumnTypes,
  type TableAdditions,
  type TightenedColumn,
} from "../deploy/live-diff.js";
import { detail, warn, withoutUrls } from "./ui.js";
import { CliError } from "./errors.js";
import { suggest } from "../util/suggest.js";
import { ReleaseHttpError } from "../deploy/release.js";
import { TenantHttpError } from "../deploy/tenant.js";

/** How a landing treats the tables already there (see the module comment). */
export type LandingMode = "merge" | "replace" | "rebuild";

/** A table a replace drops, with the rows it holds now (`null` when they could not be counted). */
export interface DroppedTable {
  readonly table: string;
  readonly rows: number | null;
  /** The release carries another table under this name (another identity), created empty in its place. */
  readonly replaced?: true;
}

/** Every table effect a landing has, by kind. Tables are named; columns are `table.column`. */
export interface TableEffects {
  readonly mode: LandingMode;
  readonly droppedTables: readonly DroppedTable[];
  readonly createdTables: readonly string[];
  readonly addedColumns: readonly string[];
  /** Added columns that declare a default, `table.column` → the default existing rows read. */
  readonly addedDefaults: Readonly<Record<string, string>>;
  readonly renamedTables: readonly { from: string; to: string }[];
  readonly droppedColumns: readonly string[];
  readonly retypedColumns: readonly RetypedColumn[];
  readonly narrowedEnums: readonly NarrowedEnum[];
  readonly retargetedRefs: readonly RetargetedRef[];
  readonly indexChanges: readonly IndexChange[];
  readonly notNullKept: readonly string[];
  readonly notNullTightened: readonly TightenedColumn[];
  /** Tables switched to the other storage mode — checked by {@link assertStorageModesKept}, and carried as `storageChanges`. */
  readonly storageChanges?: readonly StorageModeChange[];
}

export const NO_TABLE_EFFECTS: TableEffects = {
  mode: "merge",
  droppedTables: [],
  createdTables: [],
  addedColumns: [],
  addedDefaults: {},
  renamedTables: [],
  droppedColumns: [],
  retypedColumns: [],
  narrowedEnums: [],
  retargetedRefs: [],
  indexChanges: [],
  notNullKept: [],
  notNullTightened: [],
};

/**
 * The table effects of landing `outgoing` over `live`.
 *
 * `rebuild` recreates every table from the archive, so only a column drop is
 * an effect there: the rows go either way, and a retype has no rows to re-read.
 * `skipTables` leaves out tables whose rows the landing replaces wholesale (a
 * tenant deploy of a seeded release), where an effect on the old rows is moot.
 * A dropped table's rows are not counted here (`rows: null`); the caller that
 * can count them fills them in.
 */
export function tableEffects(
  outgoing: unknown,
  live: ExportedBundle,
  opts: { mode: LandingMode; skipTables?: ReadonlySet<string>; stored?: StoredColumnTypes },
): TableEffects {
  const diff = diffAgainstLive(outgoing, live, {
    mode: opts.mode === "rebuild" ? "replace" : "merge",
    ...(opts.stored === undefined ? {} : { stored: opts.stored }),
  });
  return tableEffectsOf(diff, tableAdditions(outgoing, live), opts);
}

/** {@link tableEffects} from a diff the caller already holds. */
export function tableEffectsOf(
  diff: LiveDiff,
  additions: TableAdditions | undefined,
  opts: { mode: LandingMode; skipTables?: ReadonlySet<string> },
): TableEffects {
  const skip = opts.skipTables ?? new Set<string>();
  const kept = <T extends { table: string }>(list: readonly T[]): T[] => list.filter((c) => !skip.has(c.table));
  const keptName = (list: readonly string[]): string[] => list.filter((c) => !skip.has(c.slice(0, c.indexOf("."))));
  const dotted = (list: readonly { table: string; column: string }[]): string[] => kept(list).map((c) => `${c.table}.${c.column}`);
  const rebuild = opts.mode === "rebuild";
  const addedColumns = keptName(additions?.addedColumns ?? []);
  return {
    mode: opts.mode,
    droppedTables:
      opts.mode === "replace"
        ? diff.uncarriedTables.map((table) => ({
            table,
            rows: null,
            ...(diff.replacedTables.includes(table) ? { replaced: true as const } : {}),
          }))
        : [],
    createdTables: (additions?.createdTables ?? []).filter((t) => !skip.has(t)),
    addedColumns,
    addedDefaults: Object.fromEntries(
      Object.entries(additions?.addedDefaults ?? {}).filter(([c]) => addedColumns.includes(c)),
    ),
    renamedTables: (additions?.renamedTables ?? []).filter((r) => !skip.has(r.to)),
    droppedColumns: dotted(diff.droppedColumns),
    retypedColumns: rebuild ? [] : kept(diff.retypedColumns),
    narrowedEnums: kept(diff.narrowedEnums),
    retargetedRefs: kept(diff.retargetedRefs),
    indexChanges: kept(diff.indexChanges),
    // Measured: a replace relaxes NOT NULL, so only a merge can keep it.
    notNullKept: opts.mode === "merge" ? dotted(diff.unrelaxedColumns) : [],
    notNullTightened: kept(diff.tightenedColumns),
    // A replace converts a reseeded table's storage like any other (measured),
    // so the reseed does not take it out of the check.
    storageChanges: rebuild ? [] : opts.mode === "replace" ? [...diff.storageChanges] : kept(diff.storageChanges),
  };
}

/**
 * Refuse a landing that switches a table to a storage mode (`useXdo`) the
 * instance cannot reach without losing its rows, before anything is sent.
 * Measured live, and the two landing modes differ:
 *
 * - **merge** (`ctx.mode` omitted): JSON → columns erases every stored value
 *   for good and columns → JSON fails partway on a NOT NULL violation, while
 *   the plan calls either an index change. Refused while the table holds rows;
 *   an empty table switches cleanly, said as a note. A table whose rows cannot
 *   be counted is refused too: not knowing is not evidence it is empty.
 * - **replace** (a tenant deploy): JSON → columns converts the table and keeps
 *   every value, said as a note. Columns → JSON is refused by the instance
 *   whatever the table holds (it answers 500 and changes nothing), so it is
 *   refused here for every table, empty or seeded.
 *
 * `target` names what is landed on; `remedy` ends the merge refusal (the run's
 * rebuild, with its own warning).
 */
export async function assertStorageModesKept(
  changes: readonly StorageModeChange[] | undefined,
  count: (table: { name: string; guid?: string }) => Promise<number | undefined>,
  ctx: { target: string; subject: string; remedy?: string; mode?: "merge" | "replace" },
): Promise<void> {
  if (changes === undefined || changes.length === 0) return;
  const mode = (xdo: boolean): string => (xdo ? "JSON storage" : "column storage");
  const Subject = ctx.subject.charAt(0).toUpperCase() + ctx.subject.slice(1);
  const Target = ctx.target.charAt(0).toUpperCase() + ctx.target.slice(1);
  const countOf = async (c: StorageModeChange): Promise<number | null> =>
    (await count({ name: c.liveName, ...(c.guid === undefined ? {} : { guid: c.guid }) })) ?? null;
  const rowsText = (rows: number | null): string => (rows === null ? "rows not counted" : `${rows} ${rows === 1 ? "row" : "rows"}`);
  const refuse = (message: string, held: readonly (StorageModeChange & { rows: number | null })[]): CliError =>
    new CliError("SDK_IMPORT_REFUSED", message, {
      exitCode: 2,
      details: {
        refused: "storageModeChange",
        landed: false,
        tables: held.map((c) => ({ table: c.table, from: c.from, to: c.to, rows: c.rows })),
      },
    });
  if (ctx.mode === "replace") {
    for (const c of changes.filter((c) => !c.to)) {
      detail(`${Subject} switches table ${c.table} to column storage (useXdo true → false); the instance converts it and keeps every value.`);
    }
    const toXdo = changes.filter((c) => c.to);
    if (toXdo.length === 0) return;
    const held = await Promise.all(toXdo.map(async (c) => ({ ...c, rows: await countOf(c) })));
    throw refuse(
      `${Target} was not changed: ${ctx.subject} switches ${held.length === 1 ? "a table" : `${held.length} tables`} ` +
        `to JSON storage, and the instance cannot convert a table from column storage back to ` +
        `JSON storage — it refuses the deploy whether or not the table holds rows:\n` +
        held.map((c) => `  table ${c.table} (${rowsText(c.rows)}): useXdo false → true`).join("\n") +
        `\nNothing was sent. Keep each table's storage as it is: give the table \`useXdo: false\` — a table without ` +
        `its own \`useXdo\` follows the workspace's \`use_xdo\`. To switch one anyway, land a release that carries ` +
        `the JSON-storage table under a new name beside the old one, copy the rows across, then land one without the old table.`,
      held,
    );
  }
  const counted = await Promise.all(changes.map(async (c) => ({ ...c, rows: await countOf(c) })));
  for (const c of counted.filter((c) => c.rows === 0)) {
    detail(`${Subject} switches table ${c.table} to ${mode(c.to)} (useXdo ${c.from} → ${c.to}); it holds no rows, so nothing is lost.`);
  }
  const held = counted.filter((c) => c.rows !== 0);
  if (held.length === 0) return;
  const lines = held.map(
    (c) =>
      `  table ${c.table} (${rowsText(c.rows)}): useXdo ${c.from} → ${c.to} — ` +
      (c.from
        ? "every stored value would be erased (the rows stay, every field reads empty) and cannot be restored"
        : "the instance cannot convert a table that holds rows: the deploy fails partway on a NOT NULL violation"),
  );
  throw refuse(
    `${Target} was not changed: ${ctx.subject} switches ${held.length === 1 ? "a table" : `${held.length} tables`} holding rows ` +
      `to the other storage mode, which a merge cannot do without losing them:\n${lines.join("\n")}\n` +
      `Nothing was written. Keep each table's storage as it is: give the table \`useXdo: ${held[0]!.from}\`` +
      `${held.some((c) => c.from !== held[0]!.from) ? " (or the mode it has now)" : ""} — a table without its own \`useXdo\` follows ` +
      `the workspace's \`use_xdo\`. To switch one anyway, declare the switched table as a new table, copy the rows ` +
      `across, then remove the old one${ctx.remedy === undefined ? "." : `, or ${ctx.remedy}`}`,
    held,
  );
}

/**
 * Whether a tenant deploy failed because the instance refused to convert a
 * table from column storage back to JSON storage. It answers 500 and changes
 * nothing, so the outcome is known: the deploy did not land.
 */
export function xdoConversionRefused(err: unknown): boolean {
  return (
    (err instanceof TenantHttpError || err instanceof ReleaseHttpError) &&
    /cannot be migrated from custom column names back to xdo/i.test(err.message)
  );
}

/**
 * The refusal for {@link xdoConversionRefused}: exit 2, nothing landed. `cause`
 * is what the caller settled the failure as, so the outcome reads `no`.
 */
export function xdoConversionRefusal(target: string, err: Error, cause: unknown): CliError {
  const table = /\bdatabase (\S+) cannot be migrated/i.exec(err.message)?.[1];
  const Target = target.charAt(0).toUpperCase() + target.slice(1);
  return new CliError(
    "SDK_IMPORT_REFUSED",
    `${Target} was not changed: the instance cannot convert ${table === undefined ? "a table" : `table ${table}`} from column ` +
      `storage back to JSON storage (useXdo false → true), whether or not it holds rows, and refused the deploy. ` +
      `Nothing landed. Keep the table's storage as it is: give it \`useXdo: false\` — a table without its own ` +
      `\`useXdo\` follows the workspace's \`use_xdo\`.`,
    {
      exitCode: 2,
      cause,
      details: {
        refused: "storageModeChange",
        landed: false,
        tables: table === undefined ? [] : [{ table, from: false, to: true, rows: null }],
      },
    },
  );
}

/**
 * What a replace does to a retyped column's stored values. Measured per pair:
 *
 * - `converts`: rewritten as the new type for good — an int, decimal or text
 *   source, plus bool → decimal (true → 1, false → 0), timestamp → bool
 *   (every value → false) and timestamp → a nullable int (every timestamp →
 *   null).
 * - `re-read`: left as stored and read as the new type — bool → int or text
 *   (true → 1 or "true"), timestamp → text (its epoch milliseconds).
 * - `stops`: a stored value does not convert, so the deploy stops partway —
 *   bool → timestamp (22P02) and timestamp → decimal (22003) while the table
 *   holds rows (an empty one lands), and timestamp → an int that is not
 *   nullable (23502) while a row holds a timestamp (a 0 lands as 0).
 *
 * - a vector size change stops while the table holds rows.
 *
 * A pair not measured keeps its source's rule: a bool or timestamp source is
 * re-read, any other converts.
 */
export type ReplaceRetype = "converts" | "re-read" | "stops";
export function replaceRetype(c: RetypedColumn): ReplaceRetype {
  // Not measured under a replace: a vector column refuses a vector of another
  // size (measured, merge), so converting the stored ones cannot succeed.
  if (resizesVector(c)) return "stops";
  const time = (t: string): boolean => t === "epochms" || t === "timestamp";
  if (c.from === "bool") return time(c.to) ? "stops" : c.to === "decimal" ? "converts" : "re-read";
  if (time(c.from)) {
    if (c.to === "int") return c.nullable === true ? "converts" : "stops";
    return c.to === "decimal" ? "stops" : c.to === "bool" ? "converts" : "re-read";
  }
  return "converts";
}

/** Whether a replace converts a retyped column's stored values for good (see {@link replaceRetype}). */
export function replaceConverts(c: RetypedColumn): boolean {
  return replaceRetype(c) === "converts";
}

/**
 * Whether a replace can stop partway on this retype: every `stops` pair, and
 * text → timestamp, which stops on a value that does not read as a date.
 */
function replaceCanStop(c: RetypedColumn): boolean {
  return replaceRetype(c) === "stops" || (c.from === "text" && (c.to === "epochms" || c.to === "timestamp"));
}

/** The retyped columns that can stop a replace partway, as `table.column` — what its confirmation names. */
export function stoppingRetypes(e: TableEffects): string[] {
  return e.mode === "replace" ? e.retypedColumns.filter(replaceCanStop).map((c) => `${c.table}.${c.column}`) : [];
}

/** What a replace does to one retype, as its disclosure line ends. */
function replaceRetypeNote(c: RetypedColumn): string {
  const outcome = replaceRetype(c);
  if (outcome === "re-read") return ` — re-read, not converted: ${reReading(c)}`;
  if (outcome === "stops") return ` — not converted: ${stopCondition(c)}`;
  if (c.from === "bool") return " — converted for good: true → 1, false → 0";
  if (c.from !== "epochms" && c.from !== "timestamp") return "";
  return c.to === "int" ? " — converted for good: every timestamp → null" : " — converted for good: every value → false";
}

/** What a re-read column's stored values read as (measured for each pair named). */
function reReading(c: RetypedColumn): string {
  const to = authoredFieldType(c.to);
  if (c.from === "bool" && c.to === "text") return `true and false read "true" and "false"`;
  if (c.from === "bool" && c.to === "int") return "true and false read 1 and 0";
  if ((c.from === "epochms" || c.from === "timestamp") && c.to === "text") return `a timestamp reads as its epoch milliseconds ("1767225600000")`;
  return `a value that does not read as ${to} reads null`;
}

/** When a `stops` retype stops the deploy (see {@link replaceRetype}). */
function stopCondition(c: RetypedColumn): string {
  const from = authoredFieldType(c.from);
  const to = authoredFieldType(c.to);
  if (c.to === "int") {
    return `a stored ${from} converts to null and ${c.column} is not nullable, so the deploy stops partway while a row holds a ${from} (a 0 lands as 0)`;
  }
  return `a stored ${from} does not convert to ${to}, so the deploy stops partway while the table holds rows`;
}

const READ_ONLY_SOURCES = new Set(["bool", "epochms", "timestamp"]);

/**
 * Whether a retype leaves inserts that omit the column failing with an SQL
 * error. Measured, merge: the column keeps the old type's storage, and an
 * insert that omits it writes the new type's empty value there — `""` for a
 * text, email, password or enum column, `{}` for json, 0 for a number or
 * timestamp, nothing for a date. Text-held storage (text, email, password,
 * enum) takes any of them; every other storage refuses `""` and `{}`, and a
 * date, uuid or geo column refuses 0 as well. A default the old type reads
 * lets the insert through, and only for a text-like new type: a json or
 * timestamp default is converted before it is written. A uuid new type
 * writes null, which every old storage but json refuses (NOT NULL), and a uuid
 * column takes no default. Replace: bool or timestamp to text, which a replace
 * does not convert. A merge reads the storage from `stored` when a landing
 * record knows it (see {@link asStored}). A JSON-storage (`useXdo`) table has
 * no column storage to refuse anything: measured, merge, across every pair
 * of int, decimal, bool, timestamp, date, uuid, json, text, email and enum,
 * an insert that leaves the column unset lands.
 */
export function omittedInsertsFail(retype: RetypedColumn, mode: LandingMode): boolean {
  if (mode === "rebuild") return false;
  if (mode === "replace") return retype.to === "text" && READ_ONLY_SOURCES.has(retype.from);
  if (retype.useXdo === true) return false;
  const c = asStored(retype);
  if (c.from === c.to) return false;
  if (c.to === "uuid") return c.from !== "json";
  if (TEXT_HELD.has(c.from)) return false;
  const writes = TEXT_HELD.has(c.to) ? "text" : c.to === "json" ? "json" : NUMBER_WRITTEN.has(c.to) ? "number" : undefined;
  if (writes === undefined) return false;
  if (writes === "number" && !REFUSES_NUMBER.has(c.from) && !c.from.startsWith("geo_")) return false;
  return !(writes === "text" && c.default !== undefined && readsAs(c.from, c.default));
}
const TEXT_HELD = new Set(["text", "email", "password", "enum"]);
const NUMBER_WRITTEN = new Set(["int", "decimal", "epochms", "timestamp", "bool"]);
const REFUSES_NUMBER = new Set(["date", "uuid"]);

/** Whether a column stored as `type` reads `value` (measured: "yes" reads as a bool, "1.5" not as an int). */
function readsAs(type: string, value: string): boolean {
  const v = value.trim();
  switch (type) {
    case "int":
    case "epochms":
    case "timestamp":
      return /^[+-]?\d+$/.test(v);
    case "decimal":
      return v !== "" && Number.isFinite(Number(v));
    case "bool":
      return /^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i.test(v);
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    case "json":
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Whether a merge retype to uuid leaves inserts that SET the column failing
 * too. Measured: only text-held storage takes a uuid value; an int, decimal,
 * bool, timestamp, date or json one refuses it (SQL 22P02 / 22007). A
 * JSON-storage table takes it from every one.
 */
export function setInsertsFail(retype: RetypedColumn, mode: LandingMode): boolean {
  const c = asStored(retype);
  if (mode !== "merge") return false;
  return resizesVector(c) || (c.useXdo !== true && c.to === "uuid" && c.from !== "uuid" && !TEXT_HELD.has(c.from));
}

/**
 * Whether a retype changes a vector column's size only. Measured, merge: the
 * column keeps holding vectors of the size it was created with, so every
 * stored one reads null while it declares another size (and reads again once
 * changed back), and an insert that sets a vector of the new size fails with
 * an SQL error (22000); one that leaves it unset lands.
 */
function resizesVector(c: RetypedColumn): boolean {
  const from = vectorSize(c.from);
  const to = vectorSize(c.to);
  return from !== undefined && to !== undefined && from !== to;
}

/** What to do instead of a retype whose new values the old storage refuses ({@link setInsertsFail}). */
function newColumnRemedy(c: RetypedColumn): string {
  return `add the ${resizesVector(c) ? "new size" : "uuid"} as a new column (another name) instead`;
}

/**
 * A merge retype as the column's storage sees it: `from` is the type its values
 * are held as. A merge rewrites the definition only, so after an earlier merge
 * retype that is `stored` (the type the column was created with), not the
 * declared type the live read shows. Unchanged when the storage is unknown.
 */
function asStored(c: RetypedColumn): RetypedColumn {
  return c.stored === undefined || c.stored === c.from ? c : { ...c, from: c.stored };
}

/**
 * The column's storage as a note opens with it, `aside` placed after the type,
 * up to the consequence: asserted when a landing record knows it ("…, so"),
 * else hedged ("if …,") — a merge never converts it, so an earlier merge retype
 * this project did not record leaves it holding another type.
 */
function holding(c: RetypedColumn, mode: LandingMode, aside = ""): string {
  const old = authoredFieldType(asStored(c).from);
  if (mode !== "merge" || c.stored !== undefined) return `the column keeps holding ${old}${aside}, so`;
  return `if the column still holds ${old} as created (no record here says an earlier merge retyped it)${aside},`;
}

/**
 * A merge retype predicted harmless only because the storage is ASSUMED to be
 * the type the column was created with: with no record of it, an earlier merge
 * retype may have left it holding another, and inserts then fail.
 */
function unknownStorageNote(c: RetypedColumn, mode: LandingMode): string {
  if (mode !== "merge" || c.stored !== undefined || c.useXdo === true) return "";
  return ` — what inserts do depends on the type the column holds, and no record here says it still holds ${authoredFieldType(c.from)} as created`;
}

/** Why inserts fail for {@link omittedInsertsFail} / {@link setInsertsFail}, and what lets them through. */
function insertsFailNote(c: RetypedColumn, mode: LandingMode): string {
  if (setInsertsFail(c, mode)) {
    return (
      `${holding(c, mode, resizesVector(asStored(c)) ? ", which takes no other size" : ", which takes no uuid")} an insert that sets it fails with an SQL error` +
      (omittedInsertsFail(c, mode) ? " and so does one that leaves it unset" : "") +
      ` — ${newColumnRemedy(asStored(c))}`
    );
  }
  return (
    `${holding(c, mode)} an insert that leaves it unset fails ` +
    `${mode === "replace" ? "(SQL 22P02)" : "with an SQL error"} ${omittedInsertsRemedy(mode === "merge" ? asStored(c) : c)}`
  );
}

/** What lets an insert that omits the column through, for {@link omittedInsertsFail}'s remedy. */
function omittedInsertsRemedy(c: RetypedColumn): string {
  if (c.to === "uuid") return "— a uuid column takes no default, so set it on every insert";
  const example = TEXT_HELD.has(c.to) ? OLD_TYPE_DEFAULTS[c.from] : undefined;
  if (example === undefined) return "whatever default it declares — set it on every insert";
  const old = authoredFieldType(c.from);
  return c.to === "enum"
    ? `until it declares a default ${old} also reads — an enum value such as ${JSON.stringify(example)}`
    : `until it declares a default ${old} also reads, such as ${JSON.stringify(example)}`;
}
const OLD_TYPE_DEFAULTS: Readonly<Record<string, string>> = {
  int: "0",
  decimal: "0",
  epochms: "0",
  timestamp: "0",
  bool: "false",
  date: "1970-01-01",
  json: "{}",
  uuid: "00000000-0000-0000-0000-000000000000",
};

/**
 * How a merge reads a pair's stored values where the general rule (a value
 * that reads as the new type does, one that does not reads null) says too
 * little. Measured, on column storage and on JSON storage (`useXdo`), where a
 * value stays as written and is read through the new type.
 */
function mergeReading(retype: RetypedColumn): string | undefined {
  const c = asStored(retype);
  if (c.from === c.to) return "back to the type its values are stored as: every value reads as stored";
  if (resizesVector(c)) {
    return `every stored vector has ${vectorSize(c.from)} dimensions, so each reads null while the column has the new size, and reads again if it is changed back`;
  }
  if (c.from === "decimal" && c.to === "int") return "values read truncated (29.789 reads 29) and read whole again once retyped back";
  if (c.useXdo === true) {
    const dated = c.to === "epochms" || c.to === "timestamp" || c.to === "date";
    if (c.from === "json" && c.to === "date") return "every read of the table fails (HTTP 500) while a row holds a json object there";
    if ((c.from === "text" || c.from === "enum") && dated) {
      return 'a stored value is not checked as a date: it can read as written ("12" reads 12) or as the time of the read ("x"), not null';
    }
    if (c.from === "bool" && c.to === "enum") return "true reads the enum's first value";
    if (c.from === "decimal" && c.to === "text") return 'values read as stored (1.5 reads "1.5")';
  }
  if (c.from === "decimal" && c.to === "text") return 'values read padded to the column\'s scale (29.789 reads "29.78900")';
  if (c.from === "bool" && c.to === "text") return 'true reads "1" and false reads ""';
  if (c.from === "int" && c.to === "date") return 'values read as epoch milliseconds (5 reads "1970-01-01")';
  if (c.from.startsWith("geo_") && c.to === "text") return "values read as hex-encoded geometry";
  return undefined;
}

/** A retype as authored: `(timestamp → text)`, never the stored `epochms`. */
function typeChange(c: RetypedColumn): string {
  return `${authoredFieldType(c.from)} → ${authoredFieldType(c.to)}`;
}

/**
 * One line per change to a table the target already has, each naming its data
 * effect — what a refusal lists. Additions (new tables and columns) are not
 * here: they alter nothing already there.
 */
export function alteringChanges(e: TableEffects): string[] {
  const replace = e.mode === "replace";
  return [
    ...e.droppedTables.map((t) => `drop table ${t.table} — ${rowsGone(t.rows)}${t.replaced ? REPLACED_TABLE : ""}`),
    ...e.renamedTables.map((r) => `rename table ${r.from} → ${r.to} (rows kept)`),
    ...e.droppedColumns.map((c) => `drop column ${c} — every value it holds is destroyed`),
    ...e.retypedColumns.map(
      (c) =>
        `retype ${c.table}.${c.column} (${typeChange(c)}) — ` +
        (!replace
          ? (mergeReading(c) ?? `a stored value that does not read as ${authoredFieldType(c.to)} reads null`)
          : replaceRetype(c) === "stops"
            ? stopCondition(c)
            : replaceConverts(c)
              ? `stored values are converted to ${authoredFieldType(c.to)} for good; one that does not convert becomes ${c.to === "int" && c.nullable === true ? "null" : emptyOf(c.to)}`
              : reReading(c)) +
        (setInsertsFail(c, e.mode)
          ? `; an insert that sets it fails${omittedInsertsFail(c, e.mode) ? ", and so does one that leaves it unset" : ""} — ${newColumnRemedy(asStored(c))}`
          : omittedInsertsFail(c, e.mode)
            ? `; an insert that leaves it unset fails ${omittedInsertsRemedy(e.mode === "merge" ? asStored(c) : c)}`
            : ""),
    ),
    ...e.narrowedEnums.map(
      (n) => `${n.table}.${n.column} loses ${n.removed.map((v) => `"${v}"`).join(", ")} — a row holding one reads null`,
    ),
    ...e.retargetedRefs.map(
      (r) => `${r.table}.${r.column} points at ${r.to} instead of ${r.from} — the ids rows hold now name ${r.to} rows`,
    ),
    ...e.indexChanges.map(
      (c) =>
        `${c.action} index ${c.table}: ${c.index}` +
        (c.action === "add" && c.unique ? " — refused if the rows already hold duplicates for it" : ""),
    ),
    ...e.notNullKept.map(
      (c) => `${c} becomes nullable — if the table enforces NOT NULL there, it keeps refusing a row without a value`,
    ),
    ...e.notNullTightened.map(
      (c) =>
        `${c.table}.${c.column} stops being nullable — a row holding null ` +
        (replace ? `is rewritten to ${emptyOf(c.type)} for good` : `reads ${emptyOf(c.type)}`),
    ),
  ];
}

/** The changes that add without altering, one line each. */
export function additiveChanges(e: TableEffects): string[] {
  return [
    ...e.createdTables.map((t) => `create table ${t}`),
    ...e.addedColumns.map((c) => {
      const value = e.addedDefaults[c];
      return `add column ${c} — existing rows read ${value === undefined ? "the type's empty value" : `its default ${JSON.stringify(value)}`}`;
    }),
  ];
}

/** Said of a dropped table whose name the release gives to another table. */
const REPLACED_TABLE = "; the release's table of that name is another table (another identity), created empty in its place";

/** A dropped table as a disclosure lists it: its name, its rows, and whether the release replaces it. */
export function droppedTableLine(t: DroppedTable): string {
  return (
    `${t.table} (${t.rows === null ? "rows not counted" : `${t.rows} ${t.rows === 1 ? "row" : "rows"}`})` +
    (t.replaced ? REPLACED_TABLE : "")
  );
}

function rowsGone(rows: number | null): string {
  return rows === null ? "every row it holds is deleted" : `its ${rows} ${rows === 1 ? "row is" : "rows are"} deleted`;
}

/** The empty value a row holding null reads as once the column is not nullable (measured: int 0, text ""). */
function emptyOf(type: string): string {
  if (type === "int" || type === "decimal" || type === "epochms" || type === "timestamp") return "0";
  if (type === "text" || type === "email" || type === "password") return '""';
  if (type === "bool") return "false";
  return "the type's empty value";
}

/** The JSON fields every landing document carries for its table effects, under one set of keys. */
export function tableEffectFields(e: TableEffects): {
  droppedColumns: string[];
  retypedColumns: (RetypedColumn & { converted?: boolean; stops?: true; omittedInsertsFail?: true; setInsertsFail?: true })[];
  narrowedEnums: NarrowedEnum[];
  retargetedRefs: RetargetedRef[];
  indexChanges: IndexChange[];
  notNullKept: string[];
  notNullTightened: TightenedColumn[];
  storageChanges: StorageChangePayload[];
} {
  return {
    droppedColumns: [...e.droppedColumns],
    // `converted` under a replace only; `omittedInsertsFail` / `setInsertsFail` only where they hold.
    // Types as authored (`timestamp`, never the stored `epochms`), matching the text output.
    retypedColumns: e.retypedColumns.map((c) => ({
      ...c,
      from: authoredFieldType(c.from),
      to: authoredFieldType(c.to),
      ...(c.stored !== undefined ? { stored: authoredFieldType(c.stored) } : {}),
      ...(e.mode === "replace" ? { converted: replaceConverts(c), ...(replaceRetype(c) === "stops" ? { stops: true as const } : {}) } : {}),
      ...(omittedInsertsFail(c, e.mode) ? { omittedInsertsFail: true as const } : {}),
      ...(setInsertsFail(c, e.mode) ? { setInsertsFail: true as const } : {}),
    })),
    narrowedEnums: e.narrowedEnums.map((c) => ({ ...c, removed: [...c.removed] })),
    retargetedRefs: e.retargetedRefs.map((c) => ({ ...c })),
    indexChanges: e.indexChanges.map((c) => ({ ...c })),
    notNullKept: [...e.notNullKept],
    notNullTightened: e.notNullTightened.map((c) => ({ ...c, type: authoredFieldType(c.type) })),
    storageChanges: storageChangesPayload(e.storageChanges ?? []),
  };
}

/** A table switched to the other storage mode, as a result document carries it: `useXdo` before and after. */
export type StorageChangePayload = { table: string; from: boolean; to: boolean };

/** The storage-mode switches a landing makes, under a document's `storageChanges` key. */
export function storageChangesPayload(changes: readonly StorageModeChange[]): StorageChangePayload[] {
  return changes.map((c) => ({ table: c.table, from: c.from, to: c.to }));
}

/** A landing's table effects as a result document carries them: every change, additions included. */
export function tableEffectsPayload(e: TableEffects): Record<string, unknown> {
  return {
    mode: e.mode,
    droppedTables: e.droppedTables.map((t) => ({ ...t })),
    createdTables: [...e.createdTables],
    addedColumns: [...e.addedColumns],
    addedDefaults: { ...e.addedDefaults },
    renamedTables: e.renamedTables.map((r) => ({ ...r })),
    ...tableEffectFields(e),
  };
}

/** The table effect codes {@link discloseTableEffects} warns under. */
export type TableEffectCode =
  | "plan.table-drop"
  | "plan.column-drop"
  | "plan.column-retype"
  | "plan.enum-values-removed"
  | "plan.tableref-retarget"
  | "plan.index-change"
  | "plan.not-null-kept"
  | "plan.not-null-tightened"
  | "plan.table-rename"
  | "plan.schema-additive";

export interface DiscloseOptions {
  /** What lands, lowercase: `the merge`, `the deploy`, `the promote`, `the tenant deploy`. */
  readonly subject: string;
  /** `would` while an answer is pending or for a dry run, else `will`. */
  readonly will?: "will" | "would";
  /** A path's own remedy, printed as the last line under that code's warning. */
  readonly remedies?: Partial<Record<TableEffectCode, string>>;
  /**
   * Said for additions too, with this phrase naming whose tables they reach
   * (`every branch's tables, live included`). Omitted, additions are not said:
   * a deploy that names its target already says it adds what it declares.
   */
  readonly additiveWhere?: string;
  /** What the drop+add rename hint stages the change as: `deploys` on a deploy, else `releases`. */
  readonly stages?: RenameStages;
}

/** Print every table effect as a warning under its stable code. Says nothing for an effect that is absent. */
export function discloseTableEffects(e: TableEffects, opts: DiscloseOptions): void {
  const will = opts.will ?? "will";
  const Subject = opts.subject.charAt(0).toUpperCase() + opts.subject.slice(1);
  const say = (code: TableEffectCode, msg: string, items: readonly string[]): void => {
    const remedy = opts.remedies?.[code];
    warn(msg, code, remedy === undefined ? items : [...items, remedy]);
  };

  const replace = e.mode === "replace";
  if (opts.additiveWhere !== undefined) {
    const added = additiveChanges(e);
    if (added.length > 0) say("plan.schema-additive", `${Subject} ${will} add to ${opts.additiveWhere}:`, added);
  }
  if (e.droppedTables.length > 0) {
    // Measured: a tenant deploy leaves only the release's tables; one it does
    // not carry is gone with every row, and nothing in its answer says so.
    const one = e.droppedTables.length === 1;
    say(
      "plan.table-drop",
      `${Subject} ${will} DROP ${plural(e.droppedTables.length, "table", "tables")} the release does not carry, ` +
        `with every row in ${one ? "it" : "them"}:`,
      e.droppedTables.map(droppedTableLine),
    );
  }
  if (e.renamedTables.length > 0) {
    say(
      "plan.table-rename",
      `${Subject} ${will} rename ${plural(e.renamedTables.length, "table", "tables")}, keeping ${e.renamedTables.length === 1 ? "its" : "their"} rows:`,
      e.renamedTables.map((r) => `${r.from} → ${r.to}`),
    );
  }
  if (e.droppedColumns.length > 0) {
    const one = e.droppedColumns.length === 1;
    say(
      "plan.column-drop",
      `${Subject} ${will} DROP ${plural(e.droppedColumns.length, "column", "columns")}, with the values in ${one ? "it" : "them"}:`,
      // A drop beside an add on one table reads as a rename, and is not one.
      [...e.droppedColumns, ...droppedAndAdded(e).map((p) => renameHint(p, opts.stages))],
    );
  }
  if (e.retypedColumns.length > 0) {
    const n = plural(e.retypedColumns.length, "column changes", "columns change");
    // Measured, merge: the definition changes and the stored values stay — int
    // → text reads 11 as "11"; text → int reads null, and reads again once
    // retyped back. Replace: int, decimal and text values are converted in
    // place ("hello" → 0, "1.5" → 2, 11 → false as a bool) and stay converted;
    // text → timestamp over "hello" stops the deploy; bool and timestamp
    // columns are not converted.
    const lead = replace
      ? `${n} type — ${opts.subject} CONVERTS the stored values for good, and retyping back does not restore them: ` +
        `a value that converts does (int → text: 11 → "11"; text → int: "12" → 12, "1.5" → 2), one that does not ` +
        `becomes the type's empty value (text → int: "hello" → 0; int or decimal → bool: every value → false), and ` +
        `one it cannot convert stops the deploy partway (text → timestamp: "hello"). A pair that differs says so:`
      : `${n} type — ${opts.subject} changes only the definition and leaves the stored values: one that reads as ` +
        `the new type does (int → text: 11 reads "11"), one that does not reads null while the column has the new ` +
        `type, and reads again if it is retyped back:`;
    say(
      "plan.column-retype",
      lead,
      e.retypedColumns.map(
        (c) =>
          `${c.table}.${c.column} (${typeChange(c)})` +
          (replace ? replaceRetypeNote(c) : "") +
          (!replace && mergeReading(c) !== undefined ? ` — ${mergeReading(c)}` : "") +
          (omittedInsertsFail(c, e.mode) || setInsertsFail(c, e.mode) ? ` — ${insertsFailNote(c, e.mode)}` : unknownStorageNote(c, e.mode)),
      ),
    );
  }
  if (e.narrowedEnums.length > 0) {
    // Measured on both modes: rows are not rewritten; a removed value reads
    // null until restored.
    say(
      "plan.enum-values-removed",
      `${plural(e.narrowedEnums.length, "enum column loses", "enum columns lose")} values — ${opts.subject} changes ` +
        `only the definition: a row holding a removed value reads null until the value is restored:`,
      e.narrowedEnums.map((n) => `${n.table}.${n.column} (removes ${n.removed.map((v) => `"${v}"`).join(", ")})`),
    );
  }
  if (e.retargetedRefs.length > 0) {
    say(
      "plan.tableref-retarget",
      `${plural(e.retargetedRefs.length, "table reference points", "table references point")} at another ` +
        `table — ${opts.subject} keeps the ids the rows hold, which now name rows of the new table:`,
      e.retargetedRefs.map((r) => `${r.table}.${r.column} (${r.from} → ${r.to})`),
    );
  }
  if (e.indexChanges.length > 0) {
    const uniqueAdd = e.indexChanges.some((c) => c.action === "add" && c.unique);
    say(
      "plan.index-change",
      `${Subject} ${will} change ${plural(e.indexChanges.length, "index", "indexes")}` +
        (uniqueAdd ? " — a unique index it adds is refused if the rows already there hold duplicates for it:" : ":"),
      e.indexChanges.map((c) => `${c.action} ${c.table}: ${c.index}`),
    );
  }
  if (e.notNullKept.length > 0) {
    // Measured: a column created required keeps refusing a row without a value
    // (23502) after a merge relaxes it, while the export reads nullable; one
    // made required by an earlier merge was never enforced, and the export
    // reads the two alike. Only the run that makes the change can see it.
    say(
      "plan.not-null-kept",
      `${plural(e.notNullKept.length, "column becomes", "columns become")} nullable, and a merge does not relax a ` +
        `NOT NULL the table enforces: a column created required keeps refusing a row without a value (NOT NULL ` +
        `violation) while the export reads nullable — one made required by a merge was never enforced — and later ` +
        `deploys cannot see it:`,
      e.notNullKept,
    );
  }
  if (e.notNullTightened.length > 0) {
    // Measured, merge: rows holding null are not rewritten and read back as
    // the type's empty value — int 0, text "", and a date column's key is left
    // out. Replace: they are rewritten, and relaxing it later reads the empty
    // value still.
    say(
      "plan.not-null-tightened",
      replace
        ? `${plural(e.notNullTightened.length, "column stops", "columns stop")} being nullable — ${opts.subject} ` +
            `rewrites the rows that hold null there to the type's empty value (int 0, text "") for good: making it ` +
            `nullable again does not bring the nulls back:`
        : `${plural(e.notNullTightened.length, "column stops", "columns stop")} being nullable, and a merge does not ` +
            `rewrite the rows that hold null there: they read back as the type's empty value (int 0, text "", and a ` +
            `date column's key is left out of every row):`,
      e.notNullTightened.map((c) => `${c.table}.${c.column} (${authoredFieldType(c.type)})`),
    );
  }
}

/** One table a landing drops columns from and adds columns to. */
export interface PairedColumns {
  readonly table: string;
  readonly dropped: readonly string[];
  readonly added: readonly string[];
}

/**
 * The tables that lose columns and gain others in the same landing — what reads
 * as a rename. Only a plausible one: as many columns added as dropped, else each
 * dropped column paired with an added one whose name is near it (`sku` →
 * `skus`, `name` → `full_name`). Twenty-two drops beside one unrelated add is
 * not a rename.
 */
export function droppedAndAdded(e: TableEffects): PairedColumns[] {
  return droppedAndAddedAll(e).flatMap((p) => {
    if (p.dropped.length === p.added.length) return [p];
    const near = (a: string, b: string): boolean => {
      const [x, y] = [a.toLowerCase(), b.toLowerCase()];
      const shorter = Math.min(x.length, y.length);
      return (shorter >= 4 && suggest(x, [y]) !== undefined) || (shorter >= 3 && (x.includes(y) || y.includes(x)));
    };
    const pairs = p.dropped.flatMap((d) => {
      const a = p.added.find((c) => near(d, c));
      return a === undefined ? [] : [[d, a] as const];
    });
    if (pairs.length === 0) return [];
    return [{ table: p.table, dropped: pairs.map(([d]) => d), added: [...new Set(pairs.map(([, a]) => a))] }];
  });
}

function droppedAndAddedAll(e: TableEffects): PairedColumns[] {
  const column = (dotted: string): [string, string] => {
    const at = dotted.indexOf(".");
    return [dotted.slice(0, at), dotted.slice(at + 1)];
  };
  const out = new Map<string, { dropped: string[]; added: string[] }>();
  for (const d of e.droppedColumns) {
    const [table, name] = column(d);
    const entry = out.get(table) ?? { dropped: [], added: [] };
    entry.dropped.push(name);
    out.set(table, entry);
  }
  for (const a of e.addedColumns) {
    const [table, name] = column(a);
    out.get(table)?.added.push(name);
  }
  return [...out].filter(([, v]) => v.added.length > 0).map(([table, v]) => ({ table, ...v }));
}

/** The landings a value-keeping rename is staged across: what the flow that warns lands. */
export type RenameStages = "deploys" | "releases";

/** What a dropped-and-added pair does to the values, and the two-landing way to keep them. */
export function renameHint(p: PairedColumns, stages: RenameStages = "releases"): string {
  const list = (names: readonly string[]): string => names.join(", ");
  return (
    `${p.table} drops ${list(p.dropped)} and adds ${list(p.added)}. A column has no identity of its own to rename ` +
    `by, so this does not move the values: those in ${list(p.dropped)} are destroyed and ` +
    `${list(p.added)} start${p.added.length === 1 ? "s" : ""} empty. To keep them, land it as two ${stages}: one that ` +
    `adds ${list(p.added)} beside ${list(p.dropped)}, then backfill the rows, then one that drops ${list(p.dropped)}.`
  );
}

/** A public URL slug a landing moves: what the object serves now, and what it serves once landed. */
export interface CanonicalMove {
  /** The SDK kind: `apiGroup`, `mcpServer`, `agent`, `realtimeServer`. */
  readonly kind: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The slugs a server-held release moves on a destination: each object the
 * destination holds under the release's identity whose `canonical` differs —
 * what a promote and a tenant deploy, which have no plan, read instead of the
 * route's slug report. A new object moves nothing; it had no URL to lose.
 */
export function releaseCanonicalMoves(archive: unknown, live: unknown): CanonicalMove[] {
  const out: CanonicalMove[] = [];
  const held = payloadOf(live);
  for (const [section, rows] of Object.entries(payloadOf(archive))) {
    const there = held[section];
    if (!Array.isArray(rows) || !Array.isArray(there)) continue;
    for (const row of rows as unknown[]) {
      if (row === null || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (typeof r.guid !== "string" || r.guid === "" || typeof r.canonical !== "string" || r.canonical === "") continue;
      const current = (there as unknown[]).find(
        (l): l is Record<string, unknown> => l !== null && typeof l === "object" && (l as { guid?: unknown }).guid === r.guid,
      );
      const from = current?.canonical;
      if (typeof from !== "string" || from === "" || from === r.canonical) continue;
      out.push({ kind: sectionKind(section, r), name: typeof r.name === "string" ? r.name : "", from, to: r.canonical });
    }
  }
  return out;
}

/**
 * Say each public URL a landing moves, before it is confirmed — under the code
 * `deploy --to --dry-run` and `--keep-data` say it under. `when` ends the lead
 * where the move waits on something (`once the branch is live`).
 */
export function discloseCanonicalMoves(
  moves: readonly CanonicalMove[],
  opts: { subject: string; will?: "will" | "would"; when?: string },
): void {
  if (moves.length === 0) return;
  const Subject = opts.subject.charAt(0).toUpperCase() + opts.subject.slice(1);
  warn(
    `${Subject} ${opts.will ?? "will"} move ${plural(moves.length, "public URL", "public URLs")}${opts.when === undefined ? "" : ` ${opts.when}`} — ` +
      `every endpoint under the slug served now stops answering:`,
    "plan.canonical-change",
    moves.map((m) => `${m.kind} "${m.name}": ${m.from} → ${m.to}`),
  );
}

/** The moves as a confirmation question names them, with a leading space; empty for none. */
export function movesClause(moves: readonly CanonicalMove[], lead = "It"): string {
  if (moves.length === 0) return "";
  return (
    ` ${lead} MOVES ${moves.length === 1 ? "a public URL" : `${moves.length} public URLs`} (` +
    moves.map((m) => `${m.from} → ${m.to}`).join(", ") +
    `): the old ${moves.length === 1 ? "slug stops" : "slugs stop"} answering.`
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Why {@link releaseTableEffects} has no effects: `failure` is printable,
 * `read` names which read failed, and `cause` is the error itself (never
 * printed — the archive read's can carry its signed download link).
 */
export type TableEffectsUnread = { failure: string; read?: "archive" | "destination"; cause?: unknown };

/**
 * A server-held release's table effects on a destination, read from the release
 * archive and the destination's export — what a promote and a tenant deploy,
 * which hold no local build, have instead of a plan. `failure` when either
 * could not be read: not knowing is not evidence that nothing changes.
 */
export async function releaseTableEffects(
  loadArchive: () => Promise<unknown>,
  loadLive: () => Promise<ExportedBundle>,
  /** `replace` for a tenant deploy; a promote merges. */
  opts: { mode?: "merge" | "replace"; skipTables?: ReadonlySet<string> } = {},
): Promise<{ effects: TableEffects } | TableEffectsUnread> {
  let archive: unknown;
  try {
    archive = await loadArchive();
  } catch (err) {
    // Never printed: a failure here can carry the signed download link.
    return { failure: "the release archive could not be read", read: "archive", cause: err };
  }
  if (archive === undefined) return { failure: "the release carries no id to read its archive from" };
  let live: ExportedBundle;
  try {
    live = await loadLive();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason = withoutUrls(raw).replace(/\s+/g, " ").trim();
    return { failure: reason.length > 200 ? `${reason.slice(0, 200)}…` : reason, read: "destination", cause: err };
  }
  return { effects: tableEffects(archive, live, { ...opts, mode: opts.mode ?? "merge" }) };
}

/**
 * One read shared by everything in a run that needs it, cached only once it
 * has succeeded — a failed read is tried again by the next reader.
 */
export function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= read().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };
}

/**
 * The unique index a constraint stop most likely came from, when the server's
 * answer names none: the release's own new unique indexes. One names it; more
 * than one are the candidates.
 */
export function uniqueIndexCandidates(e: TableEffects | undefined): { table: string; index: string }[] {
  return (e?.indexChanges ?? []).filter((c) => c.action === "add" && c.unique).map((c) => ({ table: c.table, index: c.index }));
}

/**
 * A deploy the server stopped on its data, read from its answer: a constraint
 * the rows break, or (`conversion`) a stored value a retype cannot convert.
 */
export interface ConstraintStop {
  kind: "unique" | "not-null" | "foreign-key" | "conversion";
  table?: string;
  index?: string;
  column?: string;
  /** For `conversion`: the release's retypes it could have come from, when more than one could be. */
  retypes?: { table: string; column: string; from: string; to: string }[];
  /** A `conversion` the server answered as a NOT NULL violation: the converted value was empty, and the column refuses it. */
  notNull?: true;
  /**
   * The release's new unique indexes the stop could have come from, when the
   * answer names no table or index and more than one could be responsible.
   * With exactly one, `table` and `index` name it instead.
   */
  candidates?: { table: string; index: string }[];
}

/**
 * Name a unique-index stop the server's answer left unnamed (its message
 * carries neither table nor index) from the release's own new unique indexes.
 */
export function namedConstraint(stop: ConstraintStop, effects: TableEffects | undefined): ConstraintStop {
  const retyped = effects?.retypedColumns ?? [];
  // Measured: timestamp → int stops on a NOT NULL violation, the converted
  // value being empty. With no column made required, a retype is the cause.
  if (stop.kind === "not-null" && stop.column === undefined && retyped.length > 0 && (effects?.notNullTightened ?? []).length === 0) {
    return namedConstraint({ ...stop, kind: "conversion", notNull: true }, effects);
  }
  if (stop.kind === "conversion") {
    if (stop.column !== undefined) return stop;
    // The retypes that can stop a replace first (see `replaceCanStop`); with
    // none of those, every retype — an unmeasured pair can stop too.
    const stopping = effects?.mode === "replace" ? retyped.filter(replaceCanStop) : [];
    const from = stopping.length > 0 ? stopping : retyped;
    if (from.length === 1) {
      const c = from[0]!;
      return { ...stop, table: c.table, column: c.column, retypes: [{ ...c }] };
    }
    return from.length > 1 ? { ...stop, retypes: from.map((c) => ({ ...c })) } : stop;
  }
  if (stop.kind !== "unique" || stop.table !== undefined || stop.index !== undefined) return stop;
  const candidates = uniqueIndexCandidates(effects);
  if (candidates.length === 1) return { ...stop, table: candidates[0]!.table, index: candidates[0]!.index };
  return candidates.length > 1 ? { ...stop, candidates } : stop;
}

/** Where a stop happened, as ` (table "t", index "i")`, or its candidates; "" when nothing names it. */
export function constraintWhere(stop: ConstraintStop): string {
  const parts = [
    stop.table === undefined ? undefined : `table "${stop.table}"`,
    stop.index === undefined ? undefined : `index "${stop.index}"`,
    stop.column === undefined ? undefined : `field "${stop.column}"`,
  ].filter((p): p is string => p !== undefined);
  const retype = stop.retypes?.length === 1 ? stop.retypes[0] : undefined;
  if (parts.length > 0) return ` (${parts.join(", ")}${retype === undefined ? "" : `: ${typeChange(retype)}`})`;
  if (stop.retypes !== undefined && stop.retypes.length > 1) {
    return ` (one of: ${stop.retypes.map((c) => `${c.table}.${c.column} ${typeChange(c)}`).join("; ")})`;
  }
  if (stop.candidates !== undefined && stop.candidates.length > 0) {
    return ` (one of: ${stop.candidates.map((c) => `table "${c.table}" ${c.index}`).join("; ")})`;
  }
  return "";
}

/**
 * The data constraint a failed deploy's answer names, or `undefined` when it
 * names none. Only an answer from the server counts — the message of an HTTP
 * failure — never a transport error, whose outcome stays unknown.
 */
export function constraintStop(err: unknown): ConstraintStop | undefined {
  if (!(err instanceof TenantHttpError || err instanceof ReleaseHttpError)) return undefined;
  const m = err.message;
  const kind: ConstraintStop["kind"] | undefined = /\b23505\b|unique[ _]violation|duplicate key/i.test(m)
    ? "unique"
    : /\b23502\b|not[ _-]null[ _]violation/i.test(m)
      ? "not-null"
      : /\b23503\b|foreign[ _]key[ _]violation/i.test(m)
        ? "foreign-key"
        : // Data exceptions: a value that does not read as the column's new
          // type (22P02), is out of its range (22003), or is not a date (22007, 22008).
          /\b22(?:P02|003|007|008|018)\b|invalid (?:text|input) (?:representation|syntax)|out of range/i.test(m)
          ? "conversion"
          : undefined;
  if (kind === undefined) return undefined;
  const table = /\b(?:table|relation) "([^"]+)"/i.exec(m)?.[1];
  const index = /\b(?:constraint|index) "([^"]+)"/i.exec(m)?.[1];
  const column = /\bKey \(([^)]+)\)=/.exec(m)?.[1] ?? /\bcolumn "([^"]+)"/i.exec(m)?.[1];
  return {
    kind,
    ...(table === undefined ? {} : { table }),
    ...(index === undefined ? {} : { index }),
    ...(column === undefined ? {} : { column }),
  };
}

export const CONSTRAINT_PHRASE: Record<ConstraintStop["kind"], string> = {
  unique: "a unique index",
  "not-null": "a required column",
  "foreign-key": "a reference",
  conversion: "a column type (a stored value does not convert to it)",
};

export const CONSTRAINT_FIX: Record<ConstraintStop["kind"], string> = {
  unique: "Make the rows that share a value in the newly unique field distinct (or drop the unique index from the release)",
  "not-null": "Fill the rows the newly required field is empty in (or give the field a default in the release)",
  "foreign-key": "Remove or repoint the rows that reference a row that is not there",
  conversion: "Change the stored values that do not read as the new type (or drop the retype from the release)",
};

