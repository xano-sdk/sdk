/**
 * Minimal deployable workspace used only by the ephemeral-CLI end-to-end script
 * (scripts/e2e-ephemeral.sh). Kept tiny on purpose: one table + one API query so
 * the import is trivially valid and can't fail for corpus-specific reasons. Not
 * part of the example set and not imported by index.ts.
 */
import { workspace, apiGroup, table, f, query, s, c, ref, input, inp } from "@xano/sdk";

const api = apiGroup({ name: "e2e", canonical: "e2e" });

const widgets = table({
  name: "widgets",
  schema: {
    label: f.text({ required: true }),
    qty: f.int({ default: "0" }),
  },
});

const ping = query({
  name: "ping",
  verb: "GET",
  apiGroup: api,
  input: { n: input.int({ required: true }) },
  stack: [
    s.set_var("doubled", inp("n")),
    s.math.mul({ name: "doubled", value: c.int(2) }),
  ],
  response: ref("doubled"),
});

/**
 * URL path params, live. The offline corpus can prove Xano SDK emits
 * `name: "echo/{slug}/n/{count}"` and that the input map lines up — it cannot
 * prove the ENGINE routes that path and binds each segment to its input. Only a
 * real request does, so this endpoint echoes both segments straight back and the
 * e2e script asserts on the values.
 */
const echo = query({
  name: "echo/{slug}/n/{count}",
  verb: "GET",
  apiGroup: api,
  input: { slug: input.text(), count: input.int() },
  stack: [
    s.set_var("slug_seen", inp("slug")),
    s.set_var("count_seen", inp("count")),
  ],
  response: { slug: ref("slug_seen"), count: ref("count_seen") },
});

const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-e2e")
  .registerApiGroups(defs([api]))
  .registerTables(defs([widgets]))
  .registerQueries(defs([ping, echo]));
