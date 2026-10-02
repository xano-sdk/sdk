/**
 * `s.webflow.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `path` is REQUIRED, and this one is not an inference from a declaration: the
 * engine rejects an empty path at run time with its own error. The host is
 * engine-supplied, so `path` is relative — this is the whole address.
 *
 * The credential is engine-supplied too, read from the workspace's Webflow
 * connection rather than passed here, which is why there is no key argument.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const webflowRequest = defineFunction({
  name: "ex_webflow_request",
  stack: [
    s.webflow.request({
      as: "result",
      path: c.text("/sites"),
      method: "GET",
    }),
  ],
  response: ref("result"),
});
