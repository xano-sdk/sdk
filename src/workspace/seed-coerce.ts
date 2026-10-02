/**
 * Pure seed validation + coercion — no `node:` imports, so it runs on the
 * browser-safe `export()` path as well as the Node deploy path.
 *
 * The split exists because the two paths disagreed on what was LEGAL:
 * `xanosdk export`/`deploy` materialised seed rows and checked them, while
 * `app.export()` / `emitBundle()` / `writeBundle()` never touched `seed` at all,
 * so the same workspace failed loudly through one documented entry point and
 * succeeded silently through the other. Everything here is reachable from both.
 *
 * What stays in `seed.ts` is the part that genuinely needs Node: reading a
 * `seedFile`, awaiting a thunk, deriving a uuid, signing the content envelope.
 */
import { DiagnosticError, numberedList, problemCount, type Diagnostic } from "./diagnostics.js";
import { SCALAR_FAMILY, normalizeIndexType, type ColumnDef, type IndexDef, type SeedRow } from "../kinds/table.js";
import { COLUMN_NULLABLE_TYPES } from "../fields/field.js";
import { isListColumn } from "../fields/field.js";
import { isHostedFile } from "../fields/hosted-file.js";
import { authoredFieldType } from "../fields/field.js";
import { emailAddress } from "../fields/email-address.js";
import type { XanoGeoData } from "../fields/value-types.js";

/**
 * Coerce one column value to its wire form, or throw a located error. Switched
 * on the column's scalar FAMILY ({@link SCALAR_FAMILY}), the grouping the row-cell
 * coercer reads too, so the two cannot drift about which types are alike. A type
 * with no family (`json`, `geo_*`, `vector`, `blob_*`, `date`, …) falls through
 * and ships its JSON value as-authored, since the engine accepts the stored JSON
 * form directly.
 *
 * The POLICY stays local and is deliberately looser than the row cell's: a seed
 * is data being loaded, so an `epochms` takes a `Date` or a parseable string
 * here where a row cell demands the whole number it will encode.
 */
function coerceScalarValue(
  label: string,
  column: string,
  type: string,
  value: unknown,
  values?: readonly (string | number)[],
  /** A scalar column (not a list element), its table's layout and a vector's size — what the uuid, email, vector, date and decimal checks were measured on. */
  scalar?: { useXdo: boolean; vectorSize?: number },
): unknown {
  // A null reaching here is one the column accepts (see `acceptsSeedNull`).
  if (value === null) return null;
  // A file column keeps the marker for the deploy path to resolve; anywhere else
  // it would serialize to `{}` and store an empty object.
  if (isHostedFile(value)) {
    if (type.startsWith("blob")) return value;
    throw new Error(
      `${label}, column "${column}" (${authoredFieldType(type)}): hostedFile() goes in a file column (image, video, audio or attachment), ` +
        `not a ${authoredFieldType(type)} column. Fix the seed value or the column type.`,
    );
  }
  // Measured: a uuid column stores a string that is no uuid as null, silently.
  if (scalar !== undefined && type === "uuid" && !(typeof value === "string" && UUID.test(value))) {
    throw located(label, column, type, value, 'a uuid ("0b2d382e-dd81-4d56-a291-ecf899ca1d33")');
  }
  // Measured: an email column stores a string that is no address as "", silently.
  if (scalar !== undefined && type === "email" && !(typeof value === "string" && emailAddress(value))) {
    throw located(label, column, type, value, 'an email address ("ada@example.com")');
  }
  // Measured: a vector column stores a value of the wrong length as null, silently.
  if (scalar !== undefined && type === "vector") {
    const size = scalar.vectorSize ?? 3;
    if (!(Array.isArray(value) && value.length === size && value.every((n) => typeof n === "number" && Number.isFinite(n)))) {
      throw located(label, column, type, value, `an array of exactly ${size} numbers (the column's size)`);
    }
    return value;
  }
  // A geo column takes the `{ type, data }` its own `type` name spells (see XanoGeoValue).
  if (scalar !== undefined && Object.hasOwn(GEO_TYPE, type)) {
    const problem = geoProblem(GEO_TYPE[type]!, value);
    if (problem !== undefined) throw located(label, column, type, value, problem);
    return value;
  }
  // Measured: a date column rolls an impossible day over ("2026-13-45" stores
  // 2027-02-14) and stores a non-date as today, or null when nullable.
  if (scalar !== undefined && type === "date") {
    if ((typeof value === "number" && Number.isFinite(value)) || (value instanceof Date && Number.isFinite(value.getTime()))) {
      return value;
    }
    if (typeof value === "string" && isCalendarDate(value)) return value;
    throw located(label, column, type, value, 'a real calendar date ("2026-01-31"), or epoch milliseconds');
  }
  switch ((Object.hasOwn(SCALAR_FAMILY, type) ? SCALAR_FAMILY[type] : undefined)) {
    case "int":
      return wholeNumber(label, column, type, value);
    case "decimal": {
      let n: number | undefined;
      if (typeof value === "number" && Number.isFinite(value)) n = value;
      else if (typeof value === "bigint") n = Number(value);
      else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) n = Number(value);
      if (n === undefined) throw located(label, column, type, value, "a number");
      if (scalar?.useXdo === false && Math.abs(Math.round(n * 1e5) / 1e5) >= FIXED_DECIMAL_LIMIT) {
        throw new SeedCellError(
          (where, shown) =>
            `${where}, column "${column}" (decimal): ${shown} is out of range — a decimal on a table without ` +
            `\`useXdo: true\` (its own, or the workspace's) holds under 1000000000 (9 digits left of the point), and the ` +
            `deploy fails on a larger one. Store it in an \`f.int\`, or give the table \`useXdo: true\`.`,
          label,
          value,
        );
      }
      return n;
    }
    case "epochms": {
      // Measured: the engine stores the epoch ms handed to it, so a string is read
      // here — strictly, so a rolled-over day or a machine's own zone never reaches it.
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
      if (typeof value === "string") {
        const ms = isoInstant(value);
        if (ms !== undefined) return ms;
      }
      throw located(
        label,
        column,
        type,
        value,
        'epoch ms, a Date, or ISO 8601 with Z or an offset ("2026-01-31T10:00:00Z"; a bare "2026-01-31" is ' +
          "midnight UTC) — a date-time without a zone reads differently per machine, so add Z or an offset",
      );
    }
    case "bool": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      throw located(label, column, type, value, "a boolean");
    }
    case "text": {
      if (typeof value === "string") return value;
      throw located(label, column, type, value, "a string");
    }
    case "enum": {
      // The one column type the TYPE SYSTEM cannot police on a deferred seed: a
      // JSON module's strings widen to `string`, never the literal union, so
      // the thunk/file forms accept any string at author time.
      // Membership is therefore checked here, where the value and the column's
      // declared options are both in hand. An enum with no options is a real,
      // engine-supported shape (a column added in the editor and not yet given
      // its values) and permits nothing, so it is left to the engine.
      if (!values || values.length === 0) return value;
      if (values.includes(value as string | number)) return value;
      if (typeof value === "number" && !Number.isFinite(value)) throw located(label, column, type, value, "one of its values");
      const allowed = values.map((v) => JSON.stringify(v)).join(", ");
      throw new SeedCellError(
        (where, shown) =>
          `${where}, column "${column}" (enum): ${shown} is not one of its ` +
          `declared values (${allowed}). Fix the seed value or add it to the column's enum.`,
        label,
        value,
      );
    }
    default:
      // A type with no scalar family (`json`, `object`, `vector`, `geo_*`, …)
      // ships its value as authored — but it still has to survive JSON, which
      // is how the deploy archive carries it. See {@link assertJsonCarryable}.
      assertJsonCarryable(label, column, type, value);
      return value;
  }
}

/**
 * Refuse a seed value JSON cannot carry, before it reaches the archive.
 *
 * Seed rows ride to the engine as a `content/<guid>-<page>.json` archive entry,
 * and the import `json_decode`s it. `JSON.stringify` does not fail on the values
 * that break that trip — it REWRITES them. A `NaN` or an `Infinity` becomes
 * `null`, a function or a symbol makes its key vanish, and the row inserts with
 * a column silently emptied. A `BigInt` is the one that throws, and it threw as
 * a bare `TypeError` naming no table, row, or column.
 *
 * The scalar families above already reject these where they can (an `int` column
 * demands a finite number). This covers the types that have no family and were
 * passed through as-authored — the `json`/`object`/`vector` columns whose value
 * is an arbitrary nested structure, which is exactly where a stray computed
 * `NaN` hides. Cycles are refused for the same reason: `JSON.stringify` throws
 * on one, and the author needs to be told which row it was in.
 */
function assertJsonCarryable(label: string, column: string, type: string, value: unknown): void {
  const seen = new Set<object>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      if (Number.isFinite(node)) return;
      throw jsonRefusal(label, column, type, path, `${node}, which is not a storable number`,
        "JSON has no NaN or Infinity, so it would ship as `null` and the column would import empty");
    }
    if (typeof node === "bigint") {
      throw jsonRefusal(label, column, type, path, "a BigInt",
        "JSON cannot carry one — convert it to a number or a string first");
    }
    if (typeof node === "function" || typeof node === "symbol") {
      throw jsonRefusal(label, column, type, path, `a ${typeof node}`,
        "JSON drops it, so the key would vanish from the imported row");
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) {
      throw jsonRefusal(label, column, type, path, "a circular reference",
        "JSON cannot carry one — the archive would fail to serialize");
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((el, i) => walk(el, `${path}[${i}]`));
    } else {
      for (const [key, member] of Object.entries(node)) walk(member, `${path}.${key}`);
    }
    seen.delete(node);
  };
  walk(value, `"${column}"`);
}

function jsonRefusal(
  label: string,
  column: string,
  type: string,
  path: string,
  got: string,
  why: string,
): Error {
  return new Error(
    `${label}, column "${column}" (${authoredFieldType(type)}): ${path} is ${got}. ${why}. ` +
      `Seed rows are carried to the engine as JSON — fix the value or the column type.`,
  );
}

/**
 * Coerce one column value, honoring an `array` column: an array-typed column
 * expects an array (or null) and each element is coerced by the base type;
 * a scalar column coerces the value directly. A non-array value for an array
 * column (or vice-versa) throws, named by column (and element index).
 */
function coerceColumnValue(label: string, col: ColumnDef, value: unknown, useXdo: boolean): unknown {
  if (value === null) return null;
  if (isListColumn(col)) {
    if (!Array.isArray(value)) throw located(label, col.name, `${authoredFieldType(col.type)}[]`, value, "an array");
    return value.map((el, j) =>
      coerceScalarValue(label, `${col.name}[${j}]`, col.type, el, col.values),
    );
  }
  return coerceScalarValue(label, col.name, col.type, value, col.values, { useXdo, vectorSize: col.vector?.size });
}

/**
 * What an int column asks for when handed a JS number past ±2^53. Such a number
 * holds only some whole numbers exactly, so whether it kept the digits written
 * cannot be told from it (E2E pass 41: 1000000000000000000 kept them, and was
 * told it had lost them): it is named as it reads, and refused either way.
 */
function unsafeIntRemedy(n: number): string {
  const reads = BigInt(n).toString();
  return (
    `a whole number within ±9007199254740991 — past that a JS number cannot hold every whole number, so this ` +
    `one reads as ${reads}, which may not be the digits written; write the digits meant as a digit string or a ` +
    `BigInt — as it reads now, "${reads}" or ${reads}n — and in a seedFile quote it in the JSON`
  );
}

/** The int64 bounds an int column holds. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * An int column's value: a whole number inside int64. Measured: the engine
 * truncates a fraction (2.5 stores 2, "7.9" stores 7) and stores 0 for a value
 * past int64, so both are refused rather than changed. A whole number past
 * 2^53 ships as its digits, which the engine stores exactly; a JS number that
 * large may not hold the digits written, so it is refused for a string or a BigInt.
 */
function wholeNumber(label: string, column: string, type: string, value: unknown): number | string {
  let big: bigint | undefined;
  if (typeof value === "bigint") big = value;
  else if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) big = BigInt(value.trim());
  else {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(n) && !Number.isInteger(n)) {
      throw located(label, column, type, value, "a whole number (an int column drops the fraction)");
    }
    if (Number.isInteger(n)) {
      if (!Number.isSafeInteger(n) && Math.abs(n) <= 2 ** 63) {
        throw located(label, column, type, value, unsafeIntRemedy(n));
      }
      big = BigInt(n);
    }
  }
  if (big === undefined) throw located(label, column, type, value, "a number");
  if (big < INT64_MIN || big > INT64_MAX) {
    throw located(label, column, type, value, "a whole number within int64 (±9223372036854775807)");
  }
  const n = Number(big);
  return Number.isSafeInteger(n) ? n : big.toString();
}

/**
 * Epoch ms for an ISO 8601 date (midnight UTC) or a date-time carrying `Z` or
 * an offset; undefined for anything else, a day or time the calendar lacks
 * included. A date-time without a zone is refused: it reads as the deploying
 * machine's local time, so one project would seed different instants.
 */
function isoInstant(value: string): number | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}(?::?\d{2})?))?$/.exec(value);
  if (m === null) return undefined;
  const [y, mo, d, h = 0, mi = 0, sec = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((v) => (v === undefined ? undefined : Number(v))) as number[];
  if (!isCalendarDate(`${m[1]}-${m[2]}-${m[3]}`) || h! > 23 || mi! > 59 || sec! > 59) return undefined;
  let offset = 0;
  const zone = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8] ?? "");
  if (zone !== null) {
    const [oh, om] = [Number(zone[2]), Number(zone[3] ?? 0)];
    if (oh > 23 || om > 59) return undefined;
    offset = (zone[1] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const at = new Date(Date.UTC(2000, mo! - 1, d!, h, mi, sec, Number((m[7] ?? "").padEnd(3, "0").slice(0, 3))));
  at.setUTCFullYear(y!);
  return at.getTime() - offset;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a uuid in its hyphenated form, either case. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The `type` name each geo column takes in its `{ type, data }` value. */
const GEO_TYPE: Readonly<Record<string, keyof XanoGeoData>> = {
  geo_point: "point",
  geo_multipoint: "points",
  geo_linestring: "path",
  geo_multilinestring: "paths",
  geo_polygon: "poly",
  geo_multipolygon: "polys",
};

/**
 * What a geo seed value should have been, or undefined when it has the
 * column's `{ type, data }` shape. A string passes: it may be WKT, which the
 * column takes as written.
 */
function geoProblem(name: keyof XanoGeoData, value: unknown): string | undefined {
  if (typeof value === "string") return undefined;
  const position = (p: unknown): boolean =>
    typeof p === "object" && p !== null && Number.isFinite((p as { lng?: unknown }).lng) && Number.isFinite((p as { lat?: unknown }).lat);
  const positions = (d: unknown): boolean => Array.isArray(d) && d.every(position);
  const v = value as { type?: unknown; data?: unknown } | null;
  const data = typeof v === "object" && v !== null && !Array.isArray(v) && v.type === name ? v.data : undefined;
  const fits =
    name === "point" ? position(data) : name === "paths" || name === "polys" ? Array.isArray(data) && data.every(positions) : positions(data);
  if (fits) return undefined;
  const shape = name === "point" ? "{ lng, lat }" : name === "paths" || name === "polys" ? "[[{ lng, lat }, …], …]" : "[{ lng, lat }, …]";
  return `{ type: "${name}", data: ${shape} } (not GeoJSON)`;
}

/**
 * Measured: a normalized table's decimal is 14 digits with 5 decimal places, so
 * a value that rounds to this magnitude or past it fails the deploy (SQL 22003).
 */
const FIXED_DECIMAL_LIMIT = 1e9;

/** `YYYY-MM-DD` naming a day the calendar has, optionally followed by a time the engine drops. */
function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return mo >= 1 && mo <= 12 && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

function located(
  label: string,
  column: string,
  type: string,
  value: unknown,
  expected: string,
): Error {
  const got = value instanceof Date ? "Date" : Array.isArray(value) ? "array" : typeof value;
  // NaN and ±Infinity have no JSON form, so the shown value would read `null`.
  const nonFinite = typeof value === "number" && !Number.isFinite(value);
  return new SeedCellError(
    (where, shown) =>
      `${where}, column "${column}" (${authoredFieldType(type)}): ` +
      (nonFinite
        ? `${String(value)} is not a storable number. `
        : `expected ${expected}, got ${got} (${shown}). `) +
      `Fix the seed value or the column type.`,
    label,
    value,
  );
}

/**
 * A cell refusal that names its offending value apart from its row, so the
 * same problem across many rows reads as one entry.
 */
class SeedCellError extends Error {
  constructor(
    readonly render: (where: string, shown: string) => string,
    where: string,
    readonly value: unknown,
  ) {
    super(render(where, shownValue(value)));
  }
}

/** Longest a shown offending value runs before it is cut: a seed value can be a whole document. */
const SHOWN_MAX = 80;

/** An offending value as a message shows it: its JSON, cut at {@link SHOWN_MAX} characters. */
function shownValue(value: unknown): string {
  const json = typeof value === "bigint" ? `${value}n` : (JSON.stringify(value) ?? String(value));
  return json.length > SHOWN_MAX ? `${json.slice(0, SHOWN_MAX - 1)}…` : json;
}

/** One row's problem: its text for any `where` (the row's label, or a group's). */
interface RowProblem {
  readonly row: number;
  readonly render: (where: string, shown: string) => string;
  readonly value?: unknown;
}

/** Row indexes and offending values a grouped problem names before eliding the rest. */
const GROUP_SAMPLE = 5;

/**
 * One message per distinct problem in a table's seed: a problem repeated across
 * rows is said once, with its row count, the first row indexes, and the first
 * distinct offending values. A problem on one row reads as before.
 */
function groupRowProblems(tableName: string, problems: readonly RowProblem[]): string[] {
  const groups = new Map<string, RowProblem[]>();
  for (const p of problems) {
    const key = p.render("\u0000", "\u0000");
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [p]);
    else list.push(p);
  }
  return [...groups.values()].map((list) => {
    const first = list[0]!;
    if (list.length === 1) return first.render(`table "${tableName}", seed row ${first.row}`, shownValue(first.value));
    const rows = list.slice(0, GROUP_SAMPLE).map((p) => p.row).join(", ") + (list.length > GROUP_SAMPLE ? ", …" : "");
    const distinct = [...new Set(list.map((p) => shownValue(p.value)))];
    const shown =
      distinct.slice(0, GROUP_SAMPLE).join(", ") + (distinct.length > GROUP_SAMPLE ? `, … (${distinct.length} distinct)` : "");
    return first.render(`table "${tableName}", ${list.length} seed rows (${rows})`, shown);
  });
}

/**
 * Validate + coerce seed rows against a table's columns. Every row must be
 * a plain object whose keys are all declared columns; each value is coerced to
 * its column's wire form. Unknown columns and un-coercible values throw, named
 * by table + row index + column — the loud counterpart to the engine's silent
 * per-row drop. Omitted columns are left absent (the engine applies its
 * default).
 *
 * Primary keys are NOT filled here — see `assignPrimaryKeys` in `seed.ts`, which
 * needs a derived uuid. {@link assertSeedIds} is the pure half of that check and
 * runs on both paths.
 */
export function coerceSeedRowValues(
  tableName: string,
  columns: ColumnDef[],
  rows: readonly SeedRow[],
  /** The table's layout: a decimal on a normalized one has a fixed size. */
  opts: { useXdo?: boolean } = {},
): Record<string, unknown>[] {
  const colByName = new Map(columns.map((c) => [c.name, c]));
  const mustSupply = columns.filter(mustSupplyInSeed);
  // Every bad row is reported, not the first: a seed file is fixed in one pass.
  const problems: RowProblem[] = [];
  const out = rows.map((row, i) => {
    const label = `table "${tableName}", seed row ${i}`;
    const say = (render: (where: string) => string): void => {
      problems.push({ row: i, render });
    };
    // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
    // stored here, where assigning it on a plain `{}` sets a prototype instead.
    const coerced = Object.create(null) as Record<string, unknown>;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      const got = Array.isArray(row) ? "array" : typeof row;
      say((where) => `${where}: expected a row object, got ${got}.`);
      return coerced;
    }
    for (const [key, value] of Object.entries(row)) {
      // An explicit `undefined` (e.g. from spreading an optional field) is treated
      // as an omitted column, matching JSON.stringify — not a coercion error.
      if (value === undefined) continue;
      const col = colByName.get(key);
      if (col === undefined) {
        // The name is the offending value, so unknown columns across rows group as one problem.
        const known = columns.map((c) => c.name).join(", ");
        problems.push({
          row: i,
          render: (where, shown) => `${where}: unknown column ${shown} (not in table schema). Known columns: ${known}.`,
          value: key,
        });
        continue;
      }
      if (value === null && !acceptsSeedNull(col)) {
        say(
          (where) =>
            `${where}, column "${key}" (${authoredFieldType(col.type)}): null in a column that is not nullable. The engine does not ` +
            `store it as null — a date fails the deploy, int/decimal/timestamp store 0, text "", bool false. ` +
            `Give the column \`nullable: true\`, or the row a value.`,
        );
        continue;
      }
      try {
        coerced[key] = coerceColumnValue(label, col, value, opts.useXdo === true);
      } catch (err) {
        if (err instanceof SeedCellError) problems.push({ row: i, render: err.render, value: err.value });
        else {
          // A refusal that names no value: everything after the row's label is the problem.
          const message = (err as Error).message;
          const rest = message.startsWith(label) ? message.slice(label.length) : null;
          say((where) => (rest === null ? message : where + rest));
        }
      }
    }
    // The typed inline seed makes a missing `required` column a compile error;
    // a `seedFile` (or an untyped thunk) had no check at all and exported clean.
    // Read on the row as written: a null or invalid value is its own problem, not a missing one.
    const missing = mustSupply.filter((c) => (row as Record<string, unknown>)[c.name] === undefined).map((c) => `"${c.name}"`);
    if (missing.length > 0) {
      say(
        (where) =>
          `${where}: missing required column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ` +
          `Supply ${missing.length === 1 ? "it" : "them"} on every row, or give the column a \`default\` (or \`nullable: true\`).`,
      );
    }
    return coerced;
  });
  problems.push(...partlySetDates(columns, rows));
  if (problems.length > 0) throw seedError(groupRowProblems(tableName, problems), tableName);
  return out;
}

/**
 * Measured: the import fails (SQL 42601, naming nothing) on a date column with
 * no default that is not nullable when a seed sets it on some rows and leaves
 * it out on others. A `required` one is said missing instead.
 */
function partlySetDates(columns: readonly ColumnDef[], rows: readonly SeedRow[]): RowProblem[] {
  const out: RowProblem[] = [];
  for (const col of columns) {
    if (col.type !== "date" || isListColumn(col) || acceptsSeedNull(col) || col.default !== undefined || mustSupplyInSeed(col)) continue;
    const isSet = (row: SeedRow): boolean =>
      row !== null && typeof row === "object" && (row as Record<string, unknown>)[col.name] !== undefined;
    const set = rows.filter(isSet).length;
    if (set === 0 || set === rows.length) continue;
    rows.forEach((row, i) => {
      if (isSet(row)) return;
      out.push({
        row: i,
        render: (where) =>
          `${where}: leaves out date column "${col.name}", which ${set} other seed row${set === 1 ? " sets" : "s set"} — ` +
          `the deploy fails on a date column set on some rows and not others. Set it on every row or none, or give ` +
          `the column a \`default\` or \`nullable: true\`.`,
      });
    });
  }
  return out;
}

const NULLABLE_BY_DEFAULT: ReadonlySet<string> = new Set(COLUMN_NULLABLE_TYPES);

/**
 * Whether a seed row may hold `null` in this column: a nullable one (declared,
 * or by its type's default), a list, or `json`, which stores null as null.
 * Measured live: in a non-nullable column a null date fails the deploy (or
 * stores today's date), a uuid or vector fails it, and int/decimal/timestamp
 * store 0, text-like types "", bool false — never the null that was written.
 */
function acceptsSeedNull(col: ColumnDef): boolean {
  if (col.type === "json" || isListColumn(col)) return true;
  return col.nullable === true || (col.nullable === undefined && NULLABLE_BY_DEFAULT.has(col.type));
}

/**
 * A column a seed row must spell: `required`, with no `default` for an omitted
 * one to take, and not nullable (an omitted nullable column stores null, which
 * the typed seed row accepts too). The system `id`/`created_at` are filled in.
 * A `json` column is never one: an omitted one stores `{}` (the type's own
 * default), and its typed seed key is optional too — its value type admits null.
 */
function mustSupplyInSeed(col: ColumnDef): boolean {
  if (col.required !== true || col.default !== undefined) return false;
  if (col.name === "id" || col.name === "created_at" || col.type === "json") return false;
  return col.nullable === false || (col.nullable === undefined && !NULLABLE_BY_DEFAULT.has(col.type));
}

/**
 * The refusal for a set of seed problems — an export failure (`SDK_EXPORT_INVALID`),
 * one `seed.invalid` detail per problem, listed together. Past
 * {@link SEED_PROBLEMS_LISTED} the rest are counted on one unnumbered line,
 * naming `table` when they are all one table's.
 */
export function seedError(problems: readonly string[], table?: string): DiagnosticError {
  const listed = problems.slice(0, SEED_PROBLEMS_LISTED);
  const rest = problems.length - listed.length;
  const details: Diagnostic[] = listed.map((message) => ({ severity: "error", code: "seed.invalid", message }));
  if (rest > 0) {
    details.push({
      severity: "error",
      code: "seed.invalid",
      message:
        `… and ${rest} more seed problem${rest === 1 ? "" : "s"}${table === undefined ? "" : ` in table "${table}"`}, ` +
        `not listed — fix these and export again to see them.`,
      unlisted: rest,
    });
  }
  return seedFailure(details);
}

/** One refusal carrying `details`, seed problems from one table or several. */
export function seedFailure(details: readonly Diagnostic[]): DiagnosticError {
  const total = problemCount(details);
  return new DiagnosticError(
    details.length === 1
      ? `xanosdk: ${details[0]!.message}`
      : `xanosdk: ${total} seed problems.\n${numberedList(details)}`,
    details,
  );
}

/** How many seed problems a refusal lists before it counts the rest. */
const SEED_PROBLEMS_LISTED = 20;

/**
 * Refuse a seed that sets `id` on SOME rows and omits it on the rest.
 *
 * The content-import path preserves each row's `id` and never auto-assigns one,
 * for every key type, so a mix collides on the primary key. All-or-nothing is
 * the only unambiguous reading: which keys would be free to fill?
 *
 * Returns whether the omitted ids still need filling (`true` when NO row set
 * one), which is what `assignPrimaryKeys` acts on.
 */
export function assertSeedIds(
  tableName: string,
  columns: ColumnDef[],
  rows: readonly Record<string, unknown>[],
): boolean {
  const idType = columns.find((c) => c.name === "id")?.type;
  if (idType !== "int" && idType !== "uuid") return false;
  const withId = rows.filter((r) => r.id !== undefined).length;
  if (withId === rows.length) return false; // all explicit — nothing to fill
  if (withId !== 0) {
    const fill = idType === "int" ? "auto-numbered 1..N" : "assigned a generated uuid";
    throw new Error(
      `table "${tableName}": ${withId} of ${rows.length} seed rows set \`id\` and the rest omit it. ` +
        `The engine preserves seed ids and won't auto-fill a missing one, so a mix collides on the ` +
        `primary key. Provide \`id\` for every seed row, or none (they'll be ${fill}).`,
    );
  }
  return true;
}

/**
 * Refuse seed rows that repeat a value over a unique index (`unique`, or the
 * primary key) — single or compound. The import fails on the first duplicate
 * with a constraint error naming neither the table nor the rows. A row with a
 * null or absent value in an indexed column is skipped: a unique index admits
 * any number of NULLs. A dotted (JSON-path) index field is not checked.
 */
export function assertSeedUnique(
  tableName: string,
  indexes: readonly IndexDef[],
  rows: readonly Record<string, unknown>[],
): void {
  for (const index of indexes) {
    const type = normalizeIndexType(index.type);
    if (type !== "primary" && !type.split("|").includes("unique")) continue;
    const names = index.fields.map((f) => f.name);
    if (names.length === 0 || names.some((n) => n.includes("."))) continue;
    const seen = new Map<string, number>();
    rows.forEach((row, i) => {
      const values = names.map((n) => row[n]);
      if (values.some((v) => v === null || v === undefined)) return;
      const key = JSON.stringify(values);
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, i);
        return;
      }
      const shown = names.length === 1 ? `${names[0]} = ${JSON.stringify(values[0])}` : `(${names.join(", ")}) = (${values.map((v) => JSON.stringify(v)).join(", ")})`;
      throw new Error(
        `table "${tableName}": seed rows ${first} and ${i} both have ${shown}, which the ` +
          `${type === "primary" ? "primary key" : `unique index on (${names.join(", ")})`} allows once — the import ` +
          `fails on the duplicate. Make the values distinct, or drop one row.`,
      );
    });
  }
}

/**
 * Whether a column's seed values are non-public — what the `deploy --static`
 * scan looks for, and what a table's `publicSeed` may exempt.
 *
 * Lives here, beside the coercer, because the browser-safe export guards need it
 * too and `seed.ts` reaches `node:fs`.
 *
 * Scoped deliberately. A PUBLIC column's seed value is already readable through
 * the deployed API, so finding it in a static bundle discloses nothing new and
 * refusing on it would be noise. What matters is a value the schema says never
 * leaves the server:
 *
 *   • `access: "internal"` — omitted from API output entirely (`f.password`'s
 *     default), so the plaintext exists ONLY in the seed file and in whatever a
 *     bundler copied it into.
 *   • `sensitive: true` — the author's explicit "do not surface this".
 *   • `type: "password"` — a credential column, whatever it declares.
 *
 * `access: "private"` is NOT included: private columns are still returned in
 * responses (the system `created_at` is private and comes back on every read),
 * so they carry no additional exposure here.
 *
 * **Why `type` is tested and not only the two declarations.** This rule runs
 * over two different inputs: LOCAL table defs, which carry everything the author
 * wrote, and rows read back from the meta table route, which do not.
 *
 * Measured 2026-09-11 against a live instance. A listed column carries `name`,
 * `type`, `description`, `nullable`, `required`, `access` and `style` (plus
 * `default`, `validators`, `values` or `children` where they apply) — and no
 * `sensitive` key on any of the 25 columns read, including a `type: "password"`
 * column that came back `access: "public"`. So for server-sourced rows the first
 * two tests reduce to `access === "internal"`, and no column in that workspace
 * declared it: the guard would have warned about nothing while a password
 * column's values rode into a release.
 *
 * `type` comes back on every listed column, so it is the arm that makes the
 * warning real on the path that reads from a server. It also covers the local
 * path, where a password column explicitly made public would otherwise pass.
 */
export function isNonPublicColumn(col: {
  access?: unknown;
  sensitive?: unknown;
  type?: unknown;
}): boolean {
  return col.access === "internal" || col.sensitive === true || col.type === "password";
}
