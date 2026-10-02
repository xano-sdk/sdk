/**
 * SAVED UNIT TESTS — `tests` on a `query`, `defineFunction`, or `middleware`.
 *
 * These are what the Xano editor calls unit tests: a named set of inputs run
 * against THIS object, with assertions on its response. Distinct from
 * `workflowTest({...})`, which is a standalone object with its own stack that
 * calls other objects — see `workflowTest.ts`.
 *
 * Two things to keep straight:
 *
 * - `expect.*` (used here) builds an assertion RECORD stored on a test.
 *   `s.expect.*` builds a STATEMENT for a workflow-test stack. Different types.
 * - A statement's `mock` is keyed by TEST NAME, and makes that step return the
 *   mock instead of doing its work — but only while that named test runs. It
 *   changes nothing about a normal request.
 *
 * `datasource` is left off on purpose. Omitted means an EMPTY datasource, the
 * recommended setting; naming one makes the engine CLONE it before every run.
 * Empty also means no `table({ seed })` rows are visible here — this test builds
 * its own input instead. To assert against seed rows on an EPHEMERAL, set
 * `datasource: "live"` (there it holds only the seed fixtures). That value is
 * STORED on the test, so clear it before you promote or the same test
 * clones the real database.
 */
import { query, expect, resp, c, ref, inp, s, input, expr } from "@xano/sdk";
import { api } from "../_shared.js";

export const scoreQuery = query({
  name: "ex_kind_score",
  verb: "POST",
  apiGroup: api,
  input: { score: input.int({ required: true }) },
  tests: [
    {
      name: "adds one",
      description: "the happy path",
      input: { score: c.int(1) },
      expect: [
        // Subject first — argument order IS the assertion.
        expect.to_equal(resp(), c.int(2)),
        expect.to_be_defined(resp()),
        // Both bounds are EXCLUSIVE.
        expect.to_be_within(resp(), c.int(0), c.int(10)),
      ],
    },
    {
      name: "rejects a negative score",
      input: { score: c.int(-1) },
      // No subject: the thing under assertion is the failure. The argument is a
      // case-insensitive substring of the error message; omit it for any error.
      expect: [expect.to_throw(c.text("must be positive"))],
    },
  ],
  stack: [
    s.precondition({
      expr: expr(inp("score"), ">", c.int(0)),
      error_type: "badrequest",
      error: c.text("score must be positive"),
    }),
    s.set_var("total", c.expression("$input.score + 1"), {
      // Keyed by test NAME. A name no test declares throws at encode time —
      // the engine ignores a mock whose key is not a real test id, so it would
      // otherwise deploy clean and silently never apply.
      mock: {
        "adds one": c.int(2),
        // Kept, switched off. A disabled mock is stored, not dropped.
        "rejects a negative score": { value: c.int(0), enabled: false },
      },
    }),
  ],
  response: ref("total"),
  // The saved request/response sample the editor records. Free-form JSON, not
  // tagged values — and a pull DOES bring it back.
  example: { input: { score: 1 }, output: { total: 2 } },
});
