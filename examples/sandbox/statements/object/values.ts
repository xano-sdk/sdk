/**
 * `s.object.values` — the object's values (`[1, 2]`).
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const objectValues = defineFunction({
  name: "ex_object_values",
  stack: [
    s.object.values({ as: "result", value: c.obj({ a: 1, b: 2 }) }),
  ],
  response: ref("result"),
});
