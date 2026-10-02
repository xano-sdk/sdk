/**
 * Reading table relationships out of a stored column.
 *
 * Both are storage details a schema view needs and nothing else states, so they
 * have been reverse-engineered once per tool up to now.
 */

import type { FieldXdo } from "../types/xdo.js";

/**
 * The table a foreign-key column points at, as a guid — or `null` if the column
 * is not a reference.
 *
 * A reference is an `int` or `uuid` column whose LAST method is `@` with a
 * single `dbo=<guid>` argument. The position matters: `@` is an annotation the
 * engine appends, and reading any `@` in the list would misread a column that
 * carries one for another reason.
 *
 * A bare `dbo=` returns `null`. That is what the editor writes when a reference
 * is CLEARED — an FK annotation pointing at nothing, which is not a reference.
 */
export function tableRefOf(column: FieldXdo): string | null {
  if (column.type !== "int" && column.type !== "uuid") return null;
  const last = column.methods?.[column.methods.length - 1];
  const arg = last?.name === "@" ? last.arg?.[0] : undefined;
  if (typeof arg !== "string" || !arg.startsWith("dbo=")) return null;
  const guid = arg.slice("dbo=".length);
  return guid === "" ? null : guid;
}

/**
 * The table a db-link column expands, as a guid — or `null` if the column is not
 * one.
 *
 * The other table relationship, and a different shape entirely: the column's
 * TYPE is the table's identity with `_mvpschema` appended, and the engine
 * expands the link into one input per column of the named table. A schema view
 * that only reads {@link tableRefOf} misses these edges.
 */
export function linkedTableOf(column: FieldXdo): string | null {
  const suffix = "_mvpschema";
  if (typeof column.type !== "string" || !column.type.endsWith(suffix)) return null;
  const guid = column.type.slice(0, -suffix.length);
  return guid === "" ? null : guid;
}
