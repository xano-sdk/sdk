/**
 * `s.expect.to_be_empty` — assert a list, object or text is empty.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToBeEmpty = workflowTest({
  name: "ex_expect_to_be_empty",
  stack: [
    s.set_var("tags", c.array([])),
    s.expect.to_be_empty({ expr: ref("tags") }),
  ],
});
