/**
 * A deployable workspace for the release row-selection probe (NOT a shipped
 * example, NOT auto-indexed). Companion to `_probe-release-seed.ts`.
 *
 * Two seeded tables with DIFFERENT row counts, so a release's per-table
 * row-count list can be checked against the table it names rather than merely
 * being non-empty — a cut that seeds the wrong table would otherwise look
 * identical to one that seeded the right one. A third table carries no seed, so
 * "absent from the manifest" is distinguishable from "present with zero rows".
 *
 * All values are invented. Nothing here is real data.
 */
import { workspace, apiGroup, table, f, query, s, c, ref } from "@xano/sdk";

const api = apiGroup({ name: "seedprobe", canonical: "seedprobe" });

/** 3 rows. */
const widgets = table({
  name: "probe_widgets",
  schema: { label: f.text({ required: true }) },
  seed: [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }],
});

/** 1 row — a different count, so the two are told apart in the manifest. */
const crates = table({
  name: "probe_crates",
  schema: { code: f.text({ required: true }) },
  seed: [{ code: "only-one" }],
});

/** No seed at all: proves the manifest lists only tables whose rows were asked for. */
const empties = table({
  name: "probe_empties",
  schema: { note: f.text({ required: true }) },
});

const ping = query({
  name: "ping",
  verb: "GET",
  apiGroup: api,
  stack: [s.set_var("ok", c.text("ok"))],
  response: ref("ok"),
});

export default workspace("probe-seed")
  .registerTables([widgets, crates, empties])
  .registerApiGroups([api])
  .registerQueries([ping]);
