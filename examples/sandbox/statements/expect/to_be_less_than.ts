/**
 * `s.expect.to_be_less_than` — codegen'd declarative statement.
 * Hosted by a `workflowTest`: assertions belong there, and a failure raises
 * rather than being collected, so one left in a query/function 500s the request.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { s, workflowTest } from "@xano/sdk";

export const expectToBeLessThan = workflowTest({
  name: "ex_expect_to_be_less_than",
  stack: [
    s.expect.to_be_less_than({}),
  ],
});
