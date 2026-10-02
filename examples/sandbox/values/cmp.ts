/**
 * `cmp(left, op, right)` + `and(...)` / `or(...)` — the search-comparison
 * builders for a `db.query` `where`. `cmp` supports the richer engine operators
 * (e.g. "includes", "like", "in") beyond `expr`'s six.
 *
 * The two text operators here are not interchangeable, and the difference is
 * invisible until you call the endpoint. `like`/`ilike` take the operand AS the
 * pattern, so they need the `%` wildcards written in; `includes` wraps the
 * operand itself and matches case-insensitively, which is what a keyword search
 * wants — a bare term under `ilike` matches only a whole-string equal and
 * returns an empty list at HTTP 200.
 */
import { defineFunction, s, c, col, ref, cmp, and, or } from "@xano/sdk";
import { posts } from "../_shared.js";

export const valueCmp = defineFunction({
  name: "ex_value_cmp",
  stack: [
    s.db.query({
      table: posts,
      where: and(
        cmp(col("published"), "=", c.bool(true)),
        or(
          cmp(col("score"), ">", c.int(10)),
          // Substring search: no wildcards to write, and case-insensitive.
          cmp(col("title"), "includes", c.text("xano")),
          // The same match spelled as an explicit pattern — `%` supplied by hand.
          cmp(col("title"), "like", c.text("%xano%")),
        ),
      ),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
