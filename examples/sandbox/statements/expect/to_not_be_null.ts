/**
 * `s.expect.to_not_be_null` — assert a value is not null.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToNotBeNull = workflowTest({
  name: "ex_expect_to_not_be_null",
  stack: [
    s.set_var("user", c.obj({ id: 1 })),
    s.expect.to_not_be_null({ expr: ref("user") }),
  ],
});
