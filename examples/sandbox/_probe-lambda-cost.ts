/**
 * What one lambda body COSTS — the crossing, not the work (feedback: lambdas are
 * an escape hatch, not a default). NOT a shipped example, NOT auto-indexed.
 *
 * A lambda body runs in a separate JavaScript runtime, so every call leaves the
 * request's own runtime and comes back. The correctness hazards are documented;
 * the PRICE is not, and an agent with no number in front of it reaches for
 * `fl.map(lambda)` the way it would reach for a native filter.
 *
 * Five endpoints, one deploy. Each does nothing but bind a value, so the only
 * thing between them is how many times the request crosses:
 *
 *   baseline    no lambda at all                → the round trip alone
 *   one         one s.lambda returning a const  → baseline + ONE crossing
 *   five        five s.lambda, same body        → is the cost per CALL or per REQUEST?
 *   map_native  fl.map over 100 ints, no body   → the native filter, for contrast
 *   map_lambda  fl.map over 100 ints with a body → the same map, one crossing
 *
 * MEASURED on a deployed ephemeral, 2026-08-22, against a ~229ms round trip.
 * Medians over 25 sequential requests each:
 *
 *   baseline    229ms          one          230ms  (+1ms  — one crossing)
 *   map_native  229ms          five         239ms  (+10ms — ~2ms per crossing)
 *                              map_lambda   244ms  (+15ms over 100 elements)
 *
 * The load-bearing result is `map_lambda`. One hundred elements cost ~15ms, not
 * the ~200ms that 100 crossings at the `five`-derived rate would cost — so an
 * iterating filter sends the body ONCE and loops on the far side. The boundary
 * is crossed per CALL, which is why "one body over a list" beats "a body inside
 * a loop" and why consolidating lambdas is the lever, not avoiding them.
 *
 * What this did NOT show: contention. Twenty CONCURRENT requests came back at
 * 245ms median for `map_lambda` against 255ms for `map_native` — no queueing
 * signal at that scale on a fresh ephemeral. The bounded worker pool is real but
 * sits above what this probe can reach, so the docs state its SHAPE and no
 * number. Do not read a negative here as "the pool is not a constraint."
 *
 * Run:
 *   node dist/bin.js deploy examples/sandbox/_probe-lambda-cost.ts --expires-hours 1
 *   for e in baseline one five map_native map_lambda; do
 *     curl -so /dev/null -w "$e %{time_total}\n" "<url>/api:probelam/$e"
 *   done
 */
import { workspace, apiGroup, query, s, c, ref, lam, fl, withFilters } from "@xano/sdk";

const api = apiGroup({ name: "probe", canonical: "probelam" });

const one100 = c.array(Array.from({ length: 100 }, (_, i) => i));

const baseline = query({
  name: "baseline",
  verb: "GET",
  apiGroup: api,
  stack: [s.set_var("v", c.int(1))],
  response: ref("v"),
});

const one = query({
  name: "one",
  verb: "GET",
  apiGroup: api,
  stack: [s.lambda({ as: "v", code: () => 1 })],
  response: ref("v"),
});

const five = query({
  name: "five",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.lambda({ as: "a", code: () => 1 }),
    s.lambda({ as: "b", code: () => 1 }),
    s.lambda({ as: "c", code: () => 1 }),
    s.lambda({ as: "d", code: () => 1 }),
    s.lambda({ as: "e", code: () => 1 }),
  ],
  response: ref("e"),
});

/** The same 100-element map, done by a native filter — no body, no crossing. */
const mapNative = query({
  name: "map_native",
  verb: "GET",
  apiGroup: api,
  stack: [s.set_var("v", withFilters(one100, fl.count()))],
  response: ref("v"),
});

/** The same 100-element map, done by a lambda body. */
const mapLambda = query({
  name: "map_lambda",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.set_var("v", withFilters(one100, fl.map(lam.fn(({ $this }) => $this, { surface: "map" })))),
  ],
  response: ref("v"),
});

const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-probe-lambda")
  .registerApiGroups(defs([api]))
  .registerQueries(defs([baseline, one, five, mapNative, mapLambda]));
