/**
 * `s.util.send_email` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@xano/sdk";

export const utilSendEmail = defineFunction({
  name: "ex_util_send_email",
  stack: [
    s.util.send_email({ as: "result", service_provider: "resend" }),
  ],
  response: ref("result"),
});
