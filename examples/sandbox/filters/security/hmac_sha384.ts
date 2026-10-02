/**
 * `fl.hmac_sha384` filter (group: security).
 * Returns a SHA384 signature representation of the value using a shared secret via the HMAC method
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterHmacSha384 = defineFunction({
  name: "ex_filter_hmac_sha384",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["hmac_sha384"](c.text("field"))))],
  response: ref("out"),
});
