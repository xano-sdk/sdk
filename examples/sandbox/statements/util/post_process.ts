/**
 * `s.util.post_process(body[])` — run a post-response sub-stack.
 */
import { defineFunction, s, c } from "@xano/sdk";

export const utilPostProcess = defineFunction({
  name: "ex_util_post_process",
  stack: [
    s.util.post_process([s.debug.log({ value: c.text("response sent") })]),
  ],
});
