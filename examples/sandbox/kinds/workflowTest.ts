/**
 * `workflowTest({...})` — an end-to-end test (payload key `workflow_test`).
 *
 * A workflow test takes NO input and returns NO response. It runs other
 * workspace objects and asserts on what they bind, so the shape is always the
 * same: a `.call` that binds with `as`, then `s.expect.*` against that variable.
 *
 * `datasource` is left off on purpose. Omitted means an EMPTY datasource — the
 * recommended setting. Naming one makes the engine CLONE that datasource before
 * every run, which against production-sized data is slow enough to fail the run.
 * Empty also means no `table({ seed })` rows are visible while the test runs. To
 * assert against seed rows on an EPHEMERAL, set `datasource: "live"` (there it
 * holds only the seed fixtures). That value is STORED on the object, so clear it
 * before you promote or the same test clones the real database.
 */
import { workflowTest, s, c, ref } from "@xano/sdk";
import { doubleFn } from "../_shared.js";

export const doubleFnTest = workflowTest({
  name: "ex_kind_double_fn_test",
  description: "ex_shared_double returns its input doubled",
  tags: ["smoke"],
  stack: [
    s.function.call({ fn: doubleFn, input: { n: 21 }, as: "doubled" }),
    s.expect.to_be_defined({ expr: ref("doubled") }),
    s.expect.to_equal({ expr: ref("doubled"), value: c.int(42) }),
  ],
});
