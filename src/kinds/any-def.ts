/**
 * Wide aliases for the def types that carry generics — the annotation that lets
 * a workspace be assembled out of independently-authored modules.
 *
 * The problem is TypeScript's, not the SDK's. `register*` stores defs and does
 * not read their brands, so it takes them however they arrive. What fails is the
 * expression that BUILDS the array:
 *
 * ```ts
 * const modules = [catalogModule, chatModule];
 * workspace("app").registerTables(modules.flatMap((m) => m.tables)); // ✗ TS2322
 * ```
 *
 * `Array.prototype.flatMap` is declared `(cb: (…) => U | ReadonlyArray<U>)`, so
 * `U` binds to the FIRST element's table type and every later table is checked
 * against that one table's schema. The diagnostic is ~40 lines of expanded
 * generics ending in a comparison between two unrelated column names, and it
 * names neither `flatMap` nor the real cause. `.concat()` collapses the same way.
 *
 * Two spellings work. Annotate the module array with the wide alias:
 *
 * ```ts
 * const modules: { tables: readonly AnyTableDef[] }[] = [catalogModule, chatModule];
 * workspace("app").registerTables(modules.flatMap((m) => [...m.tables])); // ✓
 * ```
 *
 * …or skip the loop and let an array LITERAL infer the union across every
 * element at once, which is the documented form:
 *
 * ```ts
 * workspace("app").registerTables([...catalogModule.tables, ...chatModule.tables]); // ✓
 * ```
 *
 * Nothing is lost by widening here. The typing an author actually needs lives on
 * the `table()`/`query()` handle they hold and pass to `s.db.*` — it is never
 * read back off the registered array.
 *
 * Aliases exist for exactly the def types whose generics can collapse this way.
 * `ApiGroupDef`, `TaskDef`, `TriggerDef`, `MiddlewareDef` and the rest carry no
 * generics, so a heterogeneous array of them infers cleanly with no annotation.
 */
import type { TableDef } from "./table.js";
import type { QueryHandle } from "./query.js";
import type { AddonDef } from "./addon.js";
import type { FunctionDef } from "../function/define.js";

/** Any `table()` handle, whatever its schema — see the module note on `flatMap`. */
export type AnyTableDef = TableDef;

/** Any `query()` handle, whatever its input, stack, response, or name. */
export type AnyQueryDef = QueryHandle;

/** Any `defineFunction()` def, whatever its input, stack, or response. */
export type AnyFunctionDef = FunctionDef;

/** Any `addon()` handle, whatever it grafts onto the row. */
export type AnyAddonDef = AddonDef;
