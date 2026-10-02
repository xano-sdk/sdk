/**
 * A mesh0 tracing probe — three endpoints with deliberately different outcomes,
 * so a deployed trace can be read back per statement. NOT a shipped example,
 * NOT auto-indexed.
 *
 * `ok` succeeds, `boom` trips a precondition (HTTP 400, stack unwinds), and
 * `slow` spends a second inside one statement so per-statement timing is
 * visibly attributable.
 *
 * Run:
 *   node dist/bin.js deploy examples/sandbox/_probe-mesh0-trace.ts --expires-hours 1
 *   curl -sD - "<url>/api:probemesh/ok?qty=5"
 *   # then mesh0_get_trace with the x-mesh0-trace-id header and the tenant
 */
import { workspace, apiGroup, query, s, c, inp, expr, input, ref } from "@xano/sdk";

const api = apiGroup({ name: "probe", canonical: "probemesh" });

const ok = query({
  name: "ok",
  verb: "GET",
  apiGroup: api,
  input: { qty: input.int() },
  stack: [
    s.precondition({
      expr: expr(inp("qty"), ">", c.int(0)),
      error_type: "badrequest",
      error: "qty must be greater than zero",
    }),
    s.set_var("accepted", inp("qty")),
  ],
  response: ref("accepted"),
});

const boom = query({
  name: "boom",
  verb: "GET",
  apiGroup: api,
  input: { qty: input.int() },
  stack: [
    s.set_var("seen", inp("qty")),
    s.precondition({
      expr: expr(inp("qty"), ">", c.int(1000)),
      error_type: "badrequest",
      error: "qty must be greater than one thousand",
    }),
    s.set_var("unreachable", c.int(1)),
  ],
  response: ref("seen"),
});

const slow = query({
  name: "slow",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.set_var("before", c.int(1)),
    s.util.sleep({ value: c.int(1) }),
    s.set_var("after", c.int(2)),
  ],
  response: ref("after"),
});

const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-probe-mesh0")
  .registerApiGroups(defs([api]))
  .registerQueries(defs([ok, boom, slow]));
