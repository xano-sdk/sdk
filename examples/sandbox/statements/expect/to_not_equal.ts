/**
 * `s.expect.to_not_equal` — codegen'd declarative statement.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { s, workflowTest } from "@xano/sdk";

export const expectToNotEqual = workflowTest({
  name: "ex_expect_to_not_equal",
  stack: [
    s.expect.to_not_equal({}),
  ],
});
