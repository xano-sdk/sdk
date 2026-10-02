/**
 * `s.update_var(name, value)` — reassign an existing stack variable.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const updateVar = defineFunction({
  name: "ex_update_var",
  stack: [
    s.set_var("count", c.int(1)),
    s.update_var("count", c.int(2)),
  ],
  response: ref("count"),
});
