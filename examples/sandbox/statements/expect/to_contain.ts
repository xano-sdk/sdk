/**
 * `s.expect.to_contain` — assert a list holds a value, or a text holds a substring.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Every operand is required: an absent one is substituted with `0` and the
 * assertion runs against that instead.
 */
import { c, ref, s, workflowTest } from "@xano/sdk";

export const expectToContain = workflowTest({
  name: "ex_expect_to_contain",
  stack: [
    s.set_var("roles", c.array(["admin", "editor"])),
    s.expect.to_contain({ expr: ref("roles"), value: c.text("admin") }),
  ],
});
