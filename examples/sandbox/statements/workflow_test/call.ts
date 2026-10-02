/**
 * `s.workflow_test.call({ workflowTest, datasource?, as? })` — run a workflow test.
 *
 * WORKFLOW TESTS ONLY — outside one the step fails the first real request with
 * `ERROR_FATAL: Workflow Test does not exist`, so `xanosdk export` refuses it.
 * See `statements/api/call.ts` for why. Composing suites out of smaller tests is
 * what this statement is for.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 *
 * `datasource` is left off on purpose. Omitted means an EMPTY datasource — the
 * recommended setting. Naming one makes the engine CLONE that datasource before
 * the test runs, which against production-sized data is slow enough to fail.
 */
import { workflowTest, s, ref } from "@xano/sdk";
import { doubleFnTest } from "../../kinds/workflowTest.js";

export const workflowTestCallTest = workflowTest({
  name: "ex_workflow_test_call",
  stack: [
    s.workflow_test.call({ workflowTest: doubleFnTest, as: "result" }),
    s.expect.to_be_defined({ expr: ref("result") }),
  ],
});
