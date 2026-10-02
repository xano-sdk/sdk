/**
 * Seed-content assembly. Turns a table's authored `seed` rows into the
 * signed `content/<table-guid>-<page>.json` archive entries the workspace-import
 * transport inserts on deploy.
 *
 * The engine parses each content file's `payload` (a plain row array) against the
 * table's schema and inserts the rows in the import transaction — and it swallows
 * per-row errors silently. So the loud validation lives HERE: a row with an
 * unknown column or an un-coercible value is a hard build-time error naming the
 * table, row index, and column, rather than data that vanishes on deploy.
 *
 * Node-only in practice: this is invoked from the deploy/compile path, never from
 * the browser-safe `export()` — that's what keeps seed VALUES out of any frontend
 * bundle (a table def's `seed` may be a deferred thunk resolved only here).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isMissingFile } from "../util/local-file.js";
import { LocalFileNotFoundError } from "../emit/errors.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TableDef, ColumnDef, SeedRow, SeedSource } from "../kinds/table.js";
import { SEED_FILE, isSeedFileSource, tableColumns, tableIndexes } from "../kinds/table.js";
import { resolveRef } from "../refs/guid.js";
import { buildContentEnvelope } from "./export.js";
import { coerceSeedRowValues, assertSeedIds, assertSeedUnique, isNonPublicColumn, seedFailure } from "./seed-coerce.js";
import { DiagnosticError, type Diagnostic } from "./diagnostics.js";
import { hostedFileColumnValue, hostedFileResolver, type HostedFileResolver } from "./hosted-file.js";
import { isHostedFile } from "../fields/hosted-file.js";

/**
 * One archive member (structurally an `ArchiveEntry`): its in-archive path and
 * the serialized signed `type:"content"` envelope written there.
 */
export interface SeedContentFile {
  /** `content/<table-guid>-<page>.json` (page 1-based, contiguous). */
  name: string;
  /** The serialized signed `type:"content"` envelope. */
  content: string;
}

/**
 * Target size for one content page's row array, in bytes of coerced JSON. The
 * import reads pages `1..N` per table until one is missing, so splitting a large
 * seed across pages keeps any single archive entry bounded. A page always holds
 * at least one row (a single row larger than the budget still ships whole).
 */
export const SEED_PAGE_TARGET_BYTES = 512 * 1024;

/**
 * Resolve a {@link SeedSource} (array, thunk, or async thunk) to its rows.
 *
 * A dynamic `import()` of a JSON file — `seed: () => import("./seed.json")`, the
 * form the docs recommend — resolves to a MODULE NAMESPACE, not the array: the
 * rows are on `.default`. TypeScript types `import("./x.json")` as the JSON shape
 * itself, so the thunk type-checks and only the runtime disagrees. Unwrap it here
 * rather than making every author remember `.then(m => m.default)`.
 */
export async function resolveSeedRows(source: SeedSource): Promise<SeedRow[]> {
  if (isSeedFileSource(source)) return readSeedFile(source[SEED_FILE]);
  const resolved = typeof source === "function" ? await source() : source;
  const rows = Array.isArray(resolved) ? resolved : unwrapDefaultExport(resolved);
  if (!Array.isArray(rows)) {
    throw new Error(`seed source did not resolve to an array of rows (got ${typeof resolved}).`);
  }
  return rows as SeedRow[];
}

/**
 * Read and parse a {@link seedFile} reference.
 *
 * Synchronous `node:fs` on purpose: this module is reached only from the
 * deploy/compile path, never from the browser-safe entry, which is the whole
 * point of naming the file by path instead of importing it.
 *
 * Every failure names the RESOLVED absolute path. `path` is written relative to
 * the declaring module, so when it is wrong the author needs to see what it
 * resolved to, not what they typed.
 */
function readSeedFile(ref: { path: string; base: string }): SeedRow[] {
  const where = `seedFile("${ref.path}")`;
  // `base` is `import.meta.url` in every documented use, but tolerate a plain
  // filesystem path rather than failing on a URL parse the author can't read.
  const base = /^[a-z][a-z0-9+.-]*:/i.test(ref.base) ? ref.base : pathToFileURL(ref.base).href;
  const file = fileURLToPath(new URL(ref.path, base));

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    const relative = `The path is resolved relative to the module that declares the table (the \`import.meta.url\` you passed as \`base\`).`;
    if (isMissingFile(cause)) throw new LocalFileNotFoundError(`${where}: no file at "${file}". ${relative}`);
    throw new Error(`${where}: cannot read "${file}". ${relative}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${where}: "${file}" is not valid JSON — ${(cause as Error).message}`, {
      cause,
    });
  }

  const lossy = lossyJsonInteger(text);
  if (lossy !== undefined) {
    throw new Error(
      `${where}: "${file}" holds the number ${lossy}, which JSON parsing reads as ${BigInt(Number(lossy))} — ` +
        `past ±9007199254740991 a JSON number loses its low digits. Quote it ("${lossy}") so it is seeded exactly.`,
    );
  }

  const rows = Array.isArray(parsed) ? parsed : unwrapDefaultExport(parsed);
  if (!Array.isArray(rows)) {
    throw new Error(
      `${where}: "${file}" must hold an array of seed rows (got ${typeof parsed}).`,
    );
  }
  return rows as SeedRow[];
}

/**
 * The first whole-number literal in a JSON text whose digits do not survive
 * parsing into a JS number, if any. Strings are matched first so digits inside
 * one are skipped.
 */
function lossyJsonInteger(text: string): string | undefined {
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (!/^-?\d{16,}$/.test(token)) continue;
    if (BigInt(Number(token)) !== BigInt(token)) return token;
  }
  return undefined;
}

/** The `default` export of a module namespace, when it holds the row array. */
function unwrapDefaultExport(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const fallback = (value as { default?: unknown }).default;
  return Array.isArray(fallback) ? fallback : value;
}

/**
 * Validate + coerce seed rows against a table's columns, then fill any omitted
 * primary keys. The pure validation lives in `seed-coerce.ts` so the
 * browser-safe `export()` path runs the identical checks.
 */
export function coerceSeedRows(
  tableName: string,
  columns: ColumnDef[],
  rows: readonly SeedRow[],
  opts: { useXdo?: boolean } = {},
): Record<string, unknown>[] {
  const coerced = coerceSeedRowValues(tableName, columns, rows, opts);
  assignPrimaryKeys(tableName, columns, coerced);
  return coerced;
}

/**
 * Fill the `id` of seed rows that omit it. The content-import path PRESERVES each
 * row's `id` and never auto-assigns one (a genuine engine export always carries
 * `id`), for EVERY key type. Verified against a live engine, where an omitted id
 * fails loudly and differently per type: int rows all insert as the same key
 * ("Duplicate record detected"), while a uuid row reaches Postgres as the empty
 * string and aborts the whole import with `invalid input syntax for type uuid: ""`
 * (the table itself imports fine; only a seeded one breaks).
 *
 * An int primary key is auto-numbered `1..N` (the engine resets the PK sequence
 * past the max on import); a uuid key gets a uuid derived from the table name and
 * row index, so a re-export of the same seed is byte-identical and two tables
 * never collide. All-or-nothing either way: a mix of explicit and omitted `id` is
 * ambiguous (which keys are free?) and throws — that half is {@link assertSeedIds},
 * shared with the browser-safe export path. A `system:false` table is left alone
 * — a custom PK is the author's to supply.
 */
function assignPrimaryKeys(
  tableName: string,
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
): void {
  if (!assertSeedIds(tableName, columns, rows)) return;
  const idType = columns.find((c) => c.name === "id")?.type;
  rows.forEach((r, i) => {
    r.id = idType === "int" ? i + 1 : seedUuid(tableName, i);
  });
}

/**
 * A stable RFC-4122-shaped uuid for the seed row at `index` of `tableName`.
 *
 * Derived rather than random so that exporting the same workspace twice produces
 * identical bytes — the bundle diff and round-trip checks compare exports, and a
 * fresh `randomUUID()` per run would make every seeded uuid table look changed.
 */
function seedUuid(tableName: string, index: number): string {
  const h = createHash("sha256").update(`xanosdk:seed-id:${tableName}:${index}`).digest("hex");
  // Stamp version 5 and the RFC-4122 variant so the value is a well-formed uuid,
  // not just 32 hex digits — Postgres accepts either, tooling may not.
  const version5 = `5${h.slice(13, 16)}`;
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version5}-${variant}-${h.slice(20, 32)}`;
}

/** Split coerced rows into pages under {@link SEED_PAGE_TARGET_BYTES} (≥1 row/page). */
export function paginateRows(
  rows: Record<string, unknown>[],
  budgetBytes = SEED_PAGE_TARGET_BYTES,
): Record<string, unknown>[][] {
  const pages: Record<string, unknown>[][] = [];
  let page: Record<string, unknown>[] = [];
  let size = 0;
  for (const row of rows) {
    // A cheap plain-JSON sizing stringify — intentionally NOT the PHP-shaped
    // signature encoder. Keep it separate: folding it into the signer would
    // couple page sizing to byte-exact signing and risk breaking either.
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (page.length > 0 && size + rowBytes > budgetBytes) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(row);
    size += rowBytes;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * Build every seed `content/` archive entry for a set of table defs. For
 * each table carrying `seed`, resolve → coerce → paginate → sign, keying files by
 * the table's `dbo` guid (`resolveRef("dbo", def)`, lock-aware — matches the guid
 * the same table emits in `workspace.json`). Tables with no seed, or an empty
 * resolved seed, contribute nothing.
 *
 * Must run in the same process/lock context as the workspace export so guids line
 * up. Async because a {@link SeedSource} thunk may be async (e.g. a dynamic
 * import of a seed file).
 */
export async function buildSeedContentFiles(
  tableDefs: readonly TableDef[],
  hostedFiles: HostedFileResolver = hostedFileResolver(),
  /** The workspace's `use_xdo`, which a table without its own `useXdo` inherits. */
  workspaceUseXdo = false,
): Promise<SeedContentFile[]> {
  const files: SeedContentFile[] = [];
  // Every table's refusals, then one failure: a seed is fixed in one pass.
  const problems: Diagnostic[] = [];
  for (const def of tableDefs) {
    if (def.seed === undefined) continue;
    const rows = await resolveSeedRows(def.seed);
    if (rows.length === 0) continue;
    let coerced: Record<string, unknown>[];
    try {
      coerced = coerceSeedRows(def.name, tableColumns(def), rows, { useXdo: def.useXdo ?? workspaceUseXdo });
      assertSeedUnique(def.name, tableIndexes(def), coerced);
      resolveSeedFiles(def.name, tableColumns(def), coerced, hostedFiles);
    } catch (err) {
      if (err instanceof DiagnosticError) problems.push(...err.details);
      else problems.push({ severity: "error", code: "seed.invalid", message: (err as Error).message });
      continue;
    }
    const guid = resolveRef("dbo", def);
    const pages = paginateRows(coerced);
    pages.forEach((page, i) => {
      files.push({ name: contentFileName(guid, i + 1), content: JSON.stringify(buildContentEnvelope(page)) });
    });
  }
  if (problems.length > 0) throw seedFailure(problems);
  return files;
}

/**
 * Register every hosted file a table's seed rows reference, without building
 * the content pages. The payload's file library is written when the bundle is
 * signed, BEFORE the pages can be built (they need the lock context the export
 * sets up), so the files are read here first. A row that fails validation is
 * skipped: {@link buildSeedContentFiles} reports it with the rest.
 */
export async function registerSeedHostedFiles(
  tableDefs: readonly TableDef[],
  hostedFiles: HostedFileResolver,
  /** The workspace's `use_xdo`, which a table without its own `useXdo` inherits. */
  workspaceUseXdo = false,
): Promise<void> {
  for (const def of tableDefs) {
    if (def.seed === undefined) continue;
    try {
      const columns = tableColumns(def);
      resolveSeedFiles(def.name, columns, coerceSeedRows(def.name, columns, await resolveSeedRows(def.seed), { useXdo: def.useXdo ?? workspaceUseXdo }), hostedFiles);
    } catch {
      // Reported by buildSeedContentFiles, which sees the same rows.
    }
  }
}

/** What a file column holds, by its stored type. An attachment (`blob`) holds anything. */
const FILE_COLUMN_KIND: Readonly<Record<string, "image" | "video" | "audio">> = {
  blob_img: "image",
  blob_video: "video",
  blob_audio: "audio",
};

/**
 * Replace each `hostedFile(...)` left in a file column by coercion with the
 * value an exported row carries, registering the file with `hostedFiles` so it
 * ships once beside every other reference to it. In place: `rows` are the
 * coerced copies, never the author's.
 */
function resolveSeedFiles(
  table: string,
  columns: readonly ColumnDef[],
  rows: Record<string, unknown>[],
  hostedFiles: HostedFileResolver,
): void {
  const fileColumns = columns.filter((c) => c.type.startsWith("blob"));
  if (fileColumns.length === 0) return;
  rows.forEach((row, i) => {
    for (const col of fileColumns) {
      const rules = { field: `table "${table}" seed row ${i}, column "${col.name}"`, mimeKind: FILE_COLUMN_KIND[col.type] };
      const value = row[col.name];
      const one = (v: unknown): unknown =>
        isHostedFile(v) ? hostedFileColumnValue(hostedFiles.resolveFile(v, rules)) : v;
      if (isHostedFile(value)) row[col.name] = one(value);
      else if (Array.isArray(value) && value.some(isHostedFile)) row[col.name] = value.map(one);
    }
  });
}

/**
 * The archive path a table's seed page is written at, and the reader that takes
 * it apart again.
 *
 * ONE definition of the format, because both directions exist: the deploy path
 * writes these names and {@link seedRowsByTableGuid} parses them back. Written
 * as a literal in one place and a regex in another, a change to the writer would
 * not fail the reader — it would simply stop matching, and a reset would send
 * zero rows to a table it had just emptied. A silent miss is the one failure
 * mode this format cannot afford.
 */
function contentFileName(guid: string, page: number): string {
  return `content/${guid}-${page}.json`;
}

/** The guid and page a {@link contentFileName} encodes, or `undefined`. */
function parseContentFileName(name: string): { guid: string; page: number } | undefined {
  // The guid is matched greedily up to the LAST dash before the page, since a
  // guid may itself contain `-` (they are base64url).
  const match = /^content\/(.+)-(\d+)\.json$/.exec(name);
  return match === undefined || match === null
    ? undefined
    : { guid: match[1]!, page: Number(match[2]) };
}

/** A seed value the schema says is not public, and where it came from. */
export interface NonPublicSeedValue {
  table: string;
  column: string;
  value: string;
  /**
   * Whether a static build can actually be searched for this value.
   *
   * `false` for a value below {@link MIN_SCANNABLE_LENGTH}, and for a non-string
   * one. Those are collected rather than dropped: being too short to
   * search for is not the same as being safe, and the author is the only one who
   * can judge which it is. The scanner skips them; the deploy path reports them.
   */
  scannable: boolean;
  /**
   * How the table supplies its seed, which decides how a value can have reached
   * a frontend build — and so what the refusal tells the author to change.
   */
  source: SeedSourceKind;
}

/**
 * `inline` rows ride with the table def into any bundle that imports it; a
 * `thunk`'s `import()` is one a bundler follows; a `file` (`seedFile`) is a
 * plain path no bundler reads, so a match there came from the frontend itself.
 */
export type SeedSourceKind = "inline" | "file" | "thunk";

/** Which {@link SeedSourceKind} a table's seed is. */
export function seedSourceKind(source: SeedSource): SeedSourceKind {
  return typeof source === "function" ? "thunk" : isSeedFileSource(source) ? "file" : "inline";
}

/**
 * Minimum length for a value worth scanning a built frontend for.
 *
 * Below this the string is more likely to collide with ordinary bundle content
 * (a status word, an initial) than to be the secret it came from, and a guard
 * that cries wolf gets switched off.
 */
const MIN_SCANNABLE_LENGTH = 6;

/**
 * Seed values drawn from columns {@link isNonPublicColumn} flags.
 */
export async function collectNonPublicSeedValues(
  tableDefs: readonly TableDef[],
): Promise<NonPublicSeedValue[]> {
  const found: NonPublicSeedValue[] = [];
  for (const def of tableDefs) {
    if (def.seed === undefined) continue;
    // A `publicSeed` column's values are declared public by the author, on this
    // table: they are what the frontend is meant to show.
    const exempt = new Set(def.publicSeed ?? []);
    const guarded = tableColumns(def).filter((c) => isNonPublicColumn(c) && !exempt.has(c.name));
    if (guarded.length === 0) continue;
    const source = seedSourceKind(def.seed);
    const rows = await resolveSeedRows(def.seed);
    for (const row of rows) {
      for (const col of guarded) {
        const value = Object.hasOwn(row, col.name) ? (row as Record<string, unknown>)[col.name] : undefined;
        if (value === undefined || value === null) continue;
        // A short or non-string value is recorded as UNSCANNABLE rather than
        // dropped. The floor stays where it is — below it a string collides with
        // ordinary bundle content and a guard that cries wolf gets switched off
        // — but silence was the actual defect: `deploy --static` passed on a
        // four-character `internal` seed as if it had been checked.
        const scannable = typeof value === "string" && value.length >= MIN_SCANNABLE_LENGTH;
        found.push({ table: def.name, column: col.name, value: String(value), scannable, source });
      }
    }
  }
  return found;
}

/**
 * The coerced seed rows of each table, keyed by the table's `dbo` guid.
 *
 * Read back out of the `content/` entries {@link buildSeedContentFiles} already
 * built, rather than re-resolving and re-coercing from the defs. That is the
 * point: a caller writing seed rows through a different route than the deploy's
 * import must send the SAME rows, and deriving them a second time would create a
 * second opinion about what a valid seed row is — one that could drift, and
 * whose drift would only ever show up against a real workspace.
 *
 * Pages are concatenated back in their declared order, so a table split across
 * several entries comes back as the one row list it was paginated from.
 */
export function seedRowsByTableGuid(
  files: readonly SeedContentFile[],
): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  // Sorted by page so concatenation restores the authored order rather than the
  // order the entries happen to arrive in.
  const parsed = files
    .flatMap((f) => {
      const parsedName = parseContentFileName(f.name);
      return parsedName === undefined ? [] : [{ ...parsedName, content: f.content }];
    })
    .sort((a, b) => a.page - b.page);
  for (const entry of parsed) {
    const payload = (JSON.parse(entry.content) as { payload?: unknown }).payload;
    if (!Array.isArray(payload)) continue;
    const rows = out.get(entry.guid) ?? [];
    rows.push(...(payload as Record<string, unknown>[]));
    out.set(entry.guid, rows);
  }
  return out;
}
