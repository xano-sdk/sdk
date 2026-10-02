/**
 * `s.addon.call({ addon, input?, as? })` — invoke an addon as a workspace run.
 *
 * Runs from any stack, unlike `s.api.call`/`s.task.call`/`s.trigger.call`/
 * `s.workflow_test.call`, which only run inside a `workflowTest`.
 *
 * Pass the addon DEF, not its name. A bare name is resolved to a guid with no
 * registry visibility, so a typo produces a valid-looking reference that only
 * fails at deploy — `Invalid addon reference. Try importing: <guid>`.
 *
 * `input` binds the addon's DECLARED inputs by name; a key it does not declare
 * fails the export. This addon declares none, so the call passes none.
 */
import { defineFunction, s, ref } from "@xano/sdk";
import { authorAddon } from "../../kinds/addon.js";

export const addonCall = defineFunction({
  name: "ex_addon_call",
  stack: [s.addon.call({ addon: authorAddon, as: "author" })],
  response: ref("author"),
});
