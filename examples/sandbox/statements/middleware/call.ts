/**
 * `s.middleware.call({ middleware, input?, as? })` — invoke middleware as a run.
 *
 * Pass the middleware DEF, not its name. A bare name resolves to a guid with no
 * registry visibility, so a typo deploys and then 500s with
 * `Invalid middleware reference. Try importing: <guid>`.
 */
import { defineFunction, s, ref } from "@xano/sdk";
import { rateLimit } from "../../kinds/middleware.js";

export const middlewareCall = defineFunction({
  name: "ex_middleware_call",
  stack: [s.middleware.call({ middleware: rateLimit, as: "res" })],
  response: ref("res"),
});
