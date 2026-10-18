/**
 * `s.expect.to_be_false` — assert a value is `false`.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeFalse = workflowTest({
  name: "ex_expect_to_be_false",
  stack: [
    s.set_var("archived", c.bool(false)),
    s.expect.to_be_false({ expr: ref("archived") }),
  ],
});
