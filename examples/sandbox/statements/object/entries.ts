/**
 * `s.object.entries` — the object's `{ key, value }` pairs.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const objectEntries = defineFunction({
  name: "ex_object_entries",
  stack: [
    s.object.entries({ as: "result", value: c.obj({ a: 1, b: 2 }) }),
  ],
  response: ref("result"),
});
