/**
 * `task({...})` — a scheduled/background job (payload key `task`). Function-like
 * `stack` plus a `schedule`.
 */
import { task, s, c, col, expr, every } from "@xano/sdk";
import { posts } from "../_shared.js";

export const nightlyCleanup = task({
  name: "ex_kind_nightly_cleanup",
  // Run daily, starting at a fixed timestamp. `freq` is a bare SECOND count;
  // `every()` converts a duration string to it at compile time, so the schedule
  // reads back as what it means instead of as 86400. No cron, no timezone.
  schedule: [{ startsOn: "2026-01-01T00:00:00Z", freq: every("1d"), repeatEnabled: true }],
  stack: [s.db.bulk.delete({ table: posts, where: expr(col("published"), "=", c.bool(false)) })],
});
