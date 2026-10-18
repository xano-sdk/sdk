/**
 * `s.expect.to_start_with` — assert a text starts with a prefix.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToStartWith = workflowTest({
  name: "ex_expect_to_start_with",
  stack: [
    s.set_var("email", c.text("ada@example.com")),
    s.expect.to_start_with({ expr: ref("email"), value: c.text("ada@") }),
  ],
});
