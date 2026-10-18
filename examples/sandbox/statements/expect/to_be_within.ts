/**
 * `s.expect.to_be_within` — assert the subject lies strictly between `min` and `max`.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeWithin = workflowTest({
  name: "ex_expect_to_be_within",
  stack: [
    s.set_var("total", c.int(3)),
    s.expect.to_be_within({ expr: ref("total"), min: c.int(1), max: c.int(10) }),
  ],
});
