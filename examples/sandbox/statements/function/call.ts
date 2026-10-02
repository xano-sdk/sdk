/**
 * `s.function.call({ fn, input?, as? })` — invoke a function as a workspace run.
 *
 * The binding carries the TARGET's response type: `as: "out"` is branded with
 * `InferResponse<typeof doubleFn>`, so a dotted `ref("out.…")` in the caller's
 * response types to that field instead of `unknown`. Whatever the target
 * resolves to is what propagates — declare `responseShape` on the TARGET to fix
 * every caller at once.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";
import type { InferResponse } from "@xano/sdk";
import { doubleFn } from "../../_shared.js";

export const functionCall = defineFunction({
  name: "ex_function_call",
  stack: [s.function.call({ fn: doubleFn, input: { n: c.int(5) }, as: "out" })],
  response: ref("out"),
});

/** The caller's response is the target's response — no `responseShape` needed here. */
export type FunctionCallResult = InferResponse<typeof functionCall>;
