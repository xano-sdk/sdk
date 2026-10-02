/**
 * `s.util.get_input({ encoding?, as? })` — capture the raw request body.
 */
import { defineFunction, s, ref } from "@xano/sdk";

export const utilGetInput = defineFunction({
  name: "ex_util_get_input",
  stack: [s.util.get_input({ as: "body" })],
  response: ref("body"),
});
