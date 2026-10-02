/**
 * `s.security.create_curve_key` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const securityCreateCurveKey = defineFunction({
  name: "ex_security_create_curve_key",
  stack: [
    s.security.create_curve_key({ as: "result", curve: "P-256", format: "object" }),
  ],
  response: ref("result"),
});
