/**
 * `s.expect.to_match` — assert a value matches a regex.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 *
 * The `value` slot is a PHP `preg_*` PATTERN, so build it with `c.regex(...)`.
 * A bare `c.text("^ok_.*$")` there is a pattern the engine cannot run — it is
 * refused at compile time and pointed here.
 */
import { s, c, ref, workflowTest } from "@xano/sdk";

export const expectToMatch = workflowTest({
  name: "ex_expect_to_match",
  stack: [
    s.set_var("greeting", c.text("Xano SDK Automated Testing Engine")),
    s.expect.to_match({ expr: ref("greeting"), value: c.regex("^Xano SDK.*Engine$") }),
    // A JS RegExp works too — its source and flags are used directly.
    s.expect.to_match({ expr: ref("greeting"), value: c.regex(/automated/i) }),
  ],
});
