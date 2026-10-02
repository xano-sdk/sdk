/**
 * `s.group(body[])` — a labeled block grouping a sub-stack.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const group = defineFunction({
  name: "ex_group",
  stack: [
    s.group([
      s.set_var("a", c.int(1)),
      s.math.add({ name: "a", value: c.int(2) }),
    ]),
  ],
  response: ref("a"),
});
