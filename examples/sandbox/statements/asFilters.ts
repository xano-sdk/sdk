/**
 * `asFilters` — filter a statement's RESULT before it binds.
 *
 * The editor shows it on the step as `return as <var> | upper`. It is an
 * argument of the `as` clause itself, so every statement that binds a variable
 * accepts one, in the same slot as `disabled`/`description`: inline on the
 * object-arg factories, a trailing options object on the positional specials.
 *
 * Filters come from the same `fl.*` catalog as value filters and apply in
 * order. Two things worth knowing:
 *
 *   • A statement that binds nothing (`s.precondition`, `s.while`, …) does not
 *     offer the option at all — there would be no result to filter.
 *   • The chain RETYPES the bound variable — `asFilters: [fl.count()]` on a db
 *     read makes it a `number`, not the row. Filters whose result the engine
 *     declares as `any` (`get`, `set`, `json_decode`) fold to `unknown`, which
 *     is why `user_email` below is `unknown` rather than `string`.
 *
 * Prefer `asFilters` over a follow-up `s.set_var` when you just want the result
 * in a different shape — it is one step instead of two, and it is what the
 * editor writes.
 */
import { defineFunction, s, c, ref, inp, input, fl } from "@xano/sdk";
import { users } from "../_shared.js";

export const asFilters = defineFunction({
  name: "ex_as_filters",
  input: { id: input.int() },
  stack: [
    // One filter: the generated id binds upper-cased.
    // Live: `"BF437403-9C8C-4C6D-A96D-A3B697B63290"`.
    s.security.create_uuid({ as: "token", asFilters: [fl.upper()] }),

    // Filters take arguments like any other `fl.*` call, and a chain applies
    // left to right — upper-cased, THEN cut to 8. Live: `"8418AB43"`.
    s.set_var("short_token", ref("token"), { asFilters: [fl.substr(c.int(0), c.int(8))] }),

    // Trimmed, then lower-cased. Live: `"ada@example.com"`.
    s.set_var("email", c.text("  Ada@Example.COM  "), {
      asFilters: [fl.trim(), fl.lower()],
    }),

    // A db read can select columns AND filter the result: `output` narrows the
    // row the engine returns, `asFilters` reshapes what lands in the variable —
    // `user_email` binds the column, not the row. Both live in one stored
    // `output` block; neither displaces the other.
    s.db.get({
      table: users,
      fieldValue: inp("id"),
      output: ["id", "email"],
      as: "user_email",
      asFilters: [fl.get(c.text("email"))],
    }),
  ],
  response: ref("email"),
});
