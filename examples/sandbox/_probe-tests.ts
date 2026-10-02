/**
 * Probe harness for the TEST-RUN wire contract (NOT a shipped example, NOT auto-indexed).
 *
 * `xanosdk test` was written against documented route shapes, not against the
 * engine. Four things it assumes were unverified, and each is the kind of thing
 * that fails silently rather than loudly:
 *
 *   Q1  What does a run answer with when a test FAILS? The transport treats
 *       `status === "ok"` as the only pass precisely because the failure
 *       vocabulary is unknown — this measures it instead of guessing.
 *   Q2  Does a workflow run carry `timing`? It is read defensively; if the
 *       engine always sends it, that is worth knowing, and if it sometimes
 *       omits it, the defensive read is load-bearing.
 *   Q3  Does the `unit_test` list send `datasource`? `test list` warns about the
 *       clone hazard from that field, and cannot warn at all if it is absent.
 *   Q4  Is a list a bare array or an `{items, nextPage}` envelope, and is a unit
 *       test's id the string id Xano SDK derived?
 *
 * Every question has a CONTROL: a passing case beside each failing one, so
 * "everything failed" is distinguishable from "the failing one failed", and an
 * absent field is distinguishable from a field that is present and empty.
 *
 * Run:
 *   npx tsx src/emit/bin.ts deploy examples/sandbox/_probe-tests.ts --expires-hours 1 --json
 *   (curl the four meta routes — see scripts in the session that added this)
 *   npx tsx src/emit/bin.ts ephemeral delete <name> --yes
 *
 * MEASURED OUTPUT lives at the bottom of this file. Update it if you re-run.
 */
import { workspace, apiGroup, query, workflowTest, expect, resp, s, c, ref, inp, input, expr } from "@xano/sdk";

const api = apiGroup({ name: "probe", canonical: "probe" });

/**
 * Q1 + Q3 + Q4. Four unit tests over one trivial query, chosen so each run
 * outcome the engine can produce is represented exactly once.
 */
const scoreQuery = query({
  name: "probe_score",
  verb: "POST",
  apiGroup: api,
  input: { score: input.int({ required: true }) },
  tests: [
    // CONTROL: must pass. If this fails, the harness is wrong, not the engine.
    {
      name: "probe_pass",
      description: "control — asserts the true thing",
      input: { score: c.int(1) },
      expect: [expect.to_equal(resp(), c.int(2))],
    },
    // Q1a: the stack succeeds, the ASSERTION disagrees. Expected to surface a
    // per-assertion message in `results[]`.
    {
      name: "probe_fail_assert",
      description: "Q1a — stack runs clean, assertion is false",
      input: { score: c.int(1) },
      expect: [expect.to_equal(resp(), c.int(999))],
    },
    // Q1b: the STACK throws and the test does not expect it. A different
    // failure mode from Q1a, and possibly a different status string.
    {
      name: "probe_fail_throw",
      description: "Q1b — stack throws, test does not expect a throw",
      input: { score: c.int(-1) },
      expect: [expect.to_be_defined(resp())],
    },
    // CONTROL for Q1b: the same throw, expected. Must pass, which proves Q1b's
    // failure is the unexpectedness and not the throw itself.
    {
      name: "probe_throw_expected",
      description: "control — the same throw, asserted",
      input: { score: c.int(-1) },
      expect: [expect.to_throw(c.text("must be positive"))],
    },
  ],
  stack: [
    s.precondition({
      expr: expr(inp("score"), ">", c.int(0)),
      error_type: "badrequest",
      error: c.text("score must be positive"),
    }),
    s.set_var("total", c.expression("$input.score + 1")),
  ],
  response: ref("total"),
});

/** Q2 control: a workflow test that PASSES. Does its run carry `timing`? */
const workflowPass = workflowTest({
  name: "probe_wf_pass",
  description: "Q2 control — passing workflow test",
  stack: [s.set_var("n", c.int(42)), s.expect.to_equal({ expr: ref("n"), value: c.int(42) })],
});

/** Q2: a workflow test that FAILS. Reference notes say a failure can omit `timing`. */
const workflowFail = workflowTest({
  name: "probe_wf_fail",
  description: "Q2 — failing workflow test",
  stack: [s.set_var("n", c.int(42)), s.expect.to_equal({ expr: ref("n"), value: c.int(7) })],
});

export default workspace("xanosdk-probe-tests")
  .registerApiGroups([api])
  .registerQueries([scoreQuery])
  .registerWorkflowTests([workflowPass, workflowFail]);

/* ─────────────────────────── MEASURED OUTPUT ───────────────────────────
 * Run 2026-08-22 against a dev instance, deployed to a fresh ephemeral
 * (base `<instance>/tenant/<name>`, internal workspace id 1). All four
 * controls behaved as designed, so the failures below are the engine's.
 *
 * Q1 — unit_test/{id}/run, HTTP 200 in every case:
 *   probe_pass            {"status":"ok",  "results":[{"status":"pass"}]}
 *   probe_fail_assert     {"status":"fail","results":[{"status":"fail",
 *                          "message":"to_equal failed - expected value 999 does not equal 2"}]}
 *   probe_fail_throw      {"status":"fail","results":[{"status":"fail","message":"Bad Request"}]}
 *   probe_throw_expected  {"status":"ok",  "results":[{"status":"pass"}]}
 *   → both failure modes answer "fail". A passing result carries no `message`.
 *   → NO `timing` on a unit run, ever.
 *
 * Q2 — workflow_test/{id}/run, HTTP 200:
 *   probe_wf_pass  {"status":"ok",       "timing":0}
 *   probe_wf_fail  {"status":"exception","timing":0.03,
 *                   "message":"to_equal failed - expected value 7 does not equal 42"}
 *   → THE HEADLINE: a failing workflow test says "exception", NOT "fail". The two
 *     families disagree, so any check written as `status === "fail"` reports every
 *     workflow failure as a pass. `status === "ok"` is the only safe pass test.
 *   → `timing` IS sent, and a passing run legitimately sends 0 — read it with a
 *     `typeof` check, never a truthiness one.
 *   → the failure message is TOP-LEVEL here; unit tests put it in `results[]`.
 *
 * Q3 — the two list routes disagree on `datasource`:
 *   unit_test     rows are {id,name,description,obj_id,obj_type,obj_name,
 *                 expect_count,input_count} — no `datasource` key at all.
 *   workflow_test rows DO carry `datasource` (""), plus guid/branch/tag/docs.
 *   → `test list` can only ever surface the clone hazard for workflow tests.
 *
 * Q4 — both lists are `{curPage, nextPage, prevPage, items[]}`, and a final page
 *   sends `nextPage: null` rather than omitting the key.
 *   → unit ids are the string ids Xano SDK derived, round-tripped byte-for-byte.
 *   → workflow ids are small ints the ENGINE assigns (1, 2) — not derivable
 *     locally, which is why identity is resolved by listing.
 *   → listing order is not insertion order (id 2 came back before id 1).
 *
 * End to end: `test run-all` reported 3 passed / 3 failed and exited 5;
 * `deploy --test` exited 5 with the deploy summary intact, URL included.
 * ─────────────────────────────────────────────────────────────────────── */
