/**
 * `s.db.query` — the full "Query All Records" surface. Only `db.query` takes a
 * `where` comparison (built with `expr`/`cmp`/`and`/`or` over `col(...)`),
 * `sort`, and `paging`.
 *
 * PARAM GATE: the return shape + query controls.
 */
import { defineFunction, s, c, col, inp, ref, expr, and, input, qf } from "@xano/sdk";
import { posts, users } from "../../_shared.js";
import { fieldVector } from "../../fields/vector.js";

/** Gate 1 — a simple filtered list (`where` only). */
export const dbQueryWhere = defineFunction({
  name: "ex_db_query_where",
  stack: [
    s.db.query({
      table: posts,
      where: expr(col("published"), "=", c.bool(true)),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Gate 2 — filter + sort + paging (metadata envelope).
 *
 * With the envelope on, an `output` selection would be rooted at the ENVELOPE,
 * not at the row: `output: ["curPage", "items.title"]`. A bare column list there
 * matches no envelope key, drops every one, and the endpoint answers `[]` —
 * `export()` warns and `--strict` fails. See `dbQueryPagedOutput` below for the
 * narrowed form.
 */
export const dbQueryPaged = defineFunction({
  name: "ex_db_query_paged",
  input: { page: input.int() },
  stack: [
    s.db.query({
      table: posts,
      where: and(expr(col("published"), "=", c.bool(true)), expr(col("score"), ">", c.int(0))),
      sort: [{ sortBy: "score", dir: "desc" }],
      paging: { page: inp("page"), per_page: 10 },
      as: "page",
    }),
  ],
  response: ref("page"),
});

/**
 * The narrowed paged shape: the selection is rooted at the envelope, so the
 * columns are prefixed and the counters worth keeping are named alongside them.
 */
export const dbQueryPagedOutput = defineFunction({
  name: "ex_db_query_paged_output",
  input: { page: input.int() },
  stack: [
    s.db.query({
      table: posts,
      where: expr(col("published"), "=", c.bool(true)),
      paging: { page: inp("page"), per_page: 10 },
      output: ["itemsReceived", "curPage", "nextPage", "items.id", "items.title"],
      as: "page",
    }),
  ],
  response: ref("page"),
});

/** Gate 3 — a count (`returnType: "count"` binds a number). */
export const dbQueryCount = defineFunction({
  name: "ex_db_query_count",
  stack: [
    s.db.query({
      table: posts,
      returnType: "count",
      where: expr(col("published"), "=", c.bool(true)),
      as: "total",
    }),
  ],
  response: ref("total"),
});

/**
 * Gate 4 — aggregate / group-by (`returnType: "aggregate"`). Roll rows up by a
 * `group` column with `eval` aggregators (`count`/`sum`/… ride `filters`). Write
 * `name` as a bare column — it is alias-qualified to `"posts.<col>"` on emit (the
 * engine requires the qualified form for aggregate columns) and the statement
 * declares `posts` as its alias so that qualified name resolves.
 * Byte-verified against a live capture.
 */
export const dbQueryAggregate = defineFunction({
  name: "ex_db_query_aggregate",
  stack: [
    s.db.query({
      table: posts,
      returnType: "aggregate",
      aggregate: {
        group: [{ name: "published", as: "published" }],
        eval: [
          { name: "id", as: "count", filters: [qf.count()] },
          { name: "score", as: "total", filters: [qf.sum()] },
        ],
      },
      as: "rollup",
    }),
  ],
  response: ref("rollup"),
});

/**
 * Gate 5 — a JOIN (`bind`), and the one thing to get right about it.
 *
 * The two sides of a join condition are spelled DIFFERENTLY:
 *   - the JOINED table's column takes its `as` alias — `col("author.id")`
 *   - this query's OWN column stays BARE — `col("author_id")`
 *
 * Qualifying your own column with the table's name (`col("posts.author_id")`)
 * resolves only if the query also sets `tableAlias` (see Gate 6). `db.query`
 * rejects the unresolvable spelling at export rather than letting it 400 at
 * runtime with an error naming the wrong operand.
 *
 * A join widens what `where`/`sort`/`eval` can address; it does not by itself
 * add the joined columns to the row — `eval` grafts the ones you want.
 */
export const dbQueryJoin = defineFunction({
  name: "ex_db_query_join",
  stack: [
    s.db.query({
      table: posts,
      bind: [{ table: users, as: "author", join: "left", where: expr(col("author_id"), "=", col("author.id")) }],
      eval: [{ name: "author.name", as: "author_name" }],
      sort: [{ sortBy: "author.name", dir: "asc" }],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Gate 6 — the same join with `tableAlias`, which is what lets BOTH sides be
 * dotted. `tableAlias` is the SQL alias for this query's own table
 * (`context.dbo.as`); once it is declared, `col("p.author_id")` resolves the way
 * `col("author.id")` does. Useful when a condition reads better fully qualified,
 * or when two joins make the bare form ambiguous to a reader.
 */
export const dbQueryJoinAliased = defineFunction({
  name: "ex_db_query_join_aliased",
  stack: [
    s.db.query({
      table: posts,
      tableAlias: "p",
      bind: [{ table: users, as: "author", join: "left", where: expr(col("p.author_id"), "=", col("author.id")) }],
      where: expr(col("p.published"), "=", c.bool(true)),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Gate 7 — VECTOR SIMILARITY SEARCH: rank rows by distance to a query vector.
 *
 * An `f.vector` column is searched through the `eval` pipeline, which compiles
 * to SQL (unlike `fl.*`, which evaluates in the request): the distance filter
 * turns the column into a computed `distance` column, and `sort` orders by that
 * alias. The work happens in the database, over the column's index — not by
 * reading candidate rows into the request to score them there.
 *
 * The filter must match the index `op` (`vector_cos_distance` ↔
 * `vector_cosine_ops`; `l2`/`l1`/`inner_product` likewise). Distances sort
 * ASCENDING for nearest-first; `vector_cos_similarity` is the inverse, so sort
 * that one `desc`. The same filter also works on a `where` operand
 * (`withFilters(col("embedding"), qf.vector_cos_distance(inp("q")))`) to cut off
 * by distance rather than by row count.
 *
 * Build the step with `qf.*` rather than the raw `{ name, arg }` form: an
 * `eval`/`sort`/`where` pipeline compiles to SQL and resolves a DIFFERENT
 * registry from `fl.*`, so a typo there is a runtime failure. Same emitted
 * bytes; the name and the argument count are checked here instead.
 *
 * Live-verified on a deployed environment.
 */
export const dbQueryVectorSearch = defineFunction({
  name: "ex_db_query_vector_search",
  input: { q: input.vector(1536) },
  stack: [
    s.db.query({
      table: fieldVector,
      eval: [{ name: "embedding", as: "distance", filters: [qf.vector_cos_distance(inp("q"))] }],
      sort: [{ sortBy: "distance", dir: "asc" }],
      paging: { per_page: 10, metadata: false },
      as: "nearest",
    }),
  ],
  response: ref("nearest"),
});
