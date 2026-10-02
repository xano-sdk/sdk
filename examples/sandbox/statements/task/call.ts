/**
 * `s.task.call({ task, as? })` — invoke a background task as a workspace run.
 *
 * WORKFLOW TESTS ONLY — outside one the step fails the first real request with
 * `ERROR_FATAL: Task does not exist`, so `xanosdk export` refuses it. See
 * `statements/api/call.ts` for why.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 */
import { workflowTest, s } from "@xano/sdk";
import { nightlyCleanup } from "../../kinds/task.js";

export const taskCallTest = workflowTest({
  name: "ex_task_call",
  stack: [s.task.call({ task: nightlyCleanup })],
});
