/**
 * `s.expect.to_be_null` — assert a value is null.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeNull = workflowTest({
  name: "ex_expect_to_be_null",
  stack: [
    s.set_var("deleted_at", c.null()),
    s.expect.to_be_null({ expr: ref("deleted_at") }),
  ],
});
