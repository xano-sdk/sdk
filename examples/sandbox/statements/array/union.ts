/**
 * `s.array.union({ source, with, as? })` — set-union of two arrays.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const arrayUnion = defineFunction({
  name: "ex_array_union",
  stack: [s.array.union({ source: c.array([1, 2, 3]), with: c.array([3, 4, 5]), as: "merged" })],
  response: ref("merged"),
});
