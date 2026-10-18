/**
 * `s.object.keys` — the object's keys (`["a", "b"]`).
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const objectKeys = defineFunction({
  name: "ex_object_keys",
  stack: [
    s.object.keys({ as: "result", value: c.obj({ a: 1, b: 2 }) }),
  ],
  response: ref("result"),
});
