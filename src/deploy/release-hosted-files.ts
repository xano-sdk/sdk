/**
 * The stored files a release cut on the server would reference without carrying.
 *
 * A cut copies a source's definitions and, with `--seed`, its table rows — but
 * not the bytes of the files in its file library. A row's file column and an
 * MCP icon both hold a path into that library, so on any backend the release
 * lands on the row's file is gone and the icon's URL answers 404. Deploying the
 * project directly ships the bytes, so that is the way to land them.
 *
 * Read from the SOURCE's own export: the release carries what is running there,
 * whatever the project on disk says.
 */
import { HOSTED_ICON_KINDS } from "../fields/hosted-file.js";

/** One reference a cut would leave pointing at nothing. */
export interface UncarriedFile {
  /** `tool` / `prompt` / `resource` for an icon, `table` for seeded rows. */
  kind: string;
  name: string;
  /** `icons[0]`, or the file column(s) of a seeded table. */
  field: string;
}

/** A file column, as the export stores one: image, video, audio or attachment. */
function isFileColumnType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("blob");
}

/** File columns of a stored schema, by path, descending into object columns. */
export function fileColumnsIn(schema: unknown, prefix = ""): string[] {
  if (!Array.isArray(schema)) return [];
  return schema.flatMap((col): string[] => {
    if (col === null || typeof col !== "object") return [];
    const c = col as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name === "") return [];
    const path = `${prefix}${c.name}`;
    return isFileColumnType(c.type) ? [path] : fileColumnsIn(c.children, `${path}.`);
  });
}

/** Whether an icon `src` names a file in the source's own library. */
export function isLibraryIconSrc(src: unknown): boolean {
  return typeof src === "string" && src.startsWith("/vault/");
}

/**
 * Whether a stored row's value at a file column path names a stored file. A
 * file value is an object carrying the library `path`; a list column holds
 * several, and an object column nests the path under its own name.
 */
export function rowHoldsFile(row: unknown, column: string): boolean {
  const holds = (value: unknown, path: readonly string[]): boolean => {
    if (Array.isArray(value)) return value.some((v) => holds(v, path));
    if (value === null || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (path.length === 0) return typeof v.path === "string" && v.path !== "";
    return holds(v[path[0]!], path.slice(1));
  };
  return holds(row, column.split("."));
}

/**
 * Every file reference a cut of `payload` would leave dangling.
 *
 * `seeded` names the tables whose rows the cut carries (by guid, then name).
 * A seeded table counts only when it has a file column, the source's library
 * holds at least one file, AND `rowsHoldFiles` finds a row whose file column
 * names one — a file column with no file in any row carries nothing to drop.
 * The rows are read only past the first two checks, since the export carries
 * no rows.
 */
export async function uncarriedFiles(
  payload: Record<string, unknown>,
  seeded: readonly { guid: string; name: string }[] | undefined,
  rowsHoldFiles: (table: { guid: string; name: string }, columns: readonly string[]) => Promise<boolean>,
): Promise<UncarriedFile[]> {
  const out: UncarriedFile[] = [];
  for (const kind of HOSTED_ICON_KINDS) {
    const rows = payload[kind];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      if (row === null || typeof row !== "object" || !Array.isArray(row.icons)) continue;
      (row.icons as Record<string, unknown>[]).forEach((icon, i) => {
        if (icon !== null && typeof icon === "object" && isLibraryIconSrc(icon.src)) {
          out.push({ kind, name: String(row.name ?? ""), field: `icons[${i}]` });
        }
      });
    }
  }
  const library = Array.isArray(payload.vault) ? payload.vault.length : 0;
  if (seeded !== undefined && seeded.length > 0 && library > 0) {
    const tables = Array.isArray(payload.dbo) ? (payload.dbo as Record<string, unknown>[]) : [];
    for (const want of seeded) {
      const table =
        tables.find((t) => t !== null && typeof t === "object" && t.guid === want.guid) ??
        tables.find((t) => t !== null && typeof t === "object" && t.name === want.name);
      const columns = table === undefined ? [] : fileColumnsIn(table.schema);
      if (columns.length > 0 && (await rowsHoldFiles(want, columns))) {
        out.push({ kind: "table", name: want.name, field: columns.join(", ") });
      }
    }
  }
  return out;
}

/** One line per reference, for a refusal or a notice. */
export function describeUncarried(file: UncarriedFile): string {
  return file.kind === "table"
    ? `table "${file.name}" rows holding files — file column${file.field.includes(",") ? "s" : ""} ${file.field}`
    : `${file.kind} "${file.name}" \`${file.field}\``;
}
