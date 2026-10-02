/**
 * Result-filter capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * Sources real engine goldens for `asFilters` — the filter chain a statement
 * pipes its result through before binding it (`… as $token|upper`). The offline
 * corpus cannot answer the two questions that decide whether the surface is
 * correct, because both are about what the ENGINE does with the bytes:
 *
 *   Probe #1 — does a plain chain survive a round trip unchanged?
 *   Probe #2 — do a filter's ARGUMENTS come back as sent?
 *   Probe #3 — do a db statement's column selection (`output.items`) and its
 *              result filters coexist, or does one write replace the block?
 *
 * #3 is the one worth capturing above all: the SDK reads the two independently
 * but writes `output` as a unit, and that asymmetry is where a surprise would
 * live. Each probe is a ONE-STATEMENT function so the golden promotes cleanly
 * from `run[0]`.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture-as-filters.ts --capture --runtime --out validate-out
 */
import { workspace, defineFunction, s, c, inp, input, ref, fl } from "@xano/sdk";
import { users } from "./_shared.js";

const defs = (xs: unknown[]) => xs as never[];

/** Probe #1 — a single filter on a generated statement's binding. */
const probeAsFilterPlain = defineFunction({
  name: "ex_probe_as_filter_plain",
  stack: [s.security.create_uuid({ as: "token", asFilters: [fl.upper()] })],
  response: ref("token"),
});

/** Probe #2 — a chain whose filters carry arguments, in order. */
const probeAsFilterArgs = defineFunction({
  name: "ex_probe_as_filter_args",
  stack: [
    s.security.create_uuid({ as: "token", asFilters: [fl.upper(), fl.substr(c.int(0), c.int(8))] }),
  ],
  response: ref("token"),
});

/** Probe #3 — a column selection and a filter chain in one `output` block. */
const probeAsFilterWithSelection = defineFunction({
  name: "ex_probe_as_filter_selection",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.get({
      table: users,
      fieldValue: inp("id"),
      output: ["id", "email"],
      as: "user",
      asFilters: [fl.get(c.text("email"))],
    }),
  ],
  response: ref("user"),
});

export default workspace("xanosdk-capture-as-filters")
  .registerTables(defs([users]))
  .registerFunctions(defs([probeAsFilterPlain, probeAsFilterArgs, probeAsFilterWithSelection]));
