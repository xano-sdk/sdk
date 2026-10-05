/**
 * What a merge will do that its plan does not say.
 *
 * The server's dry run answers at OBJECT granularity: it reports that a table
 * will be "updated in place from the archive" and stops there. Two consequential
 * things hide underneath that sentence, and both are invisible until after they
 * have happened:
 *
 * - **A dropped column takes its data with it.** Removing a column from a schema
 *   and releasing destroys the column and every value in it, reported as a
 *   routine in-place update with no destructive operation raised.
 *   A column drop is among the easiest destructive changes to make by accident —
 *   a rename typo, a bad merge, a refactor that removes someone else's field —
 *   and the preview is the one place it can be caught.
 * - **An env value that will not change.** A merge is add-only for environment
 *   variables: it creates keys that do not exist and silently leaves existing
 *   ones alone. Changing a secret in code and releasing reports
 *   success and rotates nothing.
 *
 * Both need the live workspace, which the plan response does not carry, so both
 * are computed here from a configuration-only export of the target. That read is
 * the reason this module exists at all: having paid for it once, it answers both
 * questions.
 *
 * Node-only (fetch, via the export call); lazily imported by the command layer.
 */
import type { ExportedBundle } from "./workspace-export.js";
import { deepEqual, normalize } from "../validate/normalize.js";
import { HOSTED_ICON_KINDS, isPrivateLibraryRow } from "../fields/hosted-file.js";
import { isWorkspaceKeyAtDefault } from "../codegen/omissions.js";
import { identityName } from "../codegen/labels.js";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS } from "../kinds/workspace-config.js";

/** A column present live that the outgoing archive no longer declares. */
export interface DroppedColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * A column the archive keeps under a different type.
 *
 * Measured on a live engine: the import accepts the change on a populated
 * column, keeps every row, and nulls every value that column held — while the
 * plan calls it a routine in-place update. As destructive as a drop, and as
 * invisible. A vector column's type carries its size (`vector(3)`), so a size
 * change is a retype too.
 */
export interface RetypedColumn {
  readonly table: string;
  readonly column: string;
  readonly from: string;
  readonly to: string;
  /** The default the landing declares for it, when it declares one. */
  readonly default?: string;
  /** Present when the landing declares the column nullable. */
  readonly nullable?: true;
  /**
   * The type the column's values are stored as, when a landing record knows
   * it. A merge retype rewrites the definition only, so after one this is not
   * `from`: the column keeps the type it was created with. Absent when unknown.
   */
  readonly stored?: string;
  /** Present when the table stores its fields as JSON (`useXdo`) before and after. */
  readonly useXdo?: true;
}

/** Per table guid, column → the type its values are stored as (see {@link RetypedColumn.stored}). */
export type StoredColumnTypes = ReadonlyMap<string, Readonly<Record<string, string>>>;

/**
 * Each table's column storage once `outgoing` has landed over `live` (keyed by
 * table guid), from what was known before (`prior`). A table or column the
 * landing creates is stored as declared; `rebuild` recreates every table, so
 * every column is. A merge rewrites a kept column's definition only, so its
 * storage is what it was — known only when `prior` knew it. A merge with no
 * `live` read cannot tell a kept column from a new one, so it keeps only what
 * `prior` knew of columns the landing still declares.
 */
export function storedColumnsAfter(
  outgoing: unknown,
  live: ExportedBundle | undefined,
  prior: StoredColumnTypes,
  mode: "merge" | "rebuild",
): Map<string, Record<string, string>> {
  const liveTables = new Map(rows(live, "dbo").map((t) => [identify(t), t]));
  const out = new Map<string, Record<string, string>>();
  for (const table of rows(outgoing, "dbo")) {
    if (typeof table.guid !== "string" || table.guid === "") continue;
    const current = mode === "rebuild" ? undefined : liveTables.get(identify(table));
    const liveColumns = current === undefined ? new Map<string, string>() : typedColumnsOf(current);
    const blind = mode === "merge" && live === undefined;
    const known = prior.get(table.guid) ?? {};
    const stored: Record<string, string> = {};
    for (const [column, type] of typedColumnsOf(table)) {
      if (type === "") continue;
      if (!blind && !liveColumns.has(column)) stored[column] = type;
      else if (known[column] !== undefined) stored[column] = known[column]!;
    }
    if (Object.keys(stored).length > 0) out.set(table.guid, stored);
  }
  return out;
}

/**
 * An enum column the archive keeps with values removed. Measured live (E2E pass
 * 34): a merge rewrites the definition only, and every row holding a removed
 * value reads null until the value is restored.
 */
export interface NarrowedEnum {
  readonly table: string;
  readonly column: string;
  readonly removed: readonly string[];
}

/**
 * A table-reference column the archive points at another table. A merge
 * rewrites the reference only: the ids the rows hold are kept, and now name
 * rows of the new table.
 */
export interface RetargetedRef {
  readonly table: string;
  readonly column: string;
  readonly from: string;
  readonly to: string;
}

/**
 * A NOT NULL column the archive makes nullable. Measured live (E2E pass 24): a
 * merge rewrites the definition and the export reads nullable, but the physical
 * NOT NULL stays — an insert that omits the column still fails 23502. A replace
 * (which recreates the table) relaxes it. Only the run that makes the change can
 * see it: afterwards the export already reads nullable.
 */
export interface UnrelaxedColumn {
  readonly table: string;
  readonly column: string;
}

/** A column the archive makes non-nullable that is nullable live, with its outgoing type. */
export interface TightenedColumn {
  readonly table: string;
  readonly column: string;
  readonly type: string;
}

/** One index added to or dropped from a table, labelled `unique(email)`, `btree(created_at desc)`. */
export interface IndexChange {
  readonly table: string;
  readonly index: string;
  readonly action: "add" | "drop";
  /** Whether the index enforces uniqueness — an add can then fail on the rows already there. */
  readonly unique: boolean;
}

/**
 * A table the archive keeps under the other storage mode (`use_xdo`: fields as
 * JSON, or as columns), its own or inherited from the workspace. Measured live
 * under a merge: on a table holding rows, JSON → columns keeps every row and
 * erases every value it held, for good; columns → JSON fails partway with a
 * NOT NULL violation. An empty table switches cleanly either way.
 */
export interface StorageModeChange {
  /** The table's name once this lands. */
  readonly table: string;
  /** Its name and guid on the target, where its rows are counted. */
  readonly liveName: string;
  readonly guid?: string;
  /** Whether the table stores its fields as JSON now, and once this lands. */
  readonly from: boolean;
  readonly to: boolean;
}

/**
 * A table's storage mode, from its `use_xdo` flag — or, where a bundle carries
 * none, from the `gin(xdo)` index only JSON storage has.
 */
function usesXdo(table: Record<string, unknown>): boolean {
  if (typeof table.use_xdo === "boolean") return table.use_xdo;
  return Array.isArray(table.index) && table.index.some((entry) => {
    const { type, fields } = (entry ?? {}) as { type?: unknown; fields?: unknown };
    return type === "gin" && Array.isArray(fields) && fields.some((f) => (f as { name?: unknown } | null)?.name === "xdo");
  });
}

/** A table's indexes, each by its label (see {@link IndexChange}). */
function indexesOf(table: Record<string, unknown>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!Array.isArray(table.index)) return out;
  for (const entry of table.index) {
    if (entry === null || typeof entry !== "object") continue;
    const { type, fields } = entry as { type?: unknown; fields?: unknown };
    if (typeof type !== "string" || type === "primary" || !Array.isArray(fields)) continue;
    const parts = type.split("|");
    const unique = parts.includes("unique");
    const kind = unique ? "unique" : (parts[0] ?? type);
    const cols = fields
      .map((f) => {
        const { name, op } = (f ?? {}) as { name?: unknown; op?: unknown };
        return typeof name !== "string" ? "" : typeof op === "string" && op !== "" ? `${name} ${op}` : name;
      })
      .filter((c) => c !== "");
    out.set(`${kind}(${cols.join(", ")})`, unique);
  }
  return out;
}

/** A table's unique indexes, each by its label (see {@link IndexChange}). */
export function uniqueIndexLabels(table: Record<string, unknown>): string[] {
  return [...indexesOf(table)].filter(([, unique]) => unique).map(([label]) => label);
}

/**
 * A table's indexes as an order-insensitive set of labels (see {@link IndexChange}),
 * for comparing two versions of the same table. A field's `asc` is the engine's
 * default and reads the same as no direction.
 *
 * `normalize()` strips every `index` key — the name is reused all over a
 * statement tree — so a table's indexes are compared through this instead.
 */
export function indexKeysOf(table: Record<string, unknown>): string[] {
  const asc = { ...table, index: Array.isArray(table.index) ? table.index.map(withoutAsc) : table.index };
  return [...indexesOf(asc).keys()].sort();
}

function withoutAsc(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object" || !Array.isArray((entry as { fields?: unknown }).fields)) return entry;
  const fields = (entry as { fields: unknown[] }).fields.map((f) =>
    f !== null && typeof f === "object" && (f as { op?: unknown }).op === "asc" ? { ...(f as object), op: "" } : f,
  );
  return { ...(entry as object), fields };
}

/** An env var whose live value differs from the one the archive carries. */
export interface StaleEnvVar {
  readonly name: string;
  /** The archive's value is empty: the live one differs because the project has none to apply. */
  readonly empty: boolean;
}

/** An env var the target holds that the outgoing archive does not declare. */
export interface DroppedEnvVar {
  readonly name: string;
}

/** The workspace's own name, when the archive would change it. */
export interface WorkspaceRename {
  readonly from: string;
  readonly to: string;
}

/** What comparing the archive against the live workspace revealed. */
export interface LiveDiff {
  /**
   * Tables the target holds that the archive does not carry, by identity. A
   * merge leaves them; a landing that makes the target exactly the archive (a
   * tenant deploy) drops them with every row — a table the archive carries a
   * same-named table in place of under another identity included.
   */
  readonly uncarriedTables: readonly string[];
  /** The {@link uncarriedTables} whose name the archive gives to another table. */
  readonly replacedTables: readonly string[];
  readonly droppedColumns: readonly DroppedColumn[];
  readonly retypedColumns: readonly RetypedColumn[];
  /** Populated only for a merge — a replace recreates the table. */
  readonly unrelaxedColumns: readonly UnrelaxedColumn[];
  /** Columns nullable live that the archive makes non-nullable. Populated only for a merge. */
  readonly tightenedColumns: readonly TightenedColumn[];
  /** Indexes the archive adds to, or drops from, a table it updates in place. Populated only for a merge. */
  readonly indexChanges: readonly IndexChange[];
  /** Enum columns kept with values removed. Populated only for a merge. */
  readonly narrowedEnums: readonly NarrowedEnum[];
  /** Table-reference columns pointed at another table. Populated only for a merge. */
  readonly retargetedRefs: readonly RetargetedRef[];
  /** Tables switched to the other storage mode. Populated only for a merge. */
  readonly storageChanges: readonly StorageModeChange[];
  /** Populated only for a merge, where env is add-only. */
  readonly unchangedEnv: readonly StaleEnvVar[];
  /**
   * Populated only for a REPLACE, which rebuilds the workspace from the archive.
   *
   * The mirror image of {@link unchangedEnv}, and the more destructive half: a
   * replace makes the target's env set exactly what the archive declares, so
   * every name the target holds and the archive does not is DROPPED. Those are
   * the ones set outside this project — through the UI, or by an earlier
   * release — which is precisely why nothing else on screen mentions them.
   */
  readonly droppedEnv: readonly DroppedEnvVar[];
  /**
   * Populated only for a MERGE: the members of the workspace `documentation`
   * block the archive would change and the merge will not write.
   *
   * A merge keeps only a fixed set of workspace fields and `documentation` is
   * not one of them — the gate and its token land only under a replace. The
   * build still resolves the token and the import still answers "applied", so
   * without this nothing says the gate stayed where it was.
   */
  readonly unappliedDocumentation: readonly ("require_token" | "token")[];
  /**
   * Set when the archive's workspace name differs from the target's.
   *
   * An import carries the workspace row along with the objects, so releasing a
   * project whose `workspace("...")` name differs from the target's RENAMES the
   * target. The server reports it, but as an ordinary `update` on the workspace
   * — folded into a count beside every other update, and labelled with the name
   * the workspace has NOW, so nothing on screen says it is about to change.
   */
  readonly workspaceRename?: WorkspaceRename;
}

/** `payload.<key>` as an array, whatever the server sent for it. */
function rows(bundle: unknown, key: string): Record<string, unknown>[] {
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  if (payload === null || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value.filter((r) => r !== null && typeof r === "object") as Record<string, unknown>[]) : [];
}

/**
 * A table's columns as `name → type`, from its `schema[]`.
 *
 * Typed rather than name-only because a RETYPE is a loss too (see
 * {@link RetypedColumn}), and a name-only view cannot see one.
 */
function typedColumnsOf(table: Record<string, unknown>): Map<string, string> {
  const out = columnsOf(table, "type", (v) => (typeof v === "string" ? v : ""));
  for (const [column, size] of columnsOf(table, "vector", (v) => (v as { size?: unknown } | null)?.size)) {
    if (out.get(column) === "vector") out.set(column, sizedVector(size));
  }
  return out;
}

/**
 * A vector column's type with its size, `vector(3)`: the size is part of what
 * the column stores. Measured, merge: changing it rewrites the definition only,
 * so every stored vector reads null while the column has the new size (and
 * reads again once it is changed back), and an insert that sets a vector of the
 * new size fails with an SQL error. A size the row does not carry is the
 * encoder's default, 3.
 */
function sizedVector(size: unknown): string {
  return `vector(${typeof size === "number" && Number.isInteger(size) ? size : 3})`;
}

/** The size in a {@link sizedVector} type, or undefined for any other type. */
export function vectorSize(type: string): number | undefined {
  const m = /^vector\((\d+)\)$/.exec(type);
  return m === null ? undefined : Number(m[1]);
}

/** A table's top-level enum columns as `name → values`. */
function enumColumnsOf(table: Record<string, unknown>): Map<string, string[] | undefined> {
  return columnsOf(table, "values", (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined));
}

/** A table's top-level columns as `name → the guid of the table it references`, for a table-reference column. */
function refColumnsOf(table: Record<string, unknown>): Map<string, string | undefined> {
  return columnsOf(table, "methods", (v) => {
    if (!Array.isArray(v)) return undefined;
    for (const m of v as { name?: unknown; arg?: unknown }[]) {
      if (m?.name !== "@" || !Array.isArray(m.arg)) continue;
      const ref = (m.arg as unknown[]).find((a): a is string => typeof a === "string" && a.startsWith("dbo="));
      if (ref !== undefined) return ref.slice("dbo=".length);
    }
    return undefined;
  });
}

/** A table's top-level columns as `name → nullable`, where the row says. */
function nullableColumnsOf(table: Record<string, unknown>): Map<string, boolean | undefined> {
  return columnsOf(table, "nullable", (v) => (typeof v === "boolean" ? v : undefined));
}

function columnsOf<T>(table: Record<string, unknown>, key: string, read: (v: unknown) => T): Map<string, T> {
  const out = new Map<string, T>();
  const schema = table.schema;
  if (!Array.isArray(schema)) return out;
  for (const entry of schema) {
    if (entry === null || typeof entry !== "object") continue;
    const { name } = entry as { name?: unknown };
    if (typeof name !== "string" || name === "") continue;
    out.set(name, read((entry as Record<string, unknown>)[key]));
  }
  return out;
}

/**
 * Identify a table across the two bundles.
 *
 * Guid first, because that is what the engine matches on and it survives a
 * rename. Name is the fallback for a table the lock has not pinned, where a guid
 * is derived rather than carried and the two sides may legitimately disagree.
 */
function identify(table: Record<string, unknown>): string {
  const guid = table.guid;
  if (typeof guid === "string" && guid !== "") return `guid:${guid}`;
  const name = table.name;
  return typeof name === "string" ? `name:${name}` : "";
}

/**
 * The workspace object's env vars, as a name→value map.
 *
 * Read from both the workspace object and the payload root: the SDK encodes env
 * onto the workspace object, and an engine export has been observed carrying it
 * at the root too. Reading only one spelling would silently find nothing.
 */
export function envValuesOf(bundle: unknown): Map<string, string> {
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  const out = new Map<string, string>();
  if (payload === null || typeof payload !== "object") return out;
  const workspace = (payload as Record<string, unknown>).workspace;
  const candidates: unknown[] = [
    (payload as Record<string, unknown>).env,
    workspace !== null && typeof workspace === "object" && !Array.isArray(workspace)
      ? (workspace as Record<string, unknown>).env
      : undefined,
    Array.isArray(workspace) && workspace[0] !== null && typeof workspace[0] === "object"
      ? (workspace[0] as Record<string, unknown>).env
      : undefined,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      // `{name, value}` is what the SDK writes. A bare `NAME=value` string is the
      // other spelling an export has been seen to use; splitting on the FIRST `=`
      // keeps a value that contains one.
      if (typeof entry === "string") {
        const at = entry.indexOf("=");
        if (at > 0) out.set(entry.slice(0, at), entry.slice(at + 1));
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      const { name, value } = entry as { name?: unknown; value?: unknown };
      if (typeof name === "string" && name !== "") out.set(name, typeof value === "string" ? value : "");
    }
  }
  return out;
}

/**
 * Compare the archive about to be released against the live workspace.
 *
 * Pure, so the network read stays in the caller and this stays testable without
 * one. Reports only LOSSES: a column the live table has and the archive does
 * not, an env key whose value a merge will decline to update, and an env key a
 * replace will drop because the archive does not declare it. A column being
 * added, or a table appearing for the first time, is not a finding.
 */
export function diffAgainstLive(
  outgoing: unknown,
  live: ExportedBundle,
  opts: { mode: "merge" | "replace"; stored?: StoredColumnTypes },
): LiveDiff {
  const outgoingTables = new Map(rows(outgoing, "dbo").map((t) => [identify(t), t]));
  // A same-named table the archive carries without an identity of its own is
  // matched by name: its guid is derived on the way out, not a different table.
  const guidlessNames = new Set(
    rows(outgoing, "dbo")
      .filter((t) => typeof t.guid !== "string" || t.guid === "")
      .map(nameOf),
  );
  const outgoingNames = new Set(rows(outgoing, "dbo").map(nameOf));
  const uncarriedTables: string[] = [];
  const replacedTables: string[] = [];
  const droppedColumns: DroppedColumn[] = [];
  const retypedColumns: RetypedColumn[] = [];
  const unrelaxedColumns: UnrelaxedColumn[] = [];
  const tightenedColumns: TightenedColumn[] = [];
  const indexChanges: IndexChange[] = [];
  const narrowedEnums: NarrowedEnum[] = [];
  const retargetedRefs: RetargetedRef[] = [];
  const storageChanges: StorageModeChange[] = [];
  const tableNames = new Map<string, string>();
  for (const t of [...rows(live, "dbo"), ...rows(outgoing, "dbo")]) {
    if (typeof t.guid === "string" && typeof t.name === "string") tableNames.set(t.guid, t.name);
  }

  for (const liveTable of rows(live, "dbo")) {
    const outgoingTable = outgoingTables.get(identify(liveTable));
    // A table the archive does not carry is not being updated in place — under a
    // merge it is left alone, and under `--prune` its deletion is already a
    // reported destructive operation. Either way its columns are not dropped
    // by an in-place update, which is what this looks for.
    if (outgoingTable === undefined) {
      // Measured: a same-named table under another guid is a different table —
      // a tenant deploy creates it beside this one under a suffixed name and
      // drops this one with its rows.
      const liveName = nameOf(liveTable);
      const ownIdentity = typeof liveTable.guid === "string" && liveTable.guid !== "";
      if (!outgoingNames.has(liveName) || (ownIdentity && !guidlessNames.has(liveName))) {
        uncarriedTables.push(liveName);
        if (outgoingNames.has(liveName)) replacedTables.push(liveName);
      }
      continue;
    }
    const kept = typedColumnsOf(outgoingTable);
    const defaults = columnsOf(outgoingTable, "default", (v) => (typeof v === "string" ? v : ""));
    const nullable = columnsOf(outgoingTable, "nullable", (v) => v === true);
    // The name the table has once this lands: a rename in the same run is
    // reported under its new name, so every list names it that way.
    const name =
      typeof outgoingTable.name === "string" ? outgoingTable.name : typeof liveTable.name === "string" ? liveTable.name : "(unnamed)";
    const storedHere = typeof liveTable.guid === "string" ? opts.stored?.get(liveTable.guid) : undefined;
    for (const [column, type] of typedColumnsOf(liveTable)) {
      const next = kept.get(column);
      if (next === undefined) droppedColumns.push({ table: name, column });
      else if (next !== type) {
        const declared = defaults.get(column) ?? "";
        // A record written before vector sizes were tracked says `vector` alone,
        // which names no storage a sized type can be compared with.
        const recorded = storedHere?.[column];
        const stored = recorded === "vector" ? undefined : recorded;
        retypedColumns.push({
          table: name,
          column,
          from: type,
          to: next,
          ...(declared === "" ? {} : { default: declared }),
          ...(nullable.get(column) === true ? { nullable: true as const } : {}),
          ...(stored === undefined ? {} : { stored }),
          ...(usesXdo(liveTable) && usesXdo(outgoingTable) ? { useXdo: true as const } : {}),
        });
      }
    }
    if (opts.mode !== "merge") continue;
    const [from, to] = [usesXdo(liveTable), usesXdo(outgoingTable)];
    if (from !== to) {
      storageChanges.push({
        table: name,
        liveName: nameOf(liveTable),
        ...(typeof liveTable.guid === "string" && liveTable.guid !== "" ? { guid: liveTable.guid } : {}),
        from,
        to,
      });
    }
    const liveIndexes = indexesOf(liveTable);
    const nextIndexes = indexesOf(outgoingTable);
    for (const [index, unique] of nextIndexes) {
      if (!liveIndexes.has(index)) indexChanges.push({ table: name, index, action: "add", unique });
    }
    for (const [index, unique] of liveIndexes) {
      if (!nextIndexes.has(index)) indexChanges.push({ table: name, index, action: "drop", unique });
    }
    const types = typedColumnsOf(liveTable);
    const nextEnums = enumColumnsOf(outgoingTable);
    for (const [column, values] of enumColumnsOf(liveTable)) {
      if (types.get(column) !== "enum" || kept.get(column) !== "enum" || values === undefined) continue;
      const next = nextEnums.get(column) ?? [];
      const removed = values.filter((v) => !next.includes(v));
      if (removed.length > 0) narrowedEnums.push({ table: name, column, removed });
    }
    const nextRefs = refColumnsOf(outgoingTable);
    for (const [column, ref] of refColumnsOf(liveTable)) {
      const next = nextRefs.get(column);
      if (ref === undefined || next === undefined || next === ref || types.get(column) !== kept.get(column)) continue;
      retargetedRefs.push({ table: name, column, from: tableNames.get(ref) ?? ref, to: tableNames.get(next) ?? next });
    }
    const nextNullable = nullableColumnsOf(outgoingTable);
    for (const [column, nullable] of nullableColumnsOf(liveTable)) {
      if (nullable === false && nextNullable.get(column) === true) unrelaxedColumns.push({ table: name, column });
      if (nullable === true && nextNullable.get(column) === false) {
        tightenedColumns.push({ table: name, column, type: kept.get(column) ?? "" });
      }
    }
  }

  // The two modes lose env in opposite directions, and each is invisible from
  // the other's vantage point.
  //
  // A MERGE is add-only, so a value the archive carries for a name the target
  // already holds is declined — the change you made in code does not land.
  //
  // A REPLACE rebuilds the workspace from the archive, so every declared value
  // does land — and every name the target holds that the archive does NOT
  // declare is dropped with the rest of the old workspace. Those are the ones
  // nobody wrote in this project, which is what makes the loss silent: the
  // config cannot mention a name it does not know about.
  const unchangedEnv: StaleEnvVar[] = [];
  const droppedEnv: DroppedEnvVar[] = [];
  const liveEnv = envValuesOf(live);
  if (opts.mode === "merge") {
    for (const [name, value] of envValuesOf(outgoing)) {
      const current = liveEnv.get(name);
      if (current !== undefined && current !== value) unchangedEnv.push({ name, empty: value === "" });
    }
  } else {
    const declared = envValuesOf(outgoing);
    for (const name of liveEnv.keys()) {
      if (!declared.has(name)) droppedEnv.push({ name });
    }
  }

  const unappliedDocumentation: ("require_token" | "token")[] = [];
  if (opts.mode === "merge") {
    const ours = documentationOf(outgoing);
    const theirs = documentationOf(live);
    if (ours !== undefined) {
      if (Object.hasOwn(ours, "require_token") && !deepEqual(ours.require_token, theirs?.require_token)) {
        unappliedDocumentation.push("require_token");
      }
      // A token gates nothing while neither side sets `require_token`, and an
      // engine export always carries an auto-generated one that differs per
      // environment — so an ungated token is never a finding.
      const gated = ours.require_token === true || theirs?.require_token === true;
      if (gated && typeof ours.token === "string" && ours.token !== "" && ours.token !== theirs?.token) {
        unappliedDocumentation.push("token");
      }
    }
  }

  // The workspace row rides along with the objects, so a differing name is a
  // rename — reported here because the plan's own `update` line cannot say it.
  const from = workspaceNameOf(live);
  const to = workspaceNameOf(outgoing);
  const workspaceRename = from !== "" && to !== "" && from !== to ? { from, to } : undefined;

  return {
    uncarriedTables,
    replacedTables,
    droppedColumns,
    retypedColumns,
    unrelaxedColumns,
    tightenedColumns,
    indexChanges,
    narrowedEnums,
    retargetedRefs,
    storageChanges,
    unchangedEnv,
    droppedEnv,
    unappliedDocumentation,
    ...(workspaceRename !== undefined ? { workspaceRename } : {}),
  };
}

/**
 * What secret material a bundle carries in cleartext: `"env values"` when any
 * env var has a value, `"documentation token"` when the workspace's or an API
 * group's is set, and — in a live export — `"workspace secrets"` (the
 * workspace's own key material), `"a repository private key"`, `"AI provider
 * API keys"` and `"vault entries"`. Empty for a bundle safe to leave
 * world-readable. For every command that writes a bundle to disk (`export
 * --out`, `ephemeral export`, `workspace export`), to decide the file's mode
 * and whether to say so.
 */
export function secretsCarriedBy(bundle: unknown): string[] {
  const out: string[] = [];
  if ([...envValuesOf(bundle).values()].some((v) => v !== "")) out.push("env values");
  const set = (block: unknown): boolean => {
    const token = (block as { token?: unknown } | null | undefined)?.token;
    return typeof token === "string" && token !== "";
  };
  const groups = payloadOf(bundle).app;
  const groupTokens = Array.isArray(groups)
    ? groups.some((g) => set((g as { documentation?: unknown } | null)?.documentation))
    : false;
  if (set(documentationOf(bundle)) || groupTokens) out.push("documentation token");
  const payload = payloadOf(bundle);
  const workspace = asRecord(payload.workspace);
  if (workspace !== undefined) {
    const crypto = asRecord(workspace.crypto);
    if (filled(workspace.secret) || filled(crypto?.secret)) out.push("workspace secrets");
    const repo = asRecord(workspace["git"]);
    if (filled(repo?.private_key)) out.push("a repository private key");
    const providers = asRecord(asRecord(asRecord(workspace.settings)?.ai_settings)?.providers);
    if (providers !== undefined && Object.values(providers).some((p) => filled(asRecord(p)?.api_key))) {
      out.push("AI provider API keys");
    }
  }
  // The vault section is the workspace's file library.
  if (Array.isArray(payload.vault) && payload.vault.some(isPrivateLibraryRow)) {
    out.push("vault entries");
  }
  return out;
}

/** A non-empty string. */
function filled(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/** `value` as a plain object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * {@link secretsCarriedBy} for the engine's XanoScript rendering of a workspace
 * (`ephemeral export --format multidoc`), same labels: `"env values"` when a
 * workspace's `env = {…}` holds a non-empty string, `"documentation token"`
 * when an API group's `swagger = {…}` carries a `token`. The engine writes the
 * token there in cleartext (`swagger = {token: "…"}`), so a multidoc file is a
 * secrets file exactly as often as the JSON one is.
 *
 * Reads the text rather than parsing it: only these two assignments matter,
 * and a line-anchored match keeps `$env.NAME` inside a stack from counting.
 */
export function secretsInMultidoc(text: string): string[] {
  const out: string[] = [];
  const nonEmptyString = /"(?:[^"\\]|\\.)+"/;
  if (assignedBlocks(text, "env").some((b) => nonEmptyString.test(b))) out.push("env values");
  if (assignedBlocks(text, "swagger").some((b) => /\btoken\s*:\s*"(?:[^"\\]|\\.)+"/.test(b))) {
    out.push("documentation token");
  }
  // A seeded release's rows, rendered with `records`: a password column's value
  // is the stored hash, and a hash is as much a credential as the env values.
  if (passwordHashesInMultidoc(text).length > 0) out.push("password hashes");
  return out;
}

/**
 * The `<table>.<column>` pairs whose seeded rows (`items = [...]`) carry a
 * non-empty value in a `password` column of that table's schema.
 */
export function passwordHashesInMultidoc(text: string): string[] {
  const out: string[] = [];
  for (const doc of text.split(/^(?=table[ \t]+)/m)) {
    const name = /^table[ \t]+("?)([^\s"{]+)\1/.exec(doc)?.[2];
    if (name === undefined) continue;
    const columns = [...doc.matchAll(/^[ \t]*password\??[ \t]+("?)([A-Za-z_]\w*)\1/gm)].map((m) => m[2]!);
    if (columns.length === 0) continue;
    const items = assignedBlocks(doc, "items", "[").join("\n");
    for (const column of columns) {
      if (new RegExp(`(?:^|[{,\\s])"?${column}"?\\s*:\\s*"(?:[^"\\\\]|\\\\.)+"`).test(items)) out.push(`${name}.${column}`);
    }
  }
  return out;
}

/** The body of every line-leading `<key> = {…}` (or `[…]`) in a multidoc, brackets balanced and strings skipped. */
function assignedBlocks(text: string, key: string, open: "{" | "[" = "{"): string[] {
  const out: string[] = [];
  const close = open === "{" ? "}" : "]";
  const start = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\${open}`, "gm");
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      } else if (ch === open) depth++;
      else if (ch === close) depth--;
    }
    out.push(text.slice(from, i - 1));
  }
  return out;
}

/** The workspace row's `documentation` block, when it carries one. */
function documentationOf(bundle: unknown): Record<string, unknown> | undefined {
  const ws = payloadOf(bundle)[WORKSPACE_KEY];
  if (ws === null || typeof ws !== "object" || Array.isArray(ws)) return undefined;
  const block = (ws as Record<string, unknown>).documentation;
  return block !== null && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

/**
 * The workspace's own name from a bundle's workspace row, or "" when absent.
 *
 * The workspace row is a single OBJECT, not a list like every other section —
 * which is why this reads the payload directly instead of going through
 * `rows()`, whose array cast would silently yield nothing here.
 */
function workspaceNameOf(bundle: unknown): string {
  const ws = payloadOf(bundle)[WORKSPACE_KEY];
  if (ws === null || typeof ws !== "object" || Array.isArray(ws)) return "";
  const name = (ws as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

/** One workspace-scoped object the release would create, remove or alter. */
export interface SharedSchemaChange {
  /** `dbo` for a table, `microservice` for a workload. */
  readonly kind: "dbo" | "microservice";
  readonly name: string;
  readonly action: "create" | "remove" | "alter";
  /** For an `alter`, what specifically differs — column names, or a retype. */
  readonly details?: readonly string[];
}

/**
 * What a release would change OUTSIDE any branch.
 *
 * Branches in Xano scope LOGIC, not data. API groups, functions, tasks,
 * triggers, middleware, tools, toolsets, channels, realtime servers, knowledge,
 * addons and messages each belong to a branch. **Tables and microservices carry
 * no branch dimension at all** — one set is shared by every branch of the
 * workspace.
 *
 * The consequence is the whole reason this function exists: releasing to a
 * non-live branch stages your logic and applies your schema to PRODUCTION, in
 * the same call, with the plan describing it as routine. Someone reaching for a
 * branch is reaching for safety, and this is the part the branch does not give
 * them.
 *
 * `undefined` for `live` means the target could not be read. That is reported as
 * UNKNOWN rather than as "no changes": a failed read is not evidence of safety,
 * and the caller must be able to tell the two apart.
 */
export function sharedSchemaChanges(
  outgoing: unknown,
  live: ExportedBundle | undefined,
  opts: { prune?: boolean } = {},
): readonly SharedSchemaChange[] | undefined {
  if (live === undefined) return undefined;

  const changes: SharedSchemaChange[] = [];

  for (const kind of ["dbo", "microservice"] as const) {
    const liveRows = new Map(rows(live, kind).map((r) => [identify(r), r]));
    const outgoingRows = new Map(rows(outgoing, kind).map((r) => [identify(r), r]));

    for (const [key, out] of outgoingRows) {
      const current = liveRows.get(key);
      const name = nameOf(out);
      if (current === undefined) {
        changes.push({ kind, name, action: "create" });
        continue;
      }
      // Identity matched, so a differing name is a RENAME — an alteration of a
      // shared object, not a create plus a remove. Reporting it as a pair would
      // double-count and imply data loss that is not happening.
      const details = kind === "dbo" ? tableDelta(current, out) : objectDelta(current, out);
      if (details.length > 0) changes.push({ kind, name, action: "alter", details });
    }

    // A merge does not delete what the bundle omits — only `--prune` does. Without
    // this gate every workspace holding one table the project does not declare
    // (a hand-made table, another team's) would have EVERY branch release refused
    // for a removal that was never going to happen.
    if (opts.prune === true) {
      for (const [key, current] of liveRows) {
        if (!outgoingRows.has(key)) changes.push({ kind, name: nameOf(current), action: "remove" });
      }
    }
  }

  return changes;
}

/** How two versions of the same table differ, in terms a reader can act on. */
function tableDelta(live: Record<string, unknown>, outgoing: Record<string, unknown>): string[] {
  const details: string[] = [];
  const before = typedColumnsOf(live);
  const after = typedColumnsOf(outgoing);

  const liveName = nameOf(live);
  const outgoingName = nameOf(outgoing);
  if (liveName !== outgoingName) details.push(`renamed from "${liveName}" to "${outgoingName}"`);

  for (const [column, type] of after) {
    const current = before.get(column);
    if (current === undefined) {
      details.push(`add column "${column}"`);
    } else if (current !== type) {
      // A retype rewrites stored values in place. It is the change most likely
      // to be destructive while looking like an edit.
      details.push(`retype column "${column}" (${current} → ${type})`);
    }
  }
  for (const column of before.keys()) {
    if (!after.has(column)) details.push(`drop column "${column}"`);
  }
  const liveIndexes = indexKeysOf(live);
  const nextIndexes = indexKeysOf(outgoing);
  for (const index of nextIndexes) if (!liveIndexes.includes(index)) details.push(`add index ${index}`);
  for (const index of liveIndexes) if (!nextIndexes.includes(index)) details.push(`drop index ${index}`);
  return details;
}

/** What a landing adds to the shared tables without altering anything already there. */
export interface TableAdditions {
  /** Tables the target does not have, by name. */
  readonly createdTables: readonly string[];
  /** Columns a table the target has does not, as `table.column`. Existing rows read the type's empty value, or the column's default. */
  readonly addedColumns: readonly string[];
  /** The added columns that declare a default, `table.column` → the default existing rows read. */
  readonly addedDefaults: Readonly<Record<string, string>>;
  /** Tables matched by identity under another name. */
  readonly renamedTables: readonly { from: string; to: string }[];
}

/** The additive half of {@link sharedSchemaChanges}, structured — the half {@link diffAgainstLive} does not report. */
export function tableAdditions(outgoing: unknown, live: ExportedBundle): TableAdditions {
  const liveTables = new Map(rows(live, "dbo").map((t) => [identify(t), t]));
  const createdTables: string[] = [];
  const addedColumns: string[] = [];
  const renamedTables: { from: string; to: string }[] = [];
  const addedDefaults: Record<string, string> = {};
  for (const table of rows(outgoing, "dbo")) {
    const current = liveTables.get(identify(table));
    const name = nameOf(table);
    if (current === undefined) {
      createdTables.push(name);
      continue;
    }
    if (nameOf(current) !== name) renamedTables.push({ from: nameOf(current), to: name });
    const before = typedColumnsOf(current);
    const defaults = columnsOf(table, "default", (v) => (typeof v === "string" ? v : ""));
    for (const column of typedColumnsOf(table).keys()) {
      if (before.has(column)) continue;
      addedColumns.push(`${name}.${column}`);
      const value = defaults.get(column) ?? "";
      if (value !== "") addedDefaults[`${name}.${column}`] = value;
    }
  }
  return { createdTables, addedColumns, addedDefaults, renamedTables };
}

/** A microservice carries no schema, so the comparison is whole-object. */
function objectDelta(live: Record<string, unknown>, outgoing: Record<string, unknown>): string[] {
  const liveName = nameOf(live);
  const outgoingName = nameOf(outgoing);
  if (liveName !== outgoingName) return [`renamed from "${liveName}" to "${outgoingName}"`];
  return deepEqual(normalize(live), normalize(outgoing)) ? [] : ["configuration differs"];
}

/**
 * What comparing the outgoing bundle against the live workspace object-by-object
 * said about whether the import has anything to do.
 *
 * `differing` is a sample, not the whole set: it exists to say WHY a release is
 * not a no-op, and a workspace where everything changed does not need every name
 * repeated back.
 */
export interface Convergence {
  /**
   * True only when the bundle carries something to compare AND every bit of it
   * is already in the workspace, byte-for-byte. A bundle with nothing comparable
   * is not evidence of convergence — it is an absence of evidence.
   *
   * MISSING counts against this exactly as DIFFERING does, and that is not a
   * detail: convergence is what lets a release skip its import, so a comparison
   * that shrugged at "the workspace does not have this object at all" would skip
   * the one release that was entirely new work.
   */
  readonly converged: boolean;
  /** How many objects (and settings rows) the comparison actually looked at. */
  readonly compared: number;
  /**
   * `<sdkKind>:<name>` entries (see {@link rowLabeler}) the target HOLDS but does not match — capped at
   * `sample` unless the caller asked for the whole set.
   *
   * Deliberately narrower than it once was: an object with no counterpart at all
   * is reported in {@link missing} instead. The two are the same failure to a
   * release and two different facts to a reader — "you are running an older one"
   * versus "you are running none" — and only the caller knows which sentence it
   * needs to print.
   */
  readonly differing: readonly string[];
  /** How many objects differ in total, whatever {@link differing} sampled. */
  readonly differingCount: number;
  /**
   * `<sdkKind>:<name>` entries the bundle DECLARES and the target does not carry
   * — capped at `sample` unless the caller asked for the whole set.
   *
   * This is the only class a verification may fail on. An object the bundle
   * declares and the target lacks means the write did not arrive; an object the
   * target carries and the bundle does not is somebody else's work
   * ({@link liveOnly}) and never a failure.
   */
  readonly missing: readonly string[];
  /** How many declared objects are absent in total, whatever {@link missing} sampled. */
  readonly missingCount: number;
  /**
   * Objects the workspace holds that the bundle does not carry — what `--prune`
   * would delete, and what a diff calls UNEXPECTED.
   *
   * Complete rather than sampled, and deliberately so: a merge leaves these
   * alone, so their count is not a size to summarize but a list someone has to
   * read before deciding to prune.
   */
  readonly liveOnly: readonly string[];
  /**
   * When `workspace:(settings)` is in {@link differing}, the dotted field paths
   * that make it differ (`settings.ai_enabled`, `documentation.require_token`,
   * `env.<NAME>` for an env key the workspace lacks). Names only, never values —
   * the row holds secrets. Empty when the settings row matches.
   */
  readonly settingsFields: readonly string[];
}

/** How the caller wants the two sampled lists sized. */
export interface CompareOptions {
  /**
   * How many names {@link Convergence.differing} and {@link Convergence.missing}
   * each carry — a number, or `"all"` for the whole set.
   *
   * Defaults to the release report's handful. That report wants a sample: it
   * prints the names to say WHY a release is not a no-op, and a thousand of them
   * would say nothing. A diff command was ASKED for the list, so for it a sample
   * is a wrong answer rather than a tidy one.
   */
  readonly sample?: number | "all";
  /**
   * How the workspace `documentation` block is compared (see
   * {@link documentationDifferences}).
   *
   * - `"request"` (default) — for a release that WRITES the block: a token the
   *   archive carries is a request whose outcome cannot be read, so it is never
   *   converged.
   * - `"skip"` — for a merge, which does not write the block at all, so it can
   *   never be a reason to send.
   * - `"compare"` — for a question about what live SAYS (`workspace diff`,
   *   the pre-cut check): the gate and the token's value are compared as values.
   */
  readonly documentation?: "request" | "skip" | "compare";
}

/** The payload key holding the workspace's own settings row. */
const WORKSPACE_KEY = "workspace";
/** The payload key holding env vars, which the SDK writes at the payload root. */
const ENV_KEY = "env";
/**
 * The payload key holding the file library. A library row the project does not
 * declare is never reported as extra: seed files ride only a `--seed` build,
 * a running app stores uploads there, and a release carries no file bytes.
 */
const VAULT_KEY = "vault";

/**
 * Payload keys that describe the ARCHIVE, not anything in the workspace, so
 * they are neither compared nor counted: `metadata` is the release record a
 * release archive carries (a compile and a live export have none), and
 * `partial` is the export's own flag. Counted, they made promote's verification
 * report "10 objects compared" where `workspace diff` of the same content said
 * 9 — and neither number was a count of objects.
 */
const ARCHIVE_KEYS: ReadonlySet<string> = new Set(["metadata", "partial"]);

/**
 * Workspace settings keys the comparison below does not read, and why.
 *
 * `env` because a merge is ADD-only for it — an existing key keeps its live
 * value whatever the archive says, so a differing value is not something the
 * import would write (it is reported on its own, see {@link diffAgainstLive}).
 *
 * `canonical` because a public URL slug is NOT settled by this comparison, and
 * describing it as settled is what made a broken release read as a clean one.
 * A slug is unique across the whole instance rather than per workspace, so what
 * an import does with the archive's value depends on who else holds it: an
 * older instance keeps whatever the object already had and substitutes a token
 * when the requested one is taken, and a release can end up serving a URL no
 * one asked for while every object compares equal here. The slug is therefore
 * answered where the answer exists — the import's own report of what it served
 * on an instance that has the xanosdk import route, and a read-back of the live
 * objects on one that does not (see `deploy/canonical-readback.ts`) — and a
 * difference there fails the release even when this comparison converged.
 *
 * `guid` because the workspace's own identity is the engine's, not this
 * project's. The workspace is addressed by id, and the archive's value is
 * dropped on the way in, so the two can never agree and comparing them would make
 * EVERY release of an already-released project report as diverged. That is not
 * a cosmetic difference: convergence is what decides whether an import is
 * skipped, so a comparison that can never converge disables the check entirely.
 *
 * `documentation` is NOT excluded outright. Its `token` is authored, resolved
 * from `xano/.secrets.json` at build time, so a blanket exclusion would let a
 * release whose ONLY change is a restored doc-site gate report up-to-date and
 * send nothing. That defeats the remediation flow a user reaches for right
 * after a leak, which is the worst possible place for it.
 *
 * What is excluded is per-member and lives in {@link documentationDifferences}:
 * the `whitelist` is a MAP whose empty form the engine returns as an empty
 * list, so it still cannot be compared, and a token the archive carries is a
 * REQUEST the live row answers with an outcome — so a resolved token is treated
 * as unconditionally non-converged rather than compared. `require_token`, which
 * is authored and comparable, is compared.
 *
 * `checksum` because the engine derives it from the row on save. No archive
 * reproduces the live value — not even a raw export of this same workspace — so
 * comparing it made every such diff report `workspace:(settings)`. It is
 * compared nowhere; it sits here because this is the one set the row is
 * filtered through.
 *
 * `iv`, `salt`, `secret` and `crypto` because they are the workspace's own key
 * material: an exported bundle (`--bundle`) carries its source workspace's, and
 * no two workspaces share them, so comparing them reported drift on every such
 * cut — and printed the key-material field names doing it. Compared nowhere.
 */
const SETTINGS_KEYS_COMPARED_ELSEWHERE = new Set([
  WORKSPACE_KEY,
  ENV_KEY,
  "canonical",
  "guid",
  "documentation",
  "checksum",
  "iv",
  "salt",
  "secret",
  "crypto",
]);

/**
 * Workspace keys a compile always writes, and the value it writes when the
 * project does not author one. Recursive for the two blocks: a member a live row
 * does not store reads as this default, never the other way round.
 */
const WORKSPACE_VALUE_DEFAULTS: Readonly<Record<string, unknown>> = {
  settings: DEFAULT_SETTINGS,
  preferences: DEFAULT_PREFERENCES,
  swagger: false,
  description: "",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `live` with every member it does not store read as `fallback`'s. Present
 * members are kept as they are — a stored value is an answer, even one away
 * from the default — and plain objects recurse, so a live `settings` holding
 * only `ai_enabled` reads as the whole default tree around it.
 */
function fillAbsentDefaults(live: unknown, fallback: unknown): unknown {
  if (live === undefined) return fallback;
  if (!isPlainObject(live) || !isPlainObject(fallback)) return live;
  const out: Record<string, unknown> = { ...live };
  for (const [key, member] of Object.entries(fallback)) out[key] = fillAbsentDefaults(live[key], member);
  return out;
}

/**
 * The two sides of the settings row put where a one-way subset can judge them.
 *
 * A compile writes the whole AI provider tree, `allow_push`, `swagger: false`
 * and an empty description whether or not anyone wrote them, and a live row
 * stores those shorter or not at all. The gap is closed on the LIVE side, by
 * reading what it does not store as the default, and never by dropping our
 * defaults: a merge WRITES `preferences`, `settings` and `description`, so our
 * default over a live `allow_push: true` or a live description is a reset the
 * release would perform, and subtracting it made that read as converged.
 *
 * The presence-gated keys ({@link isWorkspaceKeyAtDefault}) are the other
 * direction: the engine materializes them on save, so ours at the default
 * matches a live row that lacks the key OR holds it at its default by the same
 * predicate — which may be a different spelling (an empty whitelist list for
 * `{}`). A live value away from the default is compared as usual, and differs.
 *
 * The defaulted keys are read from the RAW rows, not the normalized ones.
 * `normalize()` reads `""`, `false` and a blank provider `model` as absent —
 * right for statement spellings, wrong here: it dropped our empty description
 * and `swagger: false` before the comparison saw them, so a live description or
 * a live `swagger: true` the merge would overwrite read as converged all the
 * same.
 */
function settingsSides(
  row: Record<string, unknown>,
  theirs: unknown,
  rawOurs: Record<string, unknown>,
  rawTheirs: unknown,
): { ours: Record<string, unknown>; live: unknown } {
  if (!isPlainObject(theirs)) return { ours: omitComparedElsewhere(row), live: theirs };
  const rawLive = isPlainObject(rawTheirs) ? rawTheirs : theirs;
  const live: Record<string, unknown> = { ...theirs };
  const ours: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(WORKSPACE_VALUE_DEFAULTS)) {
    live[key] = fillAbsentDefaults(rawLive[key], fallback);
    if (Object.hasOwn(rawOurs, key)) ours[key] = rawOurs[key];
  }
  for (const [key, value] of Object.entries(omitComparedElsewhere(row))) {
    if (Object.hasOwn(WORKSPACE_VALUE_DEFAULTS, key)) continue;
    if (
      isWorkspaceKeyAtDefault(key, value) &&
      (theirs[key] === undefined || isWorkspaceKeyAtDefault(key, theirs[key]))
    ) {
      continue;
    }
    ours[key] = value;
  }
  return { ours, live };
}

function omitComparedElsewhere(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !SETTINGS_KEYS_COMPARED_ELSEWHERE.has(key)));
}

/**
 * Where is an authored value in `ours` NOT already present in `theirs`,
 * recursively? Empty when every one is.
 *
 * Object keys are checked one way on purpose. The engine's workspace row carries
 * a great deal the SDK never authors — instance crypto material, usage counters,
 * git binding, provider slots for models this workspace has never used — and
 * every one of those is a key the archive does not carry and the import does not
 * write. Demanding equality there would report "changed" on every workspace
 * forever, which is the state this whole comparison exists to end.
 *
 * ARRAYS are still compared whole: a list the SDK writes (a datasource, a
 * middleware chain) is written as a list, so a shorter one is a real difference
 * rather than a server addition.
 *
 * Answers with dotted paths to the deepest member that disagrees, so a reader is
 * pointed at `settings.ai_enabled` rather than at the whole `settings` block —
 * paths only, never values, since the settings row holds provider keys and
 * tokens. A disagreement at the root itself is `(row)`.
 */
function subsetDifferences(ours: unknown, theirs: unknown, path = ""): string[] {
  const here = [path === "" ? "(row)" : path];
  if (ours === null || typeof ours !== "object") return deepEqual(ours, theirs) ? [] : here;
  if (Array.isArray(ours) || Array.isArray(theirs)) return deepEqual(ours, theirs) ? [] : here;
  if (theirs === null || typeof theirs !== "object") return here;
  const live = theirs as Record<string, unknown>;
  return Object.entries(ours as Record<string, unknown>).flatMap(([key, value]) =>
    subsetDifferences(value, live[key], path === "" ? key : `${path}.${key}`),
  );
}

/**
 * Does the workspace settings row already say what the archive says?
 *
 * The one row an import always writes, and the one that cannot be compared like
 * an object: see {@link subsetDifferences} for what the engine keeps in it, and
 * {@link SETTINGS_KEYS_COMPARED_ELSEWHERE} for the two keys answered by their own
 * rules. Env is read through {@link envOf} because the two sides spell it
 * differently — the SDK writes it at the payload root and an export has been
 * observed carrying it on the workspace row.
 *
 * Answers with the differing field paths rather than a boolean, so a diff can
 * say WHICH setting differs; an empty list is a match. `(row)` stands for a row
 * that is not an object at all, where there is no member to name.
 */
function workspaceSettingsDifferences(
  ours: unknown,
  theirs: unknown,
  outgoing: unknown,
  live: unknown,
  documentation: NonNullable<CompareOptions["documentation"]>,
): string[] {
  if (ours === null || typeof ours !== "object" || Array.isArray(ours)) {
    return deepEqual(normalize(ours), normalize(theirs)) ? [] : ["(row)"];
  }
  const sides = settingsSides(
    normalize(ours) as Record<string, unknown>,
    normalize(theirs),
    ours as Record<string, unknown>,
    theirs,
  );
  const fields = subsetDifferences(sides.ours, sides.live);
  if (documentation !== "skip") fields.push(...documentationDifferences(ours, theirs, documentation));

  // An env key the workspace does not have yet is something the import WOULD
  // add, so it is a difference. One it already has is not, whatever the value:
  // a merge will not change it.
  const liveEnv = envValuesOf(live);
  for (const name of envValuesOf(outgoing).keys()) {
    if (!liveEnv.has(name)) fields.push(`env.${name}`);
  }
  return fields;
}

/**
 * Does the live workspace already say what the archive's `documentation` block
 * says?
 *
 * Member by member, because the block's three members answer to three different
 * rules:
 *
 * - `token` — the archive's value is a request and the live row's is an outcome,
 *   so they cannot be compared. A block that carries one at all is therefore
 *   NOT converged: a release whose only change is the restored gate has to send.
 *   A block with no token says nothing about the token and converges on it.
 * - `whitelist` — a MAP the engine returns in its empty form as an empty list,
 *   so an untouched block differs on a spelling nobody changed. Not compared.
 * - `require_token` — authored, comparable, and the member most worth catching.
 *
 * A block ABSENT from the archive converges trivially: omission now means "leave
 * the live block alone", so there is nothing for the import to write.
 */
function documentationDifferences(ours: unknown, theirs: unknown, mode: "request" | "compare"): string[] {
  const authored = (ours as Record<string, unknown>).documentation;
  if (authored === null || typeof authored !== "object" || Array.isArray(authored)) return [];
  const block = authored as Record<string, unknown>;
  const live = theirs !== null && typeof theirs === "object" && !Array.isArray(theirs)
    ? ((theirs as Record<string, unknown>).documentation as Record<string, unknown> | undefined)
    : undefined;
  const fields: string[] = [];
  if (typeof block.token === "string" && block.token !== "") {
    // For a release, a token in the archive is a request whose outcome this
    // comparison cannot read, so its presence alone stops the release being
    // treated as a no-op. For a diff the live token IS the outcome, so it is
    // compared as a value.
    if (mode === "request" || block.token !== live?.token) fields.push("documentation.token");
  }
  if (Object.hasOwn(block, "require_token") && !deepEqual(block.require_token, live?.require_token)) {
    fields.push("documentation.require_token");
  }
  return fields;
}

/**
 * How many names each reported list carries by default — see
 * {@link CompareOptions.sample}, which is how a caller asks for all of them.
 */
const SAMPLE = 5;

/**
 * `payload` as a record, or an empty one.
 *
 * Exported because the landing verification reads the same decoded-archive
 * shape to list what a release declared, and two copies of "is there a payload
 * object here" is two places for the answer to drift.
 */
export function payloadOf(bundle: unknown): Record<string, unknown> {
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** A row's guid, or `undefined` when it carries none. */
function guidOf(row: Record<string, unknown>): string | undefined {
  const guid = row.guid;
  return typeof guid === "string" && guid !== "" ? guid : undefined;
}

/**
 * One section's live rows, indexed both ways.
 *
 * Guid first, because that is what the engine matches an import on. Name is not
 * a synonym for it but a FALLBACK for the case the guid index cannot answer: a
 * live export has been observed carrying rows with no guid at all (the `app`
 * section is one), and keying only by guid reported every such object as new on
 * every release. A name that repeats within the section is excluded rather than
 * guessed at — two objects sharing a name would otherwise compare against each
 * other, and a comparison that matched the wrong object could report
 * convergence over a real change.
 */
function indexSection(rows: readonly unknown[]): {
  byGuid: Map<string, Record<string, unknown>>;
  byName: Map<string, Record<string, unknown>>;
  all: Record<string, unknown>[];
} {
  const byGuid = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  const repeated = new Set<string>();
  const all: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    all.push(record);
    const guid = guidOf(record);
    if (guid !== undefined) byGuid.set(guid, record);
    const name = record.name;
    if (typeof name !== "string" || name === "") continue;
    if (byName.has(name) || repeated.has(name)) {
      byName.delete(name);
      repeated.add(name);
      continue;
    }
    byName.set(name, record);
  }
  return { byGuid, byName, all };
}

/**
 * The name-keyed counterpart, when name is allowed to answer: either the live
 * row carries no guid (an export shape observed for whole sections), or the
 * outgoing row does not, so there is no guid to disagree on.
 */
function byNameWithoutGuid(
  index: { byName: Map<string, Record<string, unknown>> },
  name: string,
  ourGuid: string | undefined,
): Record<string, unknown> | undefined {
  const candidate = index.byName.get(name);
  if (candidate === undefined) return undefined;
  return guidOf(candidate) === undefined || ourGuid === undefined ? candidate : undefined;
}

/** A row's display name, for the report: a reference file, which has none, by its path. */
function nameOf(row: Record<string, unknown>): string {
  if (typeof row.name === "string" && row.name !== "") return row.name;
  return typeof row.path === "string" && row.path !== "" ? row.path.replace(/^knowledge-refs\/[^/]+\//, "") : "(unnamed)";
}

/**
 * The SDK's name for each payload section whose key is not already that name.
 *
 * The payload keys are the engine's storage names, and a reader authored
 * `table()` and `apiGroup()`, never a `dbo` or an `app` — so every label the
 * comparison hands a report is spelled the way the author wrote the object.
 * `toolset` is absent: it holds two kinds, told apart per row (see
 * {@link sectionKind}).
 */
const SDK_KIND_BY_SECTION: Readonly<Record<string, string>> = {
  dbo: "table",
  app: "apiGroup",
  workflow_test: "workflowTest",
  realtime_server: "realtimeServer",
  channel: "realtimeChannel",
  message: "realtimeMessage",
};

/**
 * The SDK kind a row of `key` was authored as.
 *
 * Exported so every report that names an object — the diff, promote, a
 * `--keep-data` removal line, `preflight`, the release plan — spells a kind one way.
 */
export function sectionKind(key: string, row?: Record<string, unknown>): string {
  if (key === "toolset") return row?.type === "agent" ? "agent" : "mcpServer";
  return (Object.hasOwn(SDK_KIND_BY_SECTION, key) ? SDK_KIND_BY_SECTION[key] : undefined) ?? key;
}

/**
 * The payload section an import plan's operation `type` names.
 *
 * The plan reports two sections under other names — `dbo` as `table` and `app`
 * as `api_group` — and every other type under its section's own. Mapped back
 * here so a plan operation is labelled through {@link sectionKind} like any row.
 */
export function planTypeSection(type: string): string {
  return (Object.hasOwn(PLAN_TYPE_SECTIONS, type) ? PLAN_TYPE_SECTIONS[type] : undefined) ?? type;
}
const PLAN_TYPE_SECTIONS: Readonly<Record<string, string>> = { table: "dbo", api_group: "app" };

/** The label of the workspace settings row, as every report spells it. */
export const SETTINGS_LABEL = `${sectionKind(WORKSPACE_KEY)}:(settings)`;

/**
 * How one payload's rows are named in a report: `<sdkKind>:<name>`.
 *
 * A query is named by its whole identity — verb and api group as well as its
 * name — because the name alone repeats freely: a `ping` in two groups was
 * listed as both missing and unexpected under one indistinguishable label. The
 * group is read out of the SAME payload, since a compiled bundle binds it by
 * guid and an export by local id. The name stays at the end of the label's
 * name part, so a suffixed rename (`ping_01`) is still recognisable.
 *
 * A realtime channel or message repeats its name across servers (and a message
 * across channels): one whose name repeats in the payload is named by its
 * composed identity, `realtimeMessage:rt|lobby|chat`, as the lock and the
 * decode report name it (E2E pass 22: a prune refusal listed
 * `realtimeMessage:chat` twice).
 */
export function rowLabeler(payload: Record<string, unknown>): (key: string, row: Record<string, unknown>) => string {
  const groups = new Map<unknown, string>();
  for (const group of Array.isArray(payload.app) ? payload.app : []) {
    if (group === null || typeof group !== "object") continue;
    const g = group as Record<string, unknown>;
    if (typeof g.name !== "string") continue;
    if (typeof g.guid === "string" && g.guid !== "") groups.set(g.guid, g.name);
    if (typeof g.id === "number" && g.id !== 0) groups.set(g.id, g.name);
  }
  return (key, row) => {
    const kind = sectionKind(key, row);
    // A reference file has no name: it is its knowledge item's name and its path.
    if (key === "knowledge_file") return `${kind}:${identityName(payload, key, row)}`;
    if ((key === "channel" || key === "message") && typeof row.name === "string" && row.name !== "") {
      return `${kind}:${identityName(payload, key, row)}`;
    }
    if (key !== "query") return `${kind}:${nameOf(row)}`;
    const verb = typeof row.verb === "string" && row.verb !== "" ? `${row.verb} ` : "";
    const ref = (row.app as { id?: unknown } | null | undefined)?.id;
    const group =
      ref === undefined || ref === 0 || ref === "" ? undefined : (groups.get(ref) ?? (typeof ref === "number" ? `#${ref}` : String(ref)));
    return `${kind}:${verb}${nameOf(row)}${group === undefined ? "" : ` (apiGroup ${group})`}`;
  };
}

/** Every named object a bundle declares, labelled as {@link compareToLive} labels them. */
export function declaredLabels(bundle: unknown): string[] {
  const payload = payloadOf(bundle);
  const label = rowLabeler(payload);
  return Object.entries(payload).flatMap(([key, section]) =>
    Array.isArray(section)
      ? section.flatMap((row) =>
          row !== null && typeof row === "object" && typeof (row as { name?: unknown }).name === "string"
            ? [label(key, row as Record<string, unknown>)]
            : [],
        )
      : [],
  );
}

/**
 * Would importing this bundle write anything the workspace does not already
 * hold?
 *
 * Re-releasing an unchanged project rewrote every object: the server's dry run
 * answers "update" for every identity that MATCHES, which is not the same
 * question as "does it differ", so `upToDate` could never become true and every
 * invocation touched every object's `updated_at`. The comparison is
 * the missing half, and it is cheap: the live workspace is already read for the
 * loss report.
 *
 * **Written for a MERGE**, which is the only mode that can be a no-op: env is
 * add-only there, so an env key the workspace already holds is not something the
 * import would rewrite whatever value the archive carries, and an object the
 * workspace holds and the bundle does not is left alone rather than deleted.
 *
 * Compared under `normalize()`, the same rule the round-trip check uses — it
 * drops the server-assigned keys an export carries and the SDK never writes, so
 * what is left is authored state on both sides.
 *
 * **Two callers, one comparison.** A release asks "is there anything to do"; a
 * diff asks "did what I wrote arrive". Those are the same keyed-by-`kind:name`
 * walk read two ways, so they share it rather than each growing their own — two
 * comparisons would eventually disagree, and the one that disagreed while
 * claiming to verify a release would be the dangerous one. What the callers
 * choose is the wording and the list size, never the verdict: `missing`,
 * `differing` and `liveOnly` are separated here so nobody has to re-derive them
 * from a flattened list of names.
 *
 * **Conservative by construction.** A false "changed" costs one import that was
 * already happening; a false "unchanged" silently skips a real release, so every
 * uncertainty resolves to changed: an object with no live counterpart, an object
 * whose identity cannot be read, and any section the bundle carries that the
 * live export does not. Objects the WORKSPACE holds and the bundle does not are
 * reported separately rather than counted — a merge leaves them alone, and only
 * `--prune` (which deletes them) makes them a difference.
 */
/**
 * Whether a stored value is the engine's default for a key: one predicate per
 * key, so a default with two spellings (`test: []` and `test: null`) is one rule.
 */
type EngineDefault = (value: unknown) => boolean;

const isEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 0;
const isEmptyText = (v: unknown): boolean => v === "";
const isFalse = (v: unknown): boolean => v === false;
const isNull = (v: unknown): boolean => v === null;
const isNoTests = (v: unknown): boolean => v === null || isEmptyList(v);
/** Every member null — the engine's unset hint block, whichever hints it lists. */
const allNull = (v: unknown): boolean => isPlainObject(v) && Object.values(v).every((m) => m === null);
/** The telemetry block a new agent is stored with: off, every exporter blank. */
const telemetryOff = (v: unknown): boolean =>
  deepEqual(v, {
    enabled: false,
    langfuse: { base_url: "", public_key: "", secret_key: "" },
    langsmith: { api_key: "" },
    braintrust: { api_key: "", project_name: "" },
    destination: "",
  });

/**
 * Keys the engine fills on an AI object the SDK does not write, at the value it
 * fills them with — measured on an ephemeral right after a deploy (2026-09-28),
 * where each read as drift and `release create` told the author to deploy the
 * very code that was running.
 *
 * A key is dropped from a side that lacks it or holds it at this default. A
 * live value away from the default (a hint set, telemetry on, a prompt added in
 * the builder) still differs, since a release carries it.
 */
const ENGINE_FILLED_DEFAULTS: Readonly<Record<string, { readonly [key: string]: EngineDefault }>> = {
  tool: {
    auth: isFalse,
    icons: isEmptyList,
    title: isEmptyText,
    annotations: allNull,
    output_schema: isEmptyList,
    test: isNoTests,
  },
  // Agents and MCP servers share the section; an MCP server stores no settings.
  toolset: {
    prompt: isEmptyList,
    resource: isEmptyList,
    agent_settings: isNull,
  },
};

/** An agent's own settings block: members the engine fills inside it. */
const AGENT_SETTINGS_DEFAULTS: { readonly [key: string]: EngineDefault } = {
  model: isEmptyText,
  telemetry: telemetryOff,
};

/**
 * `row` with every key of `defaults` removed that it lacks or holds at its
 * default. Copies; the row itself is untouched.
 *
 * One-sided, so a row can be digested on its own (see {@link canonicalRow}).
 * The verdict is the one a two-sided rule would reach: a side away from the
 * default keeps the key, so it still differs from a side that dropped it.
 */
function withoutEngineDefaults(
  defaults: { readonly [key: string]: EngineDefault } | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (defaults === undefined) return row;
  const out = { ...row };
  for (const [key, isDefault] of Object.entries(defaults)) {
    if (!Object.hasOwn(out, key) || isDefault(out[key])) delete out[key];
  }
  // An agent's settings block: its members are judged the same way.
  if (defaults === ENGINE_FILLED_DEFAULTS.toolset && isPlainObject(out.agent_settings)) {
    out.agent_settings = withoutEngineDefaults(AGENT_SETTINGS_DEFAULTS, out.agent_settings);
  }
  return out;
}

/**
 * A table with every column's empty `default` removed, nested columns too.
 *
 * Absent, `null` and `""` are one state to the engine, and a required column's
 * default is discarded whatever it says (see the descriptor rule in
 * `normalize()`). Each one shows up in practice: a uuid primary key is written
 * with no `default` and read back as `null` (E2E pass 24), and a column with no
 * default compiles to `""` while a current instance stores `null`
 * (xano-sdk/sdk-dev#11). `normalize()` fills in only a key that is PRESENT, so
 * removing the key from one side and not the other makes the table differ.
 * The key is therefore removed from both sides here. Copies; the row is
 * untouched.
 */
function withoutEmptyColumnDefaults(table: Record<string, unknown>): Record<string, unknown> {
  const strip = (columns: unknown): unknown =>
    Array.isArray(columns)
      ? columns.map((col) => {
          if (!isPlainObject(col)) return col;
          const { default: d, ...rest } = col;
          const out = d === null || d === "" || col.required === true ? rest : col;
          return Array.isArray(out.children) ? { ...out, children: strip(out.children) } : out;
        })
      : columns;
  return Array.isArray(table.schema) ? { ...table, schema: strip(table.schema) } : table;
}

/**
 * The file an icon `src` names, as `<canonical>/<name>`, when it names one in a
 * file library — or `undefined` for any other src.
 *
 * A compiled `hostedFile()` icon reads `xanosdk-file://<canonical>/<name>` and
 * the landed one `/vault/<workspace>/<canonical>/<signature>/<name>`: the same
 * file, addressed by each backend in its own way. Compared by identity, a
 * project compares clean against the backend it just deployed.
 */
export function hostedIconIdentity(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const decode = (name: string): string => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };
  const placeholder = /^xanosdk-file:\/\/([^/\s]+)\/([^/\s]+)$/.exec(src);
  if (placeholder) return `${placeholder[1]}/${decode(placeholder[2]!)}`;
  const library = /^\/vault\/[^/\s]+\/([^/\s]+)\/[^/\s]+\/([^/\s]+)$/.exec(src);
  if (library) return `${library[1]}/${decode(library[2]!)}`;
  return undefined;
}

/** A row with each library-backed icon `src` replaced by its file identity. Copies. */
function withHostedIconIdentity(row: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(row.icons)) return row;
  return {
    ...row,
    icons: row.icons.map((icon: unknown) => {
      if (!isPlainObject(icon)) return icon;
      const id = hostedIconIdentity(icon.src);
      return id === undefined ? icon : { ...icon, src: `hosted:${id}` };
    }),
  };
}

/**
 * The two sides of an object comparison, with an UNAUTHORED slug removed.
 *
 * A canonical-bearing object that declares no slug is exported with an empty
 * one, and the import mints a token for it. The archive then says `""` for the
 * rest of that object's life while the workspace says the token, so the object
 * differs on every later release — and since convergence is what decides
 * whether an import is skipped, one api group without a pinned slug was enough
 * to make every re-release of the project report work it would not do.
 *
 * Dropped when the project does not PIN this slug. A slug the project DOES pin
 * is still compared, so changing a pin in code still counts as a difference and
 * still gets released — which is why this is not simply excluded the way the
 * workspace row's is.
 *
 * "Pinned" is the question and emptiness is only a proxy for it. Emptiness was
 * a sufficient proxy while an unnamed slug stayed empty all the way to the
 * wire. Once a build maintains a lock, an unnamed slug is MINTED locally, so it
 * is no longer empty while still being a value the project never named and the
 * instance will not adopt on an update — and comparing it would put every api
 * group, toolset and realtime server permanently in the differing set.
 *
 * `pinnedKeys` carries the answer from the caller (`<payloadKey>:<name>`, the
 * keys the release already computed for the import) so the two cannot disagree
 * about which slugs are contracts. Callers with no lock in hand pass nothing
 * and fall back to emptiness, which is exactly right for them: without a lock
 * nothing mints, so an empty slug is still precisely "not named here".
 */
/** Where {@link comparable} carries a table's index set past `normalize()`. */
const INDEX_SET_KEY = "(indexes)";

function comparable(
  section: string,
  oursIn: Record<string, unknown>,
  theirsIn: Record<string, unknown>,
  pinned: boolean,
): [unknown, unknown] {
  return [canonicalRow(section, oursIn, pinned), canonicalRow(section, theirsIn, pinned)];
}

/**
 * One side of an object comparison, in the form {@link compareToLive} compares:
 * two rows are the same object state exactly when their canonical rows are
 * deep-equal. One-sided, so a row can be digested and the digest compared later
 * (see `sync-baseline.ts`) under the same rule the comparison uses.
 */
export function canonicalRow(section: string, rowIn: Record<string, unknown>, pinned: boolean): unknown {
  let row = withoutEngineDefaults(Object.hasOwn(ENGINE_FILLED_DEFAULTS, section) ? ENGINE_FILLED_DEFAULTS[section] : undefined, rowIn);
  if (section === "dbo") {
    // `normalize()` strips `index` everywhere, so a table's indexes ride under a
    // key it keeps: an added unique index is drift like any other change.
    row = { ...withoutEmptyColumnDefaults(row), [INDEX_SET_KEY]: indexKeysOf(rowIn) };
  }
  if ((HOSTED_ICON_KINDS as readonly string[]).includes(section)) row = withHostedIconIdentity(row);
  if (pinned || !("canonical" in row)) return normalize(row);
  const { canonical: _slug, ...rest } = row;
  return normalize(rest);
}

/**
 * Does the project pin this object's slug?
 *
 * With `pinnedKeys` the caller has already decided, from the lock, and this is
 * a lookup. Without it the honest fallback is "a non-empty slug is one the
 * project named", which is what emptiness meant before a build minted anything.
 */
function pinsCanonical(
  key: string,
  record: Record<string, unknown>,
  pinnedKeys: ReadonlySet<string> | undefined,
): boolean {
  const name = typeof record.name === "string" ? record.name : undefined;
  if (pinnedKeys !== undefined) {
    return name !== undefined && pinnedKeys.has(`${key}:${name}`);
  }
  return typeof record.canonical === "string" && record.canonical !== "";
}

export function compareToLive(
  outgoing: unknown,
  live: ExportedBundle,
  /**
   * The slugs this project pins, as `<payloadKey>:<name>` — the same set the
   * release sends to the import. Omit it and the comparison falls back to
   * treating a non-empty slug as pinned; see {@link comparable} for why that is
   * right for a caller with no lock and wrong for one that has a lock.
   */
  pinnedKeys?: ReadonlySet<string>,
  opts: CompareOptions = {},
): Convergence {
  const ours = payloadOf(outgoing);
  const theirs = payloadOf(live);
  const ourLabel = rowLabeler(ours);
  const theirLabel = rowLabeler(theirs);
  const cap = opts.sample === "all" ? Number.POSITIVE_INFINITY : (opts.sample ?? SAMPLE);
  const differing: string[] = [];
  const missing: string[] = [];
  const liveOnly: string[] = [];
  let settingsFields: string[] = [];
  let differingCount = 0;
  let missingCount = 0;
  let compared = 0;

  /** Present on both sides, not equal. */
  const note = (label: string): void => {
    differingCount++;
    if (differing.length < cap) differing.push(label);
  };
  /**
   * Declared here, absent there.
   *
   * A separate bucket, never a separate VERDICT: both callers treat it as
   * non-convergence, and only the wording they print differs.
   */
  const absent = (label: string): void => {
    missingCount++;
    if (missing.length < cap) missing.push(label);
  };

  for (const [key, value] of Object.entries(ours)) {
    // Env is answered once, by name, in `workspaceSettingsDifferences` — the two sides
    // spell it differently and a merge treats it differently from an object.
    if (key === ENV_KEY || ARCHIVE_KEYS.has(key)) continue;
    if (key === WORKSPACE_KEY) {
      compared++;
      settingsFields = workspaceSettingsDifferences(value, theirs[key], outgoing, live, opts.documentation ?? "request");
      if (settingsFields.length > 0) note(SETTINGS_LABEL);
      continue;
    }
    // Any other non-array section is compared whole: there is one of it, and an
    // import writes it.
    if (!Array.isArray(value)) {
      compared++;
      if (!deepEqual(normalize(value), normalize(theirs[key]))) note(`${sectionKind(key)}:(settings)`);
      continue;
    }
    const liveSection = theirs[key];
    const index = indexSection(Array.isArray(liveSection) ? liveSection : []);
    const matched = new Set<Record<string, unknown>>();
    for (const row of value) {
      compared++;
      if (row === null || typeof row !== "object") {
        note(`${sectionKind(key)}:(unreadable)`);
        continue;
      }
      const record = row as Record<string, unknown>;
      const guid = guidOf(record);
      const name = typeof record.name === "string" ? record.name : undefined;
      const counterpart =
        (guid !== undefined ? index.byGuid.get(guid) : undefined) ??
        // Name only answers what guid cannot. A live row that HAS a guid and
        // does not have ours is a different object — the import would create
        // ours alongside it — so the fallback is refused there and taken only
        // when one side carries no guid at all.
        (name !== undefined ? byNameWithoutGuid(index, name, guid) : undefined);
      if (counterpart === undefined) {
        // Nothing to compare against, so this is absence rather than
        // disagreement. An unreadable row above stays DIFFERING: it is a row the
        // target may well be holding, and calling it missing would report the
        // one class a verification fails on over a shape this side could not read.
        absent(ourLabel(key, record));
        continue;
      }
      matched.add(counterpart);
      if (!deepEqual(...comparable(key, record, counterpart, pinsCanonical(key, record, pinnedKeys)))) {
        note(ourLabel(key, record));
      }
    }
    if (key === VAULT_KEY) continue;
    for (const row of index.all) {
      if (!matched.has(row)) liveOnly.push(theirLabel(key, row));
    }
  }
  // A section the target holds and this side carries NO key for at all — a
  // project with no workflow tests, say, against a target that has one. The
  // loop above only visits our keys, so every row there went unreported: a
  // release cut from such a target reported zero drift while carrying an
  // object the project does not have.
  for (const [key, value] of Object.entries(theirs)) {
    if (key in ours || key === ENV_KEY || key === WORKSPACE_KEY || key === VAULT_KEY || ARCHIVE_KEYS.has(key)) continue;
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (row !== null && typeof row === "object") liveOnly.push(theirLabel(key, row as Record<string, unknown>));
    }
  }

  return {
    converged: compared > 0 && differingCount === 0 && missingCount === 0,
    compared,
    differing,
    differingCount,
    missing,
    missingCount,
    liveOnly,
    settingsFields,
  };
}
