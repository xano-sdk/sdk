/**
 * `s.expect.to_not_be_defined` — assert a path resolves to nothing.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToNotBeDefined = workflowTest({
  name: "ex_expect_to_not_be_defined",
  stack: [
    s.set_var("user", c.obj({ id: 1, name: "Ada" })),
    s.expect.to_not_be_defined({ expr: ref("user.nickname") }),
  ],
});
