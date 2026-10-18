/**
 * `s.expect.to_be_true` — assert a value is `true`.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeTrue = workflowTest({
  name: "ex_expect_to_be_true",
  stack: [
    s.set_var("active", c.bool(true)),
    s.expect.to_be_true({ expr: ref("active") }),
  ],
});
