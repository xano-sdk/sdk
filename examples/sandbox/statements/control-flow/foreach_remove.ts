/**
 * `s.foreach_remove()` — remove the current item from the iterated collection.
 */
import { defineFunction, s, c, ref, expr } from "@xano/sdk";

export const foreachRemove = defineFunction({
  name: "ex_foreach_remove",
  stack: [
    s.set_var("items", c.array([1, 2, 3, 4])),
    s.foreach({
      as: "n",
      list: ref("items"),
      body: [
        s.conditional({
          when: expr(ref("n"), "=", c.int(3)),
          then: [s.foreach_remove()],
        }),
      ],
    }),
  ],
  response: ref("items"),
});
