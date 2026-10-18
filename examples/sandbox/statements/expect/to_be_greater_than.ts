/**
 * `s.expect.to_be_greater_than` — assert the subject is greater than a value.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeGreaterThan = workflowTest({
  name: "ex_expect_to_be_greater_than",
  stack: [
    s.set_var("total", c.int(3)),
    s.expect.to_be_greater_than({ expr: ref("total"), value: c.int(2) }),
  ],
});
