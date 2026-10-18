/**
 * `s.expect.to_be_in_the_past` — assert a timestamp (epoch ms or s) is before now.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeInThePast = workflowTest({
  name: "ex_expect_to_be_in_the_past",
  stack: [
    // Epoch ms are recognised by being exactly 13 digits. A ms timestamp before
    // 2001-09-09 has 12 and is read as SECONDS, far in the future.
    s.set_var("created_at", c.int(1577836800000)), // 2020-01-01
    s.expect.to_be_in_the_past({ expr: ref("created_at") }),
  ],
});
