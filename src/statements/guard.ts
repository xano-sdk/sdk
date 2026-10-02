/**
 * `guard.*` — the two authorization checks every app writes, as the shape that
 * is actually correct.
 *
 * Neither is a new engine capability. Both are `db.get` + `precondition`
 * combinations the grounding already describes in prose, and both are easy to
 * write in a way that looks right and fails:
 *
 * - **An ownership check on a row that was not found raises a 500.** `db.get`
 *   binds `null` on a miss, and `ref("note.user_id")` against a null `note` dies
 *   with `Unable to locate var` — so the guard crashes instead of denying, and
 *   the caller sees a server error where they should see a 404. The fix is to
 *   assert existence FIRST and drill afterwards, which is what these emit.
 * - **A role check against a `null` actor row passes.** Fetch the caller's row on
 *   a public endpoint, compare `actor.role` to `"admin"` with no existence
 *   check, and an unauthenticated request compares `null` to `"admin"` — which
 *   is false, so that one is safe — but `cond.in(null, [...])` and any
 *   negated form are not. Asserting the row exists first removes the class.
 *
 * Both return a fixed-arity TUPLE, not `Statement[]`: spreading a `Statement[]`
 * into a stack widens the whole tuple and every `as` in the def stops being
 * traceable, so `InferResponse` collapses. Spread these directly —
 * `stack: [...guard.role(users, "admin"), …]`.
 */
import { dbGet } from "./special/db.js";
import { precondition } from "./special/precondition.js";
import type { PreconditionErrorType } from "./special/precondition.js";
import { cond } from "./cond.js";
import { expr } from "./expression.js";
import { auth, c, ref } from "../values/value.js";
import type { FoundBrand, Statement } from "./statement.js";
import type { Condition } from "./expression.js";
import type { ObjectRef } from "../refs/guid.js";
import { tableColumns, type ColumnDef, type TableDef } from "../kinds/table.js";
import { orNames, suggestAll } from "../util/suggest.js";

/** What a failed guard says and which status it says it with. */
interface GuardMessage {
  /** Status-bearing exception (default `accessdenied` → HTTP 403). */
  errorType?: PreconditionErrorType;
  /** The message the caller sees. Defaults to a neutral one. */
  message?: string;
}

export interface RoleGuardOptions<F extends string = string> extends GuardMessage {
  /**
   * The column holding the role on the auth table. Defaults to `"role"`, which
   * is what `@xano-sdk/auth` stores. Typed as a column of a schema-typed table.
   */
  field?: F;
  /**
   * The stack variable the caller's row binds to. Defaults to `"__actor"` — a
   * name chosen to be unlikely to collide, because a guard that silently
   * overwrote an author's `user` var would change what every later statement
   * reads. Set it when you want to READ the row afterwards.
   */
  as?: string;
  /**
   * What to say when there is no caller row at all — an unauthenticated request,
   * or a token for a deleted user. Defaults to `unauthorized` (HTTP 401), which
   * is the honest distinction from the 403 a wrong ROLE gets.
   */
  missingErrorType?: PreconditionErrorType;
  /** The message for that case. */
  missingMessage?: string;
}

export interface FoundGuardOptions {
  /** Status-bearing exception (default `notfound` → HTTP 404). */
  errorType?: PreconditionErrorType;
  /** The message the caller sees. Defaults to `"Not found."`. */
  message?: string;
}

/** A dotted `rowVar` names a subpath, which neither guard can check or narrow. */
function refusePath(helper: "found" | "owner", rowVar: string): void {
  if (!rowVar.includes(".")) return;
  const base = rowVar.split(".")[0];
  const column =
    helper === "owner"
      ? ` and the owner COLUMN separately (\`guard.owner("${base}", "user_id")\`)`
      : "";
  throw new Error(
    `guard.${helper}: \`${rowVar}\` is a PATH, not a stack variable. Pass the name the row is ` +
      `bound to (\`"${base}"\`)${column} — the existence check is on the whole binding, and it ` +
      `must run before anything drills into the row.`,
  );
}

/**
 * The existence step every guard emits. Typed with
 * {@link FoundBrand} so `InferResponse` drops `| null` from `rowVar` after it.
 */
function assertFound<const Name extends string>(
  rowVar: Name,
  opts: FoundGuardOptions,
): Statement & FoundBrand<Name> {
  return precondition({
    expr: expr(ref(rowVar), "!=", c.null()),
    error_type: opts.errorType ?? "notfound",
    error: c.text(opts.message ?? "Not found."),
  }) as Statement & FoundBrand<Name>;
}

export interface OwnerGuardOptions extends GuardMessage {
  /**
   * What to say when the row itself is absent. Defaults to `notfound` (HTTP
   * 404), as another caller's row does — deliberately NOT 403, which would
   * confirm to an unauthorized caller that the id exists.
   */
  missingErrorType?: PreconditionErrorType;
  /** The message for that case. */
  missingMessage?: string;
}

/** The row type of a schema-typed table, or `never` for a bare name / raw schema. */
type GuardRow<T> = T extends TableDef<string, infer Row> ? (unknown extends Row ? never : Row) : never;

/** The role column names `field` may take: the table's columns, or any string when untyped. */
export type RoleField<T> = [GuardRow<T>] extends [never] ? string : Extract<keyof GuardRow<T>, string>;

type RoleLiteral<V> = V extends null | undefined ? never : V extends string ? (string extends V ? string : V) : string;

/**
 * The role values `guard.role` accepts for column `F` of `T`: an enum column's
 * values, `string` for any other column (or an untyped table), and a message
 * naming the problem when `F` is not a column of a typed table.
 */
export type RoleValue<T, F extends string> = [GuardRow<T>] extends [never]
  ? string
  : F extends keyof GuardRow<T>
    ? RoleLiteral<GuardRow<T>[F]>
    : `guard.role: the table has no "${F}" column — pass field: the column that holds the role`;

/**
 * The runtime twin of {@link RoleValue}, for a caller past the types (plain JS,
 * a cast): an unknown `field` and a role outside the column's enum are refused
 * with the near misses named. Both deploy clean and fail every request — an
 * unknown column is a 500 (`Unable to locate var`), a role no row can hold a 403
 * for every caller. A table without a readable schema is not checked.
 */
function assertRoleColumn(table: ObjectRef, field: string, wanted: readonly string[], fieldGiven: boolean): void {
  const problem = roleColumnProblem(table, field, wanted, fieldGiven);
  if (problem !== undefined) throw new Error(problem);
}

/**
 * Why `guard.role`'s role check on `table` can never pass, or undefined. Shared
 * by the build-time check on a table handle and the export-time one on a table
 * passed by name, which is resolved there.
 */
export function roleColumnProblem(table: ObjectRef, field: string, wanted: readonly string[], fieldGiven: boolean): string | undefined {
  const schema = (table as { schema?: unknown } | null)?.schema;
  if (schema === undefined || schema === null || typeof schema !== "object") return undefined;
  let columns: ColumnDef[];
  try {
    columns = tableColumns(table as TableDef);
  } catch {
    return undefined;
  }
  const name = String((table as { name?: unknown }).name);
  const col = columns.find((cd) => cd.name === field);
  if (col === undefined) {
    const near = suggestAll(field, columns.map((cd) => cd.name));
    return (
      `guard.role: table "${name}" has no "${field}" column` +
        (fieldGiven ? "" : " (the default role column)") +
        ` — the role check would fail every request with \`Unable to locate var\`. ` +
        (near.length > 0 ? `Did you mean field: ${orNames(near)}? ` : "") +
        `Pass \`field\` naming the column that holds the role (columns: ${columns.map((cd) => cd.name).join(", ")}).`
    );
  }
  const values = (col as { values?: unknown }).values;
  if (col.type !== "enum" || !Array.isArray(values) || values.length === 0) return undefined;
  const allowed = values.map(String);
  const bad = wanted.filter((r) => !allowed.includes(r));
  if (bad.length === 0) return undefined;
  const hints = bad
    .map((r) => {
      const near = suggestAll(r, allowed);
      return near.length > 0 ? ` "${r}" → did you mean ${orNames(near)}?` : "";
    })
    .join("");
  const good = wanted.filter((r) => allowed.includes(r));
  return (
    `guard.role: ${orNames(bad)} ${bad.length === 1 ? "is" : "are"} not ${bad.length === 1 ? "a value" : "values"} of ` +
      `"${name}.${field}" (enum: ${orNames(allowed)}), so no caller can ever hold ${bad.length === 1 ? "it" : "them"}` +
      (good.length > 0
        ? ` — only callers holding ${orNames(good)} pass.`
        : ` and the guard denies everyone.`) +
      `${hints} Add the role to the enum, or name one it has.`
  );
}

export const guard = {
  /**
   * Require the caller to hold one of `roles` on `table`.
   *
   * Three statements: fetch the caller's own row by `auth("id")`, assert it
   * exists, assert its role is in the set. Spread into a stack:
   *
   * ```ts
   * stack: [...guard.role(users, "admin"), s.db.query({ table: audit, as: "rows" })],
   * ```
   *
   * The endpoint must be authenticated (`query({ auth: users })`). On a PUBLIC
   * endpoint `auth("id")` does not resolve at all — the request fails with a 403
   * before reaching the fetch — so this is a check on top of authentication, not
   * a replacement for it.
   *
   * With `as`, the bound row is typed from `table` — `ref("me.full_name")` after
   * `guard.role(users, "admin", { as: "me" })` is the column's type, non-null
   * (the guard has already refused a missing row).
   */
  role: <const T extends ObjectRef, const F extends RoleField<T> = "role" & RoleField<T>, const As extends string = "__actor">(
    table: T,
    roles: RoleValue<T, F> | readonly RoleValue<T, F>[],
    opts: RoleGuardOptions<F> & { as?: As } = {},
  ) => {
    const as = (opts.as ?? "__actor") as As;
    const field: string = opts.field ?? "role";
    const wanted: string[] = typeof roles === "string" ? [roles] : [...(roles as readonly string[])];
    if (wanted.length === 0) {
      throw new Error(
        "guard.role: no role given. A guard with an empty role set can never pass, which " +
          "denies every caller — say which role you meant, or drop the guard.",
      );
    }
    assertRoleColumn(table, field, wanted, opts.field !== undefined);
    const actorRole = ref(`${as}.${field}`);
    return [
      dbGet({ table, fieldValue: auth("id"), as }),
      assertFound(as, {
        errorType: opts.missingErrorType ?? "unauthorized",
        message: opts.missingMessage ?? "Not signed in.",
      }),
      precondition({
        // One role is a plain comparison; several need the filter-then-compare
        // form, because `in` is a database operator and does not resolve in a
        // runtime condition.
        expr:
          wanted.length === 1
            ? expr(actorRole, "=", c.text(wanted[0]!))
            : cond.in(actorRole, c.array(wanted)),
        error_type: opts.errorType ?? "accessdenied",
        error: c.text(opts.message ?? "You do not have access to this."),
      }),
    ] as const satisfies readonly Statement[];
  },

  /**
   * Require the caller to own the row bound to `rowVar`.
   *
   * Two statements: assert the row was found, then assert its owner column is
   * the caller. Drilling is done AFTER the existence check, which is the whole
   * point — `ref("note.user_id")` against a null `note` is a 500, so the naive
   * one-line version turns a missing row into a server error.
   *
   * ```ts
   * stack: [
   *   s.db.get({ table: notes, fieldValue: inp("id"), as: "note" }),
   *   ...guard.owner("note", "user_id"),
   *   s.db.del({ table: notes, fieldValue: inp("id") }),
   * ],
   * ```
   *
   * Both failures answer 404 `"Not found."` by default — a missing row and
   * another caller's row alike — on purpose: a 403 for the second tells an
   * unauthorized caller that the id exists (`errorType: "accessdenied"` opts
   * into it, saying `"Access denied."`). The first step is `guard.found`'s, so it narrows `rowVar` to
   * non-null in `InferResponse` the same way.
   */
  owner: <const Name extends string>(
    rowVar: Name,
    ownerField = "user_id",
    opts: OwnerGuardOptions = {},
  ) => {
    refusePath("owner", rowVar);
    return [
      assertFound(rowVar, {
        errorType: opts.missingErrorType,
        message: opts.missingMessage,
      }),
      precondition({
        expr: expr(ref(`${rowVar}.${ownerField}`), "=", auth("id")),
        error_type: opts.errorType ?? "notfound",
        error: c.text(opts.message ?? ((opts.errorType ?? "notfound") === "notfound" ? "Not found." : "Access denied.")),
      }),
    ] as const satisfies readonly Statement[];
  },

  /**
   * Require the row bound to `rowVar` to exist — a 404 on a `db.get` miss,
   * instead of a later drill into `null` raising a 500.
   *
   * One statement, and the one that NARROWS: `InferResponse` drops `| null` from
   * `rowVar`'s type after it, so the endpoint's response types as the row rather
   * than `Row | null`. A hand-written `s.precondition` with the same condition
   * does not narrow — its condition is opaque to the type-level walk.
   *
   * ```ts
   * stack: [
   *   s.db.get({ table: threads, fieldValue: inp("id"), as: "thread" }),
   *   guard.found("thread", { message: "Thread not found." }),
   * ],
   * response: ref("thread"), // Row, not Row | null
   * ```
   */
  found: <const Name extends string>(
    rowVar: Name,
    opts: FoundGuardOptions = {},
  ) => {
    refusePath("found", rowVar);
    return assertFound(rowVar, opts);
  },

  /**
   * Require an arbitrary condition, with the status-bearing failure a guard
   * wants — the general case the two above are specializations of.
   *
   * Exists so a third kind of check (a tenant match, a plan tier, a feature
   * flag) lands in the same shape rather than as a bare `s.precondition` whose
   * `error_type` defaults to `standard` and therefore answers **500**.
   */
  require: (condition: Condition, opts: GuardMessage = {}) =>
    precondition({
      expr: condition,
      error_type: opts.errorType ?? "accessdenied",
      error: c.text(opts.message ?? "You do not have access to this."),
    }),
} as const;
