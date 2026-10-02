/**
 * `s.action.call({ actionId, input?, registry?, as? })` — invoke an installed
 * action.
 *
 * The id is supplied, never derived. An action is a third-party package
 * installed onto the instance, so its id is assigned at install time and is not
 * the same value on another instance — read it off an existing call in a pulled
 * workspace.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const actionCall = defineFunction({
  name: "ex_action_call",
  stack: [
    s.action.call({
      actionId: "20c63dfc-dfcf-420e-8435-8212d1a8305d",
      input: { to: c.text("a@example.com") },
      as: "sent",
    }),
  ],
  response: ref("sent"),
});
