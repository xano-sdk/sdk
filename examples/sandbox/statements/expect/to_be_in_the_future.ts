/**
 * `s.expect.to_be_in_the_future` — assert a timestamp (epoch ms or s) is after now.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeInTheFuture = workflowTest({
  name: "ex_expect_to_be_in_the_future",
  stack: [
    s.set_var("expires_at", c.int(4102444800000)), // 2100-01-01
    s.expect.to_be_in_the_future({ expr: ref("expires_at") }),
  ],
});
