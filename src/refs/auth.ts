/**
 * Auth-table reference resolution — shared by query endpoints (`query.auth`) and
 * toolset tools (`tool[].auth`). Both name an auth **table** (a
 * `table({ auth: true })`), and the engine stores/exports it through the same
 * `dbo` id↔guid remap: at rest a numeric
 * `dbo.id`, in a `packageExport` bundle the table's guid, `false` when there is
 * no auth. Modeling both on one resolver keeps the two surfaces from drifting.
 */
import { resolveRef } from "./guid.js";
import type { TableDef } from "../kinds/table.js";

/**
 * An auth-table reference: the auth `table()` def (marked `table({ auth: true })`),
 * its bare name, a raw numeric `dbo.id` escape hatch, or `false`/`null`/omitted
 * for no auth.
 *
 * `false` and `null` are ONE state, not two: the engine gates on `!empty($auth)`,
 * so every falsy spelling means the endpoint is public.
 */
export type AuthRef = false | null | TableDef | string | number;

/**
 * Resolve an {@link AuthRef} to what the engine stores: `false` (no auth), a raw
 * numeric `dbo.id` (escape hatch), or the auth table's guid. `hostLabel`/`host`
 * name the referencing object for error messages (e.g. `"query"` / the query
 * name, or `"toolset tool"` / the tool ref).
 */
export function resolveAuthRef(
  hostLabel: string,
  host: string,
  auth: AuthRef | undefined,
): false | number | string {
  if (auth === undefined || auth === false || auth === null) return false;
  // Guard the retired boolean shorthand for untyped (JS) callers — `true` isn't
  // in the param's type, so the cast is what lets the comparison narrow.
  if ((auth as unknown) === true) {
    throw new Error(
      `${hostLabel} "${host}": \`auth: true\` is no longer supported. Pass the auth table ` +
        `(e.g. \`auth: user\` for a \`table({ auth: true })\`) or its numeric id.`,
    );
  }
  if (typeof auth === "number") {
    // The raw `dbo.id` escape hatch. xanosdk can't resolve a table id against
    // the registry, but it can reject values that could never be one — a
    // fat-fingered id should fail here, not with an opaque engine error at deploy.
    if (!Number.isInteger(auth) || auth <= 0) {
      throw new Error(
        `${hostLabel} "${host}": numeric \`auth\` must be a positive integer \`dbo.id\` (got ${auth}). ` +
          `Use \`false\` for no auth, or pass the auth table def/name.`,
      );
    }
    return auth;
  }
  // A table's own `auth` flag is deliberately NOT enforced here. It looked like
  // the obvious guard, and it is an invented one: the engine gates a request by
  // comparing the TOKEN's `dbo` against the endpoint's configured `dbo` by name,
  // and mints a token for any table by name — neither side reads the table's
  // flag, which is an editor concern (which tables the auth picker offers).
  //
  // A real workspace holds a query whose auth points at a table stored
  // `auth: false`; throwing here made a faithful pull of it unloadable, which is
  // the SDK being stricter than the platform it authors for. The workspace
  // export warns about the combination instead, where a name is available and
  // nothing is blocked.
  return resolveRef("dbo", auth);
}
