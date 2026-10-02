/**
 * Filtered search operand probe (NOT a shipped example, NOT auto-indexed).
 *
 * Does a db.query `where` accept an inline FILTERED operand, or does it still 500?
 * The SDK rejects filtered search operands at export, so this probe is
 * only deployable with the db-search guard temporarily relaxed to pass-through.
 *
 * Run (with the guard temporarily relaxed):
 *   node dist/bin.js validate examples/sandbox/_capture-search.ts --runtime --out validate-out
 */
import { workspace, defineFunction, addon, s, c, col, ref, expr, withFilters, filter } from "@xano/sdk";
import { users, posts } from "./_shared.js";

const defs = (xs: unknown[]) => xs as never[];

/** Left operand filtered, no-arg filter. */
const probeSearchLeft = defineFunction({
  name: "ex_probe_search_left",
  stack: [
    s.db.query({
      table: posts,
      where: expr(withFilters(col("title"), filter("trim")), "=", c.text("hello")),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Right operand filtered. */
const probeSearchRight = defineFunction({
  name: "ex_probe_search_right",
  stack: [
    s.db.query({
      table: posts,
      where: expr(col("title"), "=", withFilters(c.text("HELLO"), filter("lower"))),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Filter WITH an argument (the failure mode to rule out is filter-arg resolution). */
const probeSearchFilterArg = defineFunction({
  name: "ex_probe_search_filter_arg",
  stack: [
    s.db.query({
      table: posts,
      where: expr(withFilters(col("title"), filter("first", c.int(3))), "=", c.text("hel")),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

// --- Known-residual closure: the other encodeSearch call sites ---

/** db.bulk.delete `where` (encodeSearch @ db.ts bulk delete) with a filtered operand. */
const probeBulkDeleteFiltered = defineFunction({
  name: "ex_probe_bulk_delete_filtered",
  stack: [
    s.db.bulk.delete({
      table: posts,
      where: expr(withFilters(col("title"), filter("trim")), "=", c.text("__nomatch__")),
      as: "deleted",
    }),
  ],
  response: ref("deleted"),
});

/** db.query join-bind `where` (encodeSearch @ db.ts bind[]) with a filtered operand. */
const probeJoinBindFiltered = defineFunction({
  name: "ex_probe_join_bind_filtered",
  stack: [
    s.db.query({
      table: posts,
      bind: [{ table: users, where: expr(withFilters(col("name"), filter("trim")), "=", c.text("__nomatch__")) }],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * An addon whose `where` (encodeSearch @ addon kind) carries a filtered operand.
 * Registered on its own — its round-trip proves the engine accepts + persists a
 * filtered operand in an addon's search (the search evaluator is shared with the
 * db.query/bulk/join sites, which are runtime-verified here).
 */
const filteredAddon = addon({
  name: "ex_probe_addon_filtered",
  table: users,
  where: expr(withFilters(col("name"), filter("trim")), "=", c.text("__nomatch__")),
  output: ["id", "name"],
});

export default workspace("xanosdk-capture-search")
  .registerTables(defs([users, posts]))
  .registerAddons(defs([filteredAddon]))
  .registerFunctions(
    defs([
      probeSearchLeft,
      probeSearchRight,
      probeSearchFilterArg,
      probeBulkDeleteFiltered,
      probeJoinBindFiltered,
    ]),
  );
