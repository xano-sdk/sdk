/**
 * `s.expect.to_end_with` — assert a text ends with a suffix.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToEndWith = workflowTest({
  name: "ex_expect_to_end_with",
  stack: [
    s.set_var("email", c.text("ada@example.com")),
    s.expect.to_end_with({ expr: ref("email"), value: c.text("@example.com") }),
  ],
});
