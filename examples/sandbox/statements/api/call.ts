/**
 * `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an API endpoint
 * as a workspace run.
 *
 * WORKFLOW TESTS ONLY. The `Run …` family resolves its target from the engine's
 * runtime object registry, and outside a workflow test that registry carries
 * only functions, tools and middleware — so an `s.api.call` in an endpoint or a
 * function deploys clean and then fails the first real request with
 * `ERROR_FATAL: Query does not exist`. `xanosdk export` refuses it for that
 * reason. To reach one endpoint's logic from another, put the shared work in a
 * function and `s.function.run` it from both.
 *
 * PARAM GATE: `headers` replaces the headers the callee sees; `auth` carries a
 * token. Two runtime rules the signature does not show:
 *
 * - `auth.token` must be a BARE STRING. A tagged value deploys clean and then
 *   fails the run — the engine stores that slot as plain text and never
 *   evaluates it.
 * - Neither slot authenticates the call inside a workflow test. To cover
 *   auth-gated logic, move the body into a `defineFunction` taking the user id
 *   and call that. See `llms/tests.md`.
 */
import { workflowTest, s, c, ref } from "@xano/sdk";
import { getUserQuery } from "../../kinds/query.js";

// The target is passed as its `query()` def handle, never a bare name: a
// query's identity is composed from its api group, verb, and name, so a name
// alone cannot resolve it (and the handle types the bound result for free).

/** Gate 1 — plain call. */
export const apiCallTest = workflowTest({
  name: "ex_api_call",
  stack: [
    s.api.call({ api: getUserQuery, input: { id: c.int(1) }, as: "res" }),
    s.expect.to_be_defined({ expr: ref("res") }),
  ],
});

/** Gate 2 — a static token, and headers the callee sees. */
export const apiCallAuthedTest = workflowTest({
  name: "ex_api_call_authed",
  stack: [
    s.api.call({
      api: getUserQuery,
      input: { id: c.int(1) },
      headers: { "X-Trace-Id": c.text("ex-api-call") },
      auth: { token: "a-test-token" },
      as: "res",
    }),
    s.expect.to_be_defined({ expr: ref("res") }),
  ],
});
