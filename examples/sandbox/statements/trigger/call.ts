/**
 * `s.trigger.call({ trigger, input?, as? })` — invoke a trigger as a workspace run.
 *
 * WORKFLOW TESTS ONLY — outside one the step fails the first real request with
 * `ERROR_FATAL: Trigger does not exist`, so `xanosdk export` refuses it. See
 * `statements/api/call.ts` for why. This is how you assert on a trigger without
 * having to produce the row change that fires it.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 */
import { workflowTest, s, c } from "@xano/sdk";
import { onUserInsert } from "../../kinds/trigger.js";

export const triggerCallTest = workflowTest({
  name: "ex_trigger_call",
  stack: [s.trigger.call({ trigger: onUserInsert, input: { new: c.obj({ id: 1 }) } })],
});
