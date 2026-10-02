/**
 * `s.comment(text?)` — a no-op annotation node.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const comment = defineFunction({
  name: "ex_comment",
  stack: [
    s.comment("this block computes the running total"),
    s.set_var("total", c.int(0)),
  ],
  response: ref("total"),
});
