/**
 * Filters the engine resolves inside a **db-query expression** — an `eval`
 * pipeline, a `sort` term, or a `where`/search operand — and nowhere else.
 *
 * There are two filter registries, and they are not the same set. `fl.*` (see
 * `generated/filters.generated.ts`) is the RUNTIME pipeline: it evaluates a
 * value in the request. The names below evaluate in **SQL**, compiled into the
 * statement the database runs, so they are reachable only from a query's own
 * expression surfaces. Being absent from the runtime catalog, each would be
 * reported by `findUnresolvableFilters` as "will 500 at runtime" if checked
 * against it — steering authors off the only spelling that works.
 *
 * The distinction is worth stating because it is what makes vector search
 * possible at all: `f.vector` columns and their pgvector indexes had no query
 * surface in the typed API, and the documented `direct_query` escape hatch needs
 * a physical table name that is reassigned on every import. The distance filters
 * here close that — the ranking happens in the database, over the index, instead
 * of pulling candidate rows into the request to score them.
 *
 * Live-verified on a deployed ephemeral: an `eval` of
 * `vector_cos_distance` over a `f.vector(3)` column, sorted by the eval's alias,
 * returned rows ordered by cosine distance (0, 0.0061, 1); the same filter on a
 * `where` operand filtered on distance. Both are exercised by
 * `examples/sandbox`.
 *
 * Browser-safe: a plain string list, no imports.
 */

/**
 * Vector distance/similarity over an `f.vector` column. Each takes ONE argument
 * — the query vector, as a `decimal[]` value (`inp("q")`, `c.array([…])`) — and
 * yields a `decimal` to sort or compare on. Pair each with the matching index
 * `op` so the index is usable: `vector_cos_distance` ↔ `vector_cosine_ops`,
 * `vector_l2_distance` ↔ `vector_l2_ops`, `vector_l1_distance` ↔ `vector_l1_ops`,
 * `vector_inner_product`/`vector_negative_inner_product` ↔ `vector_ip_ops`.
 *
 * Distances sort ASCENDING (nearest first); `vector_cos_similarity` is the
 * inverse, so sort it descending.
 */
export const VECTOR_FILTERS = [
  // The unqualified spelling, alongside the per-metric ones below. A real
  // workspace uses it on a vector column and it was reported unresolvable.
  // It is the ONE name in this file with no registered engine
  // class behind it, which is why `qf.*` does not offer it: the per-metric
  // spellings are the ones the engine declares. Kept allowlisted so the
  // workspace that already stores it still exports without a false warning.
  "vector_distance",
  "vector_cos_distance",
  "vector_cos_similarity",
  "vector_inner_product",
  "vector_negative_inner_product",
  "vector_l1_distance",
  "vector_l2_distance",
  // Registered by the engine and absent from every catalog, so they were
  // reported unresolvable until the class registry was read. `qf.*` offers both.
  "vector_hamming_distance",
  "vector_jaccard_distance",
] as const;

/**
 * Every filter resolvable in a query expression but NOT in a value pipeline:
 * the vector family, the geo predicates (`distance`/`within`/`covers`), the
 * full-text `search_rank`, and the SQL-side spellings of the length/coalesce/
 * timestamp helpers (`between_filter` is the SQL `BETWEEN`, distinct from the
 * runtime `between`).
 *
 * This list is the union of the two registries' difference, not a curated
 * subset: a name missing from it is reported as unresolvable, which is the false
 * warning this exists to prevent.
 */
export const QUERY_EXPRESSION_FILTERS = [
  ...VECTOR_FILTERS,
  // Geo predicates over a `f.geo.*` column.
  "covers",
  "distance",
  "within",
  // Full-text rank, over the search index a `search` operand matched against.
  "search_rank",
  "unaccent",
  // SQL-side scalar helpers.
  "array_length",
  "at_timezone",
  "between_filter",
  "coalesce",
  "length",
  "time",
  "to_timestamp",
  // Timestamp arithmetic and extraction, computed in the database.
  "epochms_add_day",
  "epochms_add_hour",
  "epochms_add_minute",
  "epochms_add_month",
  "epochms_add_sec",
  "epochms_add_year",
  "epochms_sub_day",
  "epochms_sub_hour",
  "epochms_sub_minute",
  "epochms_sub_month",
  "epochms_sub_sec",
  "epochms_sub_year",
  "epochms_day",
  "epochms_dow",
  "epochms_doy",
  "epochms_epoch_day",
  "epochms_epoch_hour",
  "epochms_epoch_minute",
  "epochms_epoch_sec",
  "epochms_hour",
  "epochms_minute",
  "epochms_month",
  "epochms_week",
  "epochms_year",
  // SQL-side AGGREGATES, computed by the database over a grouped result. They
  // are correctly absent from the runtime catalog — the resolvability probe
  // classifies them as phantoms because they genuinely do not resolve in a value
  // pipeline — but they are exactly what a db-query aggregate expression is for,
  // and every one of them works live. Missing here, they were reported as
  // guaranteed runtime 500s on a working workspace.
  "count_distinct",
  "median",
  // The list aggregates: collect a column's values into an array, optionally
  // ordered, optionally de-duplicated.
  "to_list",
  "to_list_asc",
  "to_list_desc",
  "to_distinct_list",
  "to_distinct_list_asc",
  "to_distinct_list_desc",
  // The earliest/latest timestamp in a group. Registered aggregate classes that
  // no catalog lists, so an aggregate query could not ask for either without a
  // raw name this allowlist then rejected.
  "min_timestamp",
  "max_timestamp",
] as const;

/**
 * A filter name a db-query expression resolves. Typed as the known set plus
 * `string` so the runtime catalog (`fl.*` names, e.g. `count`/`sum` in an
 * aggregate) and anything this list has not caught up with stay authorable —
 * autocomplete without a closed door.
 */
export type QueryFilterName = (typeof QUERY_EXPRESSION_FILTERS)[number] | (string & {});

/** Membership test for {@link QUERY_EXPRESSION_FILTERS}. */
export const isQueryExpressionFilter = (name: string): boolean =>
  (QUERY_EXPRESSION_FILTERS as readonly string[]).includes(name);
