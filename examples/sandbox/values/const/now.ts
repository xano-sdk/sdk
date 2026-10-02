/**
 * `c.now()` — current time as epoch-milliseconds (the engine's native
 * `const:epochms` constant). It is a plain unfiltered value, so it is valid
 * inline in a `where`/`cmp`. Cutoff math still reads better hoisted: compute
 * `now - 1h` once in a stack var, then compare against the var. This models the
 * SLA/expiry pattern: "rows older than an hour".
 */
import { defineFunction, s, c, col, cmp, ref, fl, withFilters } from "@xano/sdk";
import { posts } from "../../_shared.js";

const ONE_HOUR_MS = 3_600_000;

export const constNow = defineFunction({
  name: "ex_value_const_now",
  stack: [
    // Hoist `now - 1h` into a var — for readability/reuse, not because it is required.
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_add_ms(c.int(-ONE_HOUR_MS)))),
    s.db.query({
      table: posts,
      where: cmp(col("created_at"), "<", ref("cutoff")),
      as: "stale",
    }),
  ],
  response: ref("stale"),
});
